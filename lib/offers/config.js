// Offer definitions. Targets reference REAL BeastLife catalog attributes.
// `scope` drives the stacking phases (line → order → gift); `priority` orders
// within a phase; `combinable` (coupons) controls conflict resolution.
export const OFFERS = [
  // ---- line / product offers ----
  {
    id: "bxgy-bcaa-mango",
    type: "BXGY",
    scope: "line",
    priority: 20,
    title: "Buy 2 Get 1 Free · Beast Recovery BCAA (Mango)",
    target: { kind: "handle", value: "beast-recovery-bcaa-mango-120g" },
    buy: 2,
    free: 1,
  },
  {
    id: "tiered-whey",
    type: "TIERED_QTY",
    scope: "line",
    priority: 30,
    title: "Whey — buy more, save more",
    target: { kind: "tag", value: "Whey" },
    tiers: [
      { minQty: 2, percent: 5 },
      { minQty: 3, percent: 10 },
    ],
  },

  // ---- gift offer (derived line, never stored → trap-safe) ----
  {
    id: "free-gift-shaker",
    type: "FREE_GIFT",
    scope: "gift",
    priority: 40,
    title: "Free Shaker on orders over ₹1,499",
    threshold: 1499, // gated on the PRE-discount paid subtotal
    gift: {
      variantId: "gid://shopify/ProductVariant/48656508289241",
      productId: "gid://shopify/Product/9728789905625",
      handle: "beastlife-plastic-bold-shaker-neon-color-500ml-gift",
      title: "BeastLife Plastic Bold Shaker · Neon 500ML",
      image: "https://cdn.shopify.com/s/files/1/0690/7723/7977/files/PlasticShakerNeon.jpg?v=1737448220",
      value: 315,
    },
  },

  // ---- coupons (order scope; applied to the post-line-discount subtotal) ----
  {
    id: "coupon-beast10",
    type: "COUPON",
    scope: "order",
    priority: 50,
    code: "BEAST10",
    title: "BEAST10 · 10% off",
    discount: { kind: "percent", value: 10 },
    combinable: true,
  },
  {
    id: "coupon-flat200",
    type: "COUPON",
    scope: "order",
    priority: 50,
    code: "FLAT200",
    title: "FLAT200 · ₹200 off",
    discount: { kind: "fixed", value: 200 },
    minSubtotal: 999,
    combinable: true,
  },
  {
    id: "coupon-solo25",
    type: "COUPON",
    scope: "order",
    priority: 50,
    code: "SOLO25",
    title: "SOLO25 · 25% off (exclusive)",
    discount: { kind: "percent", value: 25 },
    minSubtotal: 1499,
    combinable: false, // exclusive — suppresses other offers, applies to full subtotal
  },
];
