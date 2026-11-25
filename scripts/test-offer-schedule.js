// Phase 8 line 5: a founder can schedule a bundle and an offer for a collection.
//   pnpm test:offer-schedule
// 1. windows: UTC ISO, start inclusive, end exclusive, to the millisecond
//    (getActiveOffers, offerScheduleStatus, the bundle's inWindow / getBundle);
//    a bundle's window is its offer row's window; a hand-edited mismatch is
//    not_ready / offer_differs; the anonymous bundle page and card before,
//    during and after (getBundle, bundlesByIds 'scheduled').
// 2. collection offers: membership only from this store's synced
//    collection_products (cart rows carry the handles); store B's handle never
//    matches on A; the collection note gives titles only.
// 3. brute force (PLAYBOOK money lesson): 500 random carts of real collection
//    products, in- and out-of-collection lines: only in-collection lines are
//    discounted, and completing each tier nudge with real collection products
//    in whole units makes the engine apply that tier.
// 4. routes: support 403 on every write, staff schedule (offers.write) with
//    the window in the audit diff; support reads the collection picker.
// 5. checkout across an expiry: the existing 409 PRICE_CHANGED.
// Outside services are blanked and fetch() is blocked; databases are
// throwaway file: databases.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const network = H.blockNetwork();
process.env.DATABASE_URL = "file:.test-osched-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.stack || e?.message || e).split("\n").slice(0, 4).join("\n    ")}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m} expected ${B}, got ${A}`);
};

// ---- the stores --------------------------------------------------------------------
// A: 8 products (₹100 × n). "summer-edit" holds 1–4, "gym-kit" 5–6, 7–8 are in
// no collection. B: its own collection "only-b" (a handle A does not have).
const PID = (n) => `gid://shopify/Product/${9100 + n}`;
const VID = (n) => `gid://shopify/ProductVariant/${9100 + n}1`;
const A_COLLECTIONS = [
  { handle: "summer-edit", title: "Summer Edit", productIds: [1, 2, 3, 4].map(PID) },
  { handle: "gym-kit", title: "Gym Kit", productIds: [5, 6].map(PID) },
];
const S = await H.makeRoleStore({
  name: "osched",
  a: { products: 8, collections: A_COLLECTIONS },
  b: { products: 2, collections: [{ handle: "only-b", title: "Only B", productIds: [PID(1), PID(2)] }] },
});
const { a, b } = S;

const { libsql, db } = await import("../lib/db.js");
const O = await import("../lib/offers/store.js");
const { scheduleWindow, validateOffer } = await import("../lib/offers/validate.js");
const { matchesTarget, evaluateOffers } = await import("../lib/offers/engine.js");
const { offerProgress } = await import("../lib/offers/progress.js");
const { exampleCatalog, offerTargetOptions, offerTargetNames } = await import("../lib/offers/catalog.js");
const { offerSentence, defaultOfferTitle, offerExamples } = await import("../lib/offers/plain.js");
const { offerScheduleStatus } = await import("../lib/admin/schedule.js");
const B = await import("../lib/bundles.js");
const BR = await import("../lib/commerce/bundle-read.js");
const { createCart, addItem, getCart, CART_COOKIE } = await import("../lib/cart.js");
const { cartRows } = await import("../lib/catalog/effective.js");
const { TARGET_CHOICES, offerFromForm, formFromOffer } = await import("../components/admin/offerFormModel.js");

const now = () => new Date().toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();
const raw = (t, sql, args = []) => t.run(() => libsql.execute({ sql, args }));
const tier = (id, value, extra = {}) => ({ id, type: "TIERED_QTY", scope: "line", priority: 30, title: "Buy 2+, save more", target: { kind: "collection", value }, tiers: [{ minQty: 2, percent: 10 }, { minQty: 4, percent: 20 }], ...extra });

// ---- 1. windows ------------------------------------------------------------------------
const S0 = "2026-12-01T04:30:00.000Z";
const E0 = "2026-12-08T04:30:00.000Z";
const ms = (iso, d) => new Date(Date.parse(iso) + d);

await t("scheduleWindow: canonical UTC ISO, start before end, bad dates refused in words", () => {
  eq(scheduleWindow("2026-12-01T10:00:00+05:30", null), { startsAt: S0, endsAt: null, errors: [] }, "offset converted to UTC");
  eq(scheduleWindow(S0, S0).errors, ["Schedule: start must be before end"], "equal bounds");
  eq(scheduleWindow("not a date", "").errors, ["Schedule: start is not a date"], "bad start");
  eq(scheduleWindow(null, null), { startsAt: null, endsAt: null, errors: [] }, "open window");
});

await t("offer window boundaries to the millisecond: start − 1 ms off, start on, end − 1 ms on, end off", async () => {
  await a.run(() => O.upsertOffer({ offer: tier("tiered-window", "summer-edit"), startsAt: S0, endsAt: E0 }));
  const live = async (at) => (await a.run(() => O.getActiveOffers(at))).some((o) => o.id === "tiered-window");
  eq([await live(ms(S0, -1)), await live(ms(S0, 0)), await live(ms(E0, -1)), await live(ms(E0, 0))], [false, true, true, false], "getActiveOffers");
  const st = (at) => offerScheduleStatus({ enabled: true, starts_at: S0, ends_at: E0 }, at);
  eq([st(ms(S0, -1)), st(ms(S0, 0)), st(ms(E0, -1)), st(ms(E0, 0))], ["scheduled", "active", "active", "expired"], "offerScheduleStatus");
  const titles = async (at) => a.run(() => O.collectionOfferTitles("summer-edit", at));
  eq([await titles(ms(S0, -1)), await titles(ms(S0, 0)), await titles(ms(E0, -1)), await titles(ms(E0, 0))], [[], ["Buy 2+, save more"], ["Buy 2+, save more"], []], "collection note titles");
  await a.run(() => O.deleteOffer("tiered-window"));
});

await t("an offer saved with an offset time is stored as canonical UTC; a bad window is refused", async () => {
  const row = await a.run(() => O.upsertOffer({ offer: tier("tiered-offset", "summer-edit"), startsAt: "2026-12-01T10:00:00+05:30", endsAt: E0 }));
  eq([row.starts_at, row.ends_at], [S0, E0], "stored instants");
  let code = null;
  await a.run(() => O.upsertOffer({ offer: tier("tiered-offset", "summer-edit"), startsAt: E0, endsAt: S0 })).catch((e) => (code = e.code));
  eq(code, "OFFER_INVALID", "start after end");
  await a.run(() => O.deleteOffer("tiered-offset"));
});

const bundleInput = (extra = {}) => ({ title: "Summer pair", items: [{ variantId: VID(1), quantity: 1 }, { variantId: VID(2), quantity: 1 }], bundle_price: 250, enable: true, mustPass: true, ...extra });

await t("a bundle's window is mirrored onto its offer row, to the millisecond; an edit keeps it; null clears", async () => {
  const made = await a.run(() => B.createBundle(bundleInput({ starts_at: "2026-12-01T10:00:00+05:30", ends_at: E0 })));
  const offer = async () => (await raw(a, "SELECT starts_at, ends_at FROM offers WHERE id = ?", [`bundle-${made.id}`])).rows[0];
  const row = async () => (await raw(a, "SELECT starts_at, ends_at FROM bundles WHERE id = ?", [made.id])).rows[0];
  eq([(await row()).starts_at, (await row()).ends_at], [S0, E0], "bundle row");
  eq([(await offer()).starts_at, (await offer()).ends_at], [S0, E0], "offer row");
  await a.run(() => B.upsertBundle({ id: made.id, title: "Summer pair", items: bundleInput().items, bundle_price: 240 }));
  eq([(await offer()).starts_at, (await offer()).ends_at], [S0, E0], "an edit without a window keeps it on both rows");
  await a.run(() => B.upsertBundle({ id: made.id, title: "Summer pair", items: bundleInput().items, bundle_price: 240, starts_at: null }));
  eq([(await row()).starts_at, (await offer()).starts_at], [null, null], "null clears the start on both");
  let err = null;
  await a.run(() => B.upsertBundle({ id: made.id, title: "Summer pair", items: bundleInput().items, bundle_price: 240, starts_at: E0, ends_at: S0 })).catch((e) => (err = e));
  eq([err?.code, /end must be after the start/.test(err?.message)], ["BUNDLE_INVALID", true], "start after end refused in words");
  await a.run(() => B.setBundleEnabled(made.id, false));
  await a.run(() => B.setBundleEnabled(made.id, true));
  eq((await offer()).ends_at, E0, "turning it off and on keeps the window on the offer row");
  await a.run(() => B.deleteBundle(made.id));
});

await t("bundle window boundaries (getBundle and inWindow): start − 1 ms off, start on, end − 1 ms on, end off", async () => {
  const made = await a.run(() => B.createBundle(bundleInput({ title: "Edge pair", starts_at: S0, ends_at: E0 })));
  const seen = async (at) => Boolean(await a.run(() => B.getBundle(made.slug, at)));
  eq([await seen(ms(S0, -1)), await seen(ms(S0, 0)), await seen(ms(E0, -1)), await seen(ms(E0, 0))], [false, true, true, false], "getBundle");
  const row = { starts_at: S0, ends_at: E0 };
  eq([B.inWindow(row, ms(S0, -1)), B.inWindow(row, ms(S0, 0)), B.inWindow(row, ms(E0, -1)), B.inWindow(row, ms(E0, 0))], [false, true, true, false], "inWindow");
  await a.run(() => B.deleteBundle(made.id));
});

await t("anonymous: the bundle page and card before, during and after its window; a hand-edited offer window is offer_differs", async () => {
  const before = await a.run(() => B.createBundle(bundleInput({ title: "Before pair", starts_at: later(3_600_000) })));
  const during = await a.run(() => B.createBundle(bundleInput({ title: "During pair", items: [{ variantId: VID(3), quantity: 1 }, { variantId: VID(4), quantity: 1 }], bundle_price: 600, starts_at: later(-3_600_000), ends_at: later(3_600_000) })));
  const after = await a.run(() => B.createBundle(bundleInput({ title: "After pair", items: [{ variantId: VID(5), quantity: 1 }, { variantId: VID(6), quantity: 1 }], bundle_price: 1000, ends_at: later(-1000) })));
  const page = async (x) => Boolean(await a.run(() => B.getBundle(x.slug)));
  eq([await page(before), await page(during), await page(after)], [false, true, false], "bundle page found");
  const map = await a.run(() => BR.bundlesByIds([before.id, during.id, after.id]));
  eq([before, during, after].map((x) => map.get(x.id).state), ["scheduled", "available", "scheduled"], "card states (scheduled is not a shown state)");
  eq([map.get(before.id).reasons[0].phase, map.get(after.id).reasons[0].phase], ["upcoming", "ended"], "phases");
  // the card (a JSX file plain node can't load) shows only its SHOWN_STATES
  const card = readFileSync(join(ROOT, "components/sections/BundleCardSection.js"), "utf8");
  const shownStates = JSON.parse(/SHOWN_STATES = Object\.freeze\((\[[^\]]*\])\)/.exec(card)[1]);
  ok(shownStates.length && !shownStates.includes("scheduled"), `the card hides a scheduled bundle (${shownStates})`);
  // the cart prices from the offer row: inside the window only
  const cartId = `osched-bundle-${Date.now()}`;
  await a.run(async () => {
    await createCart(cartId);
    for (const n of [1, 2, 3, 4]) await addItem(cartId, VID(n), 1);
  });
  const cart = await a.run(() => getCart(cartId));
  eq(cart.appliedOffers.filter((o) => o.id.startsWith("bundle-")).map((o) => o.id), [`bundle-${during.id}`], "only the bundle inside its window prices the cart");
  // a hand edit of the offer row's window
  await raw(a, "UPDATE offers SET ends_at = ? WHERE id = ?", [later(7_200_000), `bundle-${during.id}`]);
  const edited = (await a.run(() => BR.bundlesByIds([during.id]))).get(during.id);
  eq([edited.state, edited.reasons.find((r) => r.kind === "not_synced")?.detail], ["not_ready", "offer_differs"], "mismatch");
  for (const x of [before, during, after]) await a.run(() => B.deleteBundle(x.id));
});

// ---- 2. collection offers ----------------------------------------------------------------
await t("cart rows carry this store's collection handles; matchesTarget uses them", async () => {
  const cartId = `osched-rows-${Date.now()}`;
  await a.run(async () => {
    await createCart(cartId);
    for (const n of [1, 5, 7]) await addItem(cartId, VID(n), 1);
  });
  const rows = await a.run(() => cartRows(cartId));
  eq(rows.map((r) => [r.variant_id, r.collections]), [[VID(1), ["summer-edit"]], [VID(5), ["gym-kit"]], [VID(7), []]], "collections per row");
  ok(matchesTarget({ collections: ["summer-edit"] }, { kind: "collection", value: "summer-edit" }), "in");
  ok(!matchesTarget({ collections: ["gym-kit"] }, { kind: "collection", value: "summer-edit" }), "out");
  ok(!matchesTarget({ handle: "summer-edit" }, { kind: "collection", value: "summer-edit" }), "a product handle is not a collection");
  const cart = await a.run(() => getCart(cartId));
  ok(cart.items.every((i) => !("collections" in i)), "the shopper's cart never carries the engine-only collections");
  eq(validateOffer(tier("tiered-valid", "summer-edit")), [], "a collection target validates");
});

await t("store B's collection handle never matches on A: refused on save, and a hand-inserted offer discounts nothing", async () => {
  let err = null;
  await a.run(() => O.upsertOffer({ offer: tier("tiered-only-b", "only-b") })).catch((e) => (err = e));
  eq([err?.code, err?.errors?.some((x) => /no such collection/.test(x))], ["OFFER_INVALID", true], "refused");
  ok(await b.run(() => O.upsertOffer({ offer: tier("tiered-only-b", "only-b") })), "B can use its own handle");
  const at = now();
  await raw(a, "INSERT INTO offers (id, type, label, enabled, starts_at, ends_at, config, created_at, updated_at) VALUES (?, 'TIERED_QTY', 'x', 1, NULL, NULL, ?, ?, ?)", ["tiered-only-b", JSON.stringify(tier("tiered-only-b", "only-b")), at, at]);
  const cartId = `osched-b-${Date.now()}`;
  await a.run(async () => {
    await createCart(cartId);
    await addItem(cartId, VID(1), 3);
    await addItem(cartId, VID(2), 3);
  });
  const cart = await a.run(() => getCart(cartId));
  eq([cart.discountTotal, cart.appliedOffers.map((o) => o.id)], [0, []], "nothing applies on A");
  await raw(a, "DELETE FROM offers WHERE id = 'tiered-only-b'");
});

await t("the collection note: titles only, while live; never targets or rules", async () => {
  await a.run(() => O.upsertOffer({ offer: { ...tier("tiered-note", "summer-edit"), title: "Buy 2+, get 10% off" } }));
  await a.run(() => O.upsertOffer({ offer: tier("tiered-gym", "gym-kit") }));
  eq(await a.run(() => O.collectionOfferTitles("summer-edit")), ["Buy 2+, get 10% off"], "summer");
  eq(await b.run(() => O.collectionOfferTitles("summer-edit")), [], "another store sees none");
  await a.run(() => O.setOfferEnabled("tiered-note", false));
  eq(await a.run(() => O.collectionOfferTitles("summer-edit")), [], "off: no note");
  await a.run(() => O.deleteOffer("tiered-note"));
  await a.run(() => O.deleteOffer("tiered-gym"));
});

await t("console words, names, picker options and examples for a collection offer", async () => {
  const names = await a.run(() => offerTargetNames([tier("x", "summer-edit")]));
  eq(names, { "summer-edit": "Summer Edit" }, "names");
  eq(offerSentence({ ...tier("x", "summer-edit"), tiers: [{ minQty: 2, percent: 10 }] }, { names }), "Buy 2+ from Summer Edit, get 10% off", "TIERED sentence");
  eq(offerSentence({ id: "x", type: "BXGY", scope: "line", target: { kind: "collection", value: "summer-edit" }, buy: 2, free: 1 }, { names }), "Buy 2 from Summer Edit, get 1 free", "BXGY sentence");
  eq(defaultOfferTitle(tier("x", "summer-edit"), { names }), "Buy 2+, save more", "default title names no target");
  const opts = await a.run(() => offerTargetOptions());
  eq(opts.collections.map((c) => [c.value, c.label, c.count, c.maxPrice]), [["gym-kit", "Gym Kit", 2, 600], ["summer-edit", "Summer Edit", 4, 400]], "picker options");
  const cat = await a.run(() => exampleCatalog(tier("x", "summer-edit")));
  eq(cat.map((r) => r.variantId).sort(), [1, 2, 3, 4].map(VID).sort(), "the simulator's example carts come from the collection");
  const ex = offerExamples(tier("x", "summer-edit"), cat);
  ok(ex.example && ex.example.lines.every((l) => l.collections.includes("summer-edit")), "example lines are collection products");
  ok(TARGET_CHOICES.some((c) => c.key === "collection"), "the form offers Products in a collection");
  const form = { ...formFromOffer(null), type: "BXGY", choice: "collection", target: { kind: "collection", value: "summer-edit", label: "Summer Edit" } };
  eq(offerFromForm(form, { id: "bxgy-summer-edit-000000", names }).target.kind, "collection", "form → offer");
});

// ---- 3. brute force ------------------------------------------------------------------------
await t("brute force: 500 random carts; only in-collection lines discounted; completing each tier nudge with real collection products applies it", async () => {
  const catalog = await a.run(() => exampleCatalog({ type: "COUPON" }));
  eq(catalog.length, 8, "the real catalog with its collections");
  const offers = [tier("tiered-bf", "summer-edit"), { id: "bxgy-bf", type: "BXGY", scope: "line", priority: 30, title: "Gym 2+1", target: { kind: "collection", value: "gym-kit" }, buy: 2, free: 1 }];
  const targeted = new Set(["summer-edit", "gym-kit"]);
  const inSummer = catalog.filter((c) => c.collections.includes("summer-edit"));
  let seed = 20261126;
  // mulberry32: 32-bit integer steps (a float LCG loses precision and repeats)
  const rnd = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  const mixed = { both: 0 };
  const line = (c, quantity) => ({ variantId: c.variantId, productId: c.productId, handle: c.handle, title: c.title, price: c.price, currency: "INR", quantity, tags: c.tags, productType: c.productType, collections: c.collections });
  let nudged = 0;
  for (let k = 0; k < 500; k++) {
    const picks = new Map();
    for (let j = 0, n = 1 + rnd(5); j < n; j++) {
      const c = catalog[rnd(catalog.length)];
      picks.set(c.variantId, (picks.get(c.variantId) || 0) + 1 + rnd(3));
    }
    const items = [...picks].map(([v, q]) => line(catalog.find((c) => c.variantId === v), q));
    const result = evaluateOffers(items, { offers });
    if (items.some((i) => i.collections.includes("summer-edit")) && items.some((i) => !i.collections.includes("summer-edit"))) mixed.both++;
    for (const i of items) {
      const d = result.lineDiscounts[i.variantId] || 0;
      if (!i.collections.some((h) => targeted.has(h))) ok(d === 0, `cart ${k}: ${i.handle} is in no offer's collection but got ${d} off`);
    }
    const summerQty = items.filter((i) => i.collections.includes("summer-edit")).reduce((s, i) => s + i.quantity, 0);
    // each collection's lines get exactly their own offer's discount: the
    // tier's percent on Summer Edit lines, what the Gym Kit offer alone gives
    const pctNow = summerQty >= 4 ? 20 : summerQty >= 2 ? 10 : 0;
    const gymOnly = evaluateOffers(items, { offers: [offers[1]] });
    for (const i of items) {
      const d = result.lineDiscounts[i.variantId] || 0;
      if (i.collections.includes("summer-edit")) eq(d, Math.round((i.price * i.quantity * pctNow) / 100), `cart ${k}: ${i.handle} (summer) discount`);
      else if (i.collections.includes("gym-kit")) eq(d, gymOnly.lineDiscounts[i.variantId] || 0, `cart ${k}: ${i.handle} (gym) discount`);
    }
    const progress = offerProgress(items, { offers, result });
    const nudge = progress.nudges.find((n) => n.kind === "tier" && n.id === "tiered-bf");
    const next = [2, 4].find((m) => m > summerQty);
    if (summerQty > 0 && next) {
      ok(nudge, `cart ${k}: ${summerQty} summer units, a nudge to ${next} expected`);
      eq(nudge.add, next - summerQty, `cart ${k}: units to add`);
    }
    if (!nudge) continue;
    nudged++;
    // complete it with real collection products, whole units, spread at random
    const done = items.map((i) => ({ ...i }));
    for (let u = 0; u < nudge.add; u++) {
      const c = inSummer[rnd(inSummer.length)];
      const at = done.find((i) => i.variantId === c.variantId);
      if (at) at.quantity += 1;
      else done.push(line(c, 1));
    }
    const proof = evaluateOffers(done, { offers });
    const pct = next === 4 ? 20 : 10;
    ok(proof.appliedOffers.some((o) => o.id === "tiered-bf" && o.label === `Buy 2+, save more · ${pct}% off`), `cart ${k}: the ${pct}% tier applies after adding ${nudge.add}`);
    for (const i of done) if (i.collections.includes("summer-edit")) eq(proof.lineDiscounts[i.variantId] || 0, Math.round((i.price * i.quantity * pct) / 100), `cart ${k}: ${i.handle} discount`);
  }
  ok(nudged > 100 && mixed.both > 150, `enough nudged (${nudged}) and mixed in/out-of-collection (${mixed.both}) carts to mean something`);
});

// ---- 4. routes -------------------------------------------------------------------------
await t("support: every bundle and offer write is 403, and nothing is written", async () => {
  const before = (await raw(a, "SELECT count(*) AS n FROM bundles")).rows[0].n;
  const writes = [
    ["bundles", { create: bundleInput({ starts_at: later(60_000) }) }],
    ["offers", { offer: tier("tiered-support", "summer-edit"), startsAt: later(60_000) }],
  ];
  for (const [path, body] of writes) {
    const r = await S.call("support", path, "POST", { body });
    eq(r.status, 403, `support POST ${path}`);
  }
  eq((await raw(a, "SELECT count(*) AS n FROM bundles")).rows[0].n, before, "no bundle written");
  ok(!(await a.run(() => O.offerExists("tiered-support"))), "no offer written");
});

await t("support reads the collection picker (GET targets); signed-out is refused", async () => {
  const r = await S.call("support", "offers/targets", "GET");
  eq(r.status, 200, "support GET targets");
  eq(r.body.collections.map((c) => c.value), ["gym-kit", "summer-edit"], "this store's collections only");
  ok(!r.text.includes("only-b"), "never another store's");
  eq((await S.call("signed-out", "offers/targets", "GET")).status, 401, "signed-out");
});

await t("staff schedule a bundle and a collection offer (offers.write); the audit diff carries the window", async () => {
  const start = later(120_000);
  const made = await S.call("staff", "bundles", "POST", { body: { create: bundleInput({ title: "Staff pair", starts_at: start }) } });
  eq(made.status, 200, `staff create ${made.text}`);
  eq(made.body.bundle.starts_at, start, "window answered");
  const offer = await S.call("staff", "offers", "POST", { body: { offer: tier("tiered-staff", "summer-edit"), startsAt: start } });
  eq(offer.status, 200, `staff offer ${offer.text}`);
  const { platformDb } = await import("../lib/platform/control.js");
  const rows = (await platformDb().execute({ sql: "SELECT resource, diff FROM audit_log WHERE action = 'offers.write' AND tenant_id = ? ORDER BY rowid DESC LIMIT 2", args: [a.id] })).rows;
  const diffs = Object.fromEntries(rows.map((r) => [String(r.resource).split(":")[0], JSON.parse(r.diff)]));
  eq([diffs.bundle?.starts_at, diffs.offer?.starts_at, diffs.offer?.target], [start, start, "collection"], "audit");
  const bad = await S.call("staff", "bundles", "POST", { body: { bundle: { id: made.body.bundle.id, title: "Staff pair", items: bundleInput().items, bundle_price: 250, starts_at: E0, ends_at: S0 } } });
  eq([bad.status, bad.body.code], [422, "BUNDLE_INVALID"], "start after end");
  const foreign = await S.call("staff", "offers", "POST", { body: { offer: tier("tiered-foreign", "only-b") } });
  eq(foreign.status, 422, "another store's collection is refused");
  await a.run(() => B.deleteBundle(made.body.bundle.id));
  await a.run(() => O.deleteOffer("tiered-staff"));
});

// ---- 5. checkout across an expiry ---------------------------------------------------------
await t("checkout across an expiry: the shown total no longer holds, the existing 409 PRICE_CHANGED", async () => {
  const F = await import("./support/tenant-fixture.js");
  const c = await F.makeTenant({ name: "osched-c", products: 4, collections: [{ handle: "summer-edit", title: "Summer Edit", productIds: [PID(1), PID(2)] }] });
  const at = now();
  const { emptyList } = await import("../lib/content/documents-reader.js");
  await c.run(async () => {
    await libsql.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", args: [JSON.stringify(emptyList()), at, at] });
    await libsql.execute({ sql: "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", args: [at] });
    await O.upsertOffer({ offer: tier("tiered-expiry", "summer-edit"), endsAt: later(3_600_000) });
  });
  const { computeShipping, SHIPPING_CONFIG } = await import("../lib/shipping.js");
  const route = await import(pathToFileURL(join(ROOT, "app/api/checkout/route.js")).href);
  const { NextRequest } = await import("./support/next-server-stub.js");
  const host = c.tenant.domains[0];
  const ADDRESS = { line1: "1 Test Street", line2: "", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
  const CONTACT = { email: "snehal@mediastic.in", phone: "9999999999", name: "Schedule Test" };
  const shown = async (cartId) => {
    const cart = await c.run(() => getCart(cartId));
    const ship = computeShipping({ subtotal: cart.subtotal, discountTotal: cart.discountTotal, paymentMethod: "cod", pincode: ADDRESS.pincode, config: SHIPPING_CONFIG });
    return { cart, expectedTotal: cart.total + ship.total, expectedShipping: ship.total };
  };
  const post = async (cartId, body) => {
    const req = new NextRequest(`http://${host}/api/checkout`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", cookie: `${CART_COOKIE}=${cartId}` }, body: JSON.stringify({ contact: CONTACT, address: ADDRESS, action: "cod", ...body }) });
    const res = await c.run(() => route.POST(req));
    return { status: res.status, body: await res.json() };
  };
  const fresh = async (name) => {
    const id = `osched-${name}-${Date.now()}`;
    await c.run(async () => {
      await createCart(id);
      await addItem(id, VID(1), 2);
    });
    return id;
  };
  // control: inside the window the shown total places the order
  const ctl = await fresh("ctl");
  const s1 = await shown(ctl);
  ok(s1.cart.discountTotal > 0, "the collection offer applies before the expiry");
  const placed = await post(ctl, { idempotencyKey: "osched-ctl", expectedTotal: s1.expectedTotal, expectedShipping: s1.expectedShipping });
  eq(placed.status, 200, `inside the window: ${JSON.stringify(placed.body)}`);
  // the shopper sees the total, then the offer expires before they place it
  const cartId = await fresh("exp");
  const s2 = await shown(cartId);
  await c.run(() => libsql.execute({ sql: "UPDATE offers SET ends_at = ? WHERE id = 'tiered-expiry'", args: [now()] }));
  await new Promise((r) => setTimeout(r, 5));
  const r = await post(cartId, { idempotencyKey: "osched-exp", expectedTotal: s2.expectedTotal, expectedShipping: s2.expectedShipping });
  eq([r.status, r.body.code], [409, "PRICE_CHANGED"], "across the expiry");
  eq(r.body.cart.discountTotal, 0, "the refusal carries the cart without the offer");
  await c.cleanup();
});

network.restore?.();
await S.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
