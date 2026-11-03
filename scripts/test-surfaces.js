// Content-surfaces + notifications suite (Session 39: BE23 notification
// service, SF15 contact, SF16 FAQ sections, SF17 campaigns + UTM retention,
// MC05 product overrides w/ deleted-product guard, MC06 collection pins w/
// ownership validation, MC11 nested nav, MC15 upsell enabled-state).
//   pnpm test:surfaces
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.RESEND_API_KEY = ""; // mail = labeled dev mock
process.env.DATABASE_URL = "file:.test-surf-default.db";
process.env.PLATFORM_DB_URL = "file:.test-surf-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-surf-default.db", ".test-surf-platform.db", ".test-surf-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const N = await import("../lib/notifications.js");
const O = await import("../lib/catalog-overrides.js");
const repo = await import("../lib/repo.js");
const P = await import("../lib/cms/placements.js");
const U = await import("../lib/content/utm.js");
const { validateBlock } = await import("../lib/cms/validate.js");
const { runDueJobs } = await import("../lib/platform/worker.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "surf", name: "Surf Tenant", domains: ["surf.test"], dbUrl: "file:.test-surf-t1.db", config: { site: { support_email: "owner@surf.test" } }, secrets: { order_link_secret: "surf-secret" } });

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await withTenant(await C.getTenant("surf"), async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, await loadMigrations("tenant"));
});
const inT = async (fn) => withTenant(await C.getTenant("surf"), fn);

// catalog fixtures
await inT(async () => {
  const rows = [
    ["gid://p/1", "alpha-whey", "Alpha Whey", "Protein", 1, "2026-01-02"],
    ["gid://p/2", "beta-bar", "Beta Bar", "Snacks", 1, "2026-01-01"],
    ["gid://p/3", "gamma-gone", "Gamma Gone", "Snacks", 0, "2026-01-03"],
  ];
  for (const [id, handle, title, type, avail, created] of rows) {
    await libsql.execute({
      sql: "INSERT INTO products (id, handle, title, product_type, price_min, available, created_at, currency) VALUES (?,?,?,?, 100, ?, ?, 'INR')",
      args: [id, handle, title, type, avail, created],
    });
  }
  await libsql.execute("INSERT INTO collections (id, handle, title) VALUES ('gid://c/1','all','All')");
  await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://c/1','gid://p/1',1)");
  await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://c/1','gid://p/2',2)");
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
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const includes = (hay, needle, label = "") => {
  if (!String(hay).includes(needle)) throw new Error(`${label} expected to include ${JSON.stringify(needle)} in ${JSON.stringify(String(hay).slice(0, 160))}`);
};
const throws = async (fn, re, label = "") => {
  try {
    await fn();
  } catch (e) {
    if (!re.test(e.message)) throw new Error(`${label} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${label} expected a throw`);
};

console.log("— notification service (BE23)");

await t("notify queues a durable intent; idempotency key dedupes", async () => {
  const a = await inT(() => N.notify({ type: "test", to: "x@y.test", subject: "Hello", text: "Body", idempotencyKey: "k1" }));
  eq(a.status, "queued");
  const b = await inT(() => N.notify({ type: "test", to: "x@y.test", subject: "Hello", text: "Body", idempotencyKey: "k1" }));
  eq(b.deduped, true);
  eq(b.id, a.id);
});

await t("delivery through the jobs queue: mock mail → sent, labeled DEV MOCK", async () => {
  const results = await runDueJobs({ limit: 10 });
  const mine = results.filter((r) => r.type === "send_notification");
  if (!mine.length) throw new Error("no send_notification job ran");
  const rows = await inT(() => N.listNotifications());
  const row = rows.find((r) => r.subject === "Hello");
  eq(row.status, "sent");
  eq(row.provider_id, "mock", "honestly labeled:");
  includes(row.error, "not configured");
});

await t("no recipient → intent recorded FAILED with an honest error, never silently dropped", async () => {
  const r = await inT(() => N.notify({ type: "test", to: "", subject: "Orphan", text: "x" }));
  eq(r.status, "failed");
  includes(r.error, "no recipient");
});

await t("marketing without a consent reference is refused; with one it queues", async () => {
  await throws(() => inT(() => N.notify({ type: "promo", to: "x@y.test", subject: "Sale", text: "x", consentClass: "marketing" })), /consent reference/);
  const ok = await inT(() => N.notify({ type: "promo", to: "x@y.test", subject: "Sale", text: "x", consentClass: "marketing", consentRef: "consent:v2:m1:2026-10-01" }));
  eq(ok.status, "queued");
});

console.log("— contact (SF15)");

await t("validation refuses bad input; a good message stores + links its notification", async () => {
  eq(N.validateContact({ name: "", email: "nope", message: "hi" }).ok, false);
  const r = await inT(() => N.submitContactMessage({ name: "Pat", email: "pat@shopper.test", message: "Where is my order? It has been a week." }, { supportEmail: "owner@surf.test", storeName: "Surf" }));
  if (!r.id || !r.notificationId) throw new Error("ids missing");
  await runDueJobs({ limit: 10 });
  const inbox = await inT(() => N.listContactMessages());
  eq(inbox[0].name, "Pat");
  eq(inbox[0].notify_status, "sent", "delivery state attached:");
});

console.log("— FAQ sections (SF16)");

await t("faq sections validate + sanitize; empty question refused", async () => {
  const page = await inT(() =>
    S.upsertContentPage({
      slug: "faq",
      title: "FAQ",
      sections: [{ kind: "faq", heading: "Orders", items: [{ q: "How fast?", a: '<p>Fast.</p><script>x()</script>' }] }],
    }),
  );
  eq(page.sections[0].kind, "faq");
  includes(page.sections[0].items[0].a, "<p>Fast.</p>");
  eq(page.sections[0].items[0].a.includes("<script"), false, "sanitized:");
  await throws(
    () => inT(() => S.upsertContentPage({ slug: "faq2", title: "x", sections: [{ kind: "faq", items: [{ q: "", a: "<p>x</p>" }] }] })),
    /question text required/,
  );
});

console.log("— campaigns (SF17)");

await t("campaign pages: family + UTC window validated; windows refused on plain pages", async () => {
  await inT(() =>
    S.upsertContentPage({
      slug: "diwali",
      title: "Diwali drop",
      family: "campaign",
      window_start: "2026-10-01T00:00:00.000Z",
      window_end: "2026-11-15T00:00:00.000Z",
      sections: [{ kind: "rich", html: '<p><a href="/collections">Shop</a></p>' }],
    }),
  );
  const page = await inT(() => S.getContentPage("diwali"));
  eq(page.family, "campaign");
  eq(page.window_start, "2026-10-01T00:00:00.000Z");
  await throws(() => inT(() => S.upsertContentPage({ slug: "x1", title: "x", family: "fiesta", sections: [] })), /unknown page family/);
  await throws(() => inT(() => S.upsertContentPage({ slug: "x1", title: "x", window_end: "2026-01-01T00:00:00Z", sections: [] })), /campaign and journal pages/);
  await throws(
    () => inT(() => S.upsertContentPage({ slug: "x1", title: "x", family: "campaign", window_start: "2026-02-01T00:00:00Z", window_end: "2026-01-01T00:00:00Z", sections: [] })),
    /after window start/,
  );
});

await t("campaignVisible honors the window; snapshot carries family + window", async () => {
  const page = await inT(() => S.getContentPage("diwali"));
  eq(S.campaignVisible(page, new Date("2026-10-20T00:00:00Z").getTime()), true, "inside:");
  eq(S.campaignVisible(page, new Date("2026-09-30T00:00:00Z").getTime()), false, "before:");
  eq(S.campaignVisible(page, new Date("2026-11-15T00:00:00Z").getTime()), false, "after (end exclusive):");
  const snap = await inT(R.snapshotContent);
  const row = snap.content.pages.find((p) => p.slug === "diwali");
  eq(row.family, "campaign");
  eq(row.window_end, "2026-11-15T00:00:00.000Z");
});

await t("utm retention: only utm_* params propagate, only into internal hrefs", async () => {
  const utm = U.pickUtmParams({ utm_source: "ig", utm_campaign: "drop", evil: "x", ref: "y" });
  eq(Object.keys(utm).join(","), "utm_source,utm_campaign");
  eq(U.appendUtm("/collections", utm), "/collections?utm_source=ig&utm_campaign=drop");
  eq(U.appendUtm("/search?q=whey", utm), "/search?q=whey&utm_source=ig&utm_campaign=drop");
  eq(U.appendUtm("/faq#q-how", utm), "/faq?utm_source=ig&utm_campaign=drop#q-how", "hash preserved:");
  eq(U.appendUtm("https://evil.example/x", utm), "https://evil.example/x", "external untouched:");
  const html = U.appendUtmToHtml('<p><a href="/collections">Shop</a> <a href="https://x.test/">ext</a></p>', utm);
  includes(html, 'href="/collections?utm_source=ig&utm_campaign=drop"');
  includes(html, 'href="https://x.test/"');
});

console.log("— product overrides (MC05)");

await t("modules sanitized at save; unknown product refused; empty override removes the row", async () => {
  const r = await inT(() => O.setProductOverride("gid://p/1", { modules: [{ title: "Ingredients", html: '<p>Whey.</p><img src=x onerror=x()>' }], badge: "Lab tested" }));
  eq(r.modules[0].html.includes("onerror"), false);
  eq(r.badge, "Lab tested");
  await throws(() => inT(() => O.setProductOverride("gid://p/999", { modules: [] })), /not in the catalog/);
  const gone = await inT(() => O.setProductOverride("gid://p/1", { modules: [], badge: "" }));
  eq(gone.removed, true);
  eq(await inT(() => O.getProductOverride("gid://p/1")), null);
});

await t("deleted-product guard: an override whose product vanished is flagged ORPHANED", async () => {
  await inT(() => O.setProductOverride("gid://p/3", { modules: [{ title: "Usage", html: "<p>Daily.</p>" }] }));
  await inT(() => libsql.execute("DELETE FROM products WHERE id = 'gid://p/3'"));
  const list = await inT(O.listProductOverrides);
  const row = list.find((o) => o.product_id === "gid://p/3");
  eq(row.orphaned, true);
  eq(row.handle, null);
});

console.log("— collection pins (MC06)");

await t("pins must belong to the collection; featured order puts pins first", async () => {
  await throws(() => inT(() => O.setCollectionPins("gid://c/1", ["gid://p/999"])), /aren't in this collection/);
  await inT(() => O.setCollectionPins("gid://c/1", ["gid://p/2"]));
  const r = await inT(() => repo.getProductsInCollection("all", {}));
  eq(r.products[0].handle, "beta-bar", "pinned first:");
  eq(r.products[1].handle, "alpha-whey");
  await inT(() => O.setCollectionPins("gid://c/1", []));
  const back = await inT(() => repo.getProductsInCollection("all", {}));
  eq(back.products[0].handle, "alpha-whey", "empty pins restore Shopify order:");
});

// P2-PERF fix round 2: the home rails read every rail's pins in one statement
// (collectionPinsByHandles) and skip the count they never show. The rail must
// order its products exactly as the per-collection read does.
await t("P2-PERF: home rails read all pins in one statement and keep the pinned order; no count is read", async () => {
  const { resolveHomeSectionData } = await import("../lib/cms/section-data.js");
  const rails = [
    { id: "sec_a", kind: "product_rail", collection: "all", limit: 4, enabled: true },
    { id: "sec_b", kind: "product_rail", collection: "nope", limit: 4, enabled: true },
    { id: "sec_c", kind: "product_rail", collection: "all", limit: 2, enabled: true },
  ];
  const watched = async (fn) => {
    const seen = [];
    const client = (await import("../lib/db.js")).currentDatabase().libsql;
    const execute = client.execute;
    client.execute = async (stmt, ...rest) => {
      seen.push(typeof stmt === "string" ? stmt : String(stmt?.sql ?? ""));
      return execute.call(client, stmt, ...rest);
    };
    try {
      return { result: await fn(), seen };
    } finally {
      delete client.execute;
    }
  };
  await inT(() => O.setCollectionPins("gid://c/1", ["gid://p/2"]));
  try {
    const batch = await inT(() => repo.collectionPinsByHandles(["all", "nope", "all"]));
    eq(JSON.stringify([...batch]), JSON.stringify([["all", await inT(() => repo.collectionPinsByHandle("all"))], ["nope", []]]), "batch pins = per-collection pins:");
    const { result: data, seen } = await inT(() => watched(() => resolveHomeSectionData(rails)));
    eq(data.get("sec_a").products.map((p) => p.handle).join(","), "beta-bar,alpha-whey", "pinned first on the rail:");
    eq(data.get("sec_c").products.map((p) => p.handle).join(","), "beta-bar,alpha-whey", "the second rail on the same collection:");
    eq(data.get("sec_b").products.length, 0, "a collection that doesn't exist:");
    eq(seen.filter((s) => /collection_overrides/.test(s)).length, 1, "pins statements for three rails:");
    eq(seen.filter((s) => /count\(/i.test(s)).length, 0, "count statements on the rails:");
    // the per-collection read is unchanged: the collection page still counts
    const page = await inT(() => repo.getProductsInCollection("all", {}));
    eq(page.total, 2, "the collection page's total:");
  } finally {
    await inT(() => O.setCollectionPins("gid://c/1", []));
  }
  const { result: plain } = await inT(() => watched(() => resolveHomeSectionData(rails)));
  eq(plain.get("sec_a").products[0].handle, "alpha-whey", "no pins, Shopify order:");
});

console.log("— nested nav (MC11)");

await t("one level of children validates; unsafe child URL and two-level nesting refused", async () => {
  let r = validateBlock("nav_header", [{ label: "Shop", href: "/collections", children: [{ label: "Whey", href: "/collections/all" }] }]);
  eq(r.ok, true);
  eq(r.value[0].children.length, 1);
  r = validateBlock("nav_header", [{ label: "Shop", href: "/collections", children: [{ label: "Evil", href: "javascript:x()" }] }]);
  eq(r.ok, false, "unsafe child:");
  r = validateBlock("nav_header", [{ label: "A", href: "/", children: [{ label: "B", href: "/", children: [{ label: "C", href: "/" }] }] }]);
  eq(r.ok, false, "two levels:");
});

await t("release validation checks child links too", async () => {
  await inT(() => S.setBlock("hero", { title: "Surf things" }));
  await inT(() => S.setBlock("nav_header", [{ label: "Shop", href: "/collections", children: [{ label: "Dead", href: "/products/does-not-exist" }] }]));
  const v = await inT(async () => R.validateRelease((await R.snapshotContent()).content));
  eq(v.ok, false);
  includes(v.errors.join(" | "), "doesn't exist in the catalog");
  await inT(() => S.deleteBlock("nav_header"));
});

console.log("— upsells (MC15)");

await t("a disabled placement stays disabled through an edit round-trip", async () => {
  const id = await inT(() => P.upsertPlacement({ kind: "cart_upsell", targetProductIds: ["gid://p/1"], title: "Try", enabled: false }));
  let row = (await inT(P.listPlacements)).find((p) => p.id === id);
  eq(row.enabled, false);
  // the console edit path preserves the stored state when the form omits it
  await inT(() => P.upsertPlacement({ id, kind: "cart_upsell", targetProductIds: ["gid://p/1", "gid://p/2"], title: "Try more", enabled: row.enabled }));
  row = (await inT(P.listPlacements)).find((p) => p.id === id);
  eq(row.enabled, false, "survived the edit:");
  eq(row.target_product_ids.length, 2, "edit applied:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
