// Offer definitions. Targets reference REAL BeastLife catalog attributes
// (verified: tag "Whey" → 14 protein tubs ₹3,499–3,949; BCAA Mango is a single
// ₹499 supplement). Adding an offer = adding an entry here.
export const OFFERS = [
  {
    id: "bxgy-bcaa-mango",
    type: "BXGY",
    title: "Buy 2 Get 1 Free · Beast Recovery BCAA (Mango)",
    target: { kind: "handle", value: "beast-recovery-bcaa-mango-120g" },
    buy: 2,
    free: 1,
  },
  {
    id: "tiered-whey",
    type: "TIERED_QTY",
    title: "Whey — buy more, save more",
    target: { kind: "tag", value: "Whey" },
    tiers: [
      { minQty: 2, percent: 5 },
      { minQty: 3, percent: 10 },
    ],
  },
];
