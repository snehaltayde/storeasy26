// Commerce-expansion suite (Session 46 / BE31 + SF18–21): bundle
// compatibility gate + offer sync (zero new money paths — the engine math
// itself is covered in test-offers.js), deterministic quiz scoring and
// recommendations, journal family windows + slug redirects, and the returns
// state machine where APPROVAL MOVES NO MONEY.
//   pnpm test:commerce-exp
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

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

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
