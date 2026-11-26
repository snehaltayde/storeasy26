// The Storeasy landing page's words (platform home, components/site/MarketingHome.js).
// Every claim names where it comes from: `ticked` is a substring of a ticked
// ("- [x]") line in docs/FEATURES.md, `file` a source file that does it.
// scripts/test-marketing.js holds both to the repo and runs every visible
// string here through scanText (lib/copy/banned-copy.js). Plain data: no JSX,
// no imports, so the suite reads it in plain Node.

// The hero's bill and the calculator share these lines: the kinds of app a
// Shopify store adds one by one. No prices: the founder types their own.
export const STACK = [
  { id: "ratings", label: "Product ratings app", built: "Verified-buyer ratings" },
  { id: "subscriptions", label: "Subscriptions app", built: "Subscribe and save" },
  { id: "whatsapp", label: "WhatsApp messaging app", built: "Order updates and cart reminders" },
  { id: "shipping", label: "Delivery tracking app", built: "Shiprocket dates and tracking" },
  { id: "bundles", label: "Bundles and upsells app", built: "Offers, bundles and cart nudges" },
  { id: "quiz", label: "Product quiz app", built: "Product-finder quizzes" },
  { id: "search", label: "Search and filters app", built: "Faceted search filters" },
  { id: "builder", label: "Page builder app", built: "Drag-and-drop studio" },
  { id: "cod", label: "COD and checkout app", built: "COD with OTP and a prepaid nudge" },
  { id: "markets", label: "Currency app", built: "Markets in more than one currency" },
  { id: "ai", label: "AI writing app", built: "AI copilot, drafts only" },
];

export const HERO = {
  title: "The apps your store rents, built into one storefront.",
  lede: "Storeasy gives the catalog you already keep in Shopify its own fast storefront, with ratings, subscriptions, WhatsApp updates, offers, quizzes and an India-ready checkout inside it. Nothing you publish is written back to Shopify.",
  billTitle: "Apps a Shopify store adds one by one",
  billColumn: "With Storeasy",
  billMark: "Built in",
  billApp: "App",
  billFrom: "plans from",
  billNoPlan: "one plan",
  billFree: "a free plan to start",
  primary: "Create your store",
  secondary: "Add up your own bill",
};

// What's built in, grouped by the job it does for the founder.
export const GROUPS = [
  {
    title: "Sell more in each order",
    items: [
      { title: "Offers", body: "Tiered quantity discounts, buy X get Y, bundles, free gifts and coupons.", ticked: "A merchant can create and edit offers and bundles on the new UI", file: "lib/offers/engine.js" },
      { title: "Scheduled and collection offers", body: "Set a bundle to start and end on dates you choose, or put an offer on a whole collection.", ticked: "A founder can schedule a bundle and an offer for a collection" },
      { title: "Cart nudges that hold up", body: "The cart drawer shows what unlocks the next tier. Each nudge is checked against the offer engine first, so it never promises a discount the cart won't get.", ticked: "a cart drawer with tiered offers", file: "lib/offers/progress.js" },
      { title: "Subscribe and save", body: "Shoppers subscribe to a product, then pause, skip, swap or cancel from their account.", ticked: "A shopper can subscribe to a product and pause, skip, swap or cancel from their account" },
      { title: "Quizzes", body: "Product-finder quizzes that point a shopper to the right product.", ticked: "A merchant can create and edit product-finder quizzes on the new UI" },
    ],
  },
  {
    title: "Earn trust after the sale",
    items: [
      { title: "Ratings from verified buyers", body: "Only people who bought get an invite link. You approve each one before it shows, and product pages carry stars with structured data for search results.", ticked: "A shopper who bought a product can leave a review through an invite link, an admin moderates it" },
      { title: "WhatsApp updates", body: "Order updates and abandoned-cart reminders on WhatsApp, sent only to shoppers who agreed to marketing messages.", ticked: "gets WhatsApp order updates and an abandoned-cart reminder; nobody else does" },
      { title: "Delivery dates and tracking", body: "Shiprocket delivery estimates before checkout and live tracking on the order page.", ticked: "A shopper sees a delivery estimate and live tracking from Shiprocket on the order page" },
    ],
  },
  {
    title: "Design it yourself",
    items: [
      { title: "Studio editor", body: "A full-screen editor with drag-and-drop sections and an instant preview. Colours, type and spacing stay inside your design tokens.", ticked: "A founder edits in a full-screen studio with drag-and-drop sections and an instant preview" },
      { title: "Five flagship themes, or your own", body: "Pick one of five themes, or upload a theme package. A package with scripts is refused, and cart and checkout stay Storeasy's own.", ticked: "A founder can choose one of five flagship themes at onboarding or later" },
      { title: "Search filters", body: "Shoppers narrow search results by several filters at once.", ticked: "A shopper can filter search results by several facets" },
      { title: "AI copilot", body: "Ask for a starter store, product SEO, FAQs or offer ideas. It writes drafts only, within a daily budget, and sends no shopper data.", ticked: "gets drafts only, within a daily token budget and with no shopper data sent" },
    ],
  },
  {
    title: "Connect your own tools",
    items: [
      { title: "Apps platform", body: "Webhooks for orders created and fulfilled, with retries and signed deliveries. Outside apps get API tokens limited to what you approved, and every call is logged.", ticked: "An external plugin gets a scoped token limited to the permissions the admin approved, and every call with it is audited" },
    ],
  },
];

export const CALC = {
  legend: "What you pay each month, in rupees",
  builtAs: "In Storeasy:",
  free: "Free",
  title: "Add up the apps you could stop paying for",
  lede: "Type what you pay each month for each kind of app. Leave a line empty if you don't use one.",
  placeholder: "Your number",
  unit: "a month",
  monthly: "Apps you could replace, a month",
  yearly: "A year",
  plan: "Storeasy plan",
  planCost: "Storeasy, a month",
  difference: "Left over each month",
  over: "This plan costs more than these apps by",
  empty: "Add what you pay today to see your total.",
  invalid: "Enter an amount in rupees, like 1500.",
  clear: "Clear my figures",
  estimate: "An estimate from your own figures.",
  shopifyStays: "Your Shopify plan stays: your catalog lives there. This adds up apps only.",
  noPlans: "Storeasy's plans can't be shown right now.",
  seePricing: "See pricing",
};

export const SPEED = {
  title: "Fast because of how it's built",
  items: [
    { title: "Edge runtime", body: "Shopper pages run on the Edge runtime.", file: "app/(storefront)/layout.js" },
    { title: "Server-rendered pages", body: "Pages render on the server from a cached content layer, tagged per store, so a publish refreshes only that store.", file: "lib/cache.js" },
    { title: "Self-hosted fonts", body: "Fonts are served with the store, with no request to a font service.", file: "app/fonts/fonts.js" },
    { title: "Optimised images", body: "Product photos from Shopify are resized and compressed for each screen.", file: "components/StoreImage.js" },
  ],
  // The speed band's moving picture: the same path the four items above describe.
  flowTitle: "How a page reaches a shopper",
  flow: ["Cached content", "Edge runtime", "Shopper's screen"],
  measuredTitle: "Measured in our test suite",
  measured: [
    { title: "Theme layer", body: "An uploaded theme package added about 2 ms to a page layout render (median of 15 renders).", file: "scripts/test-theme-render.js" },
    { title: "Plugin slots", body: "Plugin slots with nothing placed in them left a product page render unchanged at about 0.9 ms (median of 25 renders).", file: "scripts/test-plugin-slots.js" },
  ],
  measuredNote: "Measured on a developer machine on 26 November 2026. These are test-suite timings, not field data from real stores.",
};

export const SAFETY = {
  title: "You stay in control",
  items: [
    { title: "Shopify stays as it is", body: "Storefront content is never written back to Shopify. Only order calls go there.", file: "scripts/test-shopify-boundary.js" },
    { title: "Drafts until you publish", body: "Every change is a draft with a preview. Only your Publish puts it live, and you can undo a publish.", ticked: "A founder can undo a publish" },
    { title: "A database for each store", body: "Each store keeps its data in its own database. One store can never read another's.", ticked: "One store can never read another store's data" },
    { title: "Roles for your team", body: "Owner, admin, staff and support. Staff can draft but not publish; support is read-only.", ticked: "staff can draft but not publish" },
    { title: "Audit trail", body: "Team and operator changes are recorded in an audit log.", file: "lib/platform/audit.js" },
    { title: "Totals checked on the server", body: "Checkout totals are recomputed on the server, and a double payment is refused.", ticked: "totals are recomputed on the server and a double payment is refused" },
  ],
};

export const INDIA = {
  title: "Checkout made for India",
  items: [
    { title: "Razorpay and cash on delivery", body: "Online payment through Razorpay, and COD where you allow it.", ticked: "A shopper can add to cart and check out" },
    { title: "A nudge to pay online", body: "On COD, the shopper sees what paying online saves them. COD orders can need a one-time code.", ticked: "A shopper choosing COD is offered a prepaid nudge, and COD orders can require an OTP" },
    { title: "PIN code autofill", body: "A PIN code fills the city and state and shows a delivery date.", ticked: "A shopper can enter a pincode and get their address filled and a delivery estimate" },
    { title: "Saved addresses", body: "Signed-in shoppers pick a saved address at checkout.", ticked: "A signed-in shopper can save addresses and pick one at checkout" },
  ],
};

export const GLOBAL = {
  title: "And beyond India",
  body: "Sell in more than one country and currency. Each market has its own currency, the exchange rate you set, price rounding and shipping. Shoppers choose where they ship to and pay in that currency.",
  ticked: "A founder can sell in more than one currency and country",
};

export const CLOSING = {
  builtInTitle: "What comes built in",
  builtInLede: "All of it ships with every store. No plan holds a feature back: plans differ by limits, like orders a month and team seats.",
  title: "Bring your Shopify catalog. Leave the app stack.",
  body: "Sign up, connect your Shopify store, pick a theme and open when checkout is ready.",
  primary: "Create your store",
  secondary: "See pricing",
  pause: "Pause the moving list",
  more: "More about Storeasy",
  sources: "Where each claim comes from",
  sourcesLede: "Each feature on this page is a ticked line in our feature list, ticked only once its tests passed, or a named part of the code.",
};

export const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/templates", label: "Templates" },
  { href: "/integrations", label: "Integrations" },
  { href: "/verticals/nutrition", label: "Nutrition stores" },
  { href: "/verticals/beauty", label: "Beauty stores" },
  { href: "/customers", label: "Customers" },
  { href: "/trust", label: "Trust and security" },
];

// Every string a visitor reads, for the copy scan.
export function visibleStrings() {
  const out = [];
  const walk = (v, key = "") => {
    if (typeof v === "string") {
      if (!["ticked", "file", "id", "href"].includes(key)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk({ STACK, HERO, GROUPS, CALC, SPEED, SAFETY, INDIA, GLOBAL, CLOSING, LINKS });
  return out;
}

// Every claim with its source, for the sources list and the suite.
export function claims() {
  return [...GROUPS.flatMap((g) => g.items), ...SPEED.items, ...SPEED.measured, ...SAFETY.items, ...INDIA.items, GLOBAL];
}

// The calculator's sums (rupees in, rupees out). A blank or invalid line
// counts as nothing; `invalid` names the lines that need fixing.
export function stackTotals(values, planPaise = null) {
  let monthly = 0;
  const invalid = [];
  let entered = 0;
  for (const [id, raw] of Object.entries(values || {})) {
    const s = String(raw ?? "").replace(/[,\s₹]/g, "");
    if (s === "") continue;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) {
      invalid.push(id);
      continue;
    }
    entered++;
    monthly += n;
  }
  monthly = Math.round(monthly * 100) / 100;
  const plan = planPaise == null ? null : planPaise / 100;
  return { monthly, yearly: Math.round(monthly * 12 * 100) / 100, entered, invalid, plan, difference: plan == null ? null : Math.round((monthly - plan) * 100) / 100 };
}
