// COM-03 suite: starting an offer in plain words, safely.
//   pnpm test:offer-form
// Real code paths throughout: the real engine, the real simulator and store
// against real tenant file databases (all tenant migrations applied), the
// real API route files called with real requests (host-resolved tenant, real
// requireAdmin), and the real OfferForm and OffersAdmin compiled with Next's
// own SWC. Components render with react-dom/server, and the form also runs on
// a small hook driver so the test can pick, type and click. No browser is
// involved: layout and real pickers are browser drills (docs/cms-reviews/P1-COM-03.md).
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-offer-form-default.db";
process.env.PLATFORM_DB_URL = "file:.test-offer-form-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const DBS = [".test-offer-form-default.db", ".test-offer-form-platform.db", ".test-offer-form-in.db", ".test-offer-form-us.db", ".test-offer-form-old.db", ".test-offer-form-big.db"];
for (const f of DBS) await rm(join(ROOT, f), { force: true });

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { NextRequest } = require("next/server");
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { db } = await import("../lib/db.js");
const ENGINE = await import("../lib/offers/engine.js");
const STORE = await import("../lib/offers/store.js");
const SIM = await import("../lib/offers/simulate.js");
const { validateOffer } = await import("../lib/offers/validate.js");
const CART = await import("../lib/cart.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "expected truthy") => {
  if (!cond) throw new Error(label);
};

// ---- loading app code that plain node can't import ------------------------------
// JSX files and route files are compiled with Next's SWC to CommonJS. Imports
// resolve like Next does ("@/…" is the project root); lib modules are the SAME
// instances this suite imports, so they share its database clients.
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const code = new Map(); // abs path → compiled CommonJS
const esm = new Map(); // abs path → module namespace
const resolveSpec = (spec, from) => {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolvePath(dirname(from), spec);
  else return null; // a package
  for (const p of [base, `${base}.js`, join(base, "index.js")]) if (/\.js$/.test(p) && existsSync(p)) return p;
  throw new Error(`can't resolve ${spec} from ${from}`);
};
const isLib = (abs) => abs.startsWith(join(ROOT, "lib") + "/");
async function prepare(abs, stubs, compileLib = false) {
  if (code.has(abs) || (!compileLib && esm.has(abs))) return;
  if (isLib(abs) && !compileLib) {
    esm.set(abs, { __esModule: true, ...(await import(pathToFileURL(abs).href)) });
    return;
  }
  const src = await readFile(abs, "utf8");
  const out = (
    await swc.transform(src, {
      filename: abs,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
  code.set(abs, out);
  for (const [, spec] of out.matchAll(/require\("([^"]+)"\)/g)) {
    if (spec in stubs) continue;
    const dep = resolveSpec(spec, abs);
    if (dep) await prepare(dep, stubs);
  }
}
// A fresh instance of `rel` and everything it compiles, with `stubs` (by the
// import string as written) taking priority. A lib file named directly is
// compiled too, so its own imports can be stubbed.
async function load(rel, stubs = {}) {
  const entry = join(ROOT, rel);
  await prepare(entry, stubs, true);
  const cache = new Map();
  const req = (from) => (spec) => {
    if (spec in stubs) return stubs[spec];
    const abs = resolveSpec(spec, from);
    if (!abs) return require(spec);
    if (abs !== entry && esm.has(abs)) return esm.get(abs);
    if (cache.has(abs)) return cache.get(abs).exports;
    const mod = { exports: {} };
    cache.set(abs, mod);
    new Function("require", "module", "exports", code.get(abs))(req(abs), mod, mod.exports);
    return mod.exports;
  };
  return req(ROOT + "/")(`@/${rel}`);
}
const tenantRequest = () =>
  load("lib/tenant-request.js", { react: { cache: (fn) => fn }, "next/headers": { headers: async () => new Headers() }, "next/navigation": { notFound() {} } });

// ---- fixtures: two stores, their own catalogs ----------------------------------
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const migrations = await loadMigrations("tenant");
for (const [id, file, currency, migrate] of [
  ["of-in", ".test-offer-form-in.db", "INR", true],
  ["of-us", ".test-offer-form-us.db", "USD", true],
  ["of-old", ".test-offer-form-old.db", "INR", false],
  ["of-big", ".test-offer-form-big.db", "INR", true],
]) {
  const client = createClient({ url: `file:${file}` });
  if (migrate) await runMigrations(client, migrations);
  else await client.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8")); // before any numbered migration
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: { currency }, secrets: {} });
}
const IN = await C.getTenant("of-in");
const US = await C.getTenant("of-us");
const OLD = await C.getTenant("of-old");
const inIN = (fn) => withTenant(IN, fn);
const inUS = (fn) => withTenant(US, fn);

// A small skincare catalog (deliberately not the old simulator's fixtures).
const CATALOG = [
  // id, handle, title, price, type, tags, variants [id, title, price]
  ["gid://shopify/Product/101", "glow-serum", "Radiance Glow Serum", 1299, "Serums", ["glow", "serum"], [["gid://shopify/ProductVariant/1011", "30ml", 1299], ["gid://shopify/ProductVariant/1012", "50ml", 1899]]],
  ["gid://shopify/Product/102", "night-cream", "Night Repair Cream", 1799, "Moisturizers", ["night"], [["gid://shopify/ProductVariant/1021", "Default Title", 1799]]],
  ["gid://shopify/Product/103", "spf-50", "Daily Defence SPF 50", 899, "Sun care", ["daily", "glow"], [["gid://shopify/ProductVariant/1031", "Default Title", 899]]],
  ["gid://shopify/Product/104", "oat-cleanser", "Gentle Oat Cleanser", 649, "Cleansers", ["gentle"], [["gid://shopify/ProductVariant/1041", "Default Title", 649]]],
  ["gid://shopify/Product/105", "lip-mask", "Lip Sleeping Mask", 549, "Masks", ["lip"], [["gid://shopify/ProductVariant/1051", "Default Title", 549]]],
];
async function seedCatalog(tenant, currency, scale = 1) {
  await withTenant(tenant, async () => {
    for (const [id, handle, title, price, type, tags, variants] of CATALOG) {
      await db
        .insertInto("products")
        .values({ id, handle, title, available: 1, currency, price_min: price * scale, price_max: Math.max(...variants.map((v) => v[2])) * scale, product_type: type, tags: JSON.stringify(tags) })
        .execute();
      let pos = 0;
      for (const [vid, vtitle, vprice] of variants)
        await db.insertInto("variants").values({ id: vid, product_id: id, title: vtitle, price: vprice * scale, currency, available: 1, position: pos++ }).execute();
    }
    await db.deleteFrom("offers").execute();
  });
}
await seedCatalog(IN, "INR");
await seedCatalog(US, "USD", 0.01);

// signed-in owners, one per store
const owner = async (tenantId, email) => {
  const u = await I.createUser({ email, password: "owner-pass-com03" });
  await I.addMembership(u.id, tenantId, "owner");
  return (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
};
const TOKENS = { "of-in": await owner("of-in", "owner@in.test"), "of-us": await owner("of-us", "owner@us.test"), "of-old": await owner("of-old", "owner@old.test") };
const request = (tenantId, method, path, body, { cookie = TOKENS[tenantId], origin = null } = {}) =>
  new NextRequest(`http://${tenantId}.test${path}`, {
    method,
    headers: { host: `${tenantId}.test`, "content-type": "application/json", ...(cookie ? { cookie: `_admin=${cookie}` } : {}), ...(origin ? { origin } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async (res) => ({ status: res.status, body: await res.json() });

console.log("— reproductions (run first against the code before COM-03)");

await t("a code's minimum-spend message uses the cart's currency, not a hard-coded rupee sign", () => {
  const usd = [{ variantId: "v", productId: "p", handle: "h", tags: [], price: 5, quantity: 1, currency: "USD" }];
  const offers = [{ id: "c-min", type: "COUPON", scope: "order", priority: 50, title: "Min", code: "MIN10", discount: { kind: "percent", value: 10 }, minSubtotal: 25 }];
  const r = ENGINE.evaluateOffers(usd, { offers, coupon: "MIN10" });
  eq(r.couponStatus.valid, false, "still refused:");
  ok(!r.couponStatus.reason.includes("₹"), `reason shows a rupee sign in a USD cart: ${r.couponStatus.reason}`);
  ok(r.couponStatus.reason.includes("$25"), `reason names the amount in dollars: ${r.couponStatus.reason}`);
  const inr = ENGINE.evaluateOffers([{ ...usd[0], price: 500, currency: "INR" }], { offers: [{ ...offers[0], minSubtotal: 999 }], coupon: "MIN10" });
  eq(inr.couponStatus.reason, "Minimum spend ₹999 for this code", "INR wording unchanged:");
});

await t("the simulator's example uses this store's products, never the old fixture products", async () => {
  const offer = { id: "coupon-sim", type: "COUPON", scope: "order", priority: 50, title: "SIM10 · 10% off", code: "SIM10", discount: { kind: "percent", value: 10 }, combinable: true };
  const r = await inIN(() => SIM.simulateOffer({ offer }));
  eq(r.ok, true, "ok:");
  const titles = r.cart.items.map((i) => i.title);
  ok(!titles.some((x) => /^Sim /.test(x)), `fixture products in the example: ${titles.join(", ")}`);
  const ours = new Set(CATALOG.map((p) => p[2]));
  ok(titles.length && titles.every((x) => ours.has(x)), `not this store's products: ${titles.join(", ")}`);
});

await t("creating a new offer never overwrites an existing one", async () => {
  const route = await load("app/api/admin/offers/route.js", { "@/lib/tenant-request": await tenantRequest() });
  // two different offers that the old form gave the same id (coupon-<code>)
  const a = { id: "coupon-save10", type: "COUPON", scope: "order", priority: 50, title: "Ten off", code: "SAVE10", discount: { kind: "percent", value: 10 }, combinable: true };
  const b = { ...a, title: "Fifty off", discount: { kind: "percent", value: 50 } };
  eq((await json(await route.POST(request("of-in", "POST", "/api/admin/offers", { offer: a })))).status, 200, "first create:");
  const second = await json(await route.POST(request("of-in", "POST", "/api/admin/offers", { offer: b })));
  const row = await inIN(() => STORE.getOfferRow("coupon-save10"));
  eq(row.config.discount.value, 10, `the live offer was replaced by a create (status ${second.status}):`);
  ok(second.status === 409, `create with a taken id: expected 409, got ${second.status}`);
  await inIN(() => STORE.deleteOffer("coupon-save10"));
});

const RAW_WORDS = ["productId", "variantId", "productType", "Target by", "Target value", "gid://", "kind=", "tag=", "handle"];
const rawWordsIn = (html, where) => RAW_WORDS.filter((raw) => html.includes(raw)).map((raw) => `${where} shows "${raw}"`);
const noRawWords = (html, where) => {
  const found = rawWordsIn(html, where);
  ok(!found.length, found.join("; "));
};
const rawBxgy = { id: "bxgy-glow", type: "BXGY", label: "Glow deal", enabled: true, starts_at: null, ends_at: null, config: { id: "bxgy-glow", type: "BXGY", scope: "line", priority: 30, title: "Glow deal", target: { kind: "tag", value: "glow" }, buy: 2, free: 1 } };
const rawGift = {
  id: "free-gift-mask",
  type: "FREE_GIFT",
  label: "Free mask",
  enabled: true,
  starts_at: null,
  ends_at: null,
  config: { id: "free-gift-mask", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Free mask", threshold: 30, gift: { variantId: "gid://shopify/ProductVariant/1051", title: "Lip Sleeping Mask", value: 5.49 } },
};

await t("the offer form shows no raw target kinds, no identifier fields, and the store's currency", async () => {
  const { default: OfferForm } = await load("components/admin/OfferForm.js");
  const problems = [];
  for (const existing of [null, rawBxgy, rawGift]) {
    const where = `form for ${existing?.type || "a new offer"}`;
    const html = renderToStaticMarkup(React.createElement(OfferForm, { existing, onDone() {}, onCancel() {}, currency: "USD", names: {}, offers: [] }));
    problems.push(...rawWordsIn(html, where));
    if (html.includes("₹")) problems.push(`${where} shows a rupee sign in a USD store`);
  }
  ok(!problems.length, problems.join("; "));
});

await t("the offers list says each offer in plain words, in the store's currency", async () => {
  const { default: OffersAdmin } = await load("components/admin/OffersAdmin.js", { "@/components/console/Toast": { useToast: () => ({ success() {}, error() {} }) } });
  const html = renderToStaticMarkup(React.createElement(OffersAdmin, { initialOffers: [rawBxgy, rawGift], currency: "USD", initialNames: {} }));
  const problems = rawWordsIn(html, "offers list");
  if (html.includes("₹")) problems.push("offers list shows a rupee sign in a USD store");
  if (!html.includes("Buy 2 products tagged “glow”, get 1 free")) problems.push("offers list lacks the plain sentence");
  ok(!problems.length, problems.join("; "));
});

const PLAIN = await import("../lib/offers/plain.js");
const MODEL = await import("../components/admin/offerFormModel.js");
const CAT = await import("../lib/offers/catalog.js");
const { handleRefsGet } = await import("../lib/admin/refs.js");
const G = (n) => `gid://shopify/Product/${n}`;
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const base = (type, extra) => ({ id: `${type.toLowerCase().replace(/_/g, "-")}-x`, type, scope: { BXGY: "line", TIERED_QTY: "line", FREE_GIFT: "gift", COUPON: "order" }[type], priority: 30, title: "Test offer", ...extra });

// ---- one shared source: the sentence, and the example the real engine runs ----------------
console.log("— the sentence and the simulator's example come from one source, and agree");

await t("the sentence reads the way a founder says it", () => {
  const names = { [G(1)]: "Whey", [V(9)]: "Serum — 50ml" };
  const say = (o, currency = "INR") => PLAIN.offerSentence(o, { names, currency });
  eq(say(base("BXGY", { target: { kind: "productId", value: G(1) }, buy: 2, free: 1 })), "Buy 2 of Whey, get 1 free", "the spec's example:");
  eq(say(base("BXGY", { target: { kind: "variantId", value: V(9) }, buy: 1, free: 1 })), "Buy 1 of Serum — 50ml, get 1 free", "a size:");
  eq(say(base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 1, free: 1 })), "Buy 1 product tagged “glow”, get 1 free", "a tag, one:");
  eq(say(base("BXGY", { target: { kind: "productType", value: "Serums" }, buy: 3, free: 1 })), "Buy 3 products of type “Serums”, get 1 free", "a type:");
  eq(say(base("BXGY", { target: { kind: "handle", value: "lost", label: "Old name" }, buy: 2, free: 1 })), "Buy 2 of Old name, get 1 free", "a lost product keeps its saved label:");
  eq(say(base("BXGY", { target: { kind: "productId", value: G(404) }, buy: 2, free: 1 })), "Buy 2 of the chosen product, get 1 free", "no name at all:");
  eq(
    say(base("TIERED_QTY", { target: { kind: "tag", value: "glow" }, tiers: [{ minQty: 3, percent: 15 }, { minQty: 2, percent: 10 }, { minQty: 3, percent: 40 }] })),
    "Buy 2 or more products tagged “glow”, get 10% off; 3 or more, 15% off",
    "steps in order, a repeated step that never applies is left out:",
  );
  eq(say(base("FREE_GIFT", { threshold: 1499, gift: { variantId: V(5), title: "Lip Mask", value: 549 } })), "Spend more than ₹1,499, get Lip Mask free", "gift:");
  eq(say(base("FREE_GIFT", { threshold: 30, gift: { variantId: V(5), title: "Lip Mask", value: 5 } }), "USD"), "Spend more than $30, get Lip Mask free", "gift in dollars:");
  eq(say(base("COUPON", { code: "SAVE10", discount: { kind: "percent", value: 10 } })), "Code SAVE10 takes 10% off the order", "code:");
  eq(say(base("COUPON", { code: "FLAT200", discount: { kind: "fixed", value: 200 }, minSubtotal: 999 })), "Code FLAT200 takes ₹200 off orders of ₹999 or more", "fixed with minimum:");
  eq(
    say(base("COUPON", { code: "SOLO", discount: { kind: "fixed", value: 5 }, minSubtotal: 20, combinable: false }), "USD"),
    "Code SOLO takes $5 off orders of $20 or more. Using it turns off other offers on that order",
    "exclusive, in dollars:",
  );
  eq(say(base("BXGY", { buy: 2, free: 1 })), null, "nothing picked yet: no sentence");
});

// The test reads the numbers back OUT of the sentence, and works out what the
// cart must do from those alone, so a wrong sentence and a wrong example both fail.
const amount = (s) => Number(String(s).replace(/[^0-9.]/g, ""));
function readSentence(sentence) {
  let m;
  if ((m = /^Buy (\d+) (?:of .+|products? tagged “.+”|products? of type “.+”), get (\d+) free$/.exec(sentence))) return { type: "BXGY", buy: +m[1], free: +m[2] };
  if ((m = /^Buy (\d+) or more .+?, get ([\d.]+)% off((?:; \d+ or more, [\d.]+% off)*)$/.exec(sentence))) {
    const tiers = [{ minQty: +m[1], percent: +m[2] }, ...[...m[3].matchAll(/; (\d+) or more, ([\d.]+)% off/g)].map((x) => ({ minQty: +x[1], percent: +x[2] }))];
    return { type: "TIERED_QTY", tiers };
  }
  if ((m = /^Spend more than (.+?), get (.+) free$/.exec(sentence))) return { type: "FREE_GIFT", threshold: amount(m[1]), gift: m[2] };
  if ((m = /^Code (\S+) takes (.+?) off (?:orders of (.+?) or more|the order)(\. Using it turns off other offers on that order)?$/.exec(sentence)))
    return { type: "COUPON", code: m[1], percent: m[2].endsWith("%") ? amount(m[2]) : null, fixed: m[2].endsWith("%") ? null : amount(m[2]), min: m[3] ? amount(m[3]) : 0, exclusive: !!m[4] };
  return null;
}
// What the sentence promises for one cart line of `qty` × `price`.
function promised(claim, lines, coupon) {
  const qty = lines.reduce((s, l) => s + l.quantity, 0);
  const price = lines[0].price;
  const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  if (claim.type === "BXGY") return { discount: Math.round(Math.floor(qty / (claim.buy + claim.free)) * claim.free * price), gift: false };
  if (claim.type === "TIERED_QTY") {
    const tier = [...claim.tiers].filter((x) => qty >= x.minQty).sort((a, b) => b.minQty - a.minQty)[0];
    return { discount: tier ? Math.round((price * qty * tier.percent) / 100) : 0, gift: false };
  }
  if (claim.type === "FREE_GIFT") return { discount: 0, gift: subtotal > claim.threshold };
  const valid = coupon === claim.code && subtotal >= claim.min;
  return { discount: !valid ? 0 : claim.percent != null ? Math.round((subtotal * claim.percent) / 100) : Math.min(claim.fixed, subtotal), gift: false };
}

// a small deterministic random source
let seed = 20261103;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const priceOf = () => (rnd() < 0.7 ? int(49, 4999) : int(100, 99999) / 100);
function randomCatalog() {
  const n = int(1, 6);
  return Array.from({ length: n }, (_, i) => ({
    variantId: V(500 + i),
    productId: G(500 + i),
    handle: `p-${i}`,
    title: `Item ${i}`,
    variantTitle: pick(["Default Title", "Small", "Large"]),
    productType: pick(["Serums", "Masks"]),
    tags: [pick(["glow", "night", "lip"]), pick(["daily", "sale"])],
    price: priceOf(),
  })).sort((a, b) => a.price - b.price);
}
function randomOffer(catalog) {
  const type = pick(["BXGY", "TIERED_QTY", "FREE_GIFT", "COUPON"]);
  const p = pick(catalog);
  const target = pick([
    { kind: "productId", value: p.productId },
    { kind: "variantId", value: p.variantId },
    { kind: "handle", value: p.handle },
    { kind: "tag", value: pick(p.tags) },
    { kind: "productType", value: p.productType },
  ]);
  if (type === "BXGY") return base(type, { target, buy: int(1, 5), free: int(1, 3) });
  if (type === "TIERED_QTY") return base(type, { target, tiers: Array.from({ length: int(1, 4) }, () => ({ minQty: int(1, 8), percent: int(1, 90) })) });
  if (type === "FREE_GIFT") return base(type, { threshold: rnd() < 0.7 ? int(50, 9999) : int(100, 999999) / 100, gift: { variantId: pick([V(999), catalog[0].variantId]), title: "Gift", value: int(0, 3000) } });
  const fixed = rnd() < 0.5;
  return base(type, {
    code: `CODE${int(1, 999)}`,
    discount: { kind: fixed ? "fixed" : "percent", value: fixed ? int(1, 3000) : int(1, 90) },
    ...(rnd() < 0.6 ? { minSubtotal: rnd() < 0.7 ? int(0, 6000) : int(1, 600000) / 100 } : {}),
    combinable: rnd() < 0.8,
  });
}

await t("on 2,000 generated offers and catalogs, the real engine gives every example exactly what its sentence says", () => {
  const counts = { BXGY: 0, TIERED_QTY: 0, FREE_GIFT: 0, COUPON: 0, nearMiss: 0, steps: 0 };
  for (let i = 0; i < 2000; i++) {
    const catalog = randomCatalog();
    const offer = randomOffer(catalog);
    eq(validateOffer(offer), [], `offer ${i} is a valid offer:`);
    const currency = pick(["INR", "USD", "EUR"]);
    const sentence = PLAIN.offerSentence(offer, { currency, names: Object.fromEntries(catalog.map((c) => [c.productId, c.title])) });
    const claim = readSentence(sentence);
    ok(claim, `offer ${i}: the sentence can't be read back: ${sentence}`);
    const plan = PLAIN.offerExamples(offer, catalog, { currency });
    if (plan.missing) {
      ok(offer.type === "BXGY" || offer.type === "TIERED_QTY" || offer.type === "FREE_GIFT", `offer ${i}: no example for a ${offer.type}`);
      ok(!catalog.some((c) => ENGINE.matchesTarget(c, offer.target)) || offer.type === "FREE_GIFT", `offer ${i}: no example although products match`);
      continue;
    }
    counts[offer.type]++;
    const carts = [...plan.steps, ...(plan.nearMiss ? [plan.nearMiss] : [])];
    counts.steps += plan.steps.length;
    if (plan.nearMiss) counts.nearMiss++;
    for (const ex of carts) {
      ok(ex.lines.every((l) => catalog.some((c) => c.variantId === l.variantId)), `offer ${i}: the example uses a product the store doesn't have`);
      const result = ENGINE.evaluateOffers(ex.lines, { offers: [offer], coupon: ex.coupon });
      const check = PLAIN.checkExample(ex, result);
      ok(check.agrees, `offer ${i} (${sentence}) on ${ex.text}: ${check.differences.join("; ")}`);
      const want = promised(claim, ex.lines, ex.coupon);
      eq(result.discountTotal, want.discount, `offer ${i} (${sentence}), cart ${ex.text}: discount the sentence promises:`);
      eq(result.gifts.length > 0, want.gift, `offer ${i} (${sentence}), cart ${ex.text}: gift the sentence promises:`);
    }
    if (plan.nearMiss) {
      const r = ENGINE.evaluateOffers(plan.nearMiss.lines, { offers: [offer], coupon: plan.nearMiss.coupon });
      ok(!r.appliedOffers.some((a) => a.id === offer.id), `offer ${i}: the near miss gets the offer`);
    }
    const applied = ENGINE.evaluateOffers(plan.example.lines, { offers: [offer], coupon: plan.example.coupon }).appliedOffers.some((a) => a.id === offer.id);
    eq(applied, plan.example.expect.applies, `offer ${i}: does the example get the offer (${sentence}; ${plan.example.text})?`);
    if (!applied) counts.roundsAway = (counts.roundsAway || 0) + 1;
  }
  for (const k of ["BXGY", "TIERED_QTY", "FREE_GIFT", "COUPON"]) ok(counts[k] > 200, `too few ${k} cases: ${counts[k]}`);
  ok((counts.roundsAway || 0) < 40, `too many examples where the discount rounds to nothing: ${counts.roundsAway}`);
  ok(counts.nearMiss > 500 && counts.steps > 1000, `too few near misses or steps: ${JSON.stringify(counts)}`);
});

await t("the simulator's check notices when the cart disagrees with the sentence", () => {
  const catalog = [{ variantId: V(1), productId: G(1), handle: "a", title: "Serum", variantTitle: "Default Title", productType: "Serums", tags: ["glow"], price: 1299 }];
  const offer = base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 2, free: 1 });
  const { example } = PLAIN.offerExamples(offer, catalog);
  eq(PLAIN.checkExample(example, ENGINE.evaluateOffers(example.lines, { offers: [offer] })).agrees, true, "the real engine agrees:");
  const wrong = ENGINE.evaluateOffers(example.lines, { offers: [{ ...offer, free: 2, buy: 1 }] });
  eq(PLAIN.checkExample(example, wrong), { agrees: false, differences: ["discount 2598, expected 1299"] }, "a different rule is caught:");
  const gift = base("FREE_GIFT", { threshold: 1000, gift: { variantId: V(7), title: "Mask", value: 1 } });
  const g = PLAIN.offerExamples(gift, catalog).example;
  eq(PLAIN.checkExample(g, ENGINE.evaluateOffers(g.lines, { offers: [] })).differences, [`gift null, expected ${V(7)}`], "a missing gift is caught:");
  const code = base("COUPON", { code: "TEN", discount: { kind: "percent", value: 10 }, minSubtotal: 2000 });
  const c = PLAIN.offerExamples(code, catalog).nearMiss;
  const accepted = ENGINE.evaluateOffers(c.lines, { offers: [{ ...code, minSubtotal: 0 }], coupon: "TEN" });
  ok(PLAIN.checkExample(c, accepted).differences.some((d) => d.startsWith("code accepted true")), "a code accepted below its minimum is caught");
});

await t("each example's words name the same numbers as the sentence", () => {
  const catalog = [{ variantId: V(1), productId: G(1), handle: "a", title: "Serum", variantTitle: "Default Title", productType: "Serums", tags: ["glow"], price: 1299 }];
  const ex = (o) => PLAIN.offerExamples(o, catalog, { currency: "INR" });
  const bxgy = ex(base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 2, free: 1 }));
  eq(bxgy.example.text, "3 × Serum (₹1,299 each): the shopper pays ₹2,598 instead of ₹3,897. 1 is free.", "buy some:");
  eq(bxgy.nearMiss.text, "2 × Serum: nothing is free yet. The shopper needs 3 in the cart.", "buy some, near miss:");
  const tiered = ex(base("TIERED_QTY", { target: { kind: "tag", value: "glow" }, tiers: [{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }] }));
  eq(tiered.steps.map((s) => s.text), ["2 × Serum: 10% off, so ₹260 saved. The shopper pays ₹2,338.", "3 × Serum: 15% off, so ₹585 saved. The shopper pays ₹3,312."], "steps:");
  const gift = ex(base("FREE_GIFT", { threshold: 2000, gift: { variantId: V(7), title: "Lip Mask", value: 549 } }));
  eq(gift.example.text, "2 × Serum (cart ₹2,598): Lip Mask is added free.", "gift:");
  eq(gift.nearMiss.text, "1 × Serum (cart ₹1,299): no gift. The cart must be over ₹2,000.", "gift, near miss:");
  const code = ex(base("COUPON", { code: "SAVE10", discount: { kind: "percent", value: 10 }, minSubtotal: 2000 }));
  eq(code.example.text, "2 × Serum (cart ₹2,598) with code SAVE10: ₹260 off, so the shopper pays ₹2,338.", "code:");
  eq(code.nearMiss.text, "1 × Serum (cart ₹1,299): the code doesn't work yet. Orders must be ₹2,000 or more.", "code, near miss:");
  const usd = PLAIN.offerExamples(base("COUPON", { code: "TEN", discount: { kind: "fixed", value: 5 } }), [{ ...catalog[0], price: 12.99 }], { currency: "USD" });
  eq(usd.example.text, "1 × Serum (cart $12.99) with code TEN: $5 off, so the shopper pays $7.99.", "dollars:");
});

await t("the simulator runs on this store's own products, for every kind of offer and pick", async () => {
  const names = await inIN(() => CAT.offerTargetNames([{ target: { kind: "productId", value: G(101) } }]));
  eq(names, { [G(101)]: "Radiance Glow Serum" }, "names come from the catalog:");
  const cases = [
    [base("BXGY", { target: { kind: "productId", value: G(101) }, buy: 2, free: 1 }), "Buy 2 of Radiance Glow Serum, get 1 free", /^3 × Radiance Glow Serum — 30ml \(₹1,299 each\)/],
    [base("BXGY", { target: { kind: "variantId", value: V(1012) }, buy: 1, free: 1 }), "Buy 1 of Radiance Glow Serum — 50ml, get 1 free", /^2 × Radiance Glow Serum — 50ml \(₹1,899 each\)/],
    [base("TIERED_QTY", { target: { kind: "tag", value: "glow" }, tiers: [{ minQty: 2, percent: 10 }] }), "Buy 2 or more products tagged “glow”, get 10% off", /^2 × (Radiance Glow Serum — 30ml|Daily Defence SPF 50): 10% off/],
    [base("TIERED_QTY", { target: { kind: "productType", value: "Masks" }, tiers: [{ minQty: 3, percent: 20 }] }), "Buy 3 or more products of type “Masks”, get 20% off", /^3 × Lip Sleeping Mask: 20% off/],
    [base("FREE_GIFT", { threshold: 2500, gift: { variantId: V(1051), title: "Lip Sleeping Mask", value: 549 } }), "Spend more than ₹2,500, get Lip Sleeping Mask free", /^\d+ × (?!Lip Sleeping Mask).+ \(cart ₹[\d,]+\): Lip Sleeping Mask is added free\.$/],
    [base("COUPON", { code: "SAVE10", discount: { kind: "percent", value: 10 }, minSubtotal: 1000 }), "Code SAVE10 takes 10% off orders of ₹1,000 or more", /with code SAVE10/],
  ];
  const ours = new Set(CATALOG.flatMap((p) => p[6].map((v) => v[0])));
  for (const [offer, sentence, text] of cases) {
    const r = await inIN(() => SIM.simulateOffer({ offer }));
    eq(r.ok, true, `${offer.type} ok:`);
    eq(r.currency, "INR", "currency:");
    eq(r.sentence, sentence, `${offer.type} sentence:`);
    ok(text.test(r.example.text), `${offer.type} example: ${r.example.text}`);
    for (const ex of [r.example, r.nearMiss, ...r.steps].filter(Boolean)) {
      ok(ex.agrees, `${offer.type}: ${ex.text} — ${ex.differences?.join("; ")}`);
      ok(!/Sim /.test(ex.text), "fixture product");
    }
    ok(r.example.appliedAlone, `${offer.type}: the example gets the offer`);
    if (r.nearMiss) ok(!r.nearMiss.appliedAlone, `${offer.type}: the near miss doesn't`);
    const plan = await inIN(async () => PLAIN.offerExamples(offer, await CAT.exampleCatalog(offer)));
    ok(plan.example.lines.every((l) => ours.has(l.variantId)), `${offer.type}: example lines are this store's variants`);
  }
});

await t("the simulator says plainly when nothing in the store matches, and works in dollars", async () => {
  const none = await inIN(() => SIM.simulateOffer({ offer: base("BXGY", { target: { kind: "tag", value: "no-such-tag" }, buy: 2, free: 1 }) }));
  eq(none.ok, true, "ok:");
  eq(none.example, null, "no example:");
  eq(none.missing, PLAIN.NO_MATCH, "plain reason:");
  const usd = await inUS(() => SIM.simulateOffer({ offer: base("COUPON", { code: "TENOFF", discount: { kind: "fixed", value: 10 }, minSubtotal: 20 }) }));
  eq(usd.currency, "USD", "store currency:");
  eq(usd.sentence, "Code TENOFF takes $10 off orders of $20 or more", "sentence:");
  ok(!JSON.stringify(usd).includes("₹"), "no rupee sign anywhere in a USD store's simulation");
  ok(usd.example.agrees && /\$/.test(usd.example.text), `example in dollars: ${usd.example.text}`);
});

await t("a store with many products: a big spend is shown with its dearest product, not 40 cheap ones", async () => {
  const BIG = await C.getTenant("of-big");
  await withTenant(BIG, async () => {
    for (let i = 0; i < 40; i++) {
      const n = String(i).padStart(2, "0");
      await db.insertInto("products").values({ id: G(`9${n}`), handle: `filler-${n}`, title: `Sample sachet ${n}`, available: 1, currency: "INR", price_min: 10 + i, price_max: 10 + i, tags: "[]" }).execute();
      await db.insertInto("variants").values({ id: V(`9${n}`), product_id: G(`9${n}`), title: "Default Title", price: 10 + i, currency: "INR", available: 1, position: 0 }).execute();
    }
    await db.insertInto("products").values({ id: G(999), handle: "big-kit", title: "Complete Kit", available: 1, currency: "INR", price_min: 5000, price_max: 5000, tags: "[]" }).execute();
    await db.insertInto("variants").values({ id: V(999), product_id: G(999), title: "Default Title", price: 5000, currency: "INR", available: 1, position: 0 }).execute();
  });
  const r = await withTenant(BIG, () => SIM.simulateOffer({ offer: base("FREE_GIFT", { threshold: 20000, gift: { variantId: V(900), title: "Sample sachet 00", value: 10 } }) }));
  eq(r.example.lines.map((l) => [l.title, l.quantity]), [["Complete Kit", 5]], "5 × the dearest product:");
  ok(r.example.agrees, r.example.text);
});

// ---- the last previous settings, and going back to them ---------------------------------------
console.log("— the last previous settings are kept, and going back is live on the next cart read");

const glowDeal = (free, extra = {}) => base("BXGY", { id: "bxgy-glow-deal", title: "Glow deal", target: { kind: "productId", value: G(101), label: "Radiance Glow Serum" }, buy: 2, free, ...extra });
async function cartDiscount(tenant, lines, coupon = null) {
  return withTenant(tenant, async () => {
    const id = `cart-${Math.random().toString(16).slice(2)}`;
    await CART.createCart(id);
    for (const [variant, qty] of lines) await CART.addItem(id, variant, qty);
    if (coupon) await CART.setCoupon(id, coupon);
    return CART.getCart(id);
  });
}

await t("each change keeps the settings from just before it; saving with no change keeps the way back", async () => {
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(1) }));
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).previous, null, "a new offer has nothing to go back to:");
  const start = "2026-12-01T00:00:00.000Z";
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(2), startsAt: start }));
  let row = await inIN(() => STORE.getOfferRow("bxgy-glow-deal"));
  eq([row.config.free, row.starts_at], [2, start], "live:");
  eq([row.previous.config.free, row.previous.starts_at, row.previous.label], [1, null, "Glow deal"], "kept, schedule included:");
  ok(row.previous.replaced_at, "kept with the time of the change");
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(2), startsAt: start }));
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).previous.config.free, 1, "a save that changes nothing keeps the way back:");
  await inIN(() => STORE.setOfferEnabled("bxgy-glow-deal", false));
  await inIN(() => STORE.setOfferEnabled("bxgy-glow-deal", true));
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).previous.config.free, 1, "turning it off and on doesn't touch it:");
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(2) }));
  row = await inIN(() => STORE.getOfferRow("bxgy-glow-deal"));
  eq([row.previous.config.free, row.previous.starts_at], [2, start], "only the LAST previous settings are kept:");
});

await t("going back restores the last settings, live on the next cart read, and going back again undoes it", async () => {
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(1) }));
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(2) })); // a mistake: buy 2 get 2
  const lines = [[V(1011), 4]];
  eq((await cartDiscount(IN, lines)).discountTotal, 2598, "the mistake is live (2 of 4 free):");
  const back = await inIN(() => STORE.revertOffer("bxgy-glow-deal"));
  eq(back.config.free, 1, "restored:");
  eq(back.previous.config.free, 2, "the undone settings become the way back:");
  eq(back.enabled, true, "still on:");
  eq((await cartDiscount(IN, lines)).discountTotal, 1299, "the very next cart read uses it (1 of 4 free):");
  await inIN(() => STORE.revertOffer("bxgy-glow-deal"));
  eq((await cartDiscount(IN, lines)).discountTotal, 2598, "going back again returns to where the founder started:");
  await inIN(() => STORE.revertOffer("bxgy-glow-deal"));
});

await t("going back keeps an offer that is off, off", async () => {
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(3) }));
  await inIN(() => STORE.setOfferEnabled("bxgy-glow-deal", false));
  const back = await inIN(() => STORE.revertOffer("bxgy-glow-deal"));
  eq([back.enabled, back.config.free], [false, 1], "off, with the earlier settings:");
  eq((await cartDiscount(IN, [[V(1011), 4]])).discountTotal, 0, "still nothing in the cart:");
  await inIN(() => STORE.setOfferEnabled("bxgy-glow-deal", true));
});

await t("going back is refused plainly when there is nothing to go back to, or the offer changed meanwhile", async () => {
  const code = async (fn) => fn().then(() => "ok", (e) => e.code);
  await inIN(() => STORE.upsertOffer({ offer: base("COUPON", { id: "coupon-fresh", code: "FRESH", discount: { kind: "percent", value: 5 } }) }));
  eq(await code(() => inIN(() => STORE.revertOffer("coupon-fresh"))), "NO_PREVIOUS", "new offer:");
  eq(await code(() => inIN(() => STORE.revertOffer("no-such-offer"))), "NOT_FOUND", "unknown:");
  await inIN(() => STORE.upsertOffer({ offer: base("COUPON", { id: "coupon-fresh", code: "FRESH", discount: { kind: "percent", value: 6 } }) }));
  const both = await Promise.all([code(() => inIN(() => STORE.revertOffer("coupon-fresh"))), code(() => inIN(() => STORE.revertOffer("coupon-fresh")))]);
  eq(both.sort(), ["CHANGED", "ok"], "two at once: one goes back, the other is told it changed:");
  eq((await inIN(() => STORE.getOfferRow("coupon-fresh"))).config.discount.value, 5, "went back exactly once:");
  await inIN(() => STORE.deleteOffer("coupon-fresh"));
});

await t("a store whose database predates migration 0019 still saves offers, with nothing to go back to", async () => {
  await withTenant(OLD, () => STORE.upsertOffer({ offer: glowDeal(1) }));
  await withTenant(OLD, () => STORE.upsertOffer({ offer: glowDeal(2) }));
  const row = await withTenant(OLD, () => STORE.getOfferRow("bxgy-glow-deal"));
  eq([row.config.free, row.previous], [2, null], "saved, no way back:");
  eq(await withTenant(OLD, () => STORE.revertOffer("bxgy-glow-deal")).catch((e) => e.code), "NO_PREVIOUS", "going back:");
  eq(await withTenant(OLD, () => STORE.listRecentOfferChanges()), [], "recent changes:");
  eq((await withTenant(OLD, () => STORE.getActiveOffers())).length, 1, "the cart still reads it:");
});

await t("a bundle's offer row has no way back here, so it can't drift from its bundle record", async () => {
  const bundleOffer = (price) => ({ id: "bundle-b-duo", type: "BUNDLE", scope: "line", priority: 5, title: "Duo", items: [{ variantId: V(1011), quantity: 1 }, { variantId: V(1031), quantity: 1 }], price });
  await inIN(() => STORE.upsertOffer({ offer: bundleOffer(1800) }));
  await inIN(() => STORE.upsertOffer({ offer: bundleOffer(1700) })); // as lib/bundles.js syncOffer writes it
  eq((await inIN(() => STORE.getOfferRow("bundle-b-duo"))).previous, null, "no way back offered:");
  const err = await inIN(() => STORE.revertOffer("bundle-b-duo")).catch((e) => e);
  eq([err.code, err.message], ["NOT_HERE", "This offer belongs to a bundle. Change it where you edit the bundle."], "refused plainly:");
  eq((await inIN(() => STORE.getOfferRow("bundle-b-duo"))).config.price, 1700, "unchanged:");
  ok(!(await inIN(() => STORE.listRecentOfferChanges())).some((c) => c.id === "bundle-b-duo"), "not in recent changes");
  const { default: OffersAdmin } = await load("components/admin/OffersAdmin.js", { "@/components/console/Toast": { useToast: () => ({ success() {}, error() {} }) } });
  const row = await inIN(() => STORE.getOfferRow("bundle-b-duo"));
  const html = renderToStaticMarkup(React.createElement(OffersAdmin, { initialOffers: [row], currency: "INR", initialNames: {} }));
  ok(html.includes("Change it in Catalog") && !html.includes(">Edit<") && !html.includes(">Delete<"), "the list sends bundles to Catalog");
  await inIN(() => STORE.deleteOffer("bundle-b-duo"));
});

await t("PUB-04 hook: recent offer changes, newest first, with the settings before and after", async () => {
  await inIN(() => STORE.upsertOffer({ offer: base("COUPON", { id: "coupon-hook", code: "HOOK", discount: { kind: "percent", value: 5 } }) }));
  await new Promise((r) => setTimeout(r, 5));
  await inIN(() => STORE.upsertOffer({ offer: base("COUPON", { id: "coupon-hook", code: "HOOK", discount: { kind: "percent", value: 7 } }) }));
  const recent = await inIN(() => STORE.listRecentOfferChanges());
  eq(recent[0].id, "coupon-hook", "newest first:");
  eq([recent[0].before.discount.value, recent[0].after.discount.value], [5, 7], "before and after:");
  ok(recent.every((r, i) => i === 0 || r.changedAt <= recent[i - 1].changedAt), "ordered by the time of the change");
  ok(recent.some((r) => r.id === "bxgy-glow-deal"), "the earlier change is listed too");
  await inIN(() => STORE.deleteOffer("coupon-hook"));
});

// ---- the API routes, as the console calls them --------------------------------------------------
console.log("— the routes the form calls");
const TR = await tenantRequest();
const ROUTES = {
  list: await load("app/api/admin/offers/route.js", { "@/lib/tenant-request": TR }),
  one: await load("app/api/admin/offers/[id]/route.js", { "@/lib/tenant-request": TR }),
  revert: await load("app/api/admin/offers/[id]/revert/route.js", { "@/lib/tenant-request": TR }),
  simulate: await load("app/api/admin/offers/simulate/route.js", { "@/lib/tenant-request": TR }),
  targets: await load("app/api/admin/offers/targets/route.js", { "@/lib/tenant-request": TR }),
};
const params = (id) => ({ params: Promise.resolve({ id }) });
// what the browser's fetch reaches, per path
async function route(tenantId, method, path, body, opts) {
  const req = request(tenantId, method, path, body, opts);
  let m;
  if (path === "/api/admin/offers") return ROUTES.list[method](req);
  if (path === "/api/admin/offers/simulate") return ROUTES.simulate.POST(req);
  if (path === "/api/admin/offers/targets") return ROUTES.targets.GET(req);
  if ((m = /^\/api\/admin\/offers\/([^/]+)\/revert$/.exec(path))) return ROUTES.revert.POST(req, params(m[1]));
  if ((m = /^\/api\/admin\/offers\/([^/]+)$/.exec(path))) return ROUTES.one[method](req, params(m[1]));
  throw new Error(`no route for ${method} ${path}`);
}

await t("routes: the list carries current product names and the store's currency", async () => {
  const r = await json(await route("of-in", "GET", "/api/admin/offers"));
  eq(r.status, 200, "status:");
  eq(r.body.currency, "INR", "currency:");
  eq(r.body.names[G(101)], "Radiance Glow Serum", "names:");
  eq((await json(await route("of-us", "GET", "/api/admin/offers"))).body.currency, "USD", "USD store:");
});

await t("routes: go back over the API, with sign-in, same-site and role checks", async () => {
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(1) }));
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(2) }));
  const path = "/api/admin/offers/bxgy-glow-deal/revert";
  eq((await route("of-in", "POST", path, undefined, { cookie: null })).status, 401, "signed out:");
  eq((await route("of-in", "POST", path, undefined, { origin: "https://evil.test" })).status, 403, "another site:");
  const supportU = await I.createUser({ email: "support@in.test", password: "support-pass-com03" });
  await I.addMembership(supportU.id, "of-in", "support");
  const supportTok = (await S.createSession({ userId: supportU.id, kind: "merchant", ttlMs: 60_000 })).token;
  eq((await route("of-in", "POST", path, undefined, { cookie: supportTok })).status, 403, "read-only support role:");
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).config.free, 2, "nothing changed by the refusals:");
  const okRes = await json(await route("of-in", "POST", path, undefined, { origin: "http://of-in.test" }));
  eq([okRes.status, okRes.body.offer.config.free], [200, 1], "owner goes back:");
  eq((await json(await route("of-in", "POST", "/api/admin/offers/no-such/revert"))).status, 404, "unknown offer:");
  await inIN(() => STORE.upsertOffer({ offer: base("COUPON", { id: "coupon-solo", code: "SOLO", discount: { kind: "percent", value: 5 } }) }));
  const none = await json(await route("of-in", "POST", "/api/admin/offers/coupon-solo/revert"));
  eq([none.status, none.body.code], [409, "NO_PREVIOUS"], "nothing to go back to:");
  ok(!/previous_config|sql/i.test(none.body.error), `plain message: ${none.body.error}`);
  await inIN(() => STORE.deleteOffer("coupon-solo"));
});

await t("routes: tags and types to pick from, with counts and the dearest price", async () => {
  const r = await json(await route("of-in", "GET", "/api/admin/offers/targets"));
  eq(r.status, 200, "status:");
  eq(r.body.tags.find((x) => x.value === "glow"), { value: "glow", count: 2, maxPrice: 1899 }, "glow:");
  eq(r.body.types.map((x) => x.value).sort(), ["Cleansers", "Masks", "Moisturizers", "Serums", "Sun care"], "types:");
  eq((await route("of-in", "GET", "/api/admin/offers/targets", undefined, { cookie: null })).status, 401, "signed out:");
});

await t("routes: the simulator answers with the store's example, and refuses an invalid offer", async () => {
  const r = await json(await route("of-in", "POST", "/api/admin/offers/simulate", { offer: glowDeal(1) }));
  eq([r.status, r.body.sentence], [200, "Buy 2 of Radiance Glow Serum, get 1 free"], "ok:");
  ok(r.body.example.agrees, "agrees");
  eq(r.body.facts.maxTargetPrice, 1899, "the dearest variant it covers:");
  eq((await route("of-in", "POST", "/api/admin/offers/simulate", { offer: { id: "x", type: "COUPON" } })).status, 422, "invalid:");
});

// ---- the form, on a small hook driver ------------------------------------------------------
console.log("— the form: pick, check, start; edit live offers safely");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Runs the real OfferForm as a function with stand-in hooks (effects run after
// each render, as React would). Child components are not expanded; pickers
// and dialogs are driven through the props the form gives them.
async function mountForm(props, tenantId = "of-in") {
  const inflight = new Set();
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const p = (async () => {
      const res = await route(tenantId, method, url, body);
      const data = await res.json();
      return { ok: res.status < 400, status: res.status, json: async () => data };
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  };
  const slots = [];
  let cursor = 0;
  let pending = [];
  const hooks = {
    useState(init) {
      const k = cursor++;
      if (!(k in slots)) slots[k] = typeof init === "function" ? init() : init;
      return [slots[k], (v) => void (slots[k] = typeof v === "function" ? v(slots[k]) : v)];
    },
    useRef(init) {
      const k = cursor++;
      if (!(k in slots)) slots[k] = { current: init };
      return slots[k];
    },
    useEffect(fn, deps) {
      const k = cursor++;
      const prev = slots[k];
      if (prev && deps && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
      const slot = { deps, cleanup: null };
      slots[k] = slot;
      pending.push(() => {
        prev?.cleanup?.();
        const c = fn();
        slot.cleanup = typeof c === "function" ? c : null;
      });
    },
  };
  const { default: OfferForm } = await load("components/admin/OfferForm.js", { react: hooks });
  const done = [];
  const changed = [];
  const allProps = { onDone: (r) => done.push(r), onCancel() {}, onChanged: () => changed.push(1), ...props };
  const render = () => {
    cursor = 0;
    pending = [];
    const tree = OfferForm(allProps);
    for (const run of pending) run();
    return tree;
  };
  const nodes = () => {
    const out = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!React.isValidElement(n)) return;
      out.push(n);
      if (n.type?.name === "SimulatorResult") walk(n.type(n.props));
      Object.values(n.props).forEach(walk);
    };
    walk(render());
    return out;
  };
  const textOf = (n) => {
    if (Array.isArray(n)) return n.map(textOf).join("");
    if (typeof n === "string" || typeof n === "number") return String(n);
    if (!React.isValidElement(n)) return "";
    if (n.type?.name === "SimulatorResult") return textOf(n.type(n.props));
    return [n.props.title, n.props.children, n.props.actions, n.props.label].map(textOf).join("");
  };
  const find = (pred, what) => {
    const el = nodes().find(pred);
    ok(el, `not on screen: ${what}`);
    return el;
  };
  const named = (name) => (n) => n.type?.name === name;
  const button = (label) => (n) => n.type?.name === "Button" && textOf(n.props.children).trim() === label;
  const typed = [];
  const view = {
    calls,
    done,
    changed,
    nodes,
    textOf,
    find,
    has: (pred) => nodes().some(pred),
    text: () => textOf(render()),
    sentence: (which = "new") => textOf(find((n) => n.props?.["data-sentence"] === which, `${which} sentence`)),
    button: (label) => find(button(label), `button "${label}"`),
    hasButton: (label) => nodes().some(button(label)),
    click(label) {
      const el = view.button(label);
      ok(!el.props.disabled && !el.props.busy, `button "${label}" can't be pressed`);
      return el.props.onClick?.();
    },
    choose: (label) => find((n) => n.type === "button" && n.props["aria-pressed"] !== undefined && textOf(n.props.children).includes(label), `choice "${label}"`).props.onClick(),
    type(id, value) {
      typed.push(id);
      find((n) => n.props?.id === id, `field ${id}`).props.onChange({ target: { value } });
    },
    typed,
    picker: (title) => find((n) => n.props?.title === title && "open" in n.props, `picker "${title}"`),
    async submit() {
      const form = find((n) => n.type === "form", "the form");
      await form.props.onSubmit({ preventDefault() {} });
      await view.idle();
    },
    async idle() {
      await sleep(400); // the form waits 350ms after the last change before it checks
      while (inflight.size) await Promise.all([...inflight]);
      render();
      while (inflight.size) await Promise.all([...inflight]);
    },
    order: (...preds) => {
      const all = nodes();
      return preds.map((p) => all.findIndex(p));
    },
    unmount() {
      for (const s of slots) s?.cleanup?.();
      globalThis.fetch = savedFetch;
    },
  };
  return view;
}
const refItem = async (tenant, qs) => (await withTenant(tenant, () => handleRefsGet({ url: `http://x.test/api/admin/refs?${qs}`, cookies: { get: (n) => (n === "_admin" ? { value: TOKENS[tenant.id] } : undefined) }, headers: { get: () => null } }))).body.items;
const NUMBER_FIELDS = new Set(["offer-buy", "offer-free", "offer-threshold", "offer-gift-value", "offer-disc-value", "offer-min-subtotal"]);
const IN_NAMES = async () => (await json(await route("of-in", "GET", "/api/admin/offers"))).body;

await t("Buy some, get some free: started by picking a product, no identifier typed, and the cart applies it", async () => {
  await inIN(() => db.deleteFrom("offers").execute());
  const v = await mountForm({ existing: null, currency: "INR", names: {}, offers: [] });
  eq(v.hasButton("Start offer"), false, "no start button before a kind is chosen");
  v.choose("Buy some, get some free");
  v.choose("One product");
  v.click("Choose a product");
  const [serum] = await refItem(IN, "type=product&q=Radiance");
  v.picker("Choose the product").props.onConfirm([serum]);
  eq(v.sentence(), "Buy 2 of Radiance Glow Serum, get 1 free", "sentence from the pick:");
  await v.idle(); // the example loads by itself
  const sim = v.find((n) => n.type?.name === "SimulatorResult", "the example").props.sim;
  ok(sim.example.agrees && /^3 × Radiance Glow Serum — 30ml/.test(sim.example.text), `example: ${sim.example.text}`);
  const [iSentence, iExample, iButton] = v.order((n) => n.props?.["data-sentence"] === "new", (n) => n.props?.["data-simulator"] === "result", (n) => n.type?.name === "Button" && n.props.type === "submit");
  ok(iSentence >= 0 && iSentence < iExample && iExample < iButton, `the start button sits below the sentence and the example: ${[iSentence, iExample, iButton]}`);
  eq(v.textOf(v.find((n) => n.type?.name === "Button" && n.props.type === "submit", "submit").props.children), "Start offer", "primary label:");
  await v.submit();
  const post = v.calls.find((c) => c.method === "POST" && c.url === "/api/admin/offers");
  eq(post.body.offer.target, { kind: "productId", value: G(101), label: "Radiance Glow Serum" }, "target from the picker:");
  eq(post.body.offer.title, "Buy 2 of Radiance Glow Serum, get 1 free", "blank title becomes the sentence:");
  ok(/^bxgy-radiance-glow-serum-[0-9a-f]{6}$/.test(post.body.offer.id), `id made for the founder: ${post.body.offer.id}`);
  eq(post.body.enabled, true, "starts live:");
  eq(v.done.length, 1, "the form closes");
  eq(v.typed.filter((id) => !NUMBER_FIELDS.has(id)), [], "nothing but numbers typed:");
  eq((await cartDiscount(IN, [[V(1011), 3]])).discountTotal, 1299, "the next cart gets it:");
  await inIN(() => STORE.deleteOffer(post.body.offer.id));
  v.unmount();
});

await t("Buy more, save more: started by picking a tag from the store's list, steps typed as numbers", async () => {
  const v = await mountForm({ existing: null, currency: "INR", names: {}, offers: [] });
  v.choose("Buy more, save more");
  v.choose("Products with a tag");
  v.click("Choose a tag");
  await v.idle();
  const picker = v.picker("Choose a tag");
  eq(picker.props.options.map((o) => o.value), ["glow", "daily", "lip", "night", "serum", "gentle"].sort((a, b) => (a === "glow" ? -1 : b === "glow" ? 1 : a.localeCompare(b))), "the store's own tags:");
  picker.props.onPick("glow");
  v.click("Add a step");
  eq(v.sentence(), "Buy 2 or more products tagged “glow”, get 10% off; 3 or more, 15% off", "sentence:");
  await v.idle();
  const sim = v.find((n) => n.type?.name === "SimulatorResult", "the example").props.sim;
  eq(sim.steps.length, 2, "one example per step:");
  ok(sim.steps.every((s) => s.agrees), "each step agrees");
  await v.submit();
  eq(v.done.length, 1, "started");
  eq(v.typed.filter((id) => !NUMBER_FIELDS.has(id)), [], "nothing but numbers typed:");
  eq((await cartDiscount(IN, [[V(1031), 2]])).appliedOffers.find((o) => o.type === "TIERED_QTY")?.amount, 180, "2 × SPF (tagged glow): 10% of ₹1,798:");
  await inIN(() => STORE.deleteOffer(v.calls.find((c) => c.method === "POST" && c.url === "/api/admin/offers").body.offer.id));
  v.unmount();
});

await t("Free gift over a spend: the gift is picked, its worth filled in, the amount typed as a number", async () => {
  const v = await mountForm({ existing: null, currency: "INR", names: {}, offers: [] });
  v.choose("Free gift over a spend");
  v.type("offer-threshold", "2000");
  v.click("Choose the gift");
  const [mask] = await refItem(IN, "type=product&q=Lip");
  const [maskVariant] = await refItem(IN, `type=variant&product=${encodeURIComponent(mask.id)}`);
  v.picker("Choose the free gift").props.onConfirm({ variantId: maskVariant.id, productId: mask.id, productHandle: mask.handle, label: mask.title, variant: maskVariant, product: mask });
  eq(v.find((n) => n.props?.id === "offer-gift-value", "worth").props.value, "549", "worth filled from the price:");
  eq(v.sentence(), "Spend more than ₹2,000, get Lip Sleeping Mask free", "sentence:");
  await v.submit();
  const post = v.calls.find((c) => c.method === "POST" && c.url === "/api/admin/offers");
  eq(post.body.offer.gift.variantId, V(1051), "gift from the picker:");
  eq(v.typed.filter((id) => !NUMBER_FIELDS.has(id)), [], "nothing but numbers typed:");
  const cart = await cartDiscount(IN, [[V(1021), 2]]);
  eq(cart.gifts.map((g) => g.variantId), [V(1051)], "the next cart over ₹2,000 gets the gift:");
  await inIN(() => STORE.deleteOffer(post.body.offer.id));
  v.unmount();
});

await t("Discount code: a code is suggested, so it starts with nothing typed at all", async () => {
  const v = await mountForm({ existing: null, currency: "INR", names: {}, offers: [] });
  v.choose("Discount code");
  eq(v.find((n) => n.props?.id === "offer-code", "code").props.value, "SAVE10", "suggested:");
  v.find((n) => n.props?.["aria-label"] === "Kind of discount", "kind").props.onChange({ target: { value: "fixed" } });
  eq(v.find((n) => n.props?.id === "offer-code", "code").props.value, "FLAT10", "follows the discount until the founder types one:");
  v.find((n) => n.props?.["aria-label"] === "Kind of discount", "kind").props.onChange({ target: { value: "percent" } });
  eq(v.sentence(), "Code SAVE10 takes 10% off the order", "sentence:");
  await v.submit();
  eq(v.done.length, 1, "started");
  eq(v.typed, [], "nothing typed:");
  const cart = await cartDiscount(IN, [[V(1041), 1]], "SAVE10");
  eq(cart.couponStatus?.valid && cart.discountTotal, 65, "the next cart takes the code:");
  await inIN(() => STORE.deleteOffer(v.calls.find((c) => c.method === "POST" && c.url === "/api/admin/offers").body.offer.id));
  v.unmount();
});

const liveRow = async (id) => {
  const list = await IN_NAMES();
  return { row: list.offers.find((o) => o.id === id), names: list.names };
};

await t("editing a live offer: old and new sentences side by side, then 'Update live offer'", async () => {
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(1) }));
  const { row, names } = await liveRow("bxgy-glow-deal");
  const v = await mountForm({ existing: row, currency: "INR", names, offers: [row] });
  eq(v.sentence("old"), "Buy 2 of Radiance Glow Serum, get 1 free", "live now:");
  eq(v.sentence("new"), "Buy 2 of Radiance Glow Serum, get 1 free", "after:");
  const submit = () => v.find((n) => n.type?.name === "Button" && n.props.type === "submit", "submit");
  eq([v.textOf(submit().props.children), submit().props.disabled], ["Update live offer", true], "nothing to update yet:");
  ok(v.text().includes("No changes yet."), "says so");
  v.type("offer-free", "2");
  const compare = v.find((n) => n.props?.["data-compare"] === "sentences", "side by side");
  const both = [];
  const walk = (n) => (Array.isArray(n) ? n.forEach(walk) : React.isValidElement(n) && (n.props["data-sentence"] && both.push([n.props["data-sentence"], v.textOf(n.props.children)]), Object.values(n.props).forEach(walk)));
  walk(compare);
  eq(both, [["old", "Buy 2 of Radiance Glow Serum, get 1 free"], ["new", "Buy 2 of Radiance Glow Serum, get 2 free"]], "both in one place:");
  eq(submit().props.disabled, false, "update enabled once changed:");
  await v.submit();
  eq(v.calls.find((c) => c.method === "PUT").url, "/api/admin/offers/bxgy-glow-deal", "updates in place:");
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).previous.config.free, 1, "the way back is kept:");
  v.unmount();
});

await t("'Turn off' is always at the top of a live offer, and takes it out of the next cart", async () => {
  const { row, names } = await liveRow("bxgy-glow-deal");
  const v = await mountForm({ existing: row, currency: "INR", names, offers: [row] });
  ok(v.hasButton("Turn off"), "shown on open");
  v.type("offer-buy", ""); // a half-finished edit
  ok(v.hasButton("Turn off"), "still shown while the form has problems");
  v.type("offer-buy", "2");
  await v.click("Turn off");
  await v.idle();
  ok(v.hasButton("Turn on") && !v.hasButton("Turn off"), "now offers Turn on");
  eq(v.changed.length, 1, "the list is told");
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).enabled, false, "off in the database:");
  const after = await cartDiscount(IN, [[V(1011), 4]]);
  eq([after.appliedOffers.some((o) => o.id === "bxgy-glow-deal"), after.discountTotal], [false, 0], "the next cart has no discount:");
  eq(v.textOf(v.find((n) => n.type?.name === "Button" && n.props.type === "submit", "submit").props.children), "Save changes", "an offer that's off says Save changes, not 'live':");
  await v.click("Turn on");
  await v.idle();
  v.unmount();
});

await t("'Go back to previous offer settings' shows the earlier sentence, asks once, and is live on the next cart read", async () => {
  const { row, names } = await liveRow("bxgy-glow-deal"); // live: get 2 free; before: get 1 free
  eq(row.previous.config.free, 1, "has a way back:");
  const v = await mountForm({ existing: row, currency: "INR", names, offers: [row] });
  eq(v.sentence("previous"), "Buy 2 of Radiance Glow Serum, get 1 free", "earlier sentence:");
  const dialog = () => v.find((n) => n.type?.name === "ConfirmDialog", "confirm");
  eq(dialog().props.open, false, "asks only when pressed:");
  v.click("Go back to previous offer settings");
  eq(dialog().props.open, true, "asks:");
  await dialog().props.onConfirm();
  eq(v.done.at(-1)?.reverted, true, "closes as reverted:");
  eq((await inIN(() => STORE.getOfferRow("bxgy-glow-deal"))).config.free, 1, "restored:");
  const next = await cartDiscount(IN, [[V(1011), 4]]);
  eq(next.appliedOffers.find((o) => o.id === "bxgy-glow-deal")?.amount, 1299, "the next cart read uses it:");
  v.unmount();
  const fresh = await mountForm({ existing: { ...row, previous: null }, currency: "INR", names, offers: [] });
  ok(!fresh.hasButton("Go back to previous offer settings"), "no button when there's nothing to go back to");
  fresh.unmount();
});

await t("form-level warnings: more than half off, or a free item worth more than the threshold; saving is still allowed", async () => {
  eq(PLAIN.FREE_ITEM_WARN_AT.INR, 2000, "the threshold, in lib/offers/plain.js:");
  const v = await mountForm({ existing: null, currency: "INR", names: {}, offers: [] });
  v.choose("Buy more, save more");
  v.choose("Products with a tag");
  v.click("Choose a tag");
  await v.idle();
  v.picker("Choose a tag").props.onPick("glow");
  v.find((n) => n.props?.["aria-label"] === "Step 1: percent off", "step").props.onChange({ target: { value: "60" } });
  const warning = () => v.nodes().find((n) => n.type?.name === "Banner" && n.props.title === "Check this is right");
  ok(warning() && v.textOf(warning()).includes("Buying 2 or more takes 60% off. That's more than half off."), "60% warns");
  const submit = () => v.find((n) => n.type?.name === "Button" && n.props.type === "submit", "submit");
  eq(submit().props.disabled, false, "a warning, not a block:");
  v.find((n) => n.props?.["aria-label"] === "Step 1: percent off", "step").props.onChange({ target: { value: "50" } });
  ok(!warning(), "exactly half off doesn't warn");
  v.unmount();

  const g = await mountForm({ existing: null, currency: "INR", names: {}, offers: [] });
  g.choose("Free gift over a spend");
  g.type("offer-threshold", "1000");
  g.picker("Choose the free gift").props.onConfirm({ variantId: V(1012), productId: G(101), productHandle: "glow-serum", label: "Radiance Glow Serum — 50ml", variant: { price: 1899 }, product: {} });
  ok(g.textOf(g.find((n) => n.type?.name === "Banner" && n.props.title === "Check this is right", "warning")).includes("worth more than the ₹1,000 a shopper must spend"), "gift worth more than the spend warns");
  g.type("offer-gift-value", "2500");
  ok(g.textOf(g.find((n) => n.type?.name === "Banner" && n.props.title === "Check this is right", "warning")).includes("The free gift is worth ₹2,500, which is more than ₹2,000."), "gift over the threshold warns");
  g.type("offer-threshold", "5000");
  g.type("offer-gift-value", "2000");
  ok(!g.nodes().some((n) => n.type?.name === "Banner" && n.props.title === "Check this is right"), "₹2,000 exactly is fine");
  g.unmount();
});

await t("warnings, one by one: the rule, its edge, and validation left exactly as it was", () => {
  const w = (o, opts) => PLAIN.offerWarnings(o, { currency: "INR", ...opts });
  const bx = (buy, free) => base("BXGY", { target: { kind: "tag", value: "glow" }, buy, free });
  eq(w(bx(1, 2)).length, 1, "buy 1 get 2 is more than half:");
  eq(w(bx(1, 1)), [], "buy 1 get 1 is half:");
  eq(w(bx(2, 1), { freeItemValue: 2001 }), ["A free item here can be worth ₹2,001, which is more than ₹2,000."], "an expensive free item:");
  eq(w(bx(2, 1), { freeItemValue: 2000 }), [], "at the threshold:");
  eq(PLAIN.offerWarnings(bx(2, 1), { currency: "USD", freeItemValue: 26 }).length, 1, "USD threshold 25:");
  eq(PLAIN.offerWarnings(bx(2, 1), { currency: "JPY", freeItemValue: 999999 }), [], "a currency with no threshold only gets the half-off checks:");
  const cp = (discount, extra) => base("COUPON", { code: "X1X", discount, ...extra });
  eq(w(cp({ kind: "percent", value: 51 })).length, 1, "51%:");
  eq(w(cp({ kind: "percent", value: 50 })), [], "50%:");
  eq(w(cp({ kind: "fixed", value: 200 })), ["Code X1X takes ₹200 off. On orders under ₹400, that's more than half off."], "fixed, no minimum:");
  eq(w(cp({ kind: "fixed", value: 200 }, { minSubtotal: 400 })), [], "fixed with a minimum of twice:");
  eq(w(cp({ kind: "fixed", value: 200 }, { minSubtotal: 399 })).length, 1, "just under twice:");
  for (const o of [bx(1, 2), cp({ kind: "percent", value: 90 }), base("TIERED_QTY", { target: { kind: "tag", value: "g" }, tiers: [{ minQty: 1, percent: 90 }] })]) eq(validateOffer(o), [], `still valid: ${o.type}`);
});

await t("validation messages reach the founder in plain words, never as field names or a rupee sign", async () => {
  const usd = PLAIN.plainErrors(validateOffer(base("FREE_GIFT", { threshold: 0, gift: { variantId: "gid://v/1" } })), { currency: "USD" });
  eq(usd, ["Enter the amount a cart must be over, more than $0.", "Choose the free gift from your products. It has to be a product from your Shopify catalog."], "gift:");
  const all = [
    ...validateOffer({ id: "x", type: "COUPON" }),
    ...validateOffer(base("TIERED_QTY", { tiers: [{ minQty: 0, percent: 99 }] })),
    ...validateOffer(base("BXGY", { buy: 0, free: 0 })),
    ...validateOffer(base("COUPON", { code: "a b", discount: { kind: "percent", value: 95 }, minSubtotal: -1, combinable: "yes" })),
    "Schedule: start must be before end",
  ];
  for (const m of PLAIN.plainErrors(all, { currency: "USD" })) ok(!/[.[\]:]\w|₹|gid|target|minQty|minSubtotal/.test(m.replace(/\.$/, "").replace(/\. /g, " ")), `not plain: ${m}`);
  const v = await mountForm({ existing: null, currency: "USD", names: {}, offers: [] }, "of-us");
  v.choose("Free gift over a spend");
  v.type("offer-threshold", "30");
  v.picker("Choose the free gift").props.onConfirm({ variantId: "gid://v/1", productId: "gid://p/1", productHandle: "x", label: "Not from Shopify", variant: { price: 5 }, product: {} });
  ok(v.text().includes("Choose the free gift from your products. It has to be a product from your Shopify catalog."), "said in the form");
  eq(v.find((n) => n.type?.name === "Button" && n.props.type === "submit", "submit").props.disabled, true, "start waits:");
  ok(!v.text().includes("₹"), "no rupee sign in a USD store's form");
  v.unmount();
});

await t("a code another offer already uses is flagged in the form", async () => {
  const other = { id: "coupon-other", type: "COUPON", config: { code: "SAVE10" } };
  const v = await mountForm({ existing: null, currency: "INR", names: {}, offers: [other] });
  v.choose("Discount code");
  ok(v.text().includes("Another offer already uses the code SAVE10."), "flagged");
  v.unmount();
});

await t("the model: new ids never collide, edits keep the id, and a saved 'handle' pick still reads as one product", () => {
  const offer = base("BXGY", { target: { kind: "productId", value: G(1), label: "Serum" }, buy: 2, free: 1 });
  const ids = new Set(Array.from({ length: 200 }, () => MODEL.newOfferId(offer)));
  eq(ids.size, 200, "200 new ids:");
  for (const id of ids) eq(validateOffer({ ...offer, id }), [], `valid id ${id}`);
  ok(/^coupon-[a-z0-9-]+-[0-9a-f]{6}$/.test(MODEL.newOfferId(base("COUPON", { code: "ÉTÉ 20%" }))), "odd characters fold into the id");
  const legacy = MODEL.formFromOffer({ type: "TIERED_QTY", config: { target: { kind: "handle", value: "glow-serum" }, tiers: [{ minQty: 2, percent: 15 }] } });
  eq(legacy.choice, "product", "handle shows as One product:");
  const back = MODEL.offerFromForm(legacy, { id: "serum-duo" });
  eq(back.target, { kind: "handle", value: "glow-serum" }, "kept exactly unless picked again:");
  ok(MODEL.sameSettings({ type: "COUPON", code: "A", discount: { kind: "percent", value: 1 } }, { type: "COUPON", scope: "order", priority: 50, combinable: true, code: "A", discount: { value: 1, kind: "percent" } }), "defaults and key order don't count as a change");
});

// ---- rendered with react-dom/server ---------------------------------------------------------------
console.log("— rendered");
// one live offer of each kind, and one that's off
await inIN(async () => {
  await db.deleteFrom("offers").execute();
  await STORE.upsertOffer({ offer: glowDeal(1) });
  await STORE.upsertOffer({ offer: glowDeal(2) });
  await STORE.upsertOffer({ offer: base("TIERED_QTY", { id: "tiered-glow", title: "Glow steps", target: { kind: "tag", value: "glow" }, tiers: [{ minQty: 2, percent: 10 }] }) });
  await STORE.upsertOffer({ offer: base("FREE_GIFT", { id: "gift-mask", title: "Free mask", threshold: 2500, gift: { variantId: V(1051), title: "Lip Sleeping Mask", value: 549 } }) });
  await STORE.upsertOffer({ offer: base("COUPON", { id: "coupon-flat", title: "FLAT200", code: "FLAT200", discount: { kind: "fixed", value: 200 }, minSubtotal: 999 }), enabled: false });
});

await t("rendered: every kind of offer, new and live, in plain words with the right money and labels", async () => {
  const { default: OfferForm } = await load("components/admin/OfferForm.js");
  const render = (props) => renderToStaticMarkup(React.createElement(OfferForm, { onDone() {}, onCancel() {}, offers: [], names: {}, ...props }));
  const list = (await IN_NAMES()).offers;
  const problems = [];
  for (const row of list) {
    const html = render({ existing: row, currency: "INR", names: (await IN_NAMES()).names });
    problems.push(...rawWordsIn(html, `live ${row.type}`));
    const iSentence = html.indexOf('data-sentence="new"');
    const iExample = html.indexOf('data-simulator="result"');
    const iButton = html.indexOf(row.enabled ? ">Update live offer<" : ">Save changes<");
    if (!(iSentence > 0 && iSentence < iExample && iExample < iButton)) problems.push(`${row.type}: button not below sentence and example (${iSentence}, ${iExample}, ${iButton})`);
    if (row.enabled && !html.includes(">Turn off<")) problems.push(`${row.type}: no Turn off`);
  }
  eq(list.map((o) => o.type).sort(), ["BXGY", "COUPON", "FREE_GIFT", "TIERED_QTY"], "rendered every kind:");
  const usd = render({ existing: { ...rawGift, previous: null }, currency: "USD" });
  if (usd.includes("₹")) problems.push("USD gift form shows ₹");
  if (!usd.includes("Cart total over ($)")) problems.push("USD gift form lacks the dollar label");
  ok(!problems.length, problems.join("; "));
});

await t("rendered: the list reads each offer as its sentence, with plain kinds and switches that say Turn off", async () => {
  const { default: OffersAdmin } = await load("components/admin/OffersAdmin.js", { "@/components/console/Toast": { useToast: () => ({ success() {}, error() {} }) } });
  const { offers, names, currency } = await IN_NAMES();
  const html = renderToStaticMarkup(React.createElement(OffersAdmin, { initialOffers: offers, initialNames: names, currency }));
  noRawWords(html, "list");
  for (const o of offers) ok(html.includes(PLAIN.offerSentence(o.config, { names, currency }).replace(/“/g, "“").replace(/&/g, "&amp;")), `sentence for ${o.id}`);
  ok(html.includes("Buy some, get some free") && html.includes("Discount code"), "plain kinds");
  ok(html.includes('aria-label="Turn off '), "switch says Turn off");
});

// ---- guards ---------------------------------------------------------------------------------
console.log("— guards");

await t("no money sign is hard-coded in the offer console or its shared source", async () => {
  for (const f of ["components/admin/OfferForm.js", "components/admin/OffersAdmin.js", "components/admin/offerFormModel.js", "lib/offers/plain.js", "lib/offers/simulate.js", "lib/offers/catalog.js", "lib/offers/engine.js"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!src.includes("₹"), `${f} contains a rupee sign`);
  }
});

await t("the console's offer code never reaches the built-in store offers (they'd ship to every store's browser)", async () => {
  const seen = new Set();
  const walk = async (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const src = await readFile(abs, "utf8");
    for (const [, spec] of src.matchAll(/(?:^|\n)\s*import[^"']*["']([^"']+)["']/g)) {
      const dep = resolveSpec(spec, abs);
      if (dep) await walk(dep);
    }
  };
  await walk(join(ROOT, "components/admin/OfferForm.js"));
  await walk(join(ROOT, "components/admin/OffersAdmin.js"));
  ok(seen.has(join(ROOT, "lib/offers/plain.js")) && seen.has(join(ROOT, "lib/offers/match.js")), "the walk reaches the shared source");
  ok(!seen.has(join(ROOT, "lib/offers/config.js")), "lib/offers/config.js is imported by the console");
  ok(!seen.has(join(ROOT, "lib/offers/engine.js")), "the engine (and its built-in offers) is imported by the console");
  ok(!seen.has(join(ROOT, "lib/db.js")), "the database client is imported by the console");
  eq(ENGINE.matchesTarget, (await import("../lib/offers/match.js")).matchesTarget, "the engine uses the same matching rule:");
});

await t("the offer suites are in the test gate", async () => {
  const { scripts } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  eq([scripts["test:offers"], scripts["test:offers-admin"], scripts["test:offer-form"]], ["node scripts/test-offers.js", "node scripts/test-offers-admin.js", "node scripts/test-offer-form.js"], "scripts:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of DBS) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
