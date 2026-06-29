// Session 8 SPIKE — push a Shopify order whose total == the externally-captured
// (Razorpay) amount, with stacked offers + shipping represented, marked paid.
// Raw Admin GraphQL (the Shopify MCP is unauthenticated; this is also the exact
// path Session 12 will wire into checkout). Run with: node --env-file=.env.local
//   scripts/spike-order-push.js <assess|create|complete <draftGid>|show <id>>
import process from "node:process";

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const APIVER = process.env.SHOPIFY_API_VERSION || "2025-10";
const ENDPOINT = `https://${SHOP}/admin/api/${APIVER}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) console.error("GraphQL errors:", JSON.stringify(j.errors, null, 2));
  return j.data;
}
const money = (n) => Number(n).toFixed(2);

// --- the canonical ₹13,466 stacked cart (verified against the live offer engine) ---
const CART = {
  lines: [
    { variantId: "gid://shopify/ProductVariant/45321217147097", quantity: 3 }, // BCAA Mango @499
    { variantId: "gid://shopify/ProductVariant/45042167054553", quantity: 1 }, // whey @4949
    { variantId: "gid://shopify/ProductVariant/45323586633945", quantity: 1 }, // whey @9749
  ],
  gift: { variantId: "gid://shopify/ProductVariant/48656508289241", quantity: 1 }, // shaker @315
  subtotal: 16195,
  discountTotal: 2729, // BXGY 499 + TIERED 734 + COUPON 1496
  total: 13466,
  shipping: 99, // a custom shipping line — proves shipping represents + still matches
  razorpayPaymentId: "pay_SPIKE8MOCKID0001", // mock external capture reference
};
CART.paidAmount = CART.total + CART.shipping; // 13565 — what Razorpay would capture

const DRAFT_FIELDS = `
  id name invoiceUrl status taxesIncluded currencyCode
  subtotalPriceSet { presentmentMoney { amount currencyCode } }
  totalShippingPriceSet { presentmentMoney { amount } }
  totalTaxSet { presentmentMoney { amount } }
  totalDiscountsSet { presentmentMoney { amount } }
  totalPriceSet { presentmentMoney { amount } }
  shippingLine { title originalPriceSet { presentmentMoney { amount } } }
  appliedDiscount { title value valueType amountSet { presentmentMoney { amount } } }
  lineItems(first: 10) { edges { node {
    title quantity
    originalUnitPriceSet { presentmentMoney { amount } }
    discountedUnitPriceSet { presentmentMoney { amount } }
    appliedDiscount { value valueType }
  } } }`;

function draftInput() {
  return {
    email: "spike@beastlife.in",
    note: `storeasy26 spike (Session 8) — paid via Razorpay ${CART.razorpayPaymentId} (mock)`,
    tags: ["storeasy26", "razorpay-paid", "spike-s8"],
    customAttributes: [
      { key: "razorpay_payment_id", value: CART.razorpayPaymentId },
      { key: "channel", value: "storeasy26-pwa" },
      { key: "captured_amount_inr", value: String(CART.paidAmount) },
    ],
    lineItems: [
      ...CART.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      {
        variantId: CART.gift.variantId,
        quantity: CART.gift.quantity,
        appliedDiscount: { valueType: "PERCENTAGE", value: 100, title: "Free gift", description: "FREE_GIFT offer" },
      },
    ],
    appliedDiscount: {
      valueType: "FIXED_AMOUNT",
      value: CART.discountTotal,
      title: "Stacked offers",
      description: "BXGY (BCAA) + Whey 5% tier + BEAST10",
    },
    shippingLine: { title: "Standard shipping", price: money(CART.shipping) },
  };
}

const cmd = process.argv[2];

function typeName(t) {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return typeName(t.ofType) + "!";
  if (t.kind === "LIST") return "[" + typeName(t.ofType) + "]";
  return t.name || typeName(t.ofType);
}

if (cmd === "schema") {
  const names = process.argv.slice(3);
  const q = `query{ ${names
    .map((n, i) => `t${i}: __type(name:"${n}"){ name kind inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`)
    .join("\n")} }`;
  const data = await gql(q);
  for (const k of Object.keys(data)) {
    const t = data[k];
    if (!t) { console.log(`(no such type: ${names[Object.keys(data).indexOf(k)]})`); continue; }
    console.log(`\n## ${t.name} (${t.kind})`);
    (t.inputFields || []).forEach((f) => console.log(`  ${f.name}: ${typeName(f.type)}`));
  }
}

if (cmd === "assess") {
  const ids = [...CART.lines.map((l) => l.variantId), CART.gift.variantId];
  const data = await gql(
    `query($ids:[ID!]!){
      shop { name currencyCode taxesIncluded taxShipping ianaTimezone billingAddress { countryCodeV2 } }
      nodes(ids:$ids){ ... on ProductVariant { id title price product { title } } }
    }`,
    { ids },
  );
  console.log("SHOP:", JSON.stringify(data.shop, null, 2));
  console.log("VARIANTS:");
  let sum = 0;
  data.nodes.forEach((v) => {
    const line = CART.lines.find((l) => l.variantId === v.id);
    if (line) sum += Number(v.price) * line.quantity;
    console.log(`  ${v.id} ₹${v.price} — ${v.product.title} / ${v.title}`);
  });
  console.log(`computed line subtotal from Shopify prices: ₹${sum} (engine subtotal ₹${CART.subtotal})`);
  console.log(`EXPECTED order total = subtotal ${CART.subtotal} − discount ${CART.discountTotal} + shipping ${CART.shipping} = ₹${CART.paidAmount}`);
}

if (cmd === "create") {
  const data = await gql(
    `mutation($input: DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder { ${DRAFT_FIELDS} } userErrors { field message } } }`,
    { input: draftInput() },
  );
  const r = data?.draftOrderCreate;
  if (r?.userErrors?.length) console.log("userErrors:", JSON.stringify(r.userErrors, null, 2));
  const d = r?.draftOrder;
  if (!d) { console.log("no draft created"); process.exit(1); }
  console.log("DRAFT:", d.id, d.name, "| taxesIncluded:", d.taxesIncluded);
  console.log("  subtotal :", d.subtotalPriceSet.presentmentMoney.amount);
  console.log("  discounts:", d.totalDiscountsSet.presentmentMoney.amount);
  console.log("  shipping :", d.totalShippingPriceSet.presentmentMoney.amount);
  console.log("  tax      :", d.totalTaxSet.presentmentMoney.amount, "(included:", d.taxesIncluded + ")");
  console.log("  TOTAL    :", d.totalPriceSet.presentmentMoney.amount, "| paidAmount:", CART.paidAmount);
  const match = Number(d.totalPriceSet.presentmentMoney.amount) === CART.paidAmount;
  console.log(match ? "  ✓ MATCH — total == amount paid" : "  ✗ MISMATCH");
  console.log("  draftId:", d.id);
}

if (cmd === "complete") {
  const id = process.argv[3];
  const data = await gql(
    `mutation($id: ID!){ draftOrderComplete(id:$id, paymentPending:false){
      draftOrder { id status order { id name displayFinancialStatus
        totalPriceSet { presentmentMoney { amount } }
        totalTaxSet { presentmentMoney { amount } } } }
      userErrors { field message } } }`,
    { id },
  );
  const r = data?.draftOrderComplete;
  if (r?.userErrors?.length) console.log("userErrors:", JSON.stringify(r.userErrors, null, 2));
  console.log(JSON.stringify(r?.draftOrder, null, 2));
}

if (cmd === "order-create") {
  // Fallback for tax-exclusive stores: force the exact total + represent GST as
  // INCLUDED via explicit taxLines, and book the Razorpay capture as the SALE txn.
  const goods = CART.total; // 13466 — GST-inclusive goods total (post stacked offers)
  const shipping = CART.shipping; // 99
  const gstRate = 0.18; // supplements = 18% IGST
  const gst = Number((goods - goods / (1 + gstRate)).toFixed(2)); // included GST portion
  const paid = goods + shipping;
  const input = {
    email: "spike-oc@beastlife.in",
    currency: "INR",
    taxesIncluded: true,
    financialStatus: "PAID",
    tags: ["storeasy26", "razorpay-paid", "spike-s8-ordercreate"],
    note: `orderCreate fallback — GST-inclusive. Razorpay ${CART.razorpayPaymentId} (mock)`,
    customAttributes: [
      { key: "razorpay_payment_id", value: CART.razorpayPaymentId },
      { key: "captured_amount_inr", value: String(paid) },
    ],
    lineItems: [
      {
        title: "storeasy26 cart (3 items + free shaker · stacked offers applied)",
        quantity: 1,
        requiresShipping: true,
        taxable: true,
        priceSet: { shopMoney: { amount: money(goods), currencyCode: "INR" } },
        taxLines: [
          { title: "IGST 18%", rate: gstRate, priceSet: { shopMoney: { amount: money(gst), currencyCode: "INR" } } },
        ],
      },
    ],
    shippingLines: [
      { title: "Standard shipping", priceSet: { shopMoney: { amount: money(shipping), currencyCode: "INR" } } },
    ],
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        gateway: "razorpay",
        authorizationCode: CART.razorpayPaymentId,
        amountSet: { shopMoney: { amount: money(paid), currencyCode: "INR" } },
      },
    ],
  };
  const data = await gql(
    `mutation($order: OrderCreateOrderInput!){ orderCreate(order:$order){
      order { id name displayFinancialStatus taxesIncluded
        totalPriceSet { presentmentMoney { amount } }
        totalTaxSet { presentmentMoney { amount } }
        totalShippingPriceSet { presentmentMoney { amount } }
        taxLines { title rate priceSet { presentmentMoney { amount } } }
        transactions(first:5){ kind status gateway authorizationCode amountSet { presentmentMoney { amount } } } }
      userErrors { field message } } }`,
    { order: input },
  );
  const r = data?.orderCreate;
  if (r?.userErrors?.length) console.log("userErrors:", JSON.stringify(r.userErrors, null, 2));
  console.log(JSON.stringify(r?.order, null, 2));
  console.log(`EXPECTED total ${paid} | included GST ${gst} (18% of ${(goods / 1.18).toFixed(2)})`);
}

if (cmd === "show") {
  const arg = process.argv[3];
  const isGid = arg.startsWith("gid://");
  const data = await gql(
    `query($q:String){ orders(first:1, query:$q){ edges { node {
      id name displayFinancialStatus
      currentSubtotalPriceSet { presentmentMoney { amount } }
      totalShippingPriceSet { presentmentMoney { amount } }
      totalTaxSet { presentmentMoney { amount } } taxesIncluded
      totalDiscountsSet { presentmentMoney { amount } }
      totalPriceSet { presentmentMoney { amount } }
      discountApplications(first:5){ edges { node { __typename
        ... on DiscountCodeApplication { code value { __typename } }
        ... on ManualDiscountApplication { title } } } }
      shippingLine { title originalPriceSet { presentmentMoney { amount } } }
      customAttributes { key value }
      transactions(first:5){ kind status gateway amountSet { presentmentMoney { amount } } }
      lineItems(first:10){ edges { node { title quantity
        discountedUnitPriceSet { presentmentMoney { amount } } } } }
    } } } }`,
    { q: isGid ? `id:${arg.split("/").pop()}` : `name:${arg}` },
  );
  console.log(JSON.stringify(data?.orders?.edges?.[0]?.node, null, 2));
}
