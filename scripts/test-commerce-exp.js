// Commerce-expansion suite (Session 46 / BE31 + SF18–21): bundle
// compatibility gate + offer sync (zero new money paths — the engine math
// itself is covered in test-offers.js), deterministic quiz scoring and
// recommendations, journal family windows + slug redirects, and the returns
// state machine where APPROVAL MOVES NO MONEY.
//   pnpm test:commerce-exp
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// P5-BUNDLEREAD: the real route files use the app's "@/…" alias and
// next/server, which plain Node can't resolve on its own (copied from
// scripts/test-cms-api.js), so the bundle route can be called below.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";

process.env.TURSO_DB_URL = "";
process.env.RESEND_API_KEY = ""; // notifications = labeled dev mock
process.env.DATABASE_URL = "file:.test-cexp-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cexp-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-cexp-default.db", ".test-cexp-platform.db", ".test-cexp-a.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const B = await import("../lib/bundles.js");
const Q = await import("../lib/quiz.js");
const R = await import("../lib/returns.js");
const O = await import("../lib/offers/store.js");
const { upsertContentPage, getContentPage, campaignVisible, resolveSlugRedirect, deleteContentPage } = await import("../lib/cms/store.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "ce", name: "ce", domains: ["ce.test"], dbUrl: "file:.test-cexp-a.db", config: {}, secrets: { order_link_secret: "ce-secret" } });
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await withTenant(await C.getTenant("ce"), async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, await loadMigrations("tenant"));
});
const inT = async (fn) => withTenant(await C.getTenant("ce"), fn);

// catalog fixture: two live variants + one sold-out
await inT(async () => {
  await libsql.execute(
    "INSERT INTO products (id, handle, title, available, currency, price_min, tags) VALUES " +
      "('gid://p/1','whey','Whey Protein',1,'INR',1000,'[\"muscle\",\"protein\"]')," +
      "('gid://p/2','creatine','Creatine',1,'INR',600,'[\"muscle\",\"strength\"]')," +
      "('gid://p/3','shaker','Shaker',0,'INR',300,'[\"gear\"]')," +
      "('gid://p/4','bcaa','Amino BCAA',1,'INR',800,'[\"recovery\",\"muscle\"]')"
  );
  await libsql.execute(
    "INSERT INTO variants (id, product_id, title, price, available, position) VALUES " +
      "('gid://v/1','gid://p/1','1kg',1000,1,0)," +
      "('gid://v/2','gid://p/2','250g',600,1,0)," +
      "('gid://v/3','gid://p/3','Default',300,0,0)," +
      "('gid://v/4','gid://p/4','200g',800,1,0)"
  );
});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const throws = async (fn, part, m = "") => {
  try {
    await fn();
  } catch (e) {
    if (!String(e.message).toLowerCase().includes(part.toLowerCase())) throw new Error(`${m} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${m} expected it to throw "${part}"`);
};

console.log("— bundles: the compatibility gate (BE31)");

await t("compat refuses: <2 components, missing variant, sold-out, non-saving price", async () => {
  await inT(async () => {
    let c = await B.checkBundleCompatibility({ items: [{ variantId: "gid://v/1", quantity: 1 }], bundle_price: 500 });
    eq(c.ok, false, "one component:");
    c = await B.checkBundleCompatibility({ items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/nope", quantity: 1 }], bundle_price: 500 });
    eq(c.problems.some((p) => p.includes("not in the catalog")), true, "missing variant:");
    c = await B.checkBundleCompatibility({ items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/3", quantity: 1 }], bundle_price: 500 });
    eq(c.problems.some((p) => p.includes("sold out")), true, "sold-out component:");
    c = await B.checkBundleCompatibility({ items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/2", quantity: 1 }], bundle_price: 1600 });
    eq(c.problems.some((p) => p.includes("doesn't save")), true, "price = sum saves nothing:");
  });
});

await t("enable is gated: a broken bundle saves as DRAFT but refuses to enable", async () => {
  await inT(async () => {
    await throws(
      () => B.upsertBundle({ slug: "broken", title: "Broken", items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/3", quantity: 1 }], bundle_price: 900, enable: true }),
      "can't enable"
    );
    const draft = await B.upsertBundle({ slug: "broken", title: "Broken", items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/3", quantity: 1 }], bundle_price: 900, enable: false });
    eq(Number(draft.enabled), 0, "draft saved:");
    eq((await O.getOfferRow(B.bundleOfferId(draft.id)))?.enabled, false, "linked offer stays disabled:");
  });
});

let bundleId = null;
await t("a good bundle enables and syncs a priority-5 BUNDLE line offer", async () => {
  await inT(async () => {
    const b = await B.upsertBundle({ slug: "starter-stack", title: "Starter Stack", items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/2", quantity: 1 }], bundle_price: 1400, enable: true });
    bundleId = b.id;
    eq(Number(b.enabled), 1);
    eq(b.compat.saving, 200, "saving = 1600 − 1400:");
    const row = await O.getOfferRow(B.bundleOfferId(b.id));
    eq(row.enabled, true, "offer enabled:");
    eq(row.config.type, "BUNDLE", "offer type:");
    eq(row.config.priority, 5, "claims lines before generic line offers:");
    eq(row.config.items.length, 2, "component list rides the offer:");
  });
});

await t("disable flips the offer off; re-enable re-runs the gate against TODAY's catalog", async () => {
  await inT(async () => {
    await B.setBundleEnabled(bundleId, false);
    eq((await O.getOfferRow(B.bundleOfferId(bundleId))).enabled, false, "offer off with the bundle:");
    // catalog moved under it: component sold out → re-enable must refuse
    await libsql.execute("UPDATE variants SET available = 0 WHERE id = 'gid://v/2'");
    await throws(() => B.setBundleEnabled(bundleId, true), "sold out", "re-gate:");
    await libsql.execute("UPDATE variants SET available = 1 WHERE id = 'gid://v/2'");
    await B.setBundleEnabled(bundleId, true);
    eq((await O.getOfferRow(B.bundleOfferId(bundleId))).enabled, true, "back on once fixed:");
  });
});

await t("storefront read is honest: sold-out component ⇒ available:false, never hidden math", async () => {
  await inT(async () => {
    await libsql.execute("UPDATE variants SET available = 0 WHERE id = 'gid://v/2'");
    const b = await B.getBundle("starter-stack");
    eq(b.available, false, "not addable:");
    eq(b.componentsSum, 1600, "sum still shown:");
    await libsql.execute("UPDATE variants SET available = 1 WHERE id = 'gid://v/2'");
  });
});

await t("delete removes the bundle AND its linked offer", async () => {
  await inT(async () => {
    const b = await B.upsertBundle({ slug: "temp", title: "Temp", items: [{ variantId: "gid://v/1", quantity: 1 }, { variantId: "gid://v/4", quantity: 1 }], bundle_price: 1500, enable: true });
    await B.deleteBundle(b.id);
    eq(await O.getOfferRow(B.bundleOfferId(b.id)), null, "offer gone:");
    eq(await B.getBundle("temp"), null, "bundle gone:");
  });
});

console.log("— quiz: deterministic scoring (SF19)");

await t("validateQuiz refuses bad slugs, short option lists, missing labels", async () => {
  eq(Q.validateQuiz({ slug: "Bad Slug", title: "T", questions: [{ prompt: "p", options: [{ label: "a" }, { label: "b" }] }] }).ok, false, "slug:");
  eq(Q.validateQuiz({ slug: "ok", title: "T", questions: [{ prompt: "p", options: [{ label: "only" }] }] }).ok, false, "1 option:");
  eq(Q.validateQuiz({ slug: "ok", title: "T", questions: [{ prompt: "p", options: [{ label: "a" }, { label: "" }] }] }).ok, false, "empty label:");
  eq(Q.validateQuiz({ slug: "ok", title: "T", questions: [{ prompt: "p", options: [{ label: "a", tags: ["X"] }, { label: "b" }] }] }).ok, true, "good one passes:");
});

await t("same answers ⇒ same result; ties break alphabetically", async () => {
  const quiz = {
    questions: [
      { id: "q1", options: [{ id: "q1o1", tags: ["zeta", "alpha"] }, { id: "q1o2", tags: [] }] },
      { id: "q2", options: [{ id: "q2o1", tags: ["alpha"] }, { id: "q2o2", tags: ["zeta"] }] },
    ],
  };
  const a = Q.scoreQuiz(quiz, { q1: "q1o1", q2: "q2o2" });
  const b = Q.scoreQuiz(quiz, { q1: "q1o1", q2: "q2o2" });
  eq(JSON.stringify(a), JSON.stringify(b), "deterministic:");
  // alpha 1, zeta 2 → zeta first; tie case:
  const tie = Q.scoreQuiz(quiz, { q1: "q1o1" }); // alpha 1, zeta 1
  eq(tie.topTags[0], "alpha", "tie breaks A–Z:");
  eq(a.topTags[0], "zeta", "score wins before alphabet:");
});

await t("recommendations: available products only, matches desc then title A–Z", async () => {
  await inT(async () => {
    const recs = await Q.recommendProducts(["muscle", "protein"]);
    eq(recs[0].handle, "whey", "2 matches first:");
    // creatine & bcaa both match 1 → "Amino BCAA" < "Creatine" alphabetically
    eq(recs[1].title, "Amino BCAA", "tie by title:");
    eq(recs.some((r) => r.handle === "shaker"), false, "sold-out products never recommended:");
  });
});

await t("disabled quizzes vanish for shoppers (getQuiz) but stay listed for the console", async () => {
  await inT(async () => {
    await Q.upsertQuiz({ slug: "finder", title: "Find your stack", questions: [{ prompt: "Goal?", options: [{ label: "Muscle", tags: ["muscle"] }, { label: "Gear", tags: ["gear"] }] }] }, { enabled: false });
    eq(await Q.getQuiz("finder"), null, "hidden from shoppers:");
    eq((await Q.listQuizzes()).find((q) => q.slug === "finder")?.enabled, false, "console still sees it:");
  });
});

console.log("— journal: scheduled publish + slug redirects (SF20)");

await t("window_start in the future means NOT visible yet (scheduled publish)", async () => {
  await inT(async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await upsertContentPage({ slug: "launch-notes", title: "Launch Notes", family: "journal", window_start: future, sections: [{ kind: "text", heading: "Soon", body: ["coming soon"] }] });
    const page = await getContentPage("launch-notes");
    eq(page.family, "journal");
    eq(campaignVisible(page), false, "future post invisible:");
    await upsertContentPage({ slug: "launch-notes", title: "Launch Notes", family: "journal", window_start: new Date(Date.now() - 1000).toISOString(), sections: [{ kind: "text", heading: "Now", body: ["live now"] }] });
    eq(campaignVisible(await getContentPage("launch-notes")), true, "past start visible:");
  });
});

await t("redirect_from maps the old slug; self-redirects refused; loops back deleted", async () => {
  await inT(async () => {
    await upsertContentPage({ slug: "new-name", title: "Renamed", family: "journal", redirect_from: "old-name", sections: [] });
    eq(await resolveSlugRedirect("old-name"), "new-name", "old slug 301 target:");
    await throws(() => upsertContentPage({ slug: "new-name", title: "Renamed", family: "journal", redirect_from: "new-name", sections: [] }), "itself", "self-redirect:");
    // a page REAPPEARING at a redirected-from slug kills the stale redirect
    await upsertContentPage({ slug: "old-name", title: "Back again", family: "journal", sections: [] });
    eq(await resolveSlugRedirect("old-name"), null, "live page beats stale redirect:");
    await deleteContentPage("old-name");
  });
});

console.log("— returns: eligibility + state machine, approval ≠ refund (SF21)");

const now = new Date().toISOString();
const old = new Date(Date.now() - 20 * 86400000).toISOString();
await inT(async () => {
  await libsql.execute("INSERT INTO customers (id, email, created_at) VALUES ('cus_1','pat@shopper.test',?),('cus_2','sam@shopper.test',?)", [now, now]);
  const mk = (id, status, created, cust, refunded = 0) =>
    libsql.execute({
      sql: "INSERT INTO orders (id, email, total, currency, status, snapshot, created_at, updated_at, sync_attempts, refunded_total, customer_id) VALUES (?,?,1000,'INR',?,'{}',?,?,0,?,?)",
      args: [id, "pat@shopper.test", status, created, created, refunded, cust],
    });
  await mk("RO-1", "synced", now, "cus_1");
  await mk("RO-2", "cancelled", now, "cus_1");
  await mk("RO-3", "synced", old, "cus_1");
  await mk("RO-4", "synced", now, "cus_1", 1000);
  await mk("RO-5", "paid", now, "cus_2");
});

await t("eligibility matrix: cancelled, out-of-window, fully-refunded all refused", async () => {
  await inT(async () => {
    eq(R.returnEligibility(await db.selectFrom("orders").selectAll().where("id", "=", "RO-1").executeTakeFirst()).ok, true, "fresh synced order:");
    eq(R.returnEligibility(await db.selectFrom("orders").selectAll().where("id", "=", "RO-2").executeTakeFirst()).ok, false, "cancelled:");
    eq(R.returnEligibility(await db.selectFrom("orders").selectAll().where("id", "=", "RO-3").executeTakeFirst()).ok, false, "20 days > 14-day window:");
    eq(R.returnEligibility(await db.selectFrom("orders").selectAll().where("id", "=", "RO-4").executeTakeFirst()).ok, false, "fully refunded:");
  });
});

await t("ownership: someone else's order reads as NOT FOUND, never as ineligible", async () => {
  await inT(() => throws(() => R.requestReturn({ customerId: "cus_1", orderId: "RO-5", reason: "it arrived damaged on the corner" }), "not found"));
});

let retId = null;
await t("request: ≥10-char reason, then ONE open request per order", async () => {
  await inT(async () => {
    await throws(() => R.requestReturn({ customerId: "cus_1", orderId: "RO-1", reason: "bad" }), "little more", "short reason:");
    const r = await R.requestReturn({ customerId: "cus_1", orderId: "RO-1", reason: "it arrived damaged on the corner" });
    retId = r.id;
    eq(r.status, "requested");
    await throws(() => R.requestReturn({ customerId: "cus_1", orderId: "RO-1", reason: "trying to open another one" }), "already open", "one open per order:");
  });
});

await t("state machine: requested→approved→completed; rejected is terminal; bad hops refused", async () => {
  await inT(async () => {
    await throws(() => R.decideReturn(retId, { action: "complete" }), "can't become", "requested can't skip to completed:");
    const a = await R.decideReturn(retId, { action: "approve", note: "send it back in the original box" });
    eq(a.status, "approved");
    eq(a.moneyNote.includes("NO money"), true, "approval says it moves no money:");
    const c = await R.decideReturn(retId, { action: "complete" });
    eq(c.status, "completed");
    await throws(() => R.decideReturn(retId, { action: "reject" }), "can't become", "completed is terminal:");
  });
});

await t("APPROVAL ≠ REFUND: the order's money columns are untouched end-to-end", async () => {
  await inT(async () => {
    const o = await db.selectFrom("orders").select(["total", "refunded_total", "status"]).where("id", "=", "RO-1").executeTakeFirst();
    eq(Number(o.total), 1000, "total:");
    eq(Number(o.refunded_total), 0, "refunded_total still 0:");
    eq(o.status, "synced", "order status untouched:");
  });
});

await t("shopper views: returnForOrder scoped by customer; foreign customer sees null", async () => {
  await inT(async () => {
    eq((await R.returnForOrder("cus_1", "RO-1"))?.status, "completed");
    eq(await R.returnForOrder("cus_2", "RO-1"), null, "not theirs:");
    eq((await R.listReturns({})).length >= 1, true, "console list joined:");
  });
});

// =============================================================================
// P5-BUNDLEREAD (COM-01, COM-02): the bounded bundle read, the bundle words
// and safe bundle writes, on a tenant-fixture file database ("cb"), registered
// on this suite's control plane so the bundle route resolves it by host.
// =============================================================================
console.log("— P5-BUNDLEREAD: bundle read, words, writes");

const TF = await import("./support/tenant-fixture.js");
const { watchStatements } = await import("./support/request-cache.js");
const { currentDatabase } = await import("../lib/db.js");
const BR = await import("../lib/commerce/bundle-read.js");
const BW = await import("../lib/commerce/bundle-words.js");
const BC = await import("../lib/commerce/bundle-compat.js");
const Cart = await import("../lib/cart.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const bundleRoute = await import("../app/api/admin/bundles/route.js");

// 16 products, one variant each: V(n) priced 100 * n, all in stock
const tn = await TF.makeTenant({ name: "cexp-bun", id: "cb", products: 16 });
dbs.push(tn.file);
await C.upsertTenant({ id: "cb", name: "cb", domains: ["cb.test"], dbUrl: tn.url, config: {}, secrets: { order_link_secret: "cb-secret" } });
const CB = await C.getTenant("cb", { fresh: true });
const inB = (fn) => withTenant(CB, fn);
const V = (n) => `gid://shopify/ProductVariant/${9100 + n}1`;
const P = (n) => `gid://shopify/Product/${9100 + n}`;
const it2 = (...ns) => ns.map((n) => ({ variantId: V(n), quantity: 1 }));
const rawClient = tn.client();
const raw = (sql, args = []) => rawClient.execute({ sql, args });
const SLUG_RULE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const same = (a, b, m = "") => eq(JSON.stringify(a), JSON.stringify(b), m);
const ok = (c, m = "") => {
  if (!c) throw new Error(`${m} expected truthy`);
};
const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code || e.message;
  }
  return "no error";
};
const bundleCount = async () => Number((await raw("SELECT count(*) AS n FROM bundles")).rows[0].n);
const rowOf = async (id) => (await raw("SELECT * FROM bundles WHERE id = ?", [id])).rows[0] ?? null;
const offerOf = async (id) => (await raw("SELECT * FROM offers WHERE id = ?", [`bundle-${id}`])).rows[0] ?? null;

const owner = await I.createUser({ email: "owner@cb.test", password: "owner-pass-p5" });
await I.addMembership(owner.id, "cb", "owner");
const ownerTok = (await S.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const callRoute = async (method, body) => {
  const url = new URL("http://cb.test/api/admin/bundles");
  const res = await bundleRoute[method]({
    url: url.href,
    nextUrl: url,
    cookies: { get: (n) => (n === "_admin" ? { name: n, value: ownerTok } : undefined) },
    headers: { get: (k) => ({ host: "cb.test" })[k.toLowerCase()] ?? null },
    json: async () => body,
  }, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
};

// ---- the state matrix --------------------------------------------------------
const M = {};
await inB(async () => {
  M.avail = (await B.upsertBundle({ slug: "m-avail", title: "Avail", items: it2(1, 2), bundle_price: 250, enable: true })).id;
  M.sold = (await B.upsertBundle({ slug: "m-sold", title: "Sold", items: it2(3, 4), bundle_price: 600, enable: true })).id;
  M.nosave = (await B.upsertBundle({ slug: "m-nosave", title: "No save", items: it2(5, 6), bundle_price: 1000, enable: true })).id;
  M.offerGone = (await B.upsertBundle({ slug: "m-offer-gone", title: "Offer gone", items: it2(1, 3), bundle_price: 350, enable: true })).id;
  M.offerOff = (await B.upsertBundle({ slug: "m-offer-off", title: "Offer off", items: it2(2, 3), bundle_price: 450, enable: true })).id;
  M.offerPrice = (await B.upsertBundle({ slug: "m-offer-price", title: "Offer price", items: it2(1, 4), bundle_price: 450, enable: true })).id;
  M.offerSched = (await B.upsertBundle({ slug: "m-offer-sched", title: "Offer sched", items: it2(2, 4), bundle_price: 550, enable: true })).id;
  M.off = (await B.upsertBundle({ slug: "m-off", title: "Off", items: it2(1, 2), bundle_price: 250, enable: false })).id;
  // stored with a duplicate, as an older console could have written it: the
  // row and its offer agree, only the duplicate is wrong
  const dupItems = [{ variantId: V(5), quantity: 1 }, { variantId: V(5), quantity: 1 }, { variantId: V(6), quantity: 1 }];
  const ts = new Date().toISOString();
  await raw("INSERT INTO bundles (id, slug, title, description, items, bundle_price, enabled, created_at, updated_at) VALUES ('bun-rawdup', 'm-rawdup', 'Raw dup', '', ?, 1500, 1, ?, ?)", [JSON.stringify(dupItems), ts, ts]);
  await O.upsertOffer({ offer: { id: "bundle-bun-rawdup", type: "BUNDLE", scope: "line", priority: 5, title: "Raw dup", items: dupItems, price: 1500 }, enabled: true });
  M.rawdup = "bun-rawdup";
});
// the catalog and the offers move under them
await raw("UPDATE variants SET available = 0 WHERE id = ?", [V(3)]);
await raw("UPDATE variants SET price = 100 WHERE id = ?", [V(5)]); // 5 + 6: 100 + 600 = 700 < 1000
await raw("DELETE FROM offers WHERE id = ?", [`bundle-${M.offerGone}`]);
await raw("UPDATE offers SET enabled = 0 WHERE id = ?", [`bundle-${M.offerOff}`]);
await raw("UPDATE offers SET config = json_set(config, '$.price', 1) WHERE id = ?", [`bundle-${M.offerPrice}`]);
await raw("UPDATE offers SET ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [`bundle-${M.offerSched}`]);

await t("P5: bundlesByIds gives available, sold_out, no_saving, not_ready (offer missing, off, out of schedule, price differs, raw duplicate items), disabled and missing", async () => {
  const ids = [M.avail, M.sold, M.nosave, M.offerGone, M.offerOff, M.offerSched, M.offerPrice, M.rawdup, M.off, "bun-nope"];
  const map = await inB(() => BR.bundlesByIds(ids));
  same([...map.keys()], ids, "every id answered, in order");
  const st = (id) => map.get(id).state;
  same(ids.map(st), ["available", "sold_out", "no_saving", "not_ready", "not_ready", "not_ready", "not_ready", "not_ready", "disabled", "missing"], "states");
  const detail = (id) => map.get(id).reasons.find((r) => r.kind === "not_synced")?.detail;
  same([M.offerGone, M.offerOff, M.offerSched, M.offerPrice].map(detail), ["offer_missing", "offer_disabled", "offer_scheduled", "offer_differs"], "offer reasons");
  ok(map.get(M.rawdup).reasons.some((r) => r.kind === "duplicate" && r.index === 1), "duplicate reason");
  eq(detail(M.rawdup), undefined, "the raw duplicate's offer is in sync: only the duplicate makes it not ready");
  const a = map.get(M.avail);
  same([a.slug, a.title, a.bundle_price, a.componentsSum, a.saving, a.currency, a.enabled], ["m-avail", "Avail", 250, 300, 50, "INR", true], "available payload");
  same(a.components.map((c) => [c.variantId, c.quantity, c.title, c.state, c.available]), [[V(1), 1, "Fixture product 1", "ok", true], [V(2), 1, "Fixture product 2", "ok", true]], "components");
  same(map.get(M.sold).components.map((c) => c.state), ["sold_out", "ok"], "the sold-out component is marked");
  same(map.get(M.nosave).reasons, [{ kind: "no_saving", sum: 700, price: 1000 }], "no_saving names the sum");
  same(map.get("bun-nope").components, [], "missing has no components");
  const text = JSON.stringify([...map.values()]);
  ok(!/catalog_title|"sku"|FX-\d/.test(text), "no raw catalog title or SKU in the payload");
});

await t("P5: a component gone from the catalog is sold_out with a 'missing' component; mixed currencies are not_ready", async () => {
  const mixed = await inB(() => B.upsertBundle({ slug: "m-mixed", title: "Mixed", items: it2(7, 8), bundle_price: 1400, enable: false }));
  await raw("UPDATE variants SET currency = 'USD' WHERE id = ?", [V(8)]);
  await raw("UPDATE variants SET currency = 'INR' WHERE id = ?", [V(7)]);
  const gone = await inB(() => B.upsertBundle({ slug: "m-gone", title: "Gone", items: [{ variantId: V(1) }, { variantId: "gid://shopify/ProductVariant/404" }], bundle_price: 50, enable: false }));
  await raw("UPDATE bundles SET enabled = 1 WHERE id IN (?, ?)", [mixed.id, gone.id]);
  await raw("UPDATE offers SET enabled = 1 WHERE id IN (?, ?)", [`bundle-${mixed.id}`, `bundle-${gone.id}`]);
  const map = await inB(() => BR.bundlesByIds([mixed.id, gone.id]));
  eq(map.get(mixed.id).state, "not_ready", "mixed:");
  ok(map.get(mixed.id).reasons.some((r) => r.kind === "mixed_currency"), "mixed reason");
  eq(map.get(mixed.id).currency, null, "no single currency:");
  eq(map.get(gone.id).state, "sold_out", "gone:");
  same(map.get(gone.id).components.map((c) => c.state), ["ok", "missing"], "gone component marked");
  await raw("UPDATE variants SET currency = 'INR' WHERE id IN (?, ?)", [V(7), V(8)]);
  await raw("DELETE FROM bundles WHERE id IN (?, ?)", [mixed.id, gone.id]);
  await raw("DELETE FROM offers WHERE id IN (?, ?)", [`bundle-${mixed.id}`, `bundle-${gone.id}`]);
});

await t("P5: after a warm-up, 1 bundle of 2 and 6 bundles of 4 cost the same number of statements, at most 3", async () => {
  const six = [];
  await inB(async () => {
    for (let k = 0; k < 6; k++) {
      const ns = [1, 2, 3, 4].map((j) => ((k + j * 2) % 12) + 1);
      six.push((await B.upsertBundle({ slug: `count-${k}`, title: `Count ${k}`, items: it2(...new Set(ns)), bundle_price: 100, enable: false })).id);
    }
  });
  ok(six.length === 6, "six bundles");
  const counts = await inB(async () => {
    await BR.bundlesByIds([M.avail]); // warm the schema probe
    const one = await watchStatements(currentDatabase().libsql, () => BR.bundlesByIds([M.avail]));
    const many = await watchStatements(currentDatabase().libsql, () => BR.bundlesByIds(six));
    return [one.statements, many.statements];
  });
  eq(counts[0].length, counts[1].length, `1 vs 6: ${counts[0].join(" | ")} vs ${counts[1].join(" | ")}\n   `);
  ok(counts[1].length <= 3, `at most 3, got ${counts[1].length}`);
  eq(counts[1].length, 3, "bundles+offers, variants, products:");
  for (const id of six) await inB(() => B.deleteBundle(id));
  same(await inB(async () => [...(await BR.bundlesByIds([])).keys()]), [], "no ids, no statement, empty map");
});

await t("P5: when the bundles read fails, bundlesByIds throws (never 'missing', never an empty Map)", async () => {
  await raw("ALTER TABLE bundles RENAME TO bundles_away");
  try {
    const got = await inB(() => BR.bundlesByIds([M.avail]).then((m) => `resolved with ${m.size} rows: ${JSON.stringify([...m.values()].map((b) => b.state))}`, (e) => e));
    ok(got instanceof Error, String(got));
    ok(/no such table/i.test(got.message), got.message);
  } finally {
    await raw("ALTER TABLE bundles_away RENAME TO bundles");
  }
});

await t("P5: the saving the read gives equals the BUNDLE discount getCart gives for one complete set", async () => {
  await inB(async () => {
    const b = await B.upsertBundle({ slug: "cart-set", title: "Cart set", items: it2(9, 10), bundle_price: 1234.4, enable: true });
    const read = (await BR.bundlesByIds([b.id])).get(b.id);
    eq(read.state, "available", "state:");
    eq(read.saving, 666, "1900 - 1234.4, rounded:");
    await Cart.createCart("p5-cart-1");
    await Cart.addItem("p5-cart-1", V(9), 1);
    await Cart.addItem("p5-cart-1", V(10), 1);
    const cart = await Cart.getCart("p5-cart-1");
    const applied = cart.appliedOffers.find((o) => o.id === `bundle-${b.id}`);
    eq(applied?.amount, read.saving, "engine discount = advertised saving:");
    await B.deleteBundle(b.id);
  });
});

await t("P5: duplicate items merge on write, and the engine's discount then equals the advertised saving", async () => {
  await inB(async () => {
    const b = await B.upsertBundle({ slug: "dup-merge", title: "Dup merge", items: [{ variantId: V(11), quantity: 1 }, { variantId: V(11), quantity: 1 }, { variantId: V(12), quantity: 1 }], bundle_price: 3000, enable: true });
    same(JSON.parse((await rowOf(b.id)).items), [{ variantId: V(11), quantity: 2 }, { variantId: V(12), quantity: 1 }], "stored merged");
    same(JSON.parse((await offerOf(b.id)).config).items, [{ variantId: V(11), quantity: 2 }, { variantId: V(12), quantity: 1 }], "offer merged");
    const read = (await BR.bundlesByIds([b.id])).get(b.id);
    eq(read.state, "available", "state:");
    eq(read.saving, 2200 + 1200 - 3000, "saving:");
    await Cart.createCart("p5-cart-2");
    await Cart.addItem("p5-cart-2", V(11), 2);
    await Cart.addItem("p5-cart-2", V(12), 1);
    const cart = await Cart.getCart("p5-cart-2");
    eq(cart.appliedOffers.find((o) => o.id === `bundle-${b.id}`)?.amount, read.saving, "engine discount:");
    const created = await B.createBundle({ title: "Dup create", items: [{ variantId: V(11) }, { variantId: V(12) }, { variantId: V(11) }], bundle_price: 3000 });
    same(JSON.parse((await rowOf(created.id)).items), [{ variantId: V(11), quantity: 2 }, { variantId: V(12), quantity: 1 }], "createBundle merges too");
    await B.deleteBundle(b.id);
    await B.deleteBundle(created.id);
  });
});

await t("P5: overlapping turned-on bundles list each other in overlapsWith", async () => {
  await inB(async () => {
    const a = await B.upsertBundle({ slug: "ov-a", title: "Overlap A", items: it2(13, 14), bundle_price: 2000, enable: true });
    const b = await B.upsertBundle({ slug: "ov-b", title: "Overlap B", items: it2(13, 14, 15), bundle_price: 3500, enable: true });
    const c = await B.upsertBundle({ slug: "ov-c", title: "Overlap C off", items: it2(13, 16), bundle_price: 2500, enable: false });
    const map = await BR.bundlesByIds([a.id, b.id]);
    same(map.get(a.id).overlapsWith, [{ id: b.id, title: "Overlap B" }], "A lists B");
    same(map.get(b.id).overlapsWith, [{ id: a.id, title: "Overlap A" }], "B lists A (a turned-off bundle is not an overlap)");
    same(map.get(M.avail) ? 1 : 0, 0, "only requested ids come back");
    for (const x of [a, b, c]) await B.deleteBundle(x.id);
  });
});

await t("P5: a create onto a taken slug and an edit onto another bundle's slug are both SLUG_TAKEN, and change nothing", async () => {
  const before = [await bundleCount(), await rowOf(M.avail), await rowOf(M.off), await offerOf(M.off)];
  eq(await inB(() => codeOf(B.upsertBundle({ id: null, slug: "m-avail", title: "Thief", items: it2(1, 2), bundle_price: 200, enable: false }))), "SLUG_TAKEN", "create:");
  eq(await inB(() => codeOf(B.upsertBundle({ id: M.off, slug: "m-avail", title: "Off", items: it2(1, 2), bundle_price: 250 }))), "SLUG_TAKEN", "edit:");
  same([await bundleCount(), await rowOf(M.avail), await rowOf(M.off), await offerOf(M.off)], before, "nothing changed");
  const r = await callRoute("POST", { bundle: { slug: "m-avail", title: "Thief", items: it2(1, 2), bundle_price: 200, enable: false } });
  same([r.status, r.body.code, r.body.error], [409, "SLUG_TAKEN", "A bundle with this link already exists."], "route:");
  eq(await bundleCount(), before[0], "route wrote nothing:");
});

await t("P5: createBundle derives slugs: 'Gym Kit' twice, a 61-character name, a Hindi name; mustPass with a failing check saves nothing", async () => {
  await inB(async () => {
    const one = await B.createBundle({ title: "Gym Kit", items: it2(1, 2), bundle_price: 250, enable: true });
    const two = await B.createBundle({ title: "Gym Kit", items: it2(1, 2), bundle_price: 250 });
    same([one.slug, two.slug, Number(one.enabled), Number(two.enabled)], ["gym-kit", "gym-kit-2", 1, 0], "gym-kit, gym-kit-2 (on only when asked)");
    const long = "Protein Whey Creatine Shaker Starter Pack For Every Single Gy"; // 61 characters
    eq(long.length, 61, "title length:");
    const l1 = await B.createBundle({ title: long, items: it2(1, 2), bundle_price: 250 });
    const l2 = await B.createBundle({ title: long, items: it2(1, 2), bundle_price: 250 });
    ok(SLUG_RULE.test(l1.slug) && SLUG_RULE.test(l2.slug), `${l1.slug} / ${l2.slug}`);
    ok(l2.slug.endsWith("-2") && l2.slug.length <= 61, l2.slug);
    const hi = await B.createBundle({ title: "जिम किट", items: it2(1, 2), bundle_price: 250 });
    eq(hi.slug, "bundle", "a name with no Latin letters:");
    const hi2 = await B.createBundle({ title: "व्यायाम", items: it2(1, 2), bundle_price: 250 });
    eq(hi2.slug, "bundle-2", "the next one:");
    eq(B.slugBase("  Café -- Deluxe!! "), "cafe-deluxe", "accents and punctuation:");
    const n = await bundleCount();
    const offers = Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n);
    const refused = await B.createBundle({ title: "Never", items: it2(1, 2), bundle_price: 9999, mustPass: true }).then(() => null, (e) => e);
    same([refused?.code, refused?.state, refused?.reasons?.map((r) => r.kind)], ["BUNDLE_INCOMPATIBLE", "no_saving", ["no_saving"]], "refused with reasons");
    same([await bundleCount(), Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n)], [n, offers], "nothing saved, no offer");
    eq((await raw("SELECT count(*) AS n FROM bundles WHERE slug LIKE 'never%'")).rows[0].n, 0, "no 'never' slug:");
    const drafted = await B.createBundle({ title: "Draft fail", items: it2(1, 2), bundle_price: 9999, enable: true });
    same([Number(drafted.enabled), drafted.compat.state], [0, "no_saving"], "without mustPass it saves turned off, with the reasons");
    for (const x of [one, two, l1, l2, hi, hi2, drafted]) await B.deleteBundle(x.id);
  });
});

// P5-BUNDLEREAD fix 1: a bundle that passes the check but that the offer
// engine refuses (a 2-character name, a quantity of 1.5) used to be left
// behind turned on with no offer, while the call reported a failure.
await t("P5 fix 1: createBundle mustPass with a 2-character name, or a quantity of 1.5, is refused with nothing saved, and a retry gets the plain slug", async () => {
  await inB(async () => {
    const counts = async () => [await bundleCount(), Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n)];
    const before = await counts();
    const gy = await B.createBundle({ title: "Gy", items: it2(1, 2), bundle_price: 250, enable: true, mustPass: true }).then(() => null, (e) => e);
    same([gy?.code, gy?.message], ["BUNDLE_INVALID", "Give the bundle a name of at least 3 characters. Nothing was saved."], "refused in plain words");
    same(await counts(), before, "(a) no row, no offer");
    eq((await raw("SELECT count(*) AS n FROM bundles WHERE slug LIKE 'gy%'")).rows[0].n, 0, "no 'gy' slug:");
    eq(await B.getBundle("gy"), null, "the storefront shows nothing:");
    const frac = await B.createBundle({ title: "Frac kit", items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2), quantity: 1 }], bundle_price: 250, enable: true, mustPass: true }).then(() => null, (e) => e);
    same([frac?.code, frac?.message], ["BUNDLE_INVALID", "Each product's quantity must be a whole number, 1 or more. Nothing was saved."], "refused in plain words");
    same(await counts(), before, "(b) no row, no offer");
    eq((await raw("SELECT count(*) AS n FROM bundles WHERE slug LIKE 'frac-kit%'")).rows[0].n, 0, "no 'frac-kit' slug:");
    // without mustPass, asked to go on: refused the same way, nothing saved
    eq(await codeOf(B.createBundle({ title: "Gy", items: it2(1, 2), bundle_price: 250, enable: true })), "BUNDLE_INVALID", "enable without mustPass:");
    same(await counts(), before, "still nothing saved");
    // the founder fixes the name and retries: the plain slug, on, with its offer
    const fixed = await B.createBundle({ title: "Gym", items: it2(1, 2), bundle_price: 250, enable: true, mustPass: true });
    same([fixed.slug, Number(fixed.enabled), Number((await offerOf(fixed.id))?.enabled)], ["gym", 1, 1], "retry");
    await B.deleteBundle(fixed.id);
  });
  const r = await callRoute("POST", { create: { title: "Gy", items: it2(1, 2), bundle_price: 250, enable: true, mustPass: true } });
  same([r.status, r.body.code], [422, "BUNDLE_INVALID"], "route:");
  eq((await raw("SELECT count(*) AS n FROM bundles WHERE slug LIKE 'gy%'")).rows[0].n, 0, "route wrote nothing:");
});

await t("P5 fix 1: upsertBundle and setBundleEnabled never leave a turned-on bundle without its offer", async () => {
  await inB(async () => {
    const n = await bundleCount();
    // a new bundle asked to go on with a 2-character name: refused before the row
    eq(await codeOf(B.upsertBundle({ slug: "two-ch", title: "Tw", items: it2(1, 2), bundle_price: 250, enable: true })), "BUNDLE_INVALID", "create on:");
    eq(await bundleCount(), n, "no row:");
    // an edit of a turned-on bundle to a quantity of 1.5: row and offer unchanged
    const live = await B.upsertBundle({ slug: "live-q", title: "Live q", items: it2(1, 2), bundle_price: 250, enable: true });
    const before = [await rowOf(live.id), await offerOf(live.id)];
    eq(await codeOf(B.upsertBundle({ id: live.id, title: "Live q", items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2), quantity: 1 }], bundle_price: 250 })), "BUNDLE_INVALID", "edit:");
    same([await rowOf(live.id), await offerOf(live.id)], before, "nothing changed");
    // a turned-off draft the engine refused has no offer; turning it on with
    // that name is refused, and with a fixed name writes its offer in full
    const draft = await B.upsertBundle({ slug: "draft-tw", title: "Tw", items: it2(1, 2), bundle_price: 250, enable: false });
    eq(await offerOf(draft.id), null, "no offer for the draft:");
    eq(await codeOf(B.setBundleEnabled(draft.id, true)), "BUNDLE_INVALID", "enable refused:");
    eq(Number((await rowOf(draft.id)).enabled), 0, "still off:");
    await B.upsertBundle({ id: draft.id, title: "Two", items: it2(1, 2), bundle_price: 250 });
    await B.setBundleEnabled(draft.id, true);
    same([Number((await rowOf(draft.id)).enabled), Number((await offerOf(draft.id))?.enabled)], [1, 1], "on, with its offer");
    eq((await BR.bundlesByIds([draft.id])).get(draft.id).state, "available", "read as available:");
    for (const x of [live, draft]) await B.deleteBundle(x.id);
  });
});

await t("P5: editing a turned-on bundle's price (no enable, no description sent) keeps it on, its offer on with the new price, and its description", async () => {
  const b = await inB(() => B.upsertBundle({ slug: "edit-me", title: "Edit me", description: "Keep this text", items: it2(9, 10), bundle_price: 1800, enable: true }));
  const r = await callRoute("POST", { bundle: { id: b.id, title: "Edit me", items: it2(9, 10), bundle_price: 1700 } });
  eq(r.status, 200, JSON.stringify(r.body));
  const row = await rowOf(b.id);
  same([Number(row.enabled), row.description, row.slug, Number(row.bundle_price)], [1, "Keep this text", "edit-me", 1700], "row");
  const offer = await offerOf(b.id);
  same([Number(offer.enabled), JSON.parse(offer.config).price], [1, 1700], "offer");
  eq((await inB(() => BR.bundlesByIds([b.id]))).get(b.id).state, "available", "still showing:");
  M.edit = b.id;
});

await t("P5: an edit that would break a turned-on bundle answers 422 and changes neither the row nor the offer", async () => {
  const before = [await rowOf(M.edit), await offerOf(M.edit)];
  const r = await callRoute("POST", { bundle: { id: M.edit, title: "Edit me", items: it2(9, 10), bundle_price: 5000 } });
  same([r.status, r.body.code, r.body.state], [422, "BUNDLE_INCOMPATIBLE", "no_saving"], "refused");
  ok(r.body.reasons.some((x) => x.kind === "no_saving"), "with reasons");
  ok(!/₹|component \d/.test(r.body.error), `plain words: ${r.body.error}`);
  same([await rowOf(M.edit), await offerOf(M.edit)], before, "nothing changed");
  const off = await callRoute("POST", { bundle: { id: M.edit, title: "Edit me", items: it2(9, 10), bundle_price: 5000, enable: false } });
  eq(off.status, 200, "enable: false still saves it turned off:");
  same([Number((await rowOf(M.edit)).enabled), Number((await offerOf(M.edit)).enabled)], [0, 0], "off, with its offer");
  const on = await callRoute("POST", { bundle: { id: M.edit, title: "Edit me", items: it2(9, 10), bundle_price: 5000, enable: true } });
  same([on.status, /^can't enable/.test(on.body.error)], [422, true], "enable: true is still checked");
});

await t("P5: POST { create } with a handle instead of a variant GID is refused 422 'Pick the product again.', with no row", async () => {
  const n = await bundleCount();
  const r = await callRoute("POST", { create: { title: "By handle", items: [{ variantId: "fixture-product-1", quantity: 1 }, { variantId: V(2), quantity: 1 }], bundle_price: 250 } });
  same([r.status, r.body.error], [422, "Pick the product again."], "refused");
  eq(await bundleCount(), n, "no row:");
  const good = await callRoute("POST", { create: { title: "Route Kit", items: it2(1, 2), bundle_price: 250, enable: true, mustPass: true } });
  eq(good.status, 200, JSON.stringify(good.body));
  same([good.body.bundle.slug, Number(good.body.bundle.enabled), good.body.compat.state, good.body.compat.reasons, good.body.currency], ["route-kit", 1, "available", [], "INR"], "created");
  const bad = await callRoute("POST", { create: { title: "Route Kit", items: it2(1, 2), bundle_price: 9999, mustPass: true } });
  same([bad.status, bad.body.code], [422, "BUNDLE_INCOMPATIBLE"], "mustPass refusal");
  eq(await bundleCount(), n + 1, "only the good one saved:");
  const g = await callRoute("GET", null);
  eq(g.body.currency, "INR", "GET currency:");
  ok(g.body.bundles.every((b) => typeof b.compat.state === "string" && Array.isArray(b.compat.reasons)), "GET reasons");
  const c = await callRoute("POST", { check: { items: it2(1, 3), bundle_price: 100 } });
  same([c.body.currency, c.body.compat.state, c.body.compat.reasons.map((x) => x.kind)], ["INR", "sold_out", ["sold_out"]], "check");
});

await t("P5: bundle words: no rupee sign, 'INR' or 'component ' in the source; USD sentences use $; a null currency never prints 'null'", async () => {
  const src = await readFile(join(ROOT, "lib/commerce/bundle-words.js"), "utf8");
  for (const bad of ["₹", "INR", "component "]) ok(!src.includes(bad), `bundle-words.js holds "${bad}"`);
  const STATES = ["available", "sold_out", "no_saving", "not_ready", "disabled", "missing"];
  const REASONS = [{ kind: "sold_out", index: 0 }, { kind: "missing", index: 1 }, { kind: "no_saving", sum: 1500, price: 1600 }, { kind: "too_few" }, { kind: "duplicate", index: 1 }, { kind: "bad_price" }, { kind: "mixed_currency" }, { kind: "not_synced", detail: "offer_missing" }];
  const all = (currency) => [...STATES.map((s) => BW.stateLine(s, REASONS, { currency })), ...REASONS.map((r) => BW.reasonSentence(r, { currency })), BW.gridEmptyLine(), BW.overlapLine()];
  const usd = all("USD");
  ok(usd.every((x) => x && !/₹|INR|component \d/.test(x)), usd.join(" | "));
  const money = [BW.stateLine("no_saving", REASONS, { currency: "USD" }), BW.reasonSentence(REASONS[2], { currency: "USD" })];
  ok(money.every((x) => x.includes("$1,500")), money.join(" | "));
  eq(BW.stateLine("no_saving", REASONS, { currency: "USD" }), "The price no longer saves anything (the products add up to $1,500), so shoppers don't see it. Lower the price in Catalog > Bundles.", "final text:");
  for (const cur of [null, undefined]) ok(all(cur).every((x) => !/null|undefined/.test(x)), `${cur}: ${all(cur).join(" | ")}`);
  eq(BW.stateLine("available", []), "Showing to shoppers.", "available:");
  eq(BW.reasonSentence({ kind: "duplicate" }), "This product is already in the bundle", "duplicate:");
});

await t("P5: bundle-read, bundle-compat and bundle-words import nothing under lib/offers/ and no node: module (tenant-context's async_hooks, which the edge runtime has, is the only one)", async () => {
  const { existsSync } = await import("node:fs");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
  const scan = async (start) => {
    const seen = new Set();
    const queue = [start];
    const hits = [];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      const src = strip(await readFile(join(ROOT, f), "utf8"));
      for (const m of src.matchAll(nodeImport)) hits.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
        let r = join(dirname(f), m[1]);
        if (!r.endsWith(".js")) r += ".js";
        if (existsSync(join(ROOT, r))) queue.push(r);
      }
    }
    return { seen, hits };
  };
  const read = await scan("lib/commerce/bundle-read.js");
  for (const f of ["lib/db.js", "lib/tenant-context.js", "lib/schema-compat.js", "lib/catalog/effective.js", "lib/commerce/bundle-compat.js"]) ok(read.seen.has(f), `${f} reached: ${[...read.seen].join(", ")}`);
  same(read.hits, ["lib/tenant-context.js: node:async_hooks"], "node imports from bundle-read");
  same([...read.seen].filter((f) => f.startsWith("lib/offers/")), [], "lib/offers from bundle-read");
  for (const f of ["lib/commerce/bundle-compat.js", "lib/commerce/bundle-words.js"]) {
    const r = await scan(f);
    same([r.hits, [...r.seen].filter((x) => x.startsWith("lib/offers/"))], [[], []], f);
  }
});

await t("P5: compatFrom keeps the legacy problems and adds states in order (not_ready, then sold_out, then no_saving)", async () => {
  const vs = new Map([["a", { id: "a", product_id: "pa", price: 100, available: 1 }], ["b", { id: "b", product_id: "pb", price: 200, available: 0 }]]);
  const ps = new Map([["pa", { id: "pa", title: "A", available: true }], ["pb", { id: "pb", title: "B", available: true }]]);
  const c = BC.compatFrom({ items: [{ variantId: "a" }, { variantId: "b" }], bundle_price: 500, variantsById: vs, productsById: ps });
  same([c.state, c.problems], ["sold_out", ["component 2 (B): sold out", "bundle price ₹500 doesn't save anything (components sum to ₹300)"]], "sold_out beats no_saving; legacy words kept");
  const d = BC.compatFrom({ items: [{ variantId: "a" }, { variantId: "a" }, { variantId: "b" }], bundle_price: 50, variantsById: vs, productsById: ps });
  eq(d.state, "not_ready", "duplicate beats sold_out:");
  same(BC.mergeItems([{ variantId: "a", quantity: 2 }, { variantId: "b" }, { variantId: "a", quantity: "3" }]), [{ variantId: "a", quantity: 5 }, { variantId: "b", quantity: 1 }], "mergeItems");
  const e = BC.compatFrom({ items: [{ variantId: "a" }, { variantId: "a2" }], bundle_price: 99.6, variantsById: new Map([...vs, ["a2", { id: "a2", product_id: "pa", price: 100.2, available: 1 }]]), productsById: ps });
  same([e.saving, e.liveSaving], [200.2 - 99.6, 101], "saving stays legacy; liveSaving is rounded like the engine");
});

console.log("— P5-PANEL: picked products only, edits keep what they don't send, home use, whole quantities");

await t("P5-PANEL: a handle (or any non-GID) variantId on `bundle` or `check` is refused 422 'Pick the product again.', and no row is written", async () => {
  const n = await bundleCount();
  const offers = Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n);
  const r = await callRoute("POST", { bundle: { slug: "by-handle", title: "By handle", items: [{ variantId: "fixture-product-1", quantity: 1 }, { variantId: V(2), quantity: 1 }], bundle_price: 250, enable: false } });
  same([r.status, r.body.error, r.body.code], [422, "Pick the product again.", "BAD_ITEM"], "bundle refused");
  const only = await callRoute("POST", { bundle: { slug: "by-handle", title: "By handle", items: [{ variantId: "some-handle" }], bundle_price: 250 } });
  same([only.status, only.body.error], [422, "Pick the product again."], "the brief's case");
  const blank = await callRoute("POST", { bundle: { slug: "by-handle", title: "By handle", items: [{ variantId: "" }, { variantId: V(2) }], bundle_price: 250 } });
  eq(blank.status, 422, "an empty variant id is refused too:");
  const c = await callRoute("POST", { check: { items: [{ variantId: "fixture-product-1", quantity: 1 }, { variantId: V(2), quantity: 1 }], bundle_price: 250 } });
  same([c.status, c.body.error, c.body.compat], [422, "Pick the product again.", undefined], "check refused, no compat");
  // an edit of an existing bundle by handle changes nothing either
  const before = [await rowOf(M.avail), await offerOf(M.avail)];
  const e = await callRoute("POST", { bundle: { id: M.avail, title: "Avail", items: [{ variantId: "fixture-product-1" }, { variantId: V(2) }], bundle_price: 250 } });
  eq(e.status, 422, "edit by handle:");
  same([await rowOf(M.avail), await offerOf(M.avail)], before, "the edited bundle is unchanged");
  same([await bundleCount(), Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n)], [n, offers], "no row, no offer");
  eq((await raw("SELECT count(*) AS n FROM bundles WHERE slug = 'by-handle'")).rows[0].n, 0, "no 'by-handle' slug:");
});

await t("P5-PANEL: an edit through the route without slug, enable or description keeps all three and updates the bundle-<id> offer price and items", async () => {
  const b = await inB(() => B.upsertBundle({ slug: "panel-edit", title: "Panel edit", description: "Stays as it was", items: it2(11, 12), bundle_price: 2000, enable: true }));
  const r = await callRoute("POST", { bundle: { id: b.id, title: "Panel edit 2", items: [...it2(11, 12), { variantId: V(13), quantity: 2 }], bundle_price: 4500 } });
  eq(r.status, 200, JSON.stringify(r.body));
  const row = await rowOf(b.id);
  same([row.slug, Number(row.enabled), row.description, row.title, Number(row.bundle_price)], ["panel-edit", 1, "Stays as it was", "Panel edit 2", 4500], "row");
  const offer = await offerOf(b.id);
  const cfg = JSON.parse(offer.config);
  same([Number(offer.enabled), cfg.price, cfg.items], [1, 4500, [{ variantId: V(11), quantity: 1 }, { variantId: V(12), quantity: 1 }, { variantId: V(13), quantity: 2 }]], "offer");
  await inB(() => B.deleteBundle(b.id));
});

await t("P5-PANEL: GET marks usedOnHome for a bundle the LIVE home refers to (not an older home version, not another document)", async () => {
  const ids = await inB(async () => [
    (await B.createBundle({ title: "On home", items: it2(1, 2), bundle_price: 250, enable: true })).id,
    (await B.createBundle({ title: "Old home", items: it2(1, 2), bundle_price: 250 })).id,
    (await B.createBundle({ title: "On a page", items: it2(1, 2), bundle_price: 250 })).id,
  ]);
  const [live, old, page] = ids;
  const ts = new Date().toISOString();
  const before = await callRoute("GET", null);
  ok(before.body.bundles.every((x) => x.usedOnHome === false), "no live home yet: all false");
  await raw("INSERT INTO documents (id, type, label, draft, draft_hash, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_home', 'home', 'Home', '{}', 'h', 1, 'ver_home2', ?, ?)", [ts, ts]);
  await raw("INSERT INTO documents (id, type, label, draft, draft_hash, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_pg', 'page', 'About', '{}', 'h', 1, 'ver_pg1', ?, ?)", [ts, ts]);
  await raw("INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ('ver_home2', 'bundle', ?), ('ver_home1', 'bundle', ?), ('ver_pg1', 'bundle', ?), ('ver_home2', 'media', ?)", [live, old, page, old]);
  try {
    const g = await callRoute("GET", null);
    eq(g.status, 200, JSON.stringify(g.body));
    const by = new Map(g.body.bundles.map((x) => [x.id, x.usedOnHome]));
    same([by.get(live), by.get(old), by.get(page), by.get(M.avail)], [true, false, false, false], "usedOnHome");
  } finally {
    await raw("DELETE FROM document_refs WHERE version_id IN ('ver_home1', 'ver_home2', 'ver_pg1')");
    await raw("DELETE FROM documents WHERE id IN ('doc_home', 'doc_pg')");
    for (const id of ids) await inB(() => B.deleteBundle(id));
  }
});

await t("P5-PANEL: a store without the documents tables reads every bundle as not on the home (no error)", async () => {
  await raw("ALTER TABLE document_refs RENAME TO document_refs_away");
  try {
    const g = await callRoute("GET", null);
    eq(g.status, 200, JSON.stringify(g.body));
    ok(g.body.bundles.length > 0 && g.body.bundles.every((x) => x.usedOnHome === false), "all false");
  } finally {
    await raw("ALTER TABLE document_refs_away RENAME TO document_refs");
  }
});

await t("P5-PANEL: a quantity that is not whole (1.5) gives the bad_quantity reason (not_ready), a turned-off draft saves with it, and it can never be turned on", async () => {
  await inB(async () => {
    const c = await B.bundleCompat({ items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2), quantity: 1 }], bundle_price: 250 });
    same([c.ok, c.state, c.reasons.map((r) => [r.kind, r.index ?? null])], [false, "not_ready", [["bad_quantity", 0]]], "the check");
    eq(c.reasons[0].title, "Fixture product 1", "the reason names the product:");
    ok(!/₹|component/i.test(c.reasons[0].words), `plain words: ${c.reasons[0].words}`);
    const whole = await B.bundleCompat({ items: [{ variantId: V(1), quantity: 2 }, { variantId: V(2), quantity: "1" }, { variantId: V(3) }], bundle_price: 500 });
    ok(!whole.reasons.some((r) => r.kind === "bad_quantity"), "whole numbers, a string '1' and a missing quantity are fine");
    const draft = await B.createBundle({ title: "Half kit", items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2), quantity: 1 }], bundle_price: 250 });
    same([Number(draft.enabled), draft.compat.state], [0, "not_ready"], "saved turned off, not ready");
    const listed = (await B.listBundles()).find((b) => b.id === draft.id);
    same([listed.compat.ok, listed.compat.state, listed.compat.reasons.map((r) => r.kind)], [false, "not_ready", ["bad_quantity"]], "listBundles never shows it as ready to turn on");
    same([await codeOf(B.setBundleEnabled(draft.id, true)), Number((await rowOf(draft.id)).enabled)], ["BUNDLE_INVALID", 0], "turning it on is refused");
    eq(await codeOf(B.upsertBundle({ id: draft.id, title: "Half kit", items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2), quantity: 1 }], bundle_price: 250, enable: true })), "BUNDLE_INVALID", "enable: true on an edit:");
    eq(await codeOf(B.createBundle({ title: "Half kit", items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2) }], bundle_price: 250, enable: true })), "BUNDLE_INVALID", "create asked to go on:");
    // fixed to a whole number, it turns on
    await B.upsertBundle({ id: draft.id, title: "Half kit", items: it2(1, 2), bundle_price: 250 });
    await B.setBundleEnabled(draft.id, true);
    same([Number((await rowOf(draft.id)).enabled), Number((await offerOf(draft.id))?.enabled)], [1, 1], "on, with its offer");
    await B.deleteBundle(draft.id);
  });
  const r = await callRoute("POST", { check: { items: [{ variantId: V(1), quantity: 1.5 }, { variantId: V(2), quantity: 1 }], bundle_price: 250 } });
  same([r.status, r.body.compat.state, r.body.compat.reasons.map((x) => x.kind)], [200, "not_ready", ["bad_quantity"]], "the route's check says it too");
});

await t("P5-PANEL: createBundle's pre-check: mustPass with enable: false and a 2-character name is refused, and nothing is saved", async () => {
  await inB(async () => {
    const before = [await bundleCount(), Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n)];
    const e = await B.createBundle({ title: "Gy", items: it2(1, 2), bundle_price: 250, enable: false, mustPass: true }).then(() => null, (x) => x);
    same([e?.code, e?.message], ["BUNDLE_INVALID", "Give the bundle a name of at least 3 characters. Nothing was saved."], "refused in plain words");
    same([await bundleCount(), Number((await raw("SELECT count(*) AS n FROM offers")).rows[0].n)], before, "no row, no offer");
    eq((await raw("SELECT count(*) AS n FROM bundles WHERE slug LIKE 'gy%'")).rows[0].n, 0, "no 'gy' slug:");
  });
});

rawClient.close();
await tn.cleanup();

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
