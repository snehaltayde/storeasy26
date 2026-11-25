// COM-03 suite: starting an offer in plain words, safely.
//   pnpm test:offer-form
// Real code paths throughout: the real engine, the real simulator and store
// against real tenant file databases (all tenant migrations applied), the
// real API route files called with real requests (host-resolved tenant, real
// requireAdmin). The old OfferForm and OffersAdmin went in Phase 2 line 11;
// the offers screens are test:offers-console's. No browser is
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

await t("an example avoids a product whose discount would round to nothing, and says so when every one would", () => {
  const sachet = { variantId: V(2), productId: G(2), handle: "s", title: "Sachet", variantTitle: "Default Title", productType: "Serums", tags: ["glow"], price: 0.4 };
  const serum = { ...sachet, variantId: V(3), productId: G(3), handle: "t", title: "Serum", price: 1299 };
  const steps = base("TIERED_QTY", { target: { kind: "tag", value: "glow" }, tiers: [{ minQty: 2, percent: 10 }] });
  const plan = PLAIN.offerExamples(steps, [sachet, serum]);
  eq([plan.example.lines[0].title, plan.example.expect.applies], ["Serum", true], "buy more: the product where 10% is worth something:");
  const bx = PLAIN.offerExamples(base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 1, free: 1 }), [sachet, serum]);
  eq(bx.example.lines[0].title, "Serum", "buy some, too:");
  const only = PLAIN.offerExamples(steps, [sachet]);
  eq(only.example.text, "2 × Sachet: 10% off rounds to nothing on a cart this small.", "said plainly:");
  eq([ENGINE.evaluateOffers(only.example.lines, { offers: [steps] }).discountTotal, only.example.expect.applies], [0, false], "and the engine agrees:");
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

await t("going back restores the schedule and the name too", async () => {
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(1) }));
  await inIN(() => STORE.upsertOffer({ offer: glowDeal(1, { title: "Renamed deal" }), startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-02-01T00:00:00.000Z" }));
  const back = await inIN(() => STORE.revertOffer("bxgy-glow-deal"));
  eq([back.label, back.starts_at, back.ends_at], ["Glow deal", null, null], "name and schedule as they were:");
  eq([back.previous.label, back.previous.starts_at], ["Renamed deal", "2027-01-01T00:00:00.000Z"], "the undone ones are the way back:");
  ok((await inIN(() => STORE.getActiveOffers())).some((o) => o.id === "bxgy-glow-deal"), "live again now, not from next year");
});

await t("a save that only reorders the stored settings never offers them as a way back", async () => {
  const offer = base("COUPON", { id: "coupon-order", code: "ORDER", discount: { kind: "percent", value: 5 } });
  // stored the way an older writer laid it out: same settings, keys in another order
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(offer).reverse()));
  await inIN(() => db.insertInto("offers").values({ id: offer.id, type: offer.type, label: offer.title, enabled: 1, config: reordered, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }).execute());
  await inIN(() => STORE.upsertOffer({ offer }));
  const raw = await inIN(() => db.selectFrom("offers").select("previous_config").where("id", "=", offer.id).executeTakeFirst());
  ok(raw.previous_config, "the database kept a snapshot, because the text differs");
  eq((await inIN(() => STORE.getOfferRow(offer.id))).previous, null, "but the same settings aren't offered as a way back:");
  eq(await inIN(() => STORE.revertOffer(offer.id)).catch((e) => e.code), "NO_PREVIOUS", "going back says there's nothing:");
  await inIN(() => STORE.deleteOffer(offer.id));
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
  // Phase 2 line 11: the old screen's rendered half went with it (the offers screens: test:offers-console)
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
  const steep = await json(await route("of-in", "POST", "/api/admin/offers/simulate", { offer: base("TIERED_QTY", { target: { kind: "tag", value: "glow" }, tiers: [{ minQty: 2, percent: 60 }] }) }));
  eq(steep.body.warnings, ["Buying 2 or more takes 60% off. That's more than half off."], "the same warnings as the form:");
  eq(r.body.warnings, [], "none for buy 2 get 1 on a ₹1,899 product:");
});

// ---- the form, on a small hook driver ------------------------------------------------------
console.log("— the form: pick, check, start; edit live offers safely");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refItem = async (tenant, qs) => (await withTenant(tenant, () => handleRefsGet({ url: `http://x.test/api/admin/refs?${qs}`, cookies: { get: (n) => (n === "_admin" ? { value: TOKENS[tenant.id] } : undefined) }, headers: { get: () => null } }))).body.items;
const NUMBER_FIELDS = new Set(["offer-buy", "offer-free", "offer-threshold", "offer-gift-value", "offer-disc-value", "offer-min-subtotal"]);
const IN_NAMES = async () => (await json(await route("of-in", "GET", "/api/admin/offers"))).body;







const liveRow = async (id) => {
  const list = await IN_NAMES();
  return { row: list.offers.find((o) => o.id === id), names: list.names };
};





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



await t("the model: new ids never collide, edits keep the id, and a saved 'handle' pick still reads as one product", () => {
  const offer = base("BXGY", { target: { kind: "productId", value: G(1), label: "Serum" }, buy: 2, free: 1 });
  // P4-FIX5: deterministic (the random endings were 6 hex, so 200 random ids
  // collided once). Fixed endings that repeat on purpose: each new id is made
  // with the ids so far as the store's own, so a repeat retries and never clashes.
  const endings = Array.from({ length: 200 }, (_, i) => (0xa00000 + Math.floor(i / 3)).toString(16)); // each ending three times
  const ids = new Set();
  for (const suffix of endings) ids.add(MODEL.newOfferId(offer, { suffix, taken: [...ids] }));
  eq(ids.size, 200, "200 new ids:");
  for (const id of ids) {
    eq(validateOffer({ ...offer, id }), [], `valid id ${id}`);
    ok(/^bxgy-serum-[0-9a-f]{6}$/.test(id), `the id's shape: ${id}`);
  }
  // a clash retries with the next ending, the same way every time (a form's id holds still between renders)
  const taken = ["bxgy-serum-abcdef", "bxgy-serum-abcdf0"];
  eq(MODEL.newOfferId(offer, { suffix: "abcdef", taken }), "bxgy-serum-abcdf1", "past two taken ids:");
  eq(MODEL.newOfferId(offer, { suffix: "abcdef", taken: new Set(taken) }), "bxgy-serum-abcdf1", "a Set of taken ids:");
  eq(MODEL.newOfferId(offer, { suffix: "ffffff", taken: ["bxgy-serum-ffffff"] }), "bxgy-serum-000000", "it wraps at ffffff:");
  eq(MODEL.newOfferId(offer, { suffix: "abcdef" }), "bxgy-serum-abcdef", "nothing taken: the ending as given:");
  eq(MODEL.newOfferId(offer, { suffix: "abcdef", taken: ["coupon-serum-abcdef", "bxgy-serum-abcdef-x"] }), "bxgy-serum-abcdef", "only an exact id counts as taken:");
  // random endings with the ids so far: 200 distinct, whatever the endings are
  const randomIds = [];
  for (let i = 0; i < 200; i++) randomIds.push(MODEL.newOfferId(offer, { taken: randomIds }));
  eq(new Set(randomIds).size, 200, "200 random ids:");
  ok(/^coupon-[a-z0-9-]+-[0-9a-f]{6}$/.test(MODEL.newOfferId(base("COUPON", { code: "ÉTÉ 20%" }))), "odd characters fold into the id");
  const legacy = MODEL.formFromOffer({ type: "TIERED_QTY", config: { target: { kind: "handle", value: "glow-serum" }, tiers: [{ minQty: 2, percent: 15 }] } });
  eq(legacy.choice, "product", "handle shows as One product:");
  const back = MODEL.offerFromForm(legacy, { id: "serum-duo" });
  eq(back.target, { kind: "handle", value: "glow-serum" }, "kept exactly unless picked again:");
  let f = MODEL.updateForm(MODEL.formFromOffer(null), { type: "BXGY" });
  f = MODEL.updateForm(f, { target: { kind: "productId", value: G(1), label: "Serum" } });
  eq(MODEL.updateForm(f, { choice: "product" }).target?.value, G(1), "choosing the same kind keeps the pick:");
  f = MODEL.updateForm(f, { choice: "tag" });
  eq(f.target, null, "switching to a tag clears the product, so no sentence claims a product the founder moved away from:");
  eq(PLAIN.offerSentence(MODEL.offerFromForm(f, { id: "x-y-z" })), null, "no sentence until a tag is picked:");
  ok(MODEL.sameSettings({ type: "COUPON", code: "A", discount: { kind: "percent", value: 1 } }, { type: "COUPON", scope: "order", priority: 50, combinable: true, code: "A", discount: { value: 1, kind: "percent" } }), "defaults and key order don't count as a change");
});

// ---- review fix round 1 ---------------------------------------------------------------------
// The reproductions below were run first against the code before the fix
// (docs/cms-reviews/P1-COM-03.md, "Fix round 1").
console.log("— a name left blank follows the rules when the offer is edited");

// Start an offer the way the form does with the name left blank, then edit it
// the way the form does: formFromOffer → updateForm → offerFromForm → save.
async function startBlankThenEdit(id, start, patch) {
  let f = MODEL.updateForm(MODEL.formFromOffer(null), { type: start.type });
  f = MODEL.updateForm(f, start.form);
  ok(!f.title, "the name is left blank");
  await inIN(() => STORE.upsertOffer({ offer: MODEL.offerFromForm(f, { id, currency: "INR" }) }));
  const { row, names } = await liveRow(id);
  eq(row.config.titleAuto, true, "a blank name is saved marked as automatic:");
  const startedAs = row.label;
  const edit =MODEL.updateForm(MODEL.formFromOffer(row, { names, currency: "INR" }), patch);
  const offer = MODEL.offerFromForm(edit, { id, names, currency: "INR" });
  await inIN(() => STORE.upsertOffer({ offer }));
  const saved = await inIN(() => STORE.getOfferRow(id));
  return { startedAs, offer, saved, names, sentence: PLAIN.offerSentence(offer, { names, currency: "INR" }), fresh: PLAIN.defaultOfferTitle(offer, { names, currency: "INR" }) };
}

await t("a blank name follows the rules on edit: Buy some, get some free (get 2 free → get 1 free)", async () => {
  const id = "bxgy-blank-cream";
  const r = await startBlankThenEdit(id, { type: "BXGY", form: { target: { kind: "productId", value: G(102), label: "Night Repair Cream" }, buy: "1", free: "2" } }, { free: "1" });
  eq(r.startedAs, "Buy 1 of Night Repair Cream, get 2 free", "started with the default name:");
  eq(r.sentence, "Buy 1 of Night Repair Cream, get 1 free", "the founder's new sentence:");
  eq([r.saved.label, r.saved.config.title], [r.sentence, r.sentence], "the saved name follows the new rules:");
  const cart = await cartDiscount(IN, [[V(1021), 2]]);
  eq(cart.appliedOffers.find((o) => o.id === id), { id, type: "BXGY", label: r.sentence, amount: 1799 }, "the shopper's next cart reads what it gives:");
  await inIN(() => STORE.deleteOffer(id));
});

await t("a blank name follows the rules on edit: Free gift over a spend (₹2,000 → ₹3,000)", async () => {
  const id = "gift-blank-mask";
  const gift = { variantId: V(1051), productId: G(105), handle: "lip-mask", title: "Lip Sleeping Mask", value: 549 };
  const r = await startBlankThenEdit(id, { type: "FREE_GIFT", form: { threshold: "2000", gift } }, { threshold: "3000" });
  eq(r.startedAs, "Free Lip Sleeping Mask on orders over ₹2,000", "started with the default name:");
  eq([r.saved.label, r.saved.config.title], ["Free Lip Sleeping Mask on orders over ₹3,000", "Free Lip Sleeping Mask on orders over ₹3,000"], "the saved name follows the new amount:");
  eq((await cartDiscount(IN, [[V(1021), 1], [V(1041), 1]])).gifts.length, 0, "a ₹2,448 cart no longer gets it:");
  const cart = await cartDiscount(IN, [[V(1021), 2]]);
  eq(cart.appliedOffers.find((o) => o.id === id)?.label, "Free Lip Sleeping Mask on orders over ₹3,000", "the next cart (and the Shopify discount description) reads the new amount:");
  await inIN(() => STORE.deleteOffer(id));
});

await t("a blank name follows the rules on edit: Discount code (10% → 25%)", async () => {
  const id = "coupon-blank-names";
  const r = await startBlankThenEdit(id, { type: "COUPON", form: { code: "NAMES10" } }, { discValue: "25" });
  eq(r.startedAs, "NAMES10 · 10% off", "started with the default name:");
  eq([r.saved.label, r.saved.config.title, r.saved.config.code], ["NAMES10 · 25% off", "NAMES10 · 25% off", "NAMES10"], "the saved name follows; the code itself is kept:");
  const cart = await cartDiscount(IN, [[V(1041), 1]], "NAMES10");
  eq([cart.couponStatus?.valid, cart.discountTotal], [true, 162], "the next cart takes 25%:");
  await inIN(() => STORE.deleteOffer(id));
});

await t("a blank name follows the rules on edit: Buy more, save more (another product)", async () => {
  const id = "tiered-blank-names";
  const r = await startBlankThenEdit(
    id,
    { type: "TIERED_QTY", form: { target: { kind: "productId", value: G(102), label: "Night Repair Cream" }, tiers: [{ minQty: "2", percent: "10" }] } },
    { target: { kind: "productId", value: G(104), label: "Gentle Oat Cleanser" } },
  );
  eq(r.startedAs, "Buy more Night Repair Cream, save more", "started with the default name:");
  eq(r.saved.label, "Buy more Gentle Oat Cleanser, save more", "the saved name names the new product:");
  const cart = await cartDiscount(IN, [[V(1041), 2]]);
  eq(cart.appliedOffers.find((o) => o.id === id)?.label, "Buy more Gentle Oat Cleanser, save more · 10% off", "the next cart:");
  await inIN(() => STORE.deleteOffer(id));
});



await t("the model: a saved name equal to the default is treated as automatic, a typed one is kept", () => {
  const cfg = base("BXGY", { target: { kind: "productId", value: G(104), label: "Gentle Oat Cleanser" }, buy: 2, free: 1, title: "Buy 2 of Gentle Oat Cleanser, get 1 free" });
  eq(MODEL.formFromOffer({ type: "BXGY", config: cfg }, { names: { [G(104)]: "Gentle Oat Cleanser" } }).title, "", "matches the default with the catalog's name:");
  eq(MODEL.formFromOffer({ type: "BXGY", config: cfg }, { names: {} }).title, "", "matches the default with the name saved at the pick:");
  eq(MODEL.formFromOffer({ type: "BXGY", config: { ...cfg, title: "Oat deal" } }, { names: {} }).title, "Oat deal", "typed:");
  eq(MODEL.formFromOffer({ type: "BXGY", config: cfg }, { names: { [G(104)]: "Oat Cleanser 150ml" } }).title, "", "unmarked, product renamed since: the name saved at the pick still matches:");
  const byHandle = base("TIERED_QTY", { target: { kind: "handle", value: "oat-cleanser" }, tiers: [{ minQty: 2, percent: 10 }], title: "Buy more Gentle Oat Cleanser, save more" });
  eq(MODEL.formFromOffer({ type: "TIERED_QTY", config: byHandle }, { names: { "oat-cleanser": "Gentle Oat Cleanser" } }).title, "", "unmarked, no saved pick name: the catalog's name matches:");
  // marked automatic, in wording an older version used (the tag in the name):
  // only the mark can tell, so it alone must count
  const older = base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 2, free: 1, title: "Buy 2 products tagged “glow”, get 1 free", titleAuto: true });
  eq(MODEL.formFromOffer({ type: "BXGY", config: older }, { names: {} }).title, "", "marked automatic, in older wording:");
  eq(MODEL.formFromOffer({ type: "BXGY", config: { ...older, titleAuto: undefined } }, { names: {} }).title, older.title, "the same name unmarked is kept as typed:");
  const back = MODEL.offerFromForm(MODEL.formFromOffer({ type: "BXGY", config: cfg }, { names: {} }), { id: cfg.id, names: {} });
  ok(MODEL.sameSettings(back, cfg), "an untouched form saves exactly what was there");
  eq(MODEL.offerFromForm(MODEL.updateForm(MODEL.formFromOffer(null), { type: "COUPON", title: "Big sale" }), { id: "x-y-z" }).titleAuto, undefined, "a typed name isn't marked automatic:");
  eq(MODEL.offerFromForm(MODEL.updateForm(MODEL.formFromOffer(null), { type: "COUPON" }), { id: "x-y-z" }).titleAuto, true, "a blank one is:");
});

await t("default names never show a store's internal tags or types to shoppers", () => {
  const dt = (target, extra) => PLAIN.defaultOfferTitle(base(extra.tiers ? "TIERED_QTY" : "BXGY", { target, ...extra }), { names: { [G(104)]: "Gentle Oat Cleanser" } });
  eq(dt({ kind: "tag", value: "clearance-hidden" }, { buy: 2, free: 1 }), "Buy 2, get 1 free", "tag, buy some get some:");
  eq(dt({ kind: "productType", value: "INT-SKU-TYPE" }, { buy: 3, free: 1 }), "Buy 3, get 1 free", "type, buy some get some:");
  eq(dt({ kind: "tag", value: "clearance-hidden" }, { tiers: [{ minQty: 2, percent: 10 }] }), "Buy more, save more", "tag, buy more save more:");
  eq(dt({ kind: "productId", value: G(104) }, { buy: 2, free: 1 }), "Buy 2 of Gentle Oat Cleanser, get 1 free", "a product keeps its name:");
  eq(PLAIN.offerSentence(base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 2, free: 1 })), "Buy 2 products tagged “glow”, get 1 free", "the founder's sentence still names the tag:");
});

console.log("— going back, safely");



await t("the message after saving says when shoppers really get the offer", () => {
  const at = new Date("2026-06-01T00:00:00.000Z");
  const o = (extra) => ({ label: "Glow deal", enabled: true, starts_at: null, ends_at: null, ...extra });
  eq(MODEL.doneMessage({ created: true, offer: o() }, at), "“Glow deal” has started.", "now:");
  const later = MODEL.doneMessage({ created: true, offer: o({ starts_at: "2026-07-01T00:00:00.000Z" }) }, at);
  ok(/^“Glow deal” starts \d/.test(later) && !later.includes("has started"), `a future start: ${later}`);
  ok(MODEL.doneMessage({ created: true, offer: o({ starts_at: "2026-01-01T00:00:00.000Z", ends_at: "2026-02-01T00:00:00.000Z" }) }, at).includes("dates have already ended"), "dates in the past");
  eq(MODEL.doneMessage({ offer: o() }, at), "Updated. Shoppers get it on their next cart.", "update:");
  ok(MODEL.doneMessage({ offer: o({ enabled: false }) }, at).includes("off"), "an update to an offer that's off");
  eq(MODEL.doneMessage({ reverted: true, offer: o() }, at), "Back to the earlier settings. Shoppers get them on their next cart.", "going back:");
  ok(MODEL.doneMessage({ reverted: true, offer: o({ ends_at: "2026-02-01T00:00:00.000Z" }) }, at).includes("ended"), "going back to dates that ended");
});


console.log("— cases the mutation check found untested");



await t("a big catalog: a tag's products are found even when 500 other products come first", async () => {
  const BIG = await C.getTenant("of-big");
  await withTenant(BIG, async () => {
    const n = (i) => String(i).padStart(3, "0");
    const ids = Array.from({ length: 520 }, (_, i) => i);
    await db.insertInto("products").values(ids.map((i) => ({ id: G(`7${n(i)}`), handle: `aa-${n(i)}`, title: `Aa filler ${n(i)}`, available: 1, currency: "INR", price_min: 20, price_max: 20, tags: '["other"]' }))).execute();
    await db.insertInto("variants").values(ids.map((i) => ({ id: V(`7${n(i)}`), product_id: G(`7${n(i)}`), title: "Default Title", price: 20, currency: "INR", available: 1, position: 0 }))).execute();
    await db.insertInto("products").values({ id: G(8888), handle: "zz-rare", title: "Zz Rare Oil", available: 1, currency: "INR", price_min: 900, price_max: 900, tags: '["rare"]' }).execute();
    await db.insertInto("variants").values({ id: V(8888), product_id: G(8888), title: "Default Title", price: 900, currency: "INR", available: 1, position: 0 }).execute();
  });
  const offer = base("BXGY", { target: { kind: "tag", value: "rare" }, buy: 2, free: 1 });
  const rows = await withTenant(BIG, () => CAT.exampleCatalog(offer));
  eq(rows.map((r) => r.title), ["Zz Rare Oil"], "the tagged product:");
  const sim = await withTenant(BIG, () => SIM.simulateOffer({ offer }));
  ok(sim.example?.agrees && /Zz Rare Oil/.test(sim.example.text), `the example: ${sim.example?.text || sim.missing}`);
});

await t("the engine's matching rule is exact, as it always was (tags and types are case-sensitive)", () => {
  const item = { variantId: "v1", productId: "p1", handle: "glow-serum", tags: ["Glow"], productType: "Serums" };
  const m = ENGINE.matchesTarget;
  eq([m(item, { kind: "tag", value: "Glow" }), m(item, { kind: "tag", value: "glow" }), m(item, { kind: "tag", value: "Glo" })], [true, false, false], "tag:");
  eq([m(item, { kind: "productType", value: "Serums" }), m(item, { kind: "productType", value: "serums" })], [true, false], "type:");
  eq([m(item, { kind: "handle", value: "glow-serum" }), m(item, { kind: "handle", value: "glow" })], [true, false], "handle:");
  eq([m({ ...item, tags: "Glow" }, { kind: "tag", value: "Glow" }), m(item, null), m(item, { kind: "collection", value: "x" })], [false, false, false], "no tags list, no target, unknown kind:");
  const r = ENGINE.evaluateOffers([{ ...item, price: 100, quantity: 3 }], { offers: [base("BXGY", { target: { kind: "tag", value: "glow" }, buy: 2, free: 1 })] });
  eq(r.discountTotal, 0, "a 'glow' offer doesn't apply to a 'Glow' product in the cart:");
});

await t("a bundle's offer can't be turned on, off, changed or deleted from Offers", async () => {
  const bundleOffer = { id: "bundle-b-trio", type: "BUNDLE", scope: "line", priority: 5, title: "Trio", items: [{ variantId: V(1011), quantity: 1 }, { variantId: V(1031), quantity: 1 }], price: 1800 };
  await inIN(() => STORE.upsertOffer({ offer: bundleOffer }));
  const path = "/api/admin/offers/bundle-b-trio";
  const toggle = await json(await route("of-in", "PUT", path, { enabled: false }));
  eq([toggle.status, toggle.body.code], [409, "NOT_HERE"], "turn off:");
  eq((await json(await route("of-in", "PUT", path, { offer: { ...bundleOffer, price: 1 } }))).status, 409, "change:");
  eq((await json(await route("of-in", "DELETE", path))).status, 409, "delete:");
  const row = await inIN(() => STORE.getOfferRow("bundle-b-trio"));
  eq([row.enabled, row.config.price], [true, 1800], "unchanged:");
  // Phase 2 line 11: the old screen's rendered half went with it (the offers screens: test:offers-console)
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



// ---- guards ---------------------------------------------------------------------------------
console.log("— guards");

await t("no money sign is hard-coded in the offer console or its shared source", async () => {
  for (const f of ["components/admin/offers/OfferEditor.js", "components/admin/offers/OffersList.js", "components/admin/offerFormModel.js", "lib/offers/plain.js", "lib/offers/simulate.js", "lib/offers/catalog.js", "lib/offers/engine.js"]) {
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
  // Phase 2 line 11: the offers screens (the old OfferForm and OffersAdmin are gone)
  await walk(join(ROOT, "components/admin/offers/OfferEditor.js"));
  await walk(join(ROOT, "components/admin/offers/OffersList.js"));
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
