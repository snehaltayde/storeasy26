// PERF-04: the "perf" fixture for the design harness. A store sized like a
// realistic mid-size D2C brand, so local baselines measure the reads and bytes
// a real founder's store would cause, not the 8-product demo.
//   node scripts/dev-design.js seed --fixture perf
//
// Local only. The seed writes to the harness's own sqld (scripts/seed-design-
// preview.js refuses any other database URL before this module runs), and
// nothing here talks to Shopify: products, collections and media are written
// straight into the local tenant database, the way a finished first sync
// would leave them.
//
// Two halves:
//   buildPerfFixture()  pure and deterministic (the same input gives the same
//                       store, byte for byte). No database, no clock, no
//                       randomness outside a seeded generator. Unit-tested in
//                       scripts/test-perf-tools.js.
//   seedPerfFixture()   writes that store into the active tenant database and
//                       publishes it, so the live storefront serves it.
import { createHash } from "node:crypto";

export const FIXTURE_NAMES = ["perf"];

// The sizes, and why. These are an engineering estimate of a mid-size Indian
// D2C store (supplements, skincare, snacks, apparel), leaning to the larger
// side so local numbers don't flatter the storefront. They are not real tenant
// sizes: nobody has read a real store's database (OQ-11, the owner's call).
// scripts/perf-report.js (library mode) keeps its 5,000-product catalog as
// the stress case; this fixture is the "typical busy store" case.
export const PERF_FIXTURE = Object.freeze({
  name: "perf",
  products: 400, // in the catalog, the 8 demo products included
  variantsPattern: [1, 2, 3, 3, 4, 6], // per product, in turn (capped at the sizes a type has): about 3 on average
  imagesPattern: [3, 4, 5, 6], // product photos per product, in turn: 4.5 on average
  soldOutEvery: 9, // one product in 9 is sold out
  typeCollections: 10, // one per product type, about 39 products each
  themedCollectionSizes: [60, 48, 72, 24, 36, 28, 16, 32, 20, 18, 14, 12, 30, 10, 24, 8],
  // plus "shop-all" (every product) and the 3 demo collections: 30 collections
  contentPages: 20, // policies, FAQ, size guide, our story and the like
  pageSections: [3, 8], // sections per content page, low to high
  journalPosts: 60, // blog posts, about 1,000 words each
  postSections: [4, 8],
  campaigns: 4, // landing pages with a visibility window
  homeSections: 12,
  headerMenu: { items: 6, childrenEach: 4 },
  footerLinks: 10,
  offers: 5, // plus the 3 demo offers and one offer per enabled bundle
  bundles: 4, // 3 enabled
  quizzes: 1,
  productPhotos: 24, // library images the product photos point at
  pagePhotos: 8, // library images for pages and home sections
});

export const RATIONALE = [
  "400 products: big enough that a missing index or an unbounded read shows, while still the size a growing D2C brand reaches (a few hundred products, most with flavour or size options).",
  "About 3 variants and 4 to 5 photos per product, because product pages and the cart join variants and images.",
  "30 collections, from every product (shop-all) down to 8, because collection pages, the collections index and the header menu all read them.",
  "20 content pages and 60 journal posts, because every live page reads the published release, and that snapshot carries every page and post.",
  "12 home sections, 4 of them product rails, because each one resolves its own catalog data.",
  "8 offers, 4 bundles and 1 quiz, because the cart runs the offer engine on every read.",
  "32 library images stored in the tenant database, because media is part of a real store's size.",
  "An estimate, not real data: the owner decides whether engineers may read real tenant sizes (OQ-11).",
];

// The base seed's 8 demo products and 3 collections stay; the fixture adds to them.
export const DEMO_PRODUCT_IDS = Array.from({ length: 8 }, (_, i) => `gid://p/${i + 1}`);
const DEMO_COLLECTIONS = 3;

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
export const mediaIdFor = (key) => `med_${sha(`perf-media:${key}`).slice(0, 18)}`;
const FIXED_TIME = Date.UTC(2026, 0, 15, 6, 0, 0); // the fixture's own "now", never the clock
const iso = (msOffset) => new Date(FIXED_TIME + msOffset).toISOString();
const DAY = 86_400_000;

const SUBJECTS = ["Every batch", "This formula", "Our team", "The blend", "Each serving", "This routine", "The texture", "Every order", "Our lab partner", "The recipe", "Your first week", "The pack"];
const VERBS = ["is tested for", "is made for", "keeps to", "is balanced for", "brings together", "is packed for", "is checked for", "is designed around", "supports", "is mixed for"];
const OBJECTS = ["daily training", "sensitive skin", "clean ingredients", "Indian summers", "steady energy", "quick recovery", "a light finish", "everyday use", "busy mornings", "honest labels", "third-party lab results", "slow, even absorption"];
const TAILS = ["", " without added sugar", " with no fillers", " so you can feel the difference in a few weeks", " and ships within 24 hours", " in small batches", " from sources we can trace", " so it fits the routine you already have"];
const sentence = (r) => `${pick(r, SUBJECTS)} ${pick(r, VERBS)} ${pick(r, OBJECTS)}${pick(r, TAILS)}.`;
const paragraph = (r, lo = 3, hi = 6) => Array.from({ length: between(r, lo, hi) }, () => sentence(r)).join(" ");

const TYPES = [
  { type: "Protein", code: "PRO", tags: ["protein", "fitness"], nouns: ["Whey Protein Isolate", "Whey Protein Concentrate", "Plant Protein Blend", "Mass Gainer", "Casein Night Protein", "Protein Coffee"], sizes: ["500g", "1kg", "2kg"], flavours: ["Chocolate", "Vanilla", "Mango", "Coffee", "Unflavoured", "Strawberry"], price: [1499, 4999] },
  { type: "Creatine", code: "CRE", tags: ["creatine", "fitness"], nouns: ["Creatine Monohydrate", "Micronised Creatine", "Creatine Gummies", "Creatine HCL", "Creatine + Electrolytes", "Buffered Creatine"], sizes: ["100g", "250g", "500g"], flavours: ["Unflavoured", "Lemon", "Watermelon", "Orange", "Blue Raspberry", "Kala Khatta"], price: [599, 1799] },
  { type: "Pre-workout", code: "PRE", tags: ["pre-workout", "fitness", "energy"], nouns: ["Pre-workout", "Pump Formula", "Stim-free Pre-workout", "Energy Shot", "BCAA Recovery", "EAA Hydration"], sizes: ["30 servings", "60 servings", "90 servings"], flavours: ["Fruit Punch", "Green Apple", "Mango Chilli", "Cola", "Lemon Iced Tea", "Grape"], price: [999, 2999] },
  { type: "Vitamins", code: "VIT", tags: ["vitamins", "wellness"], nouns: ["Multivitamin Men", "Multivitamin Women", "Vitamin D3 + K2", "Vitamin B12", "Biotin", "Zinc + Magnesium"], sizes: ["60 tablets", "90 tablets", "120 tablets"], flavours: null, price: [399, 1299] },
  { type: "Omega", code: "OME", tags: ["omega", "wellness"], nouns: ["Fish Oil", "Triple Strength Omega", "Vegan Omega", "Krill Oil", "Omega 3-6-9", "Cod Liver Oil"], sizes: ["60 softgels", "90 softgels", "120 softgels"], flavours: null, price: [499, 1799] },
  { type: "Skincare", code: "SKN", tags: ["skincare", "beauty"], nouns: ["Vitamin C Face Serum", "Niacinamide Serum", "Hyaluronic Moisturiser", "SPF 50 Sunscreen", "Gentle Face Wash", "Retinol Night Cream"], sizes: ["30ml", "50ml", "100ml"], flavours: null, price: [349, 1299] },
  { type: "Haircare", code: "HAI", tags: ["haircare", "beauty"], nouns: ["Onion Hair Oil", "Anti-dandruff Shampoo", "Keratin Conditioner", "Hair Growth Serum", "Scalp Scrub", "Hair Gummies"], sizes: ["100ml", "200ml", "300ml"], flavours: null, price: [299, 999] },
  { type: "Snacks", code: "SNK", tags: ["snacks", "food"], nouns: ["Protein Bar", "Peanut Butter", "Rolled Oats", "Muesli", "Protein Cookies", "Energy Bites"], sizes: ["Pack of 6", "Pack of 12", "1kg"], flavours: ["Chocolate", "Crunchy", "Honey", "Dark Chocolate", "Almond", "Peanut"], price: [249, 899] },
  { type: "Apparel", code: "APP", tags: ["apparel"], nouns: ["Training Tee", "Joggers", "Hoodie", "Gym Shorts", "Sports Bra", "Tank Top"], sizes: ["S", "M", "L", "XL", "XXL", "XS"], flavours: ["Black", "Olive", "Navy", "Grey", "Maroon", "White"], price: [599, 2499] },
  { type: "Accessories", code: "ACC", tags: ["accessories"], nouns: ["Shaker Bottle", "Gym Bag", "Lifting Straps", "Resistance Band Set", "Steel Bottle", "Pill Organiser"], sizes: ["Standard", "Large", "Travel"], flavours: ["Black", "Blue", "Red", "Grey", "Green", "Pink"], price: [199, 1999] },
];
const LINES = ["", "Pro", "Daily", "Advanced", "Elite", "Essentials", "Max"];
const EXTRA_TAGS = ["bestseller", "new", "vegan", "sugar-free", "gift", "lab-tested", "travel"];

const THEMED = ["top-rated", "new-launches", "under-999", "gifting", "vegan", "sugar-free", "combos-and-kits", "summer-essentials", "gym-starter", "skin-routine", "immunity", "travel-size", "clearance", "staff-picks", "festive-edit", "limited-edition"];
const PAGE_SLUGS = ["privacy-policy", "terms-of-service", "refund-policy", "shipping-policy", "cancellation-policy", "cookie-policy", "faq", "size-guide", "ingredients-glossary", "lab-reports", "how-to-use", "store-locator", "bulk-orders", "affiliate-program", "careers", "press", "sustainability", "our-story", "warranty", "contact-details"];
const POST_TOPICS = ["protein-myths", "creatine-guide", "skin-barrier", "monsoon-skincare", "pre-workout-timing", "vegan-protein", "sleep-and-recovery", "sunscreen-basics", "gut-health", "hydration", "home-workouts", "hair-fall"];

// ---------------------------------------------------------------------------
// the store, as plain data
// ---------------------------------------------------------------------------

export function buildPerfFixture(spec = PERF_FIXTURE) {
  if (!spec || !FIXTURE_NAMES.includes(spec.name)) throw new Error(`Unknown fixture "${spec?.name}". Known fixtures: ${FIXTURE_NAMES.join(", ")}.`);
  const generatedCount = spec.products - DEMO_PRODUCT_IDS.length;

  // media first: product photos and page images point at library ids
  const media = [];
  for (let n = 0; n < spec.productPhotos; n++) media.push({ id: mediaIdFor(`product-${n}`), key: `product-${n}`, filename: `product-photo-${n + 1}.webp`, width: 800, height: 800, alt: `Product photo ${n + 1}` });
  for (let n = 0; n < spec.pagePhotos; n++) media.push({ id: mediaIdFor(`page-${n}`), key: `page-${n}`, filename: `page-photo-${n + 1}.webp`, width: 1200, height: 600, alt: `Lifestyle photo ${n + 1}` });
  const productPhoto = (n) => `/api/media/${media[n % spec.productPhotos].id}`;
  const pagePhoto = (n) => `/api/media/${media[spec.productPhotos + (n % spec.pagePhotos)].id}`;

  const products = [];
  for (let i = 0; i < generatedCount; i++) {
    const r = rng(1000 + i);
    const t = TYPES[i % TYPES.length];
    const noun = t.nouns[Math.floor(i / TYPES.length) % t.nouns.length];
    const line = LINES[Math.floor(i / (TYPES.length * t.nouns.length)) % LINES.length];
    const title = `${line ? `${line} ` : ""}${noun}`;
    const handle = `${slug(title)}-${i + 1}`;
    const id = `gid://shopify/Product/${8_000_000 + i}`;
    // Every variant is a different option combination: flavour (or colour) by
    // size, or size alone where a product type has no flavours.
    const nVariants = t.flavours ? spec.variantsPattern[i % spec.variantsPattern.length] : Math.min(spec.variantsPattern[i % spec.variantsPattern.length], t.sizes.length);
    const nImages = spec.imagesPattern[i % spec.imagesPattern.length];
    const base = Math.round(between(r, t.price[0], t.price[1]) / 10) * 10 - 1;
    const available = i % spec.soldOutEvery !== 4;
    const variants = [];
    const sizeCount = t.flavours ? (nVariants >= 4 ? 2 : 1) : nVariants;
    for (let k = 0; k < nVariants; k++) {
      const sizeIndex = k % sizeCount;
      const size = t.sizes[sizeIndex];
      const flavour = t.flavours ? t.flavours[Math.floor(k / sizeCount)] : null;
      const price = base + sizeIndex * Math.round((base * 0.6) / 10) * 10;
      variants.push({
        id: `gid://shopify/ProductVariant/${90_000_000 + i * 10 + k}`,
        title: flavour ? `${flavour} / ${size}` : size,
        sku: `PF-${t.code}-${i + 1}-${k + 1}`,
        price,
        compare_at_price: k === 0 && i % 4 === 1 ? Math.round(price * 1.25) : null,
        available: available && !(nVariants > 2 && k === nVariants - 1 && i % 5 === 0) ? 1 : 0,
        selected_options: flavour ? [{ name: t.type === "Apparel" || t.type === "Accessories" ? "Colour" : "Flavour", value: flavour }, { name: "Size", value: size }] : [{ name: "Size", value: size }],
        image_url: null,
        position: k,
      });
    }
    const optionNames = variants[0].selected_options.map((o) => o.name);
    const options = optionNames.map((name) => ({ name, values: [...new Set(variants.map((v) => v.selected_options.find((o) => o.name === name).value))] }));
    const images = Array.from({ length: nImages }, (_, n) => ({ id: `${id}::img::${n}`, url: productPhoto(i * 7 + n), alt: `${title}, photo ${n + 1}`, width: 800, height: 800, position: n }));
    const tags = [...t.tags, EXTRA_TAGS[i % EXTRA_TAGS.length], ...(i % 3 === 0 ? [EXTRA_TAGS[(i + 3) % EXTRA_TAGS.length]] : [])];
    const prices = variants.map((v) => v.price);
    const description = `${paragraph(r, 3, 5)} ${paragraph(r, 2, 3)}`;
    const description_html = `<p>${paragraph(r, 3, 5)}</p><ul>${Array.from({ length: 4 }, () => `<li>${sentence(r)}</li>`).join("")}</ul><p>${paragraph(r, 2, 4)}</p>`;
    products.push({
      id,
      handle,
      title,
      description,
      description_html,
      product_type: t.type,
      vendor: "Perf Nutrition Co",
      tags,
      price_min: Math.min(...prices),
      price_max: Math.max(...prices),
      compare_at_min: variants[0].compare_at_price,
      currency: "INR",
      available: variants.some((v) => v.available) ? 1 : 0,
      total_inventory: available ? between(r, 5, 400) : 0,
      featured_image: images[0].url,
      featured_image_alt: images[0].alt,
      options,
      created_at: iso(-(generatedCount - i) * 1.7 * DAY),
      updated_at: iso(-DAY),
      variants,
      images,
    });
  }
  const generatedIds = products.map((p) => p.id);

  // collections: shop-all, one per type, then the themed ones
  const collections = [];
  const col = (n, handle, title, productIds) =>
    collections.push({ id: `gid://shopify/Collection/${7_000_000 + n}`, handle, title, description: `${title}. Picked from the full range.`, image: pagePhoto(n), image_alt: title, productIds });
  col(0, "shop-all", "Shop all", [...DEMO_PRODUCT_IDS, ...generatedIds]);
  TYPES.slice(0, spec.typeCollections).forEach((t, n) => col(1 + n, slug(t.type), t.type, products.filter((p) => p.product_type === t.type).map((p) => p.id)));
  spec.themedCollectionSizes.forEach((size, n) => {
    const handle = THEMED[n % THEMED.length];
    const ids = Array.from({ length: Math.min(size, generatedCount) }, (_, k) => generatedIds[(n * 37 + k * 11) % generatedCount]);
    col(1 + spec.typeCollections + n, handle, handle.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), ids);
  });

  // content pages, journal posts and campaigns
  const sectionsFor = (r, [lo, hi], n, { prose = false } = {}) => {
    const out = [];
    const count = between(r, lo, hi);
    for (let s = 0; s < count; s++) {
      const id = `sec_p${sha(`${n}:${s}`).slice(0, 10)}`;
      const kind = prose ? (s % 4 === 2 ? "image" : "text") : ["text", "faq", "rich", "text", "image", "text", "rich", "faq"][s % 8];
      if (kind === "text") out.push({ id, kind, heading: sentence(r).replace(/\.$/, ""), body: Array.from({ length: prose ? between(r, 3, 4) : between(r, 2, 3) }, () => paragraph(r, prose ? 4 : 3, prose ? 7 : 5)) });
      else if (kind === "rich") out.push({ id, kind, heading: sentence(r).replace(/\.$/, ""), html: `<p>${paragraph(r)}</p><ul>${Array.from({ length: 5 }, () => `<li>${sentence(r)}</li>`).join("")}</ul><p>${paragraph(r)}</p>` });
      else if (kind === "faq") out.push({ id, kind, heading: "Questions we get asked", items: Array.from({ length: between(r, 6, 10) }, () => ({ q: `${sentence(r).replace(/\.$/, "")}?`, a: paragraph(r, 2, 3) })) });
      else out.push({ id, kind: "image", src: pagePhoto(n + s), alt: `Photo for section ${s + 1}`, caption: sentence(r) });
    }
    return out;
  };
  const pages = PAGE_SLUGS.slice(0, spec.contentPages).map((slugName, n) => {
    const r = rng(5000 + n);
    return { slug: slugName, title: slugName.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), description: sentence(r), family: "page", sections: sectionsFor(r, spec.pageSections, n) };
  });
  const posts = Array.from({ length: spec.journalPosts }, (_, n) => {
    const r = rng(7000 + n);
    const topic = POST_TOPICS[n % POST_TOPICS.length];
    return { slug: `${topic}-${n + 1}`, title: `${topic.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}, part ${Math.floor(n / POST_TOPICS.length) + 1}`, description: sentence(r), family: "journal", window_start: iso(-(spec.journalPosts - n) * 6 * DAY), sections: sectionsFor(r, spec.postSections, 100 + n, { prose: true }) };
  });
  const campaigns = Array.from({ length: spec.campaigns }, (_, n) => {
    const r = rng(9000 + n);
    return { slug: ["summer-sale", "new-year-goals", "festive-gifting", "launch-week"][n % 4], title: ["Summer sale", "New year goals", "Festive gifting", "Launch week"][n % 4], description: sentence(r), family: "campaign", window_start: iso(-30 * DAY), window_end: "2031-01-01T00:00:00.000Z", sections: sectionsFor(r, [3, 5], 200 + n) };
  });

  // the home page, the menus
  const typeCol = (n) => collections[1 + n];
  const themed = (n) => collections[1 + spec.typeCollections + n];
  const rail = (id, title, c) => ({ id, kind: "product_rail", title, collection: c.handle, collection_id: c.id, limit: 8, enabled: true });
  const r = rng(4242);
  const homeSections = [
    { id: "sec_pfcollect", kind: "collections", title: "Shop by category", limit: 8, enabled: true },
    rail("sec_pfrail1", "Top rated", themed(0)),
    { id: "sec_pfban1", kind: "banner", title: "Free shipping over ₹999", text: sentence(r), label: "Shop all", href: "/collections/shop-all", enabled: true },
    rail("sec_pfrail2", "Protein", typeCol(0)),
    { id: "sec_pfimg1", kind: "image_with_text", image: pagePhoto(0), image_alt: "A shaker bottle on a gym bench", image_side: "left", title: "Made in small batches", text: paragraph(r, 2, 3), label: "Our story", href: "/policies/our-story", enabled: true },
    { id: "sec_pfnew", kind: "new", title: "New arrivals", limit: 8, enabled: true },
    rail("sec_pfrail3", "Skincare", typeCol(5)),
    { id: "sec_pfrich", kind: "rich_text", title: "Why lab tested matters", html: `<p>${paragraph(r)}</p><p>${paragraph(r)}</p>`, enabled: true },
    rail("sec_pfrail4", "Snacks", typeCol(7)),
    { id: "sec_pfimg2", kind: "image_with_text", image: pagePhoto(1), image_alt: "Serum bottles on a shelf", image_side: "right", title: "A routine that fits", text: paragraph(r, 2, 3), label: "Read the journal", href: "/journal", enabled: true },
    { id: "sec_pfban2", kind: "banner", title: "Bundles save up to 20%", text: sentence(r), label: "See bundles", href: "/collections/combos-and-kits", enabled: true },
    rail("sec_pfrail5", "Gym starter", themed(8)),
  ].slice(0, spec.homeSections);
  const navHeader = [
    { label: "Shop all", href: "/collections/shop-all" },
    ...[0, 5, 3, 7].map((n) => ({ label: typeCol(n).title, href: `/collections/${typeCol(n).handle}`, children: [1, 2, 3, 4].slice(0, spec.headerMenu.childrenEach).map((k) => ({ label: themed((n + k) % spec.themedCollectionSizes.length).title, href: `/collections/${themed((n + k) % spec.themedCollectionSizes.length).handle}` })) })),
    { label: "Journal", href: "/journal" },
  ].slice(0, spec.headerMenu.items);
  const navFooter = pages.slice(0, spec.footerLinks).map((p) => ({ label: p.title, href: `/policies/${p.slug}` }));

  // commerce: offers, bundles, quiz
  const inStock = products.filter((p) => p.available && p.variants[0].available);
  const firstOf = (type) => inStock.find((p) => p.product_type === type);
  const shaker = inStock.find((p) => p.title.includes("Shaker Bottle")) || firstOf("Accessories");
  const offers = [
    { offer: { id: "protein-tiered", type: "TIERED_QTY", scope: "line", title: "Protein: 10% off 2, 15% off 3+", target: { kind: "tag", value: "protein" }, tiers: [{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }] }, enabled: true },
    { offer: { id: "creatine-bxgy", type: "BXGY", scope: "line", title: "Creatine: buy 2, get 1 free", target: { kind: "productType", value: "Creatine" }, buy: 2, free: 1 }, enabled: true },
    { offer: { id: "welcome10", type: "COUPON", scope: "order", title: "WELCOME10: 10% off your first order", code: "WELCOME10", discount: { kind: "percent", value: 10 }, minSubtotal: 999 }, enabled: true },
    { offer: { id: "gift-shaker", type: "FREE_GIFT", scope: "gift", title: "Free shaker over ₹3,999", threshold: 3999, gift: { variantId: shaker.variants[0].id, title: shaker.title } }, enabled: true },
    { offer: { id: "monsoon-15", type: "COUPON", scope: "order", title: "MONSOON15: 15% off", code: "MONSOON15", discount: { kind: "percent", value: 15 } }, enabled: true, startsAt: "2030-06-01T00:00:00.000Z", endsAt: "2030-07-01T00:00:00.000Z" },
  ].slice(0, spec.offers);
  const kit = (types) => types.map((type) => ({ variantId: firstOf(type).variants[0].id, quantity: 1 }));
  const priceOf = (items) => items.reduce((s, c) => s + products.find((p) => p.variants.some((v) => v.id === c.variantId)).variants.find((v) => v.id === c.variantId).price, 0);
  const bundles = [
    { slug: "gym-starter-kit", title: "Gym starter kit", items: kit(["Protein", "Creatine", "Accessories"]), enable: true },
    { slug: "morning-skin-routine", title: "Morning skin routine", items: kit(["Skincare", "Vitamins"]), enable: true },
    { slug: "recovery-stack", title: "Recovery stack", items: kit(["Protein", "Omega", "Pre-workout"]), enable: true },
    { slug: "snack-box", title: "Snack box", items: kit(["Snacks", "Accessories"]), enable: false },
  ]
    .slice(0, spec.bundles)
    .map((b) => ({ ...b, description: sentence(r), bundle_price: Math.round(priceOf(b.items) * 0.85) }));
  const quizzes = [
    {
      slug: "find-your-protein",
      title: "Find your protein",
      intro: "Four questions, then the products that fit.",
      questions: [
        { prompt: "What is your main goal?", options: [{ label: "Build muscle", tags: ["protein"] }, { label: "Recover faster", tags: ["pre-workout"] }, { label: "Feel healthier", tags: ["vitamins"] }] },
        { prompt: "Do you avoid dairy?", options: [{ label: "Yes", tags: ["vegan"] }, { label: "No", tags: ["protein"] }] },
        { prompt: "How often do you train?", options: [{ label: "Most days", tags: ["creatine"] }, { label: "A few times a week", tags: ["protein"] }, { label: "Rarely", tags: ["wellness"] }] },
        { prompt: "Sweet tooth?", options: [{ label: "Yes", tags: ["snacks"] }, { label: "No", tags: ["sugar-free"] }] },
      ],
    },
  ].slice(0, spec.quizzes);

  // The product the report measures: 6 variants (3 flavours by 2 sizes) and
  // 6 photos.
  const MEASURED = 11;
  const measuredProduct = products[MEASURED];

  // What scripts/perf-report.js asks for. One place, so the report and the
  // fixture can't drift apart.
  const measuredVariants = [inStock[1], inStock[12], inStock[40]].map((p) => ({ variantId: p.variants[0].id, productId: p.id, quantity: 1 + (p === inStock[1] ? 1 : 0) }));
  const measured = {
    productHandle: measuredProduct.handle,
    productTitle: measuredProduct.title,
    categoryCollection: typeCol(0).handle,
    categoryTitle: typeCol(0).title,
    allCollection: "shop-all",
    allTitle: "Shop all",
    policySlug: "refund-policy",
    policyTitle: pages.find((p) => p.slug === "refund-policy")?.title,
    searchTerm: "protein",
    cart: { id: "perf-cart-1", lines: measuredVariants },
  };

  return { spec, media, products, collections, pages, posts, campaigns, homeSections, navHeader, navFooter, offers, bundles, quizzes, measured };
}

// Sizes as the database will hold them once seeded (demo rows included).
export function fixtureSummary(fx) {
  return {
    products: fx.products.length + DEMO_PRODUCT_IDS.length,
    variants: fx.products.reduce((s, p) => s + p.variants.length, 0) + DEMO_PRODUCT_IDS.length,
    productImages: fx.products.reduce((s, p) => s + p.images.length, 0),
    collections: fx.collections.length + DEMO_COLLECTIONS,
    collectionMemberships: fx.collections.reduce((s, c) => s + c.productIds.length, 0) + 9,
    contentPages: fx.pages.length,
    journalPosts: fx.posts.length,
    campaigns: fx.campaigns.length,
    homeSections: fx.homeSections.length,
    offersAdded: fx.offers.length,
    bundles: fx.bundles.length,
    quizzes: fx.quizzes.length,
    media: fx.media.length,
  };
}

// A deterministic photo-like image: a soft gradient with grain, so it
// compresses like a photo rather than a flat colour.
async function photo(key, width, height) {
  const { default: sharp } = await import("sharp");
  const r = rng(Number.parseInt(sha(key).slice(0, 8), 16));
  const [c1, c2] = [[between(r, 40, 220), between(r, 40, 220), between(r, 40, 220)], [between(r, 40, 220), between(r, 40, 220), between(r, 40, 220)]];
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const f = (x / width + y / height) / 2;
      const grain = (r() - 0.5) * 36;
      const o = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch++) raw[o + ch] = Math.max(0, Math.min(255, Math.round(c1[ch] * (1 - f) + c2[ch] * f + grain)));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).webp({ quality: 72 }).toBuffer();
}

// ---------------------------------------------------------------------------
// write it into the active tenant database (call inside withTenant)
// ---------------------------------------------------------------------------

export async function seedPerfFixture({ libsql, log = () => {}, spec = PERF_FIXTURE } = {}) {
  const fx = buildPerfFixture(spec);
  const inChunks = async (stmts, size = 250) => {
    for (let i = 0; i < stmts.length; i += size) await libsql.batch(stmts.slice(i, i + size), "write");
  };
  const json = (v) => JSON.stringify(v);

  // media (direct rows with fixed ids, so photo links are the same every seed)
  for (const m of fx.media) {
    const bytes = await photo(m.key, m.width, m.height);
    await libsql.execute({
      sql: "INSERT INTO media (id, filename, mime, size, width, height, alt, variant, parent_id, sha256, data, created_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)",
      args: [m.id, m.filename, "image/webp", bytes.length, m.width, m.height, m.alt, createHash("sha256").update(bytes).digest("hex"), bytes, iso(-90 * DAY)],
    });
  }

  // catalog, as a finished first sync would leave it
  const stmts = [];
  for (const p of fx.products) {
    stmts.push({
      sql: "INSERT INTO products (id, handle, title, description, description_html, product_type, vendor, tags, price_min, price_max, compare_at_min, currency, available, total_inventory, featured_image, featured_image_alt, options, created_at, updated_at, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [p.id, p.handle, p.title, p.description, p.description_html, p.product_type, p.vendor, json(p.tags), p.price_min, p.price_max, p.compare_at_min, p.currency, p.available, p.total_inventory, p.featured_image, p.featured_image_alt, json(p.options), p.created_at, p.updated_at, p.updated_at],
    });
    for (const v of p.variants) {
      stmts.push({
        sql: "INSERT INTO variants (id, product_id, title, sku, price, compare_at_price, currency, available, selected_options, image_url, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        args: [v.id, p.id, v.title, v.sku, v.price, v.compare_at_price, "INR", v.available, json(v.selected_options), v.image_url, v.position],
      });
    }
    for (const im of p.images) {
      stmts.push({ sql: "INSERT INTO product_images (id, product_id, url, alt, width, height, position) VALUES (?,?,?,?,?,?,?)", args: [im.id, p.id, im.url, im.alt, im.width, im.height, im.position] });
    }
  }
  for (const c of fx.collections) {
    stmts.push({ sql: "INSERT INTO collections (id, handle, title, description, image, image_alt, updated_at, synced_at) VALUES (?,?,?,?,?,?,?,?)", args: [c.id, c.handle, c.title, c.description, c.image, c.image_alt, iso(-DAY), iso(-DAY)] });
    c.productIds.forEach((pid, position) => stmts.push({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?,?,?)", args: [c.id, pid, position] }));
  }
  await inChunks(stmts);
  log(`  catalog: ${fx.products.length} products, ${fx.collections.length} collections added`);

  // The fixture's content (home, header, footer, pages, posts, campaigns)
  // becomes documents in perf-docs-fixture.js. The fixture has no hand-picked
  // pairs, badges or pins, so the measured product page shows the automatic
  // "Pairs well with" list at most, and no badge.

  // commerce
  const { upsertOffer } = await import("../lib/offers/store.js");
  for (const o of fx.offers) await upsertOffer(o);
  const { upsertBundle } = await import("../lib/bundles.js");
  // P5-BUNDLEREAD: a bundle whose slug is already there is edited (a create
  // onto a taken slug is refused now), so a reseed onto a used database works
  for (const b of fx.bundles) {
    const had = (await libsql.execute({ sql: "SELECT id FROM bundles WHERE slug = ?", args: [b.slug] })).rows[0];
    await upsertBundle({ ...b, id: had?.id ?? null });
  }
  const { upsertQuiz } = await import("../lib/quiz.js");
  for (const q of fx.quizzes) await upsertQuiz(q);

  // the cart the report measures (cart API and checkout's first step)
  await libsql.execute({ sql: "INSERT INTO carts (id, coupon_code, created_at, updated_at) VALUES (?, NULL, ?, ?)", args: [fx.measured.cart.id, iso(0), iso(0)] });
  for (const [n, line] of fx.measured.cart.lines.entries()) {
    const price = fx.products.find((p) => p.id === line.productId).variants[0].price;
    await libsql.execute({ sql: "INSERT INTO cart_items (cart_id, variant_id, product_id, quantity, price_at_add, added_at) VALUES (?,?,?,?,?,?)", args: [fx.measured.cart.id, line.variantId, line.productId, line.quantity, price, iso(n * 1000)] });
  }

  // the content is published as documents by perf-docs-fixture.js (takeOver)
  return { summary: fixtureSummary(fx), measured: fx.measured, release: null };
}
