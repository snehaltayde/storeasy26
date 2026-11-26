// The Storeasy landing page's words (platform home, components/site/MarketingHome.js).
// Every claim names where it comes from: `ticked` is a substring of a ticked
// ("- [x]") line in docs/FEATURES.md, `file` a source file that does it.
// Every price of someone else's app is in STACK below with the page it was
// read from and the day it was read. scripts/test-marketing.js holds all of it
// to the repo and runs every visible string here through scanText
// (lib/copy/banned-copy.js). Plain data: no JSX, no imports, so the suite reads
// it in plain Node.

// The day every app price below was read from its public page.
export const PRICES_CHECKED = "2026-11-26";
const listing = (slug) => `https://apps.shopify.com/${slug}`;

// The hero's deck, the apps section and the calculator share these lines: the
// kinds of app a Shopify store adds one by one, each with ONE well-known app's
// lowest paid monthly plan as a standard estimate (owner's decision,
// 2026-11-26, docs/DECISIONS.md). Rules for `price`, held by the suite:
//   - the figure is exactly what the vendor's public page showed on
//     `checkedAt`; nothing is estimated, converted or rounded here
//   - `url` is that page. A Shopify App Store listing (basis "listing") shows
//     the vendor's dollar price as Shopify's own rupee estimate; a vendor's own
//     price list (basis "vendor") is in rupees before taxes
//   - a kind of app with no public price gets no line at all
// No Storeasy price is written here: plans come from lib/platform/billing.js.
export const STACK = [
  { id: "ratings", label: "Product ratings app", built: "Verified-buyer ratings", price: { vendor: "Judge.me", plan: "Awesome", amount: 1384.06, currency: "INR", basis: "listing", url: listing("judgeme"), checkedAt: PRICES_CHECKED } },
  { id: "subscriptions", label: "Subscriptions app", built: "Subscribe and save", price: { vendor: "Appstle Subscriptions", plan: "Starter", amount: 922.71, currency: "INR", basis: "listing", url: listing("subscriptions-by-appstle"), checkedAt: PRICES_CHECKED } },
  { id: "whatsapp", label: "WhatsApp messaging app", built: "Order updates and cart reminders", price: { vendor: "Interakt", plan: "Growth", amount: 2799, currency: "INR", basis: "vendor", url: "https://www.interakt.shop/pricing/", checkedAt: PRICES_CHECKED } },
  { id: "shipping", label: "Delivery tracking app", built: "Shiprocket dates and tracking", price: { vendor: "AfterShip", plan: "Tracking", amount: 1014.98, currency: "INR", basis: "listing", url: listing("aftership"), checkedAt: PRICES_CHECKED } },
  { id: "bundles", label: "Bundles and offers app", built: "Offers, bundles and free gifts", price: { vendor: "Fast Bundle", plan: "Standard (1K)", amount: 1753.14, currency: "INR", basis: "listing", url: listing("fast-bundle-product-bundles"), checkedAt: PRICES_CHECKED } },
  { id: "cart", label: "Cart upsell app", built: "Cart drawer with tier nudges", price: { vendor: "Upcart", plan: "0-200 orders", amount: 2767.19, currency: "INR", basis: "listing", url: listing("upcart-cart-builder"), checkedAt: PRICES_CHECKED } },
  { id: "quiz", label: "Product quiz app", built: "Product-finder quizzes", price: { vendor: "VQB Product Quiz Builder", plan: "Convert", amount: 2768.12, currency: "INR", basis: "listing", url: listing("product-recommendation-quiz"), checkedAt: PRICES_CHECKED } },
  { id: "search", label: "Search and filters app", built: "Faceted search filters", price: { vendor: "Boost AI Search & Filter", plan: "Launch", amount: 2675.84, currency: "INR", basis: "listing", url: listing("product-filter-search"), checkedAt: PRICES_CHECKED } },
  { id: "builder", label: "Page builder app", built: "Drag-and-drop studio", price: { vendor: "PageFly", plan: "Builder", amount: 2214.49, currency: "INR", basis: "listing", url: listing("pagefly"), checkedAt: PRICES_CHECKED } },
  { id: "cod", label: "COD form app", built: "COD with OTP and a prepaid nudge", price: { vendor: "Releasit COD Form & Upsells", plan: "Premium", amount: 1060.19, currency: "INR", basis: "listing", url: listing("releasit-cod-order-form"), checkedAt: PRICES_CHECKED } },
  { id: "markets", label: "Currency app", built: "Markets in more than one currency", price: { vendor: "BUCKS Currency Converter", plan: "Plus", amount: 921.78, currency: "INR", basis: "listing", url: listing("bucks-currency-converter"), checkedAt: PRICES_CHECKED } },
  { id: "ai", label: "AI writing app", built: "AI copilot, drafts only", price: { vendor: "AI Product Description-ChatGPT", plan: "Basic Plan", amount: 1374.83, currency: "INR", basis: "listing", url: listing("automated-description-writing"), checkedAt: PRICES_CHECKED } },
];

// The standard estimate, in whole rupees: what the calculator starts from and
// what the hero's bill adds up to. The page shows whole rupees, so each line
// is rounded once and the total is the sum of what is shown.
export const typicalRupees = (row) => Math.round(row.price.amount);
export const typicalValues = () => Object.fromEntries(STACK.map((row) => [row.id, String(typicalRupees(row))]));
export const typicalTotal = () => STACK.reduce((sum, row) => sum + typicalRupees(row), 0);

// The header every marketing page shares (components/site/SiteNav.js).
export const NAV = {
  label: "Storeasy",
  product: "Product",
  productLabel: "What Storeasy does",
  menu: "Menu",
  close: "Close menu",
  cta: "Create your store",
  ctaShort: "Start",
  talk: "Talk to us",
  items: [
    { id: "studio", href: "/#yours", label: "Studio and themes", body: "A storefront that's yours" },
    { id: "offers", href: "/#sell", label: "Offers and subscriptions", body: "Sell more in each order" },
    { id: "checkout", href: "/#checkout", label: "Checkout", body: "Razorpay, COD and PIN code autofill" },
    { id: "speed", href: "/#speed", label: "Speed", body: "Pages rendered at the edge" },
    { id: "control", href: "/#control", label: "Control", body: "Drafts, roles and an audit trail" },
    { id: "apps", href: "/#calculator", label: "App costs", body: "What the app stack adds up to" },
  ],
  feature: { href: "/#calculator", title: "Add up your app bill", body: "Twelve kinds of app, built in." },
  links: [
    { href: "/pricing", label: "Pricing" },
    { href: "/templates", label: "Templates" },
    { href: "/integrations", label: "Integrations" },
    { href: "/customers", label: "Customers" },
    { href: "/trust", label: "Trust" },
  ],
};

export const HERO = {
  eyebrow: "A storefront for your Shopify catalog",
  title: "The apps you rent, built in.",
  lede: "Your Shopify catalog gets its own fast storefront, with ratings, subscriptions, WhatsApp, offers, quizzes and an India-ready checkout inside it.",
  billTitle: "Apps a Shopify store adds one by one",
  billColumn: "With Storeasy",
  billMark: "Built in",
  billPer: "/mo",
  billSum: "Typical app bill",
  billMore: "Every app price, with its source",
  billNoPlan: "One plan",
  primary: "Create your store",
  secondary: "See what the apps cost",
};

// The page's story after the bill, in order: a storefront that's yours, sell
// more, checkout for India, speed, control, the app bill, plans, start.
export const YOURS = {
  title: "A storefront that's yours",
  lede: "Design it in the studio. The catalog stays in Shopify.",
  items: [
    { id: "studio", title: "Studio editor", body: "Full-screen, with drag-and-drop sections and an instant preview, inside your design tokens.", ticked: "A founder edits in a full-screen studio with drag-and-drop sections and an instant preview" },
    { id: "themes", title: "Five flagship themes, or your own", body: "Pick one, or upload a theme package. Cart and checkout stay Storeasy's own.", ticked: "A founder can choose one of five flagship themes at onboarding or later" },
    { id: "filters", title: "Search filters", body: "Shoppers narrow results by several filters at once.", ticked: "A shopper can filter search results by several facets" },
    { id: "copilot", title: "AI copilot", body: "Starter store, product SEO, FAQs, offer ideas. Drafts only, and no shopper data is sent.", ticked: "gets drafts only, within a daily token budget and with no shopper data sent" },
    { id: "apps", title: "Apps platform", body: "Webhooks with signed deliveries, and API tokens limited to what you approved.", ticked: "An external plugin gets a scoped token limited to the permissions the admin approved, and every call with it is audited" },
  ],
};

export const SELL = {
  title: "Sell more in each order",
  lede: "All of it comes with the store.",
  all: "Every store gets all of it. Plans differ by limits, like orders a month and team seats.",
  items: [
    { id: "offers", title: "Offers", body: "Quantity tiers, buy X get Y, bundles, free gifts and coupons.", ticked: "A merchant can create and edit offers and bundles on the new UI", file: "lib/offers/engine.js" },
    { id: "nudges", title: "Cart nudges that hold up", body: "Each nudge is checked against the offer engine before it shows.", ticked: "a cart drawer with tiered offers", file: "lib/offers/progress.js" },
    { id: "schedule", title: "Scheduled and collection offers", body: "Start and end dates, or an offer on a whole collection.", ticked: "A founder can schedule a bundle and an offer for a collection" },
    { id: "subscribe", title: "Subscribe and save", body: "Shoppers pause, skip, swap or cancel from their account.", ticked: "A shopper can subscribe to a product and pause, skip, swap or cancel from their account" },
    { id: "quiz", title: "Quizzes", body: "Product-finder quizzes that lead to the right product.", ticked: "A merchant can create and edit product-finder quizzes on the new UI" },
    { id: "ratings", title: "Ratings from verified buyers", body: "Invite-only, approved by you, with structured data for search.", ticked: "A shopper who bought a product can leave a review through an invite link, an admin moderates it" },
    { id: "whatsapp", title: "WhatsApp updates", body: "Order updates and cart reminders, only for shoppers who agreed.", ticked: "gets WhatsApp order updates and an abandoned-cart reminder; nobody else does" },
    { id: "delivery", title: "Delivery dates and tracking", body: "Shiprocket estimates before checkout, live tracking after.", ticked: "A shopper sees a delivery estimate and live tracking from Shiprocket on the order page" },
  ],
};

export const CALC = {
  legend: "What each app costs a month, in rupees",
  builtAs: "In Storeasy:",
  typical: "Typical:",
  title: "What the app stack costs",
  lede: "Each line starts at a well-known app's lowest paid plan. Change any figure to what you pay.",
  stackCaption: "Twelve kinds of app, one store",
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
  clear: "Clear all",
  reset: "Back to typical prices",
  estimate: "A standard estimate, not your bill.",
  shopifyStays: "Your Shopify plan stays: your catalog lives there. This adds up apps only.",
  noPlans: "Storeasy's plans can't be shown right now.",
  seePricing: "See pricing",
  sources: "Where each app price comes from",
  sourcesLede: "One well-known app for each kind, at its lowest paid monthly plan, read from its public price page. Bigger stores pay more: most of these plans rise with orders. Each app also does more or less than what Storeasy has built in, so compare what you use.",
  listingNote: "From its Shopify App Store listing, which shows the dollar price as Shopify's rupee estimate.",
  vendorNote: "From its own price list, before taxes.",
  checked: "Read on",
  planWord: "plan",
};

export const PRICING = {
  title: "Three plans, then Enterprise",
  lede: "Every plan has every feature on this page. You choose by size.",
  perMonth: "a month",
  orders: "orders a month",
  seats: "team seats",
  everything: "Every feature, no add-ons",
  choose: "Start on",
  enterpriseBody: "More orders, more seats, or terms of your own.",
  enterprisePrice: "Custom",
  enterpriseCta: "Talk to us",
  enterpriseAbove: "Above",
  noPlans: "Storeasy's plans can't be shown right now.",
  more: "Compare plans",
};

export const SPEED = {
  title: "Fast because of how it's built",
  items: [
    { id: "edge", title: "Edge runtime", body: "Shopper pages run on the Edge runtime.", file: "app/(storefront)/layout.js" },
    { id: "server", title: "Server-rendered pages", body: "From a cache tagged per store, so a publish refreshes only that store.", file: "lib/cache.js" },
    { id: "fonts", title: "Self-hosted fonts", body: "No request to a font service.", file: "app/fonts/fonts.js" },
    { id: "images", title: "Optimised images", body: "Product photos resized for each screen.", file: "components/StoreImage.js" },
  ],
  // The speed section's moving picture: the same path the four items above describe.
  flowTitle: "How a page reaches a shopper",
  flow: ["Cached content", "Edge runtime", "Shopper's screen"],
  measuredTitle: "Measured in our test suite",
  measured: [
    { title: "Theme layer", figure: "2 ms", body: "An uploaded theme package added about 2 ms to a page layout render (median of 15 renders).", file: "scripts/test-theme-render.js" },
    { title: "Plugin slots", figure: "0.9 ms", body: "Plugin slots with nothing placed in them left a product page render unchanged at about 0.9 ms (median of 25 renders).", file: "scripts/test-plugin-slots.js" },
  ],
  measuredNote: "Measured on a developer machine on 26 November 2026. These are test-suite timings, not field data from real stores.",
};

export const SAFETY = {
  title: "You stay in control",
  items: [
    { id: "shopify", title: "Shopify stays as it is", body: "Content is never written back. Only order calls go there.", file: "scripts/test-shopify-boundary.js" },
    { id: "drafts", title: "Drafts until you publish", body: "Only your Publish puts a change live, and you can undo it.", ticked: "A founder can undo a publish" },
    { id: "database", title: "A database for each store", body: "One store can never read another's data.", ticked: "One store can never read another store's data" },
    { id: "roles", title: "Roles for your team", body: "Staff can draft but not publish; support is read-only.", ticked: "staff can draft but not publish" },
    { id: "audit", title: "Audit trail", body: "Team and operator changes are recorded.", file: "lib/platform/audit.js" },
    { id: "totals", title: "Totals checked on the server", body: "Recomputed at checkout; a double payment is refused.", ticked: "totals are recomputed on the server and a double payment is refused" },
  ],
};

export const INDIA = {
  title: "Checkout made for India",
  lede: "Pay online or on delivery, with the address filled from a PIN code.",
  items: [
    { id: "pay", title: "Razorpay and cash on delivery", body: "Online payment, and COD where you allow it.", ticked: "A shopper can add to cart and check out" },
    { id: "nudge", title: "A nudge to pay online", body: "COD shoppers see what paying online saves. COD can need a one-time code.", ticked: "A shopper choosing COD is offered a prepaid nudge, and COD orders can require an OTP" },
    { id: "pin", title: "PIN code autofill", body: "City, state and a delivery date from six digits.", ticked: "A shopper can enter a pincode and get their address filled and a delivery estimate" },
    { id: "address", title: "Saved addresses", body: "Signed-in shoppers pick a saved address.", ticked: "A signed-in shopper can save addresses and pick one at checkout" },
  ],
};

export const GLOBAL = {
  title: "And beyond India",
  body: "Each market has its own currency, exchange rate, rounding and shipping. Shoppers pay in the currency of where they ship to.",
  ticked: "A founder can sell in more than one currency and country",
};

// Words drawn inside the artwork (components/site/LandingArt.js). The art is
// decoration, hidden from screen readers, but its words are scanned like the rest.
export const ART = {
  studio: { sections: ["Hero", "Products", "Ratings", "Questions"], draft: "Draft", publish: "Publish" },
  copilot: { ask: "Write FAQs for this product", tag: "Draft" },
  apps: { events: ["Order created", "Order fulfilled"], signed: "Signed" },
  filters: ["Size", "Colour", "In stock"],
  checkout: { pin: "PIN code", pinValue: "411001", city: "Pune", state: "Maharashtra", online: "Pay online", cod: "Cash on delivery", code: "One-time code", date: "Delivery date", saved: "Saved address" },
  control: { shopify: "Shopify catalog", store: "Your storefront", readOnly: "Read only", orders: "Orders", steps: ["Draft", "Preview", "Publish"], undo: "Undo", roles: ["Owner", "Admin", "Staff", "Support"] },
  stack: "Storeasy",
};

export const CLOSING = {
  title: "Bring your Shopify catalog. Leave the app stack.",
  body: "Sign up, connect your store, pick a theme, open when checkout is ready.",
  primary: "Create your store",
  secondary: "See pricing",
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
      if (!["ticked", "file", "id", "href", "url", "checkedAt", "currency", "basis"].includes(key)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk({ STACK, NAV, HERO, YOURS, SELL, CALC, PRICING, SPEED, SAFETY, INDIA, GLOBAL, ART, CLOSING, LINKS });
  return out;
}

// Every claim with its source, for the sources list and the suite.
export function claims() {
  return [...YOURS.items, ...SELL.items, ...SPEED.items, ...SPEED.measured, ...SAFETY.items, ...INDIA.items, GLOBAL];
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
