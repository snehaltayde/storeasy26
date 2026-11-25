// Support cannot read outside the matrix (Phase 0 line 2). Line 1
// (test:permissions) proves who gets past each gate; this suite proves what the
// read-only callers get back once past it.
//   pnpm test:support-reads
// Callers checked: every merchant role without settings.read (derived from
// roleAllows, so today staff and support) and an operator under a support grant.
// The fixture plants canary strings: store A's secrets and settings, member
// emails, an audit row, an order's customer details and cart credentials, a
// contact message, store B's name, product, offer, document and secrets, and
// every session token. Each probe (scripts/support/support-reads.js) is called
// as each caller and its raw text searched for every canary (also lowercased and
// URL-encoded); its top-level keys must be on the probe's list. The owner is the
// positive control: settings, team and audit show their canaries to the owner,
// and secrets reach no one. Every console page (scripts/support/admin-pages.js)
// has a row, every page a read-only role may not open has a server-side gate,
// and every page is run as support with its components stubbed
// (scripts/support/page-harness.js): no prop holds a canary.
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// short lowercase ASCII, so no encoding or casing hides one (risk 3)
const CNY = {
  platformSecret: "cnyplatsecret0",
  // store A secrets: never in any answer, not even the owner's
  orderLinkSecret: "cnyolsecret0",
  adminPassword: "cnyadminpass0",
  shopifyAdminToken: "cnyshopadmtok0",
  shopifyClientSecret: "cnyshopclisec0",
  storefrontToken: "cnysftoken0",
  storefrontPrivateToken: "cnysfprivtok0",
  shopifyWebhookSecret: "cnyshopwhsec0",
  razorpayKeySecret: "cnyrzpkeysec0",
  razorpayWebhookSecret: "cnyrzpwhsec0",
  ga4ApiSecret: "cnyga4sec0",
  metaCapiToken: "cnymetacapi0",
  dbToken: "cnydbtoken0",
  // store A settings (the owner's Settings shows them)
  shopifyScopes: "cnyscopes0",
  metaTestEventCode: "cnymetatest0",
  // audit
  auditResource: "cnyauditres0",
  // the order's customer and cart
  orderEmail: "cnyordmail0@example.test",
  orderPhone: "9876501234",
  orderName: "cnyordname0",
  orderAddress: "cnyaddrline0",
  orderCity: "cnyordcity0",
  orderPincode: "cnypin0",
  orderSnapshot: "cnysnapshot0",
  cartId: "cnycartid0",
  idempotencyKey: "cnyidemkey0",
  customerId: "cnycustid0",
  // contact message
  msgName: "cnymsgname0",
  msgEmail: "cnymsgmail0@example.test",
  msgBody: "cnymsgbody0",
  // store B
  bName: "cnystoreb0",
  bProduct: "cnybproduct0",
  bOffer: "cnyboffer0",
  bDocument: "cnybdoc0",
  bOrderLinkSecret: "cnybolsecret0",
  bShopifyAdminToken: "cnybshoptok0",
  // Phase 4 line 1: an app's secret setting in A (no one reads it back) and store B's install
  appSecret: "cnyappsecret0",
  bApp: "cnybapp0",
  // Phase 4 line 3: store B's custom app (its name), and A's webhook address path
  bWebhookApp: "cnybhookapp0",
  bTheme: "cnybtheme0", // Phase 5 line 1: store B's uploaded theme's name
  bArchivedTheme: "cnybarchived0", // P5-A: store B's archived package's name
  hookPath: "cnyhookpath0",
};
const SECRET_KEYS = [
  "platformSecret", "orderLinkSecret", "adminPassword", "shopifyAdminToken", "shopifyClientSecret", "storefrontToken", "storefrontPrivateToken",
  "shopifyWebhookSecret", "razorpayKeySecret", "razorpayWebhookSecret", "ga4ApiSecret", "metaCapiToken", "dbToken", "cartId", "idempotencyKey",
  "bOrderLinkSecret", "bShopifyAdminToken", "appSecret",
];
// member emails (…@sup-a.test … @sup-d.test) and the operator's (operator@sup.test)
const MEMBER_EMAIL = /[\w.+-]+@sup(-[a-d])?\.test/i;
const SECRET_KEY_NAMES = /"(secrets|dbToken|db_token|password_hash|token_hash|secret_hash)"\s*:/;

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-sup-default.db";
process.env.PLATFORM_SECRET = CNY.platformSecret;
process.env.PLATFORM_CACHE_MS = "50";
const network = H.blockNetwork();

const { roleAllows, ROLES, ACTIONS } = await import("../lib/platform/authz.js");
const { SUPPORT_PROBES } = await import("./support/support-reads.js");
const { ADMIN_PAGES } = await import("./support/admin-pages.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack && !e.message ? e.stack : e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

// --- the fixture ------------------------------------------------------------------
const store = await H.makeRoleStore({
  name: "sup",
  a: {
    products: 2,
    collections: 1,
    config: { shopify_scopes: CNY.shopifyScopes, meta_test_event_code: CNY.metaTestEventCode },
    secrets: {
      order_link_secret: CNY.orderLinkSecret,
      admin_password: CNY.adminPassword,
      shopify_admin_token: CNY.shopifyAdminToken,
      shopify_client_secret: CNY.shopifyClientSecret,
      shopify_storefront_token: CNY.storefrontToken,
      shopify_storefront_private_token: CNY.storefrontPrivateToken,
      shopify_webhook_secret: CNY.shopifyWebhookSecret,
      razorpay_key_secret: CNY.razorpayKeySecret,
      razorpay_webhook_secret: CNY.razorpayWebhookSecret,
      ga4_api_secret: CNY.ga4ApiSecret,
      meta_capi_token: CNY.metaCapiToken,
    },
  },
  b: {
    products: [{ title: CNY.bProduct, handle: "cnybproduct-h" }],
    secrets: { order_link_secret: CNY.bOrderLinkSecret, shopify_admin_token: CNY.bShopifyAdminToken },
  },
});
const { call, a, b, users, cookies } = store;
const F = await import("./support/tenant-fixture.js");
const C = await import("../lib/platform/control.js");
const I = await import("../lib/platform/identity.js");
const { audit } = await import("../lib/platform/audit.js");
const { db } = await import("../lib/db.js");
const { saveMedia } = await import("../lib/media.js");
const R = await import("../lib/registry/index.js");

// store A's database token and store B's name, on the control-plane rows
{
  const row = await C.getTenant(a.id, { fresh: true });
  await C.upsertTenant({ ...row, dbToken: CNY.dbToken });
  await C.patchTenant(b.id, { name: CNY.bName });
}
// store C (support is a member too) and store D (support is a member, suspended)
const c = await F.makeTenant({ name: "sup-c", mode: "documents" });
const d = await F.makeTenant({ name: "sup-d", mode: "documents" });
await I.addMembership(users.support.id, c.id, "support");
await I.addMembership(users.support.id, d.id, "support");
await C.patchTenant(d.id, { status: "suspended" });

await audit({ actor: { kind: "merchant", id: users.owner.id, role: "owner" }, action: "settings.write", resource: CNY.auditResource, tenantId: a.id });

const now = new Date().toISOString();
const ORDER_ID = "BL-SUPREAD1";
await a.run(async () => {
  await db
    .insertInto("orders")
    .values({
      id: ORDER_ID,
      idempotency_key: CNY.idempotencyKey,
      cart_id: CNY.cartId,
      email: CNY.orderEmail,
      phone: CNY.orderPhone,
      name: CNY.orderName,
      address_line1: CNY.orderAddress,
      city: CNY.orderCity,
      state: "KA",
      pincode: CNY.orderPincode,
      country: "IN",
      subtotal: 500,
      discount_total: 0,
      shipping_total: 0,
      total: 500,
      currency: "INR",
      snapshot: JSON.stringify({ contact: { email: CNY.orderEmail, note: CNY.orderSnapshot }, items: [] }),
      payment_method: "cod",
      payment_status: "cod",
      status: "confirmed",
      customer_id: CNY.customerId,
      razorpay_order_id: "order_supread1",
      razorpay_payment_id: "pay_supread1",
      coupon_code: "SUPREAD10",
      created_at: now,
      updated_at: now,
    })
    .execute();
  // events as the state machine writes them (lib/orders.js, order-cancel.js, order-projection.js)
  await db
    .insertInto("order_events")
    .values([
      { order_id: ORDER_ID, from_status: null, to_status: "pending_payment", meta: JSON.stringify({ payment_method: "cod", write_id: "w_1" }), created_at: now },
      { order_id: ORDER_ID, from_status: "pending_payment", to_status: "confirmed", meta: JSON.stringify({ attempt: 1, error: "Shopify said no", write_id: "w_2" }), created_at: now },
    ])
    .execute();
  await db.insertInto("return_requests").values({ id: "ret_supread1", order_id: ORDER_ID, customer_id: "cnycustid0", reason: "too big", status: "requested", created_at: now, updated_at: now }).execute();
  await db.insertInto("contact_messages").values({ id: "msg_supread1", name: CNY.msgName, email: CNY.msgEmail, message: CNY.msgBody, created_at: now }).execute();
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const media = await a.run(() => saveMedia({ filename: "logo.png", mime: "image/png", bytes: Buffer.concat([PNG, Buffer.from("cnymediablob0")]), alt: "logo" })).catch((e) => ({ error: e }));

// documents: the owner (no name, so the email fallback) creates, saves and publishes a page in A; owner-b one in B
const docs = (caller, body, host) => call(caller, "documents", "PUT", { body, host });
async function ownerPage(caller, host, slug, title) {
  const created = await docs(caller, { createDocument: { type: "page", meta: { slug, title } } }, host);
  if (created.status !== 200) throw new Error(`create ${slug}: ${created.text.slice(0, 300)}`);
  let doc = created.body.document;
  const saved = await docs(caller, { saveDraft: { id: doc.id, body: { ...doc.body, meta: { ...doc.body.meta, title: `${title} v2` } } }, revision: doc.revision }, host);
  if (saved.status === 200) doc = saved.body.document;
  // a store's first publish needs its home page, so the home page goes first
  const homeBody = R.emptyBody("home");
  const text = R.newSection("text", { id: "sec_h1" });
  homeBody.sections = [{ ...text, settings: { ...text.settings, title: "Welcome", body: ["Hello."] } }];
  const home = (await docs(caller, { createDocument: { type: "home", body: homeBody } }, host)).body?.document;
  if (home) await docs(caller, { publish: { id: home.id, draftHash: home.draftHash }, revision: home.revision }, host);
  const pub = await docs(caller, { publish: { id: doc.id, draftHash: doc.draftHash }, revision: doc.revision }, host);
  return { doc, published: pub.status === 200, publishText: pub.text };
}
const pageA = await ownerPage("owner", a.tenant.domains[0], "about", "About us");
const pageB = await ownerPage("owner-b", b.tenant.domains[0], "cnybdoc-slug", CNY.bDocument);

// offers: one in A, one in B (its title a canary)
const offerOf = (id, title, code) => ({ id, type: "COUPON", scope: "order", priority: 50, title, code, discount: { kind: "percent", value: 10 }, combinable: true });
const offerA = offerOf("coupon-supread", "SUPREAD10", "SUPREAD10");
const madeA = await call("owner", "offers", "POST", { body: { offer: offerA } });
const madeB = await call("owner-b", "offers", "POST", { body: { offer: offerOf("coupon-cnyb", CNY.bOffer, "CNYB10") }, host: b.tenant.domains[0] });

// P2-D: a bundle, an experiment and a quiz in A, so the dynamic pages and the
// quiz ?slug= probe read real rows
const bundleA = await call("owner", "bundles", "POST", { body: { create: { title: "Support pair", items: a.products.slice(0, 2).map((p) => ({ variantId: p.variants?.[0]?.id ?? p.variants?.nodes?.[0]?.id, quantity: 1 })), bundle_price: 250, enable: true, mustPass: true } } });
const experimentA = await call("owner", "experiments", "POST", { body: { experiment: { slug: "sup-exp", name: "Support experiment", hypothesis: "A shorter hero title sells more", target_kind: "hero", min_sample: 50, variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "Shorter", highlight: "", subtitle: "" } }] } } });
const quizA = await call("owner", "quiz", "POST", { body: { quiz: { slug: "sup-quiz", title: "Support quiz", intro: "", questions: [{ prompt: "Your goal?", options: [{ label: "Muscle", tags: ["muscle"] }, { label: "Energy", tags: ["energy"] }] }] } } });

// Phase 4 line 1: Trust badges and a fixture app with a secret setting in A,
// the fixture app in B (its greeting a canary)
const { registerPlugin } = await import("../lib/plugins/catalog.js");
registerPlugin({
  id: "sup-secret-app",
  name: "Support fixture app",
  version: "1.0.0",
  summary: "A fixture app.",
  description: "A fixture app with a secret setting.",
  icon: "Puzzle",
  author: { name: "Tests" },
  scopes: ["orders.read"],
  settings: [
    { key: "api_key", kind: "secret", label: "API key" },
    { key: "greeting", kind: "text", label: "Greeting", max: 40 },
  ],
});
const appA = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
const secretApp = await call("owner", "apps", "POST", { body: { install: { pluginId: "sup-secret-app", scopes: ["orders.read"] } } });
const secretSaved = await call("owner", "apps/[id]", "POST", { params: { id: secretApp.body?.install?.id }, body: { settings: { api_key: CNY.appSecret, greeting: "Hello" } } });
const appB = await call("owner-b", "apps", "POST", { body: { install: { pluginId: "sup-secret-app", scopes: ["orders.read"] } }, host: b.tenant.domains[0] });
await call("owner-b", "apps/[id]", "POST", { params: { id: appB.body?.install?.id }, body: { settings: { greeting: CNY.bApp } }, host: b.tenant.domains[0] });

// Phase 4 line 3: a custom app in A with a delivered order.created event for
// the fixture order (its secret a canary), and a custom app in B (its name a canary)
process.env.STOREASY_PLUGIN_EGRESS_LOCAL = "1";
process.env.NODE_ENV ||= "test"; // the local flag needs test or development
// the address's path is a canary: support sees the host only
const hookBody = (name) => ({ create_custom: { name, url: `http://127.0.0.1:9/${CNY.hookPath}/in`, topics: ["order.created"], scopes: ["orders.read"] } });
const hookA = await call("owner", "apps", "POST", { body: hookBody("Support webhook app") });
const hookB = await call("owner-b", "apps", "POST", { body: hookBody(CNY.bWebhookApp), host: b.tenant.domains[0] });
// the secret's longest letters-and-digits run, lower-cased (the search is case-blind)
CNY.webhookSecret = ((hookA.body?.secret ?? "").slice(6).match(/[A-Za-z0-9]+/g) ?? [""]).sort((x, y) => y.length - x.length)[0].toLowerCase();
SECRET_KEYS.push("webhookSecret");
// Phase 4 line 4: an API token on that app; its secret part and stored hash are canaries
const minted = await call("owner", "apps/[id]/tokens", "POST", { params: { id: hookA.body?.install?.id }, body: { create: { name: "Support probe token", scopes: ["orders.read"] } } });
CNY.appTokenSecret = String(minted.body?.secret ?? "").split(".")[1] ?? "";
CNY.appTokenHash = minted.body?.token?.id ? String((await a.run(async () => (await import("../lib/db.js")).db.selectFrom("plugin_tokens").select("secret_hash").where("id", "=", minted.body.token.id).executeTakeFirst()))?.secret_hash ?? "") : "";
SECRET_KEYS.push("appTokenSecret", "appTokenHash");
await a.run(async () => {
  const { emitOrderEvent, fanOut } = await import("../lib/plugins/events.js");
  const ev = await emitOrderEvent("order.created", ORDER_ID);
  if (ev) await fanOut(ev.id);
  const { db: tdb } = await import("../lib/db.js");
  await tdb.updateTable("plugin_deliveries").set({ status: "delivered", attempts: 1, last_status: 200, delivered_at: new Date().toISOString() }).execute();
});

// Phase 5 line 1: Aurora uploaded in A; a theme in B whose name and description are canaries
const auroraText = await readFile(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8");
const themeA = await call("owner", "themes", "POST", { body: JSON.parse(auroraText) });
const themeB = await call("owner-b", "themes", "POST", { body: { ...JSON.parse(auroraText), id: "cnyb-theme", name: CNY.bTheme, description: CNY.bTheme }, host: b.tenant.domains[0] });

// P5-A: an archived package in each store (A's under its own id, B's name a canary)
const archivedA = await call("owner", "themes", "POST", { body: { ...JSON.parse(auroraText), id: "archived-a", name: "Archived A" } });
const archivedB = await call("owner-b", "themes", "POST", { body: { ...JSON.parse(auroraText), id: "cnyb-archived", name: CNY.bArchivedTheme, description: CNY.bArchivedTheme }, host: b.tenant.domains[0] });
const archA = await call("owner", "themes/[id]", "POST", { params: { id: archivedA.body?.package?.id }, body: { archive: true } });
const archB = await call("owner-b", "themes/[id]", "POST", { params: { id: archivedB.body?.package?.id }, body: { archive: true }, host: b.tenant.domains[0] });
ok(archA.body?.package?.status === "archived" && archB.body?.package?.status === "archived", `fixture archived packages (${archA.text?.slice(0, 120)} | ${archB.text?.slice(0, 120)})`);

const CTX = {
  themeId: themeA.body?.package?.id ?? null,
  bThemeId: themeB.body?.package?.id ?? null,
  appId: appA.body?.install?.id ?? null,
  secretAppId: secretApp.body?.install?.id ?? null,
  webhookAppId: hookA.body?.install?.id ?? null,
  bWebhookAppId: hookB.body?.install?.id ?? null,
  docId: pageA.doc.id,
  bDocId: pageB.doc.id,
  bundleId: bundleA.body?.bundle?.id ?? null,
  experimentSlug: experimentA.body?.experiment?.slug ?? null,
  quizSlug: quizA.body?.quiz?.slug ?? null,
  collectionGid: a.collections?.[0]?.id ?? null,
  offerId: madeA.body?.offer?.id ?? offerA.id,
  offer: offerA,
  orderId: ORDER_ID,
  orderEmail: CNY.orderEmail,
  orderPhone: CNY.orderPhone,
  productGid: a.products?.[0]?.id ?? "gid://shopify/Product/9101",
  mediaId: media?.id ?? "med_missing",
  ownerSid: null, // set after the owner's own probes (its revoke probe would end it)
};

// sessions: every token is a canary for every other caller
const TOKENS = {
  ownerAdmin: cookies.owner._admin,
  adminAdmin: cookies.admin._admin,
  staffAdmin: cookies.staff._admin,
  supportAdmin: cookies.support._admin,
  ownerBAdmin: cookies["owner-b"]._admin,
  operatorPlatform: cookies["operator-support"]._platform,
  operatorSupport: cookies["operator-support-entry"]["__Host-support"], // Phase 3 line 5
  ownerPreviewToken: "",
};

// --- the search ----------------------------------------------------------------------
const variants = (v) => [...new Set([v, v.toLowerCase(), encodeURIComponent(v), encodeURIComponent(v).toLowerCase()])];
function leaks(text, { skip = [], tokens = TOKENS, emails = true } = {}) {
  const hay = String(text ?? "");
  const lower = hay.toLowerCase();
  const found = [];
  const all = { ...CNY, ...tokens };
  for (const [k, v] of Object.entries(all)) {
    if (skip.includes(k) || !v) continue;
    if (variants(v).some((x) => hay.includes(x) || lower.includes(x.toLowerCase()))) found.push(k);
  }
  if (emails && MEMBER_EMAIL.test(hay)) found.push(`member email ${hay.match(MEMBER_EMAIL)[0]}`);
  if (SECRET_KEY_NAMES.test(hay)) found.push(`key ${hay.match(SECRET_KEY_NAMES)[1]}`);
  return found;
}
// what an owner may see: everything but secrets, tokens other than its own, and store B
const OWNER_SKIP = Object.keys(CNY).filter((k) => !SECRET_KEYS.includes(k) && !k.startsWith("b"));

// --- the callers ------------------------------------------------------------------
const MERCHANT = ["owner", "admin", "staff", "support"];
const LEAST = MERCHANT.filter((r) => !roleAllows(r, "settings.read"));
// Phase 3 line 5: an operator under a grant on the same host (_platform) and
// across hosts (the __Host-support session) both act as support
const OPERATOR_SUPPORT = ["operator-support", "operator-support-entry"];
const roleOf = (caller) => (OPERATOR_SUPPORT.includes(caller) ? "support" : caller);
const CALLERS = [...LEAST, ...(LEAST.includes("support") ? OPERATOR_SUPPORT : [])];
// the roles that lose customer PII (lib/admin/order-view.js); the others keep it by design
const REDACTED = (caller) => roleOf(caller) === "support";
// (line 3: a webhook address's path is redacted with them)
const ORDER_PII = ["orderEmail", "orderPhone", "orderName", "orderAddress", "orderCity", "orderPincode", "orderSnapshot", "customerId", "hookPath"];
// a caller's own session token is not a leak to itself
const OWN_TOKEN = { owner: "ownerAdmin", admin: "adminAdmin", staff: "staffAdmin", support: "supportAdmin", "operator-support": "operatorPlatform", "operator-support-entry": "operatorSupport" };
const skipFor = (caller) => [...(REDACTED(caller) ? [] : ORDER_PII), OWN_TOKEN[caller]];

await t("setup: outside services blank, only file: databases, the fixture planted", () => {
  eq(secretSaved.status, 200, `the app secret saved: ${secretSaved.text?.slice(0, 200)}`);
  eq(appB.status, 200, `store B's app: ${appB.text?.slice(0, 200)}`);
  ok(CNY.webhookSecret.length >= 6 && hookB.status === 200, `the custom apps (line 3): ${hookA.text?.slice(0, 160)} | ${hookB.text?.slice(0, 160)}`);
  for (const [k, v] of Object.entries({ appId: CTX.appId, secretAppId: CTX.secretAppId, themeId: CTX.themeId, bThemeId: CTX.bThemeId, bundleId: CTX.bundleId, experimentSlug: CTX.experimentSlug, quizSlug: CTX.quizSlug, collectionGid: CTX.collectionGid, appTokenSecret: /^[0-9a-f]{64}$/.test(CNY.appTokenSecret), appTokenHash: /^[0-9a-f]{64}$/.test(CNY.appTokenHash) })) ok(v, `fixture ${k} (${bundleA.text?.slice(0, 120)} | ${experimentA.text?.slice(0, 120)} | ${quizA.text?.slice(0, 120)})`);
  for (const k of H.OUTSIDE_SERVICE_ENV) eq(process.env[k], "", k);
  for (const tn of [a, b, c, d]) F.assertLocalDbUrl(tn.tenant.dbUrl);
  eq(CALLERS.join(","), "staff,support,operator-support,operator-support-entry", "least-trusted callers, derived from roleAllows:");
  eq(madeA.status, 200, `offer A: ${madeA.text?.slice(0, 200)}`);
  eq(madeB.status, 200, `offer B: ${madeB.text?.slice(0, 200)}`);
  ok(!media.error, `media saved: ${media.error?.message}`);
  ok(pageA.published, `page A published: ${pageA.publishText?.slice(0, 300)}`);
  for (const [k, v] of Object.entries(CNY)) ok(/^[a-z0-9@.]+$/.test(v), `${k} is short lowercase ASCII`);
});

// --- positive controls: the owner sees what support must not ------------------------
await t("owner (positive control): Settings shows the config canaries, Team the emails, Audit the audit row", async () => {
  const s = await call("owner", "settings", "GET");
  eq(s.status, 200, "settings:");
  ok(s.text.includes(CNY.shopifyScopes) || s.text.includes(CNY.metaTestEventCode), `settings carries a config canary: ${s.text.slice(0, 200)}`);
  const team = await call("owner", "team", "GET");
  eq(team.status, 200, "team:");
  ok(MEMBER_EMAIL.test(team.text), "team lists member emails");
  const au = await call("owner", "audit", "GET");
  eq(au.status, 200, "audit:");
  ok(au.text.includes(CNY.auditResource), "audit shows the canary row");
  const o = await call("owner", "orders/[id]", "GET", { params: { id: ORDER_ID } });
  eq(o.body?.order?.email, CNY.orderEmail, "the owner sees the order's email:");
  const q = await call("owner", "orders", "GET", { query: `q=${encodeURIComponent(CNY.orderEmail)}` });
  eq(q.body?.orders?.length, 1, "the owner can search orders by email:");
});

await t("owner: no secret, cart credential or other store's data on any settings, team, audit or probe answer", async () => {
  const bad = [];
  const ownerTokens = { ...TOKENS, ownerAdmin: "", ownerPreviewToken: "" }; // its own
  for (const [path, opts] of [["settings", {}], ["team", {}], ["audit", {}], ["integrations", {}], ["privacy", {}], ["help", {}], ["domains", {}], ["billing", {}], ["automations", {}]]) {
    const r = await call("owner", path, "GET", opts);
    const found = leaks(r.text, { skip: OWNER_SKIP, tokens: ownerTokens, emails: false });
    if (found.length) bad.push(`GET ${path}: ${found.join(", ")}`);
  }
  for (const p of SUPPORT_PROBES) {
    const r = await call("owner", p.path, p.method, p.req?.(CTX) ?? {});
    const found = leaks(r.text, { skip: OWNER_SKIP, tokens: ownerTokens, emails: false });
    if (found.length) bad.push(`${p.name}: ${found.join(", ")}`);
  }
  eq(bad.join("\n"), "", "secrets reached the owner:");
});

// the owner's own preview session, which no other caller may end or change
const ownerPreview = await call("owner", "preview-session", "POST", { body: { create: true } });
CTX.ownerSid = ownerPreview.body?.sid;
TOKENS.ownerPreviewToken = ownerPreview.body?.token ?? "";
await t("owner: makes its own preview session", () => eq(ownerPreview.status, 200, `owner preview: ${ownerPreview.text?.slice(0, 200)}`));
// Phase 4 line 2: Trust badges installed, so the placements probe reads a real install
// (line 1's fixture may have installed it already: then its install is used)
const installed = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
CTX.installId = installed.body?.install?.id ?? (await call("owner", "apps", "GET")).body?.installs?.find((i) => i.pluginId === "trust-badges")?.id;
await t("owner: Trust badges is installed (the blocks probe's install)", () => ok(/^pin_[0-9a-f]{16}$/.test(String(CTX.installId)), `install: ${installed.text?.slice(0, 200)}`));

// --- every probe as every least-trusted caller -----------------------------------------
const results = {}; // caller -> probe name -> response
for (const caller of CALLERS) {
  results[caller] = {};
  for (const p of SUPPORT_PROBES) results[caller][p.name] = await call(caller, p.path, p.method, p.req?.(CTX) ?? {});
}

for (const caller of CALLERS) {
  await t(`${caller}: every probe answers its status with only its listed top-level keys`, () => {
    const bad = [];
    for (const p of SUPPORT_PROBES) {
      const r = results[caller][p.name];
      if (r.status !== (p.status ?? 200)) bad.push(`${p.name}: status ${r.status} ${r.text.slice(0, 160)}`);
      const extra = Object.keys(r.body ?? {}).filter((k) => !p.keys.includes(k));
      if (extra.length) bad.push(`${p.name}: unlisted keys ${extra.join(",")} (has ${Object.keys(r.body ?? {}).join(",")})`);
      for (const [k, allowed] of Object.entries(p.inner || {})) {
        const v = r.body?.[k];
        const more = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).filter((x) => !allowed.includes(x)) : [];
        if (more.length) bad.push(`${p.name}: unlisted ${k} keys ${more.join(",")}`);
      }
    }
    eq(bad.join("\n"), "", "");
  });
  await t(`${caller}: no canary in any probe's raw answer`, () => {
    const bad = [];
    for (const p of SUPPORT_PROBES) {
      const found = leaks(results[caller][p.name].text, { skip: skipFor(caller) });
      if (found.length) bad.push(`${p.name}: ${found.join(", ")}`);
    }
    eq(bad.join("\n"), "", "");
  });
}

// every read a least-trusted role is allowed has at least one probe here
await t("guard: every admin-routes.js read row a least-trusted role is allowed has a probe in support-reads.js", async () => {
  const { ADMIN_ROUTES } = await import("./support/admin-routes.js");
  const reads = ADMIN_ROUTES.filter((r) => (r.method === "GET" || r.crossOrigin === "read") && LEAST.some((role) => roleAllows(role, r.action)));
  ok(reads.length >= 30, `${reads.length} read rows`);
  const missing = reads.filter((r) => !SUPPORT_PROBES.some((p) => p.path === r.path && p.method === r.method && (!r.variant || p.variant === r.variant)));
  eq(missing.map((r) => `${r.method} ${r.path}${r.variant ? ` (${r.variant})` : ""}`).join(", "), "", "read rows without a probe:");
});

// --- staff's allowed writes and every denied row's refusal --------------------------------
await t("staff writes: offers POST, documents create/save (and a stale save's 409 current), returns POST answer without a canary", async () => {
  const bad = [];
  const check = (label, r, status) => {
    if (status && r.status !== status) bad.push(`${label}: status ${r.status} ${r.text.slice(0, 160)}`);
    const found = leaks(r.text, { skip: skipFor("staff") });
    if (found.length) bad.push(`${label}: ${found.join(", ")}`);
  };
  check("offers POST", await call("staff", "offers", "POST", { body: { offer: offerOf("coupon-staff", "STAFF10", "STAFF10") } }), 200);
  const created = await call("staff", "documents", "PUT", { body: { createDocument: { type: "page", meta: { slug: "staff-page", title: "Staff page" } } } });
  check("documents createDocument", created, 200);
  const doc = created.body?.document;
  if (doc) check("documents saveDraft", await call("staff", "documents", "PUT", { body: { saveDraft: { id: doc.id, body: doc.body }, revision: doc.revision } }), 200);
  // the owner saved and published page A last, so a stale save as staff names the owner
  const current = (await call("owner", "documents", "PUT", { body: { getDocument: CTX.docId } })).body?.document;
  const stale = await call("staff", "documents", "PUT", { body: { saveDraft: { id: CTX.docId, body: current.body }, revision: current.revision - 1 } });
  check("documents stale saveDraft", stale, 409);
  ok(stale.body?.current && "updatedByName" in stale.body.current, `the 409 carries current.updatedByName: ${stale.text.slice(0, 200)}`);
  check("returns POST", await call("staff", "returns", "POST", { body: { id: "ret_supread1", action: "approve" } }), 200);
  eq(bad.join("\n"), "", "");
});

await t("denied rows: every refusal a least-trusted caller gets carries no canary", async () => {
  const { ADMIN_ROUTES } = await import("./support/admin-routes.js");
  const bad = [];
  for (const caller of CALLERS) {
    const role = roleOf(caller);
    for (const r of ADMIN_ROUTES.filter((x) => !roleAllows(role, x.action))) {
      const res = await call(caller, r.path, r.method, r.probe ?? {});
      if (res.status !== 403) bad.push(`${caller} ${r.method} ${r.path} ${r.variant ?? ""}: status ${res.status}`);
      const found = leaks(res.text, { skip: skipFor(caller) });
      if (found.length) bad.push(`${caller} ${r.method} ${r.path} ${r.variant ?? ""}: ${found.join(", ")}`);
    }
  }
  eq(bad.join("\n"), "", "");
});

// --- per-route checks ------------------------------------------------------------------
await t("S4 orders: a PII-redacted caller's ?q= matches order ids only, never email or phone", async () => {
  for (const caller of CALLERS.filter(REDACTED)) {
    eq(results[caller]["orders ?q=<email>"].body?.orders?.length, 0, `${caller} by email:`);
    eq(results[caller]["orders ?q=<phone>"].body?.orders?.length, 0, `${caller} by phone:`);
    const byId = await call(caller, "orders", "GET", { query: `q=${ORDER_ID.slice(3)}` });
    eq(byId.body?.orders?.length, 1, `${caller} by order id:`);
  }
});

await t("orders/[id] (S5): PII and snapshot null with pii_redacted for support; cart_id and idempotency_key absent for every role", async () => {
  for (const caller of ["support", ...OPERATOR_SUPPORT]) {
    const o = results[caller]["orders/[id]"].body?.order;
    for (const k of ["email", "phone", "name", "address_line1", "city", "pincode", "snapshot"]) eq(o?.[k], null, `${caller} ${k}:`);
    eq(o?.pii_redacted, true, `${caller} pii_redacted:`);
    eq(o?.total, 500, `${caller} keeps the money:`);
  }
  for (const caller of MERCHANT) {
    const r = await call(caller, "orders/[id]", "GET", { params: { id: ORDER_ID } });
    eq(r.status, 200, `${caller}:`);
    for (const k of ["cart_id", "idempotency_key"]) ok(!(k in (r.body?.order ?? {})), `${caller} gets no ${k}`);
    ok(!r.text.includes(CNY.cartId) && !r.text.includes(CNY.idempotencyKey), `${caller}: neither value in the text`);
  }
});

// support's order: every key it may carry, and what each event's meta may say
const SUPPORT_ORDER_KEYS = [
  "id", "status", "payment_method", "payment_status", "total", "subtotal", "discount_total", "shipping_total", "currency",
  "coupon_code", "applied_offers", "appliedOffers", "razorpay_order_id", "razorpay_payment_id", "shopify_order_id",
  "sync_attempts", "sync_error", "created_at", "updated_at", "paid_at", "synced_at", "items", "events", "pii_redacted",
  "financial_status", "fulfillment_status", "refunded_total", "provider_updated_at", "redacted_at",
  // nulled for support (lib/admin/order-view.js PII_FIELDS, snapshot)
  "email", "phone", "name", "address_line1", "address_line2", "city", "state", "pincode", "country", "customer_id", "snapshot",
];
const ORDER_EVENT_KEYS = ["id", "order_id", "from_status", "to_status", "meta", "created_at"];
// every meta key the state machine writes (lib/orders.js, order-cancel.js, order-projection.js)
const EVENT_META_KEYS = [
  "payment_method", "razorpay_order_id", "razorpay_payment_id", "source", "webhook_event_id", "attempt", "shopify_order_id", "error",
  "reason", "via", "shopify_already_cancelled", "razorpay_refund_id", "refunded_amount", "shopify_cancelled_at", "write_id",
];
await t("orders/[id] for support: only listed order keys, customer_id null, payment ids and coupon kept, events and their meta listed and canary-free", () => {
  for (const caller of CALLERS.filter(REDACTED)) {
    const o = results[caller]["orders/[id]"].body?.order ?? {};
    const extra = Object.keys(o).filter((k) => !SUPPORT_ORDER_KEYS.includes(k));
    eq(extra.join(","), "", `${caller} unlisted order keys (has ${Object.keys(o).join(",")}):`);
    eq(o.customer_id, null, `${caller} customer_id:`);
    eq([o.razorpay_order_id, o.razorpay_payment_id, o.coupon_code].join(","), "order_supread1,pay_supread1,SUPREAD10", `${caller} keeps payment ids and coupon:`);
    ok(o.events?.length === 2, `${caller} sees the fixture events`);
    for (const e of o.events ?? []) {
      eq(Object.keys(e).filter((k) => !ORDER_EVENT_KEYS.includes(k)).join(","), "", `${caller} event keys:`);
      eq(Object.keys(e.meta ?? {}).filter((k) => !EVENT_META_KEYS.includes(k)).join(","), "", `${caller} event meta keys:`);
      eq(leaks(JSON.stringify(e.meta), { skip: skipFor(caller) }).join(","), "", `${caller} event meta canaries:`);
    }
  }
});

await t("S3 documents: history and recent publishes name nobody by email (support and the owner alike)", async () => {
  for (const caller of [...CALLERS, "owner"]) {
    const h = await call(caller, "documents", "PUT", { body: { listHistory: CTX.docId } });
    eq(h.status, 200, `${caller} history:`);
    ok(h.body.versions.length > 0, `${caller} sees versions`);
    for (const v of h.body.versions) ok(!MEMBER_EMAIL.test(v.by), `${caller} history by "${v.by}"`);
    ok(h.body.versions.some((v) => v.by === "Someone on your team"), `${caller}: the nameless owner reads "Someone on your team": ${JSON.stringify(h.body.versions.map((v) => v.by))}`);
    const rp = await call(caller, "documents", "PUT", { body: { listRecentlyPublished: true } });
    eq(rp.status, 200, `${caller} recent:`);
    ok(!MEMBER_EMAIL.test(rp.text), `${caller} recent publishes carry no member email`);
  }
});

await t("media: listings and usage carry no file bytes", () => {
  for (const caller of CALLERS) {
    for (const m of results[caller]["media ?archived=include"].body?.media ?? []) ok(!("data" in m), `${caller} media item has no data`);
    ok(!results[caller]["media PUT usage"].text.includes("cnymediablob0"), `${caller} usage has no bytes`);
    ok(!results[caller]["media ?archived=include"].text.includes("cnymediablob0"), `${caller} list has no bytes`);
  }
  ok((results.support["media ?archived=include"].body?.media ?? []).some((m) => m.id === CTX.mediaId), "the fixture media is listed");
});

await t("preview-session: a read-only caller makes only its own links; the owner's session can't be ended or changed by it", async () => {
  for (const caller of CALLERS) {
    const mine = results[caller]["preview-session create"];
    ok(mine.body?.token && mine.body.token !== TOKENS.ownerPreviewToken, `${caller} gets its own token`);
    eq(results[caller]["preview-session revoke (owner's)"].body?.code, "PREVIEW_SESSION_NOT_FOUND", `${caller} revoke:`);
    eq(results[caller]["preview-session showDesign (owner's)"].body?.code, "PREVIEW_SESSION_NOT_FOUND", `${caller} showDesign:`);
  }
  const still = await call("owner", "preview-session", "POST", { body: { showDesign: { sid: CTX.ownerSid, on: false } } });
  eq(still.status, 200, `the owner's session is still live: ${still.text.slice(0, 200)}`);
});

await t("stores: support gets exactly A and C (never B or suspended D), each entry only {id,name,role,url,current}", () => {
  const ids = (r) => (r.body?.stores ?? []).map((s) => s.id).sort().join(",");
  eq(ids(results.support.stores), [a.id, c.id].sort().join(","), "support:");
  eq(ids(results.staff.stores), a.id, "staff:");
  for (const caller of OPERATOR_SUPPORT) eq(ids(results[caller].stores), "", `${caller} (an operator under a grant):`);
  for (const caller of CALLERS) for (const s of results[caller].stores.body?.stores ?? []) eq(Object.keys(s).sort().join(","), "current,id,name,role,url", `${caller} entry keys:`);
});

await t("returns, onboarding, releases: no customer fields and no emails", () => {
  for (const caller of CALLERS) {
    const rows = results[caller].returns.body?.returns ?? [];
    eq(rows.length, 1, `${caller} sees the fixture return:`);
    // P2-B: the shopper's reason and note are customer details, so a redacted caller gets them null
    const keys = `created_at,currency,id,note,order_id,${REDACTED(caller) ? "pii_redacted," : ""}reason,refunded_total,status,total,updated_at`;
    for (const row of rows) eq(Object.keys(row).sort().join(","), keys, `${caller} return keys:`);
    if (REDACTED(caller)) for (const row of rows) eq(JSON.stringify([row.reason, row.note]), "[null,null]", `${caller} return free text:`);
    for (const name of ["returns", "onboarding", "releases", "releases preview"]) {
      const txt = results[caller][name].text;
      ok(!MEMBER_EMAIL.test(txt) && !txt.includes(CNY.orderEmail) && !txt.includes(CNY.orderPhone), `${caller} ${name}`);
    }
  }
});

// --- console pages: the table, the gates, the prop sweep ---------------------------------
const PAGES_DIR = join(ROOT, "app/(console)/admin/(authed)");
async function pageFiles(dir) {
  const out = [];
  for (const f of await readdir(dir)) {
    const p = join(dir, f);
    if ((await stat(p)).isDirectory()) out.push(...(await pageFiles(p)));
    else if (f === "page.js") out.push(relative(PAGES_DIR, dirname(p)).split("\\").join("/"));
  }
  return out;
}
const pageRel = (page) => `app/(console)/admin/(authed)/${page ? `${page}/` : ""}page.js`;

await t("pages: every console page has a row in admin-pages.js, every row a page, every action is in ACTIONS", async () => {
  const files = (await pageFiles(PAGES_DIR)).sort();
  const rows = ADMIN_PAGES.map((r) => r.page).sort();
  eq(files.filter((f) => !rows.includes(f)).join(","), "", "pages without a row:");
  eq(rows.filter((r) => !files.includes(r)).join(","), "", "rows without a page:");
  eq(new Set(rows).size, rows.length, "rows unique:");
  for (const r of ADMIN_PAGES) ok(ACTIONS.includes(r.action), `${r.page} action ${r.action}`);
  // 18 since Phase 1 line 10 removed the 14 redirect-only pages
  ok(files.length >= 18, `walked ${files.length} pages`);
});

// a page's gate: roleAllows(actor.role, "<action>") before any data read
async function gateProblem(r) {
  const src = await readFile(join(ROOT, pageRel(r.page)), "utf8");
  const gate = src.indexOf(`roleAllows(actor.role, "${r.action}")`);
  const actorAt = src.indexOf("adminActor(");
  // the actor line is `await tfetch(() => adminActor(…))`, so the next tfetch( is the first data read
  const firstData = src.indexOf("tfetch(", actorAt);
  const actorEnd = src.indexOf("\n", actorAt);
  if (gate < 0) return `${r.page}: no roleAllows(actor.role, "${r.action}")`;
  if (firstData >= 0 && firstData < gate) return `${r.page}: tfetch( before its gate`;
  // nor a direct awaited call (a lib read outside tfetch) between the actor and the gate
  if (/\bawait\b/.test(src.slice(actorEnd, gate))) return `${r.page}: an await before its gate`;
  return null;
}

await t("S2 pages: every page a least-trusted role may not read checks roleAllows(actor.role, action) before its data", async () => {
  const bad = [];
  for (const r of ADMIN_PAGES) {
    if (LEAST.every((role) => roleAllows(role, r.action))) continue;
    const problem = await gateProblem(r);
    if (problem) bad.push(problem);
  }
  eq(bad.join("\n"), "", "");
});

// P2-F: a page whose data needs more than storefront.read (which every console
// role holds) is gated in its own source even while every role holds its action,
// so taking the action from a role later closes the page too
await t("P2-F guard: every page whose row action isn't storefront.read checks roleAllows(actor.role, action) before its data", async () => {
  const bad = [];
  for (const r of ADMIN_PAGES.filter((x) => x.action !== "storefront.read")) {
    const problem = await gateProblem(r);
    if (problem) bad.push(problem);
  }
  eq(bad.join("\n"), "", "");
});

const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });

// P2-F: the gate's NoAccess branch, rendered: a roleAllows that withholds
// orders.read from every role, so even the owner gets the no-access page on
// Analytics and the page reads none of its data
await t("P2-F analytics: a role without orders.read gets NoAccess (page words) and no analytics data", async () => {
  const gated = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }), stubs: { "@/lib/platform/authz": { roleAllows: (role, action) => action !== "orders.read" && roleAllows(role, action) } } });
  const run = await gated.run(pageRel("analytics"), { cookies: cookies.owner });
  ok(!run.error && !run.redirect, `ran: ${run.error?.message} ${run.redirect}`);
  const names = [...new Set(run.props.map((p) => p.component))];
  const na = run.props.find((p) => p.component.endsWith("#NoAccess"));
  ok(na && na.props.page === true && na.props.role === "owner", `NoAccess with page words: ${names.join(",")}`);
  ok(!names.some((n) => /SalesNumbers|FunnelCard|AnalyticsTables|CoverageNote/.test(n)), `no analytics data: ${names.join(",")}`);
  const open = await pages.run(pageRel("analytics"), { cookies: cookies.owner });
  ok(open.props.some((p) => p.component.endsWith("#SalesNumbers")) && !open.props.some((p) => p.component.endsWith("#NoAccess")), "the real roleAllows lets the owner in:");
});
const pageRuns = {};
for (const r of ADMIN_PAGES) {
  // "$order", "$offer", "$bundle", "$experiment" and "$quiz" are the fixture's rows (P2-D)
  const FIXTURE = { $order: ORDER_ID, $offer: CTX.offerId, $bundle: CTX.bundleId, $experiment: CTX.experimentSlug, $quiz: CTX.quizSlug, $app: CTX.appId, $theme: CTX.themeId };
  const params = Object.fromEntries(Object.entries(r.params ?? {}).map(([k, v]) => [k, v in FIXTURE ? FIXTURE[v] : v]));
  pageRuns[r.page] = await pages.run(pageRel(r.page), { cookies: cookies.support, params });
}

await t("page sweep: every console page runs as support (a page, a redirect or a not-found, never a crash)", () => {
  const bad = Object.entries(pageRuns)
    .filter(([, run]) => run.error)
    .map(([page, run]) => `${page}: ${String(run.error?.message || run.error).split("\n")[0].slice(0, 200)}`);
  eq(bad.join("\n"), "", "");
  // an import the harness could not give a page fails the sweep, even one the page caught
  eq(Object.values(pageRuns).flatMap((run) => run.unresolved).join("\n"), "", "unresolved imports:");
  const rendered = Object.entries(pageRuns).filter(([, run]) => run.props.length).map(([p]) => p);
  const other = Object.entries(pageRuns).filter(([, run]) => !run.props.length).map(([p, run]) => `${p} (${run.redirect ? `redirect ${run.redirect}` : run.notFound ? "not found" : "empty"})`);
  ok(rendered.length >= 15, `most pages rendered props: ${rendered.length}; not: ${other.join(", ")}`);
  // P2-D: the dynamic pages read the fixture's rows, so support gets the page itself
  const dynamic = ADMIN_PAGES.filter((r) => Object.values(r.params ?? {}).some((v) => String(v).startsWith("$"))).map((r) => r.page);
  eq(dynamic.sort().join(","), "apps/[id],bundles/[id],experiments/[slug],offers/[id],orders/[id],quizzes/[slug],themes/[id]", "dynamic rows on fixture ids:");
  eq(dynamic.filter((p) => pageRuns[p].notFound || pageRuns[p].redirect || !pageRuns[p].props.length).join(","), "", "dynamic pages that did not render:");
});

await t("page sweep (S1, S2): no prop on any console page holds a canary for support", () => {
  const bad = [];
  for (const [page, run] of Object.entries(pageRuns)) {
    // support's own email is its own (the onboarding page names the signed-in
    // member); every other member's email still counts
    const found = leaks(run.text.replaceAll(users.support.email, ""), { skip: skipFor("support") });
    if (found.length) bad.push(`${page}: ${found.join(", ")}`);
  }
  eq(bad.join("\n"), "", "");
});

await t("P5-A archived themes: support and operator support see only A's archived package, on the route and the page, never B's canary", async () => {
  for (const caller of ["support", "operator-support"]) {
    const r = results[caller]["themes ?status=archived"];
    eq(r.status, 200, `${caller} status:`);
    eq((r.body?.packages ?? []).map((p) => p.name).join(","), "Archived A", `${caller} archived list:`);
    ok(!r.text.includes(CNY.bArchivedTheme), `${caller} archived list has no B canary`);
  }
  for (const [caller, jar] of [["support", cookies.support], ["operator-support-entry", cookies["operator-support-entry"]]]) {
    const run = await pages.run(pageRel("themes"), { cookies: jar, searchParams: { status: "archived" } });
    ok(!run.error && !run.redirect && !run.notFound && run.props.length, `${caller} archived page renders`);
    ok(run.text.includes("Archived A"), `${caller} archived page shows A's archived theme`);
    ok(!run.text.includes(CNY.bArchivedTheme), `${caller} archived page has no B canary`);
  }
});

// P7-B: a flagship's detail page is read-only for support. The page harness
// returns props, not markup, so the controls (ApplyThemeDialog and the Archive
// dialog, both gated on the role prop by RoleGate) are checked through what the
// page hands them: the support role, no Archive for a flagship, and no
// use/update/archive action strings anywhere in what it sends the browser.
await t("P7-B flagship detail (/admin/themes/bloom): support and operator support render it read-only", async () => {
  const own = await pages.run(pageRel("themes/[id]"), { cookies: cookies.owner, params: { id: "bloom" } });
  ok(/\brole owner\b/.test(own.text), "positive control: the owner's page is handed role owner");
  for (const caller of ["support", "operator-support-entry"]) {
    const run = await pages.run(pageRel("themes/[id]"), { cookies: cookies[caller], params: { id: "bloom" } });
    ok(!run.error && !run.redirect && !run.notFound && run.props.length, `${caller} flagship detail renders (200)`);
    ok(run.text.includes("Bloom"), `${caller} detail names Bloom`);
    ok(/\brole support\b/.test(run.text) && !/\brole (owner|admin|staff)\b/.test(run.text), `${caller} page is handed the support role`);
    const all = `${run.text}\n${JSON.stringify(run.props)}`;
    ok(!/data-themes-action["':= \\]*(use|update|archive)\b/.test(all), `${caller} has no use, update or archive control`);
    ok(!/Archive theme|Use this theme|Update to /.test(all), `${caller} has no Archive, Use or Update words`);
    const actions = [...all.matchAll(/data-themes-action["':= \\]*([a-z-]+)/g)].map((m) => m[1]);
    ok(actions.every((x) => ["download", "details", "flagship-preview"].includes(x)), `${caller} only read-controls: ${actions.join(",")}`);
  }
});

// P6-A: store B's real document id, asked of store A's studio, opens home with the missing note
await t("studio page: store B's document id opens A's home with the missing note and no B text", async () => {
  ok(CTX.bDocId && CTX.bDocId !== CTX.docId, "fixture bDocId");
  for (const caller of ["support", "operator-support-entry"]) {
    const run = await pages.run(pageRel("studio"), { cookies: cookies[caller], searchParams: { doc: CTX.bDocId } });
    ok(!run.error && !run.redirect && !run.notFound && run.props.length, `${caller} studio renders`);
    const all = `${run.text}\n${JSON.stringify(run.props)}`;
    ok(all.includes("doc_home"), `${caller} studio opens doc_home`);
    ok(all.includes("so the editor opened your home page"), `${caller} missing note shows`);
    ok(!all.includes(CTX.bDocId), `${caller} studio has no B document id`);
    ok(!all.includes(CNY.bDocument), `${caller} studio has no B canary`);
  }
});

// Phase 3 line 5: the operator's cross-host support session (__Host-support) opens
// every console page as support does: rendered, and no canary in any prop
await t("page sweep (line 5): every console page runs as operator-support-entry, renders, and no prop holds a canary", async () => {
  const bad = [];
  let rendered = 0;
  for (const r of ADMIN_PAGES) {
    const params = Object.fromEntries(Object.entries(r.params ?? {}).map(([k, v]) => [k, v === "$order" ? ORDER_ID : v === "$app" ? CTX.appId : v === "$theme" ? CTX.themeId : v]));
    const run = await pages.run(pageRel(r.page), { cookies: cookies["operator-support-entry"], params });
    if (run.error) bad.push(`${r.page}: ${String(run.error?.message || run.error).split("\n")[0].slice(0, 200)}`);
    if (run.redirect === "/admin/login") bad.push(`${r.page}: sent to the sign-in (the __Host-support session was not accepted)`);
    if (run.props.length) rendered++;
    const found = leaks(run.text, { skip: skipFor("operator-support-entry") });
    if (found.length) bad.push(`${r.page}: ${found.join(", ")}`);
  }
  eq(bad.join("\n"), "", "");
  ok(rendered >= 15, `most pages rendered props: ${rendered}`);
});

await t("S2 pages: every settings tab, Integrations and Billing show support and staff only the no-access page (Phase 2 line 7), Automations its PermissionNote, and none of their data", async () => {
  const NEW_UI = ADMIN_PAGES.map((r) => r.page).filter((p) => p === "settings" || p.startsWith("settings/") || p === "integrations" || p === "billing");
  ok(NEW_UI.length >= 12 && NEW_UI.includes("settings/team"), `the settings, integrations and billing pages (${NEW_UI.join(",")}):`);
  for (const role of LEAST) {
    for (const page of NEW_UI) {
      const run = role === "support" ? pageRuns[page] : await pages.run(pageRel(page), { cookies: cookies[role] });
      ok(!run.error, `${role} ${page}: ${run.error?.message}`);
      const names = [...new Set(run.props.map((p) => p.component))];
      // the no-access page and nothing else: no form, list or panel that could carry data.
      // settings/team is line 8's page with line 8's own no-access part (TeamNoAccess, no props)
      const team = page === "settings/team";
      eq(JSON.stringify(names), JSON.stringify([team ? "@/components/admin/team/TeamPage#TeamNoAccess" : "@/components/admin/settings/NoAccess#NoAccess"]), `${role} ${page} components:`);
      eq(JSON.stringify(run.props[0].props), JSON.stringify(team ? {} : { role }), `${role} ${page} hands its no-access page ${team ? "nothing" : "only the role"}:`);
      const found = leaks(run.text, { skip: skipFor(role) });
      eq(found.join(","), "", `${role} ${page} canaries:`);
    }
    const run = role === "support" ? pageRuns.automations : await pages.run(pageRel("automations"), { cookies: cookies[role] });
    ok(!run.error, `${role} automations: ${run.error?.message}`);
    const names = run.props.map((p) => p.component);
    ok(names.some((n) => n.endsWith("#PermissionNote")), `${role} automations shows a PermissionNote: ${names.join(",")}`);
    ok(!names.some((n) => n.includes("AutomationsAdmin")), `${role} automations renders no AutomationsAdmin`);
    eq(leaks(run.text, { skip: skipFor(role) }).join(","), "", `${role} automations canaries:`);
  }
  // the refusal sentence itself (the no-access page's words, naming the role)
  const { NO_ACCESS_WORDS } = await import("../lib/admin/settings-sections.js");
  for (const role of LEAST) ok(/^Your role \(\w+\) can't open settings, integrations or billing; ask an owner or admin/.test(NO_ACCESS_WORDS.body(role)) && NO_ACCESS_WORDS.body(role).includes(`(${role})`), `${role}'s refusal sentence`);
});

await t("onboarding (Phase 1 line 1): support reads the Welcome page with its own email only; an operator's support session gets no account", async () => {
  const welcome = (run) => run.props.find((p) => p.component.endsWith("onboarding/Welcome") || p.component.includes("Welcome"))?.props;
  const s = welcome(pageRuns.onboarding);
  ok(s, `support's onboarding renders Welcome: ${pageRuns.onboarding.props.map((p) => p.component).join(",")}`);
  eq(s.address, a.tenant.domains[0], "the store's address:");
  ok(typeof s.storeName === "string" && s.storeName.length > 0, "the store's name");
  eq(s.account?.email, users.support.email, "support sees only its own email:");
  for (const role of ["owner", "admin", "staff"]) ok(!pageRuns.onboarding.text.includes(users[role].email), `no ${role} email in support's props`);
  eq(Object.keys(s).sort().join(","), "account,address,open,storeName", "Welcome's props:");
  const op = await pages.run(pageRel("onboarding"), { cookies: cookies["operator-support"] });
  ok(!op.error, `operator support: ${op.error?.message}`);
  eq(welcome(op)?.account, null, "an operator's support session has no account on the page:");
});

await t("onboarding (Phase 1 line 3): support's page gets the four steps with every action disabled and a reason, no Shopify domain, and opens on ?step= when it is a real step", async () => {
  const steps = (run) => run.props.find((p) => p.component.includes("onboarding/Onboarding"))?.props;
  const s = steps(pageRuns.onboarding);
  ok(s, `support's onboarding renders Onboarding: ${pageRuns.onboarding.props.map((p) => p.component).join(",")}`);
  eq(s.initial.steps.map((x) => x.id).join(","), "connect,import,brand,open", "the steps:");
  const acts = s.initial.steps.flatMap((x) => x.actions);
  ok(acts.every((a) => a.allowed === false && typeof a.reason === "string" && a.reason.length > 0), `every action disabled with a reason: ${JSON.stringify(acts)}`);
  ok(!Object.hasOwn(s.initial.steps[0].facts, "shopDomain"), "no shop domain for support");
  eq(s.canSync, false, "support can't run a sync:");
  eq(s.initialStep, s.initial.current, "no ?step: the first step not done:");
  const brand = await pages.run(pageRel("onboarding"), { cookies: cookies.support, searchParams: { step: "brand" } });
  eq(steps(brand)?.initialStep, "brand", "?step=brand:");
  const junk = await pages.run(pageRel("onboarding"), { cookies: cookies.support, searchParams: { step: "nope" } });
  eq(steps(junk)?.initialStep, s.initial.current, "an unknown ?step is ignored:");
});

await t("page sweep (positive control): the owner's Settings (Tracking) and Orders pages do carry their canaries", async () => {
  // Phase 2 line 7: the test event code lives on the Tracking tab
  const s = await pages.run(pageRel("settings/tracking"), { cookies: cookies.owner });
  ok(!s.error, `owner settings/tracking: ${s.error?.message}`);
  ok(s.text.includes(CNY.metaTestEventCode), "the owner's Tracking props carry the test event code canary");
  const o = await pages.run(pageRel("orders"), { cookies: cookies.owner });
  ok(o.text.includes(CNY.orderEmail), "the owner's orders props carry the order email");
  ok(!o.text.includes(CNY.cartId), "but never the cart id");
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

for (const tn of [c, d]) await tn.cleanup();
await store.cleanup();
await F.removeFixtureFiles("sup");
const { rm } = await import("node:fs/promises");
for (const f of [".test-sup-default.db", ".test-sup-default.db-wal", ".test-sup-default.db-shm"]) await rm(join(ROOT, f), { force: true });

console.log(`\n${SUPPORT_PROBES.length} probes × ${CALLERS.length} callers, ${ADMIN_PAGES.length} pages`);
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
