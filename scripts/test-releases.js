// Releases suite (Session 36 / BE09 + SF23): snapshot determinism + content
// hashing, atomic publish with no draft→live leakage, rollback that preserves
// drafts, publish validation (required slots, dead catalog links, brand
// contrast), scheduled publish through the real jobs queue, and preview
// token expiry/tamper/tenant-binding.
// P2-VGATE adds the reader version gate: v1-v3 read as before (compared with
// outputs recorded from a6d028e), v4 fails closed, anything else is an error,
// one statement per request for pointer plus release (request-cache stub),
// listReleases hiding lost-race rows, and the storefront layout's chrome and
// maintenance page rendered (Next's SWC) on ContentUnavailableError.
// P2-GUARD adds the guarded flip: one write batch per publish, rollback and
// scheduled flip, so a lost race or a failed stamp leaves nothing behind; the
// scheduled job re-reads and retries; v4 targets are refused; the documents
// marker for every legacy surface; the documents-mode Publishing badge.
//   pnpm test:releases
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { readFile, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// One simulated request at a time for next/headers (the rendered layout).
// Outside one, headers() and cookies() throw, as Next's own do.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__vgateRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() {
  const r = req();
  return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) };
}
export async function cookies() {
  const r = req();
  return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) };
}
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rel-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rel-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

process.env.PLATFORM_SITE_HOSTS = "";

const dbs = [".test-rel-default.db", ".test-rel-platform.db", ".test-rel-t1.db", ".test-rel-vg.db", ".test-rel-vgbare.db", ".test-rel-vgl.db", ".test-rel-gd.db", ".test-rel-gd4.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const W = await import("../lib/platform/worker.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

// control plane + one registered tenant (the worker resolves job tenants here)
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({
  id: "rt",
  name: "Release Tenant",
  domains: ["rt.test"],
  dbUrl: "file:.test-rel-t1.db",
  config: { site: { name: "Release Tenant" } },
  secrets: { order_link_secret: "rt-link-secret" },
});

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const tenantMigrations = await loadMigrations("tenant");
const RT = (await C.getTenant("rt"));
await withTenant(RT, async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, tenantMigrations);
  // a tiny catalog for link validation
  await libsql.execute(
    "INSERT INTO collections (id, handle, title, synced_at) VALUES ('gid://shopify/Collection/1', 'whey', 'Whey', '2026-01-01')",
  );
});
const inTenant = (fn) => withTenant(RT, fn);

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

console.log("— snapshot & hash");

await t("snapshot is deterministic: same drafts → same canonical bytes → same hash", async () => {
  await inTenant(() => S.setBlock("hero", { title: "Release me", primary: { label: "Shop", href: "/collections/whey" } }));
  const [a, b] = [await inTenant(R.snapshotContent), await inTenant(R.snapshotContent)];
  eq(a.hash, b.hash);
  eq(a.canonical, b.canonical);
});

await t("stableStringify sorts keys recursively (field order can't change the hash)", async () => {
  eq(R.stableStringify({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
});

console.log("— publish / no leakage / rollback");

let relA, relB;
await t("publish flips the live pointer atomically and stamps published_at", async () => {
  relA = await inTenant(() => R.createRelease({ note: "first", actor: { kind: "merchant", id: "u1" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.id, relA.id);
  eq(live.content_hash, relA.hash);
  if (!live.published_at) throw new Error("published_at missing");
});

await t("editing a draft does NOT change the live release (no draft→live leak)", async () => {
  await inTenant(() => S.setBlock("hero", { title: "Draft-only edit", primary: { label: "Shop", href: "/collections/whey" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.content.blocks.hero.title, "Release me", "live hero:");
  // and the console sees the divergence
  const snap = await inTenant(R.snapshotContent);
  if (snap.hash === live.content_hash) throw new Error("dirty detection failed");
});

await t("second publish goes live; rollback to the first restores it and PRESERVES drafts", async () => {
  relB = await inTenant(() => R.createRelease({ note: "second", actor: { kind: "merchant", id: "u1" } }));
  eq((await inTenant(R.getLiveRelease)).id, relB.id);
  await inTenant(() => R.rollbackRelease(relA.id, { actor: { kind: "merchant", id: "u1" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.id, relA.id);
  eq(live.content.blocks.hero.title, "Release me");
  // drafts still carry the newer edit — rollback touched only the pointer
  eq((await inTenant(() => S.getBlockRow("hero"))).value.title, "Draft-only edit");
});

await t("release rows are immutable snapshots: A and B both still exist, hashes distinct", async () => {
  const { releases } = await inTenant(R.listReleases);
  eq(releases.length, 2);
  if (releases[0].content_hash === releases[1].content_hash) throw new Error("hashes should differ");
});

console.log("— publish validation");

await t("missing hero title blocks; dead catalog link blocks; unknown path warns", async () => {
  const base = { v: 1, blocks: {}, pages: [], brand: null };
  let r = await inTenant(() => R.validateRelease({ ...base, blocks: { hero: { title: "  " } } }));
  eq(r.ok, false, "empty hero:");
  r = await inTenant(() => R.validateRelease({ ...base, blocks: { hero: { title: "Hi", primary: { label: "x", href: "/collections/does-not-exist" } } } }));
  eq(r.ok, false, "dead link:");
  if (!/doesn't exist in the catalog/.test(r.errors.join(" "))) throw new Error(`wrong error: ${r.errors}`);
  r = await inTenant(() => R.validateRelease({ ...base, blocks: { nav_header: [{ label: "Blog", href: "/blog" }] } }));
  eq(r.ok, true, "unknown path is a warning:");
  // S38 adds missing-policy-page warnings for plain tenants — count only the path one
  eq(r.warnings.filter((w) => w.includes("isn't a storefront route")).length, 1);
});

await t("brand contrast failure blocks a publish even if it slipped into drafts", async () => {
  const r = await inTenant(() => R.validateRelease({ v: 1, blocks: {}, pages: [], brand: { foreground: "#cccccc", background: "#ffffff" } }));
  eq(r.ok, false);
  // DOC-04: the issue names its document; "Brand:" is the reader's wording, not the server's
  const brand = r.issues.find((i) => i.severity === "error");
  // TOK-02: readability is the pairing matrix (BRAND_PAIR); BRAND_INVALID is a malformed value
  if (brand?.documentId !== "doc_design" || brand.code !== "BRAND_PAIR") throw new Error(`wrong issue: ${JSON.stringify(r.issues)}`);
  if (!/contrast/i.test(r.errors[0])) throw new Error(`wrong error: ${r.errors}`);
  const { issueText } = await import("../lib/cms/issues.js");
  if (!/^Brand: /.test(issueText(brand))) throw new Error(`worded: ${issueText(brand)}`);
});

await t("createRelease refuses an invalid draft set with RELEASE_INVALID", async () => {
  await inTenant(() => S.setBlock("hero", { title: "" }));
  try {
    await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } }));
    throw new Error("expected RELEASE_INVALID");
  } catch (e) {
    eq(e.code, "RELEASE_INVALID");
  }
  await inTenant(() => S.setBlock("hero", { title: "Draft-only edit" })); // restore
});

console.log("— scheduled publish via the jobs queue");

await t("schedule creates the release WITHOUT flipping; the due job flips it", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const r = await inTenant(() => R.createRelease({ note: "scheduled", actor: { kind: "merchant", id: "u1" }, scheduledFor: future }));
  eq((await inTenant(R.getLiveRelease)).id, relA.id, "pointer untouched:");
  const job = (
    await C.platformDb().execute({ sql: "SELECT id, tenant_id, run_after, status FROM jobs WHERE idempotency_key = ?", args: [`publish_${r.id}`] })
  ).rows[0];
  if (!job) throw new Error("no queued job");
  eq(job.tenant_id, "rt");
  eq(job.run_after, future);
  // make it due, then run through the REAL worker path (tenant context included)
  await C.platformDb().execute({ sql: "UPDATE jobs SET run_after = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), job.id] });
  const res = await W.runJobById(job.id);
  eq(res.ok, true, "job:");
  eq((await inTenant(R.getLiveRelease)).id, r.id, "flipped:");
  if (!(await inTenant(R.getLiveRelease)).published_at) throw new Error("published_at missing after scheduled flip");
});

console.log("— S52: schedule cancel + per-item diff + known paths");

await t("cancelScheduledRelease removes the pending job and the never-published row", async () => {
  const future = new Date(Date.now() + 120_000).toISOString();
  const r = await inTenant(() => R.createRelease({ note: "to-cancel", actor: { kind: "merchant", id: "u1" }, scheduledFor: future }));
  const out = await inTenant(() => R.cancelScheduledRelease(r.id, { actor: { kind: "merchant", id: "u1" } }));
  eq(out.cancelled, true);
  const job = (await C.platformDb().execute({ sql: "SELECT id FROM jobs WHERE idempotency_key = ?", args: [`publish_${r.id}`] })).rows[0];
  if (job) throw new Error("job still queued after cancel");
  const row = (await C.platformDb().execute({ sql: "SELECT 1 FROM jobs WHERE idempotency_key = ?", args: [`publish_${r.id}`] })).rows[0];
  if (row) throw new Error("job row survived");
  const rels = await inTenant(() => R.listReleases({ limit: 50 }));
  if (rels.releases.find((x) => x.id === r.id)) throw new Error("release row survived cancel");
});

await t("cancelScheduledRelease refuses published and non-scheduled releases", async () => {
  try {
    await inTenant(() => R.cancelScheduledRelease(relA.id));
    throw new Error("expected refuse");
  } catch (e) {
    if (!/not a scheduled release|already published/.test(e.message)) throw e;
  }
  try {
    await inTenant(() => R.cancelScheduledRelease("rel_nope"));
    throw new Error("expected 404");
  } catch (e) {
    if (!/not found/.test(e.message)) throw e;
  }
});

await t("releaseDiff names exactly what changed since live", async () => {
  await inTenant(() => S.setBlock("hero", { title: "Diff hero edit" })); // block edit vs live
  await inTenant(() => S.upsertContentPage({ slug: "diff-page", title: "Diff page", sections: [{ kind: "text", heading: "H", body: ["x"] }] }));
  const d = await inTenant(() => R.releaseDiff());
  eq(d.firstPublish, false);
  eq(d.dirty, true);
  const hero = d.items.find((i) => i.type === "block" && i.key === "hero");
  if (!hero) throw new Error(`hero change missing: ${JSON.stringify(d.items)}`);
  const page = d.items.find((i) => i.type === "page" && i.key === "diff-page");
  eq(page?.change, "added");
  // publish → diff empties
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } }));
  const d2 = await inTenant(() => R.releaseDiff());
  eq(d2.dirty, false);
  eq(d2.items.length, 0, "clean after publish:");
  // delete the page → "removed"
  await inTenant(() => S.deleteContentPage("diff-page"));
  const d3 = await inTenant(() => R.releaseDiff());
  eq(d3.items.find((i) => i.type === "page" && i.key === "diff-page")?.change, "removed");
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } })); // settle
});

await t("links to /journal, /quiz, /bundles, /wishlist, /account no longer warn", async () => {
  await inTenant(() =>
    S.setBlock("nav_header", [
      { label: "Journal", href: "/journal" },
      { label: "Quiz", href: "/quiz/skin" },
      { label: "Sets", href: "/bundles/kit" },
      { label: "Wishlist", href: "/wishlist" },
      { label: "Account", href: "/account" },
    ]),
  );
  const snap = await inTenant(() => R.snapshotContent());
  const v = await inTenant(() => R.validateRelease(snap.content));
  // DOC-04: the messages no longer say "Header nav …", so filter on where each
  // issue is filed, not its words (filtering on /nav/ found nothing, ever)
  const navUnknown = (i) => i.documentId === "doc_header" && i.code === "LINK_UNKNOWN_ROUTE";
  const navWarnings = v.issues.filter(navUnknown).map((i) => i.message);
  eq(navWarnings.length, 0, `spurious warnings: ${navWarnings.join(" | ")}`);
  // and the same filter does catch one when there is one
  const bad = await inTenant(() => R.validateRelease({ ...snap.content, blocks: { ...snap.content.blocks, nav_header: [{ label: "Blog", href: "/blog" }] } }));
  eq(bad.issues.filter(navUnknown).length, 1, "a real unknown route is caught:");
  await inTenant(() => S.deleteBlock("nav_header"));
});

await t("publishReleaseById on an unknown id fails (job dead-letters, pointer safe)", async () => {
  const before = (await inTenant(R.getLiveRelease)).id;
  try {
    await inTenant(() => R.publishReleaseById("rel_nope"));
    throw new Error("expected throw");
  } catch (e) {
    if (!/not found/.test(e.message)) throw e;
  }
  eq((await inTenant(R.getLiveRelease)).id, before);
});

console.log("— S53 (0B-1): reviewed candidate binding + no partial snapshots");

await t("expectedDraftHash binds the publish: mismatch is DRAFTS_CHANGED, match publishes", async () => {
  // every row, not listReleases: that hides a never-published, unscheduled row (P2-VGATE)
  const rowCount = async () => Number((await inTenant(() => libsql.execute("SELECT count(*) AS n FROM releases"))).rows[0].n);
  const before = await rowCount();
  try {
    await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" }, expectedDraftHash: "sha-of-something-older" }));
    throw new Error("expected DRAFTS_CHANGED");
  } catch (e) {
    if (e.code !== "DRAFTS_CHANGED") throw e;
  }
  const after = await rowCount();
  if (after !== before) throw new Error("a refused publish must not create a release row");
  const snap = await inTenant(() => R.snapshotContent());
  const r = await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" }, expectedDraftHash: snap.hash }));
  if (r.hash !== snap.hash) throw new Error("published a different candidate than reviewed");
});

await t("a failing pages read makes the snapshot THROW — never a partial release", async () => {
  const { createClient } = await import("@libsql/client");
  await rm(join(here, "../.test-rel-t3.db"), { force: true });
  const t3db = createClient({ url: "file:.test-rel-t3.db" });
  await t3db.executeMultiple(schema);
  await runMigrations(t3db, tenantMigrations);
  // swap cms_pages for a view that ERRORS on read (not "no such table")
  await t3db.execute("DROP TABLE cms_pages");
  await t3db.execute("CREATE VIEW cms_pages AS SELECT json_extract('not json', '$.x') AS slug");
  await C.upsertTenant({ id: "rt3", name: "Rel broken-pages", domains: [], dbUrl: "file:.test-rel-t3.db", config: {}, secrets: {} });
  const T3 = await C.getTenant("rt3");
  let threw = null;
  try {
    await withTenant(T3, () => R.snapshotContent());
  } catch (e) {
    threw = String(e?.message || e);
  }
  if (!threw || !/release snapshot failed reading pages/.test(threw)) {
    throw new Error(`expected a loud snapshot failure, got: ${threw || "no throw (partial release possible!)"}`);
  }
  await rm(join(here, "../.test-rel-t3.db"), { force: true });
});

console.log("— S53 (0B-2): ALL presentation state publishes together");

await t("v2 snapshot freezes overrides/pins/placements/redirects; draft edits stay draft; v1 falls back", async () => {
  const P = await import("../lib/content/presentation.js");
  await inTenant(async () => {
    await db.insertInto("product_overrides").values({ product_id: "gid://p/ov1", modules: JSON.stringify([{ title: "Ingredients", html: "<p>aqua</p>" }]), badge: "NEW" }).execute();
    await db.insertInto("collection_overrides").values({ collection_id: "gid://c/pin1", pinned: JSON.stringify(["gid://p/a", "gid://p/b"]) }).execute();
    await db.insertInto("placements").values({ id: "pl_cart1", kind: "cart_upsell", source_product_id: null, target_product_ids: JSON.stringify(["gid://p/a"]), title: "Add this", enabled: 1, position: 0 }).execute();
    await db.insertInto("page_redirects").values({ from_slug: "old-post", to_slug: "new-post", created_at: new Date().toISOString() }).execute();
  });
  const snap = await inTenant(() => R.snapshotContent());
  if (snap.content.v < 2) throw new Error(`expected v2+ envelope, got v${snap.content.v}`);
  if (snap.content.product_overrides.length !== 1 || snap.content.placements.length !== 1) throw new Error("sets missing from snapshot");
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } }));

  // mutate every draft set AFTER publish
  await inTenant(async () => {
    await db.updateTable("product_overrides").set({ badge: "CHANGED" }).where("product_id", "=", "gid://p/ov1").execute();
    await db.deleteFrom("placements").where("id", "=", "pl_cart1").execute();
    await db.updateTable("collection_overrides").set({ pinned: JSON.stringify(["gid://p/z"]) }).where("collection_id", "=", "gid://c/pin1").execute();
    await db.updateTable("page_redirects").set({ to_slug: "changed-post" }).where("from_slug", "=", "old-post").execute();
  });

  const liveC = (await inTenant(() => R.getLiveRelease())).content;
  if (P.presentationProductOverride(liveC, "gid://p/ov1").found.badge !== "NEW") throw new Error("live badge not frozen");
  if (P.presentationCollectionPins(liveC, "gid://c/pin1").found.join() !== "gid://p/a,gid://p/b") throw new Error("live pins not frozen");
  if (P.presentationPlacements(liveC, "cart_upsell").length !== 1) throw new Error("live placement not frozen");
  if (P.presentationSlugRedirect(liveC, "old-post").found !== "new-post") throw new Error("live redirect not frozen");
  // v1 releases never froze these → null = fall back to live tables
  if (P.presentationProductOverride({ v: 1 }, "x") !== null) throw new Error("v1 must fall back");
  if (P.presentationPlacements({ v: 1 }, "cart_upsell") !== null) throw new Error("v1 must fall back");

  const d = await inTenant(() => R.releaseDiff());
  for (const type of ["overrides", "pins", "placements", "redirects"]) {
    if (!d.items.find((i) => i.type === type)) throw new Error(`diff missing ${type}: ${JSON.stringify(d.items)}`);
  }
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } })); // settle for later tests
});

await t("mediaUsage protects scheduled + retained releases and derivative URLs", async () => {
  const { mediaUsage, mediaUrl } = await import("../lib/media.js");
  await inTenant(async () => {
    await db
      .insertInto("releases")
      .values({ id: "rel_medsched", content: JSON.stringify({ v: 2, note: mediaUrl("medAAA111") }), content_hash: "x", note: "", created_by: null, created_at: new Date().toISOString(), scheduled_for: new Date(Date.now() + 86400000).toISOString() })
      .execute();
    await db
      .insertInto("media")
      .values({ id: "medAAA111", filename: "a.png", mime: "image/png", size: 1, sha256: "s1", data: new Uint8Array([1]), created_at: new Date().toISOString() })
      .execute();
    await db
      .insertInto("media")
      .values({ id: "medAAA111thumb", filename: "t.webp", mime: "image/webp", size: 1, sha256: "s2", variant: "thumb", parent_id: "medAAA111", data: new Uint8Array([1]), created_at: new Date().toISOString() })
      .execute();
    // a page referencing only the DERIVATIVE url
    await db.insertInto("cms_pages").values({ slug: "thumb-user", title: "T", sections: JSON.stringify([{ kind: "image", src: mediaUrl("medAAA111thumb"), alt: "t" }]), enabled: 1, updated_at: new Date().toISOString() }).execute();
  });
  const uses = await inTenant(() => mediaUsage("medAAA111"));
  if (!uses.find((u) => /scheduled release:rel_medsched/.test(u.where))) throw new Error(`scheduled release not protected: ${JSON.stringify(uses)}`);
  if (!uses.find((u) => /page:thumb-user/.test(u.where))) throw new Error(`derivative reference not protected: ${JSON.stringify(uses)}`);
  await inTenant(async () => {
    await db.deleteFrom("releases").where("id", "=", "rel_medsched").execute();
    await db.deleteFrom("cms_pages").where("slug", "=", "thumb-user").execute();
  });
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } })); // settle
});

console.log("— S54: section-id changes are not publish dirt; envelope upgrade is named");

await t("an id-only home_sections change does NOT dirty the diff; a content change does", async () => {
  const saved = await inTenant(() => S.setBlock("home_sections", [{ kind: "new", title: "Diff ids", limit: 5 }]));
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } }));
  const current = (await inTenant(() => S.getBlockRow("home_sections"))).value;
  // re-save the SAME content with different instance ids
  await inTenant(() => S.setBlock("home_sections", current.map((s, i) => ({ ...s, id: `sec_zz${i}abcd` }))));
  const d = await inTenant(() => R.releaseDiff());
  if (d.items.find((i) => i.type === "block" && i.key === "home_sections")) {
    throw new Error(`id-only change dirtied the diff: ${JSON.stringify(d.items)}`);
  }
  // a REAL change still registers
  await inTenant(() => S.setBlock("home_sections", current.map((s) => ({ ...s, title: "Changed title" }))));
  const d2 = await inTenant(() => R.releaseDiff());
  if (!d2.items.find((i) => i.type === "block" && i.key === "home_sections")) throw new Error("content change missed");
  await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } })); // settle
});

console.log("— S53 (audit A2): live-release reads fail closed");

await t("getLiveReleaseState: live / none / corrupt / dangling pointer are DISTINCT", async () => {
  // live (whatever the suite last published)
  const live = await inTenant(() => R.getLiveReleaseState());
  if (live.state !== "live") throw new Error(`expected live, got ${live.state}`);
  const liveId = live.release.id;

  // corrupt content → error, and the compat wrapper maps it to null
  await inTenant(() => db.updateTable("releases").set({ content: "{broken" }).where("id", "=", liveId).execute());
  const corrupt = await inTenant(() => R.getLiveReleaseState());
  if (corrupt.state !== "error") throw new Error(`corrupt: expected error, got ${corrupt.state}`);
  if ((await inTenant(() => R.getLiveRelease())) !== null) throw new Error("wrapper should badge null on error");

  // restore, then dangling pointer → error (NOT "none")
  const canonical = (await inTenant(() => R.snapshotContent())).canonical;
  await inTenant(() => db.updateTable("releases").set({ content: canonical }).where("id", "=", liveId).execute());
  await inTenant(() => db.updateTable("release_state").set({ live_release_id: "rel_ghost" }).where("id", "=", 1).execute());
  const dangling = await inTenant(() => R.getLiveReleaseState());
  if (dangling.state !== "error") throw new Error(`dangling: expected error, got ${dangling.state}`);

  // no pointer → none (genuinely pre-first-publish)
  await inTenant(() => db.updateTable("release_state").set({ live_release_id: null }).where("id", "=", 1).execute());
  const none = await inTenant(() => R.getLiveReleaseState());
  if (none.state !== "none") throw new Error(`no pointer: expected none, got ${none.state}`);

  // restore the suite's live pointer
  await inTenant(() => db.updateTable("release_state").set({ live_release_id: liveId }).where("id", "=", 1).execute());
  const restored = await inTenant(() => R.getLiveReleaseState());
  if (restored.state !== "live") throw new Error("restore failed");
});

await t("getLiveReleaseState: missing release tables = none (pre-migration tenant)", async () => {
  const { createClient } = await import("@libsql/client");
  await rm(join(here, "../.test-rel-t2.db"), { force: true });
  const t2db = createClient({ url: "file:.test-rel-t2.db" });
  await t2db.executeMultiple(schema); // baseline only — NO 0007 release tables
  await C.upsertTenant({ id: "rt2", name: "Rel bare", domains: [], dbUrl: "file:.test-rel-t2.db", config: {}, secrets: {} });
  const T2 = await C.getTenant("rt2");
  const s = await withTenant(T2, () => R.getLiveReleaseState());
  if (s.state !== "none") throw new Error(`expected none, got ${s.state} (${s.error || ""})`);
  await rm(join(here, "../.test-rel-t2.db"), { force: true });
});

console.log("— preview tokens");

await t("preview token round-trips; expiry and tamper are rejected", async () => {
  const token = await inTenant(R.previewToken);
  eq(await inTenant(() => R.verifyPreviewToken(token)), true, "valid:");
  eq(await inTenant(() => R.verifyPreviewToken(token, { now: Date.now() + 2 * 3600_000 })), false, "expired:");
  const [p, exp, sig] = token.split(".");
  eq(await inTenant(() => R.verifyPreviewToken(`${p}.${exp}.${"0".repeat(20)}`)), false, "tampered:");
  eq(await inTenant(() => R.verifyPreviewToken("garbage")), false, "garbage:");
});

await t("preview token is tenant-bound: another tenant's context rejects it", async () => {
  const token = await inTenant(R.previewToken);
  const other = { ...RT, id: "other-tenant", secrets: { order_link_secret: "other-secret" } };
  eq(await withTenant(other, () => R.verifyPreviewToken(token)), false);
});

// --- S60: approvals bound to the candidate hash --------------------------------
await t("approval: binds to the exact candidate; a draft edit silently withdraws it; stale hash → DRAFTS_CHANGED", async () => {
  const A = await import("../lib/cms/approvals.js");
  const snap = await inTenant(R.snapshotContent);
  const approved = await inTenant(() => A.approveCandidate({ expectedHash: snap.hash, actor: "merchant:reviewer", note: "festive check" }));
  eq(approved.draft_hash, snap.hash, "bound to the reviewed hash");
  const cur = await inTenant(A.currentApproval);
  eq(cur?.actor, "merchant:reviewer", "current candidate reads approved");
  // drafts move → the approval stops applying, nothing has to invalidate it
  await inTenant(() => S.setBlock("hero", { title: "Post-approval edit", primary: { label: "Shop", href: "/collections/whey" } }));
  eq(await inTenant(A.currentApproval), null, "edited candidate is NOT approved");
  // approving with the hash the reviewer SAW (now stale) refuses, same contract as publish
  const stale = await inTenant(() => A.approveCandidate({ expectedHash: snap.hash, actor: "merchant:reviewer" }).then(() => null, (e) => e));
  eq(stale?.code, "DRAFTS_CHANGED", "stale approval refused");
  // re-approve the new candidate → applies again
  const snap2 = await inTenant(R.snapshotContent);
  await inTenant(() => A.approveCandidate({ expectedHash: snap2.hash, actor: "merchant:reviewer2" }));
  eq((await inTenant(A.currentApproval))?.actor, "merchant:reviewer2");
});

// --- P2-VGATE: the reader version gate -----------------------------------------
console.log("— P2-VGATE: the reader version gate");
{
  const Res = await import("../lib/content/resolve.js");
  const { runRequest, watchStatements } = await import("./support/request-cache.js");
  const { currentDatabase } = await import("../lib/db.js");

  // "vg": a store whose live release this block swaps (v1..v4, broken ones).
  // "vgl": a legacy store with a good v3 release, a brand and a theme.
  // "vgbare": no release tables at all (pre-migration).
  const ok = (v, m) => {
    if (!v) throw new Error(m);
  };
  const same = (got, want, m = "") => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  const BASE_CONFIG = (id) => ({ site: { name: `VGate ${id} Store` }, brand: { accent: "#7c3aed" }, theme: { kit: "glow", version: 1 } });
  const putTenant = (id, file, config = BASE_CONFIG(id)) =>
    C.upsertTenant({ id, name: `VGate ${id}`, domains: [`${id}.test`], dbUrl: `file:${file}`, config, secrets: { order_link_secret: `${id}-secret` } });
  const tenantDb = async (id, file, { migrate = true } = {}) => {
    await putTenant(id, file);
    const T = await C.getTenant(id);
    await withTenant(T, async () => {
      await libsql.executeMultiple(schema);
      if (migrate) await runMigrations(libsql, tenantMigrations);
      // a catalog, so the collections scroller has something to list
      await libsql.execute("INSERT INTO collections (id, handle, title, synced_at) VALUES ('gid://shopify/Collection/77', 'vg-serums', 'VG Serums', '2026-01-01')");
      await libsql.execute("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at) VALUES ('gid://shopify/Product/77', 'vg-p', 'VG P', 100, 100, 'INR', 1, '2026-01-01')");
      await libsql.execute("INSERT INTO collection_products (collection_id, product_id, position) VALUES ('gid://shopify/Collection/77', 'gid://shopify/Product/77', 0)");
    });
    return T;
  };
  const VG = await tenantDb("vg", ".test-rel-vg.db");
  const VGL = await tenantDb("vgl", ".test-rel-vgl.db");
  const VGBARE = await tenantDb("vgbare", ".test-rel-vgbare.db", { migrate: false });
  const inVg = (fn) => withTenant(VG, fn);

  // content: an object (stored canonical) or a raw string (stored as is)
  let seq = 0;
  const putLive = async (T, content, { id = `rel_vg_${++seq}`, published = true } = {}) => {
    await withTenant(T, async () => {
      await libsql.execute({
        sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, '', NULL, ?, NULL, ?)",
        args: [id, typeof content === "string" ? content : R.stableStringify(content), `h_${id}`, new Date(Date.now() + seq).toISOString(), published ? new Date().toISOString() : null],
      });
      await libsql.execute({ sql: "UPDATE release_state SET live_release_id = ? WHERE id = 1", args: [id] });
    });
    return id;
  };
  const V3 = {
    v: 3,
    blocks: {
      hero: { title: "VG live hero" },
      announcement: { enabled: true, text: "VG live announcement" },
      nav_header: [{ label: "VG Nav", href: "/collections/vg-serums" }],
      nav_footer: [{ label: "VG Foot", href: "/about" }],
      home_sections: [{ id: "sec_vg11", kind: "new", title: "VG new", limit: 4 }],
    },
    pages: [{ slug: "about", title: "About VG", description: "", sections: [], enabled: true }],
    brand: { accent: "#7c3aed" },
    theme: { kit: "glow", version: 1 },
    product_overrides: [],
    collection_pins: [],
    placements: [],
    redirects: [],
  };
  // a v4 row that is not a v4 list (the shape P2-VGATE guessed before P2-ATOM
  // fixed it). P2-READ reads real v4 lists (scripts/test-release-readers.js);
  // this one must still fail closed, now as BAD_LIST.
  const V4 = { v: 4, list: { doc_header: "dv_1", doc_announcement: "dv_2" }, hash: "x" };
  // every getter the storefront has, with arguments
  const GETTERS = [
    ["resolvedAnnouncement", []],
    ["resolvedHero", []],
    ["resolvedHomeSections", []],
    ["resolvedNav", ["header"]],
    ["resolvedNav", ["footer"]],
    ["resolvedCollectionsIndex", []],
    ["resolvedPdpExtras", []],
    ["resolvedContentPage", ["about"]],
    ["resolvedContentPageList", []],
    ["resolvedBrand", []],
    ["resolvedTheme", []],
    ["resolvedSurfaceTemplates", []],
    ["resolvedSurfaceTemplateFor", ["product", "gid://shopify/Product/77"]],
    ["resolvedProductOverride", ["gid://shopify/Product/77"]],
    ["resolvedCollectionPins", ["vg-serums"]],
    ["resolvedPdpPairs", ["gid://shopify/Product/77"]],
    ["resolvedCartUpsell", [[]]],
    ["resolvedSlugRedirect", ["old"]],
  ];
  for (const [fn] of GETTERS) if (typeof Res[fn] !== "function") throw new Error(`resolve.js has no ${fn}: update this list`);

  await t("v1, v2 and v3 releases: getLiveReleaseState, contentSource and every resolved* getter answer as a6d028e did", async () => {
    // scripts/support/legacy-release-outputs.js was run inside an a6d028e
    // checkout to record the fixture; this runs the same file here and now.
    const out = join(ROOT, ".test-rel-legacy-outputs.json");
    try {
      const r = spawnSync(process.execPath, [join(here, "support/legacy-release-outputs.js"), out], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
      if (r.status !== 0) throw new Error(`recorder failed: ${r.stderr || r.stdout}`);
      const now = JSON.parse(await readFile(out, "utf8"));
      const then = JSON.parse(await readFile(join(here, "fixtures/legacy-release-outputs.a6d028e.json"), "utf8"));
      eq(Object.keys(now.fixtures).join(), "v1,v2,v3", "fixtures:");
      for (const [name, rec] of Object.entries(now.fixtures)) {
        // the one addition: release.v, the envelope version (P2-VGATE)
        const rel = rec.getLiveReleaseState?.ok?.release;
        if (!rel) throw new Error(`${name}: not live: ${JSON.stringify(rec.getLiveReleaseState)}`);
        eq(rel.v, Number(name.slice(1)), `${name} release.v:`);
        delete rel.v;
        const want = then.fixtures[name];
        eq(Object.keys(rec).length, Object.keys(want).length, `${name} outputs:`);
        for (const k of Object.keys(want)) {
          if (JSON.stringify(rec[k]) !== JSON.stringify(want[k])) throw new Error(`${name} ${k} differs from a6d028e:\n now  ${JSON.stringify(rec[k]).slice(0, 300)}\n then ${JSON.stringify(want[k]).slice(0, 300)}`);
        }
      }
    } finally {
      await rm(out, { force: true });
    }
  });

  await t("a v4 release that is not a v4 list is live with v 4, contentSource throws ContentUnavailableError (BAD_LIST, P2-READ), and no getter returns anything", async () => {
    const id = await putLive(VG, V4);
    const s = await inVg(() => R.getLiveReleaseState());
    eq(s.state, "live", "state:");
    eq(s.release.v, 4, "release.v:");
    eq(s.release.id, id, "release:");
    const src = await inVg(() => Res.contentSource().then(() => null, (e) => e));
    if (!(src instanceof Res.ContentUnavailableError)) throw new Error(`contentSource: expected ContentUnavailableError, got ${src ? src.message : "an answer"}`);
    eq(src.detail?.code, "BAD_LIST", "detail.code:");
    eq(Res.isContentUnavailable(src), true, "isContentUnavailable:");
    for (const [fn, args] of GETTERS) {
      const got = await inVg(() => Res[fn](...args).then((v) => ({ v }), (e) => ({ e })));
      if (!got.e) throw new Error(`${fn}(${args.map((a) => JSON.stringify(a))}) answered ${JSON.stringify(got.v)?.slice(0, 200)} on a v4 release`);
      if (fn !== "resolvedContentPageList" && !Res.isContentUnavailable(got.e)) throw new Error(`${fn}: threw ${got.e.message}, not ContentUnavailableError`);
    }
    // explicitly: the home page never falls back to DEFAULT_HOME_SECTIONS
    const home = await inVg(() => Res.resolvedHomeSections().then((v) => v, (e) => e));
    if (!Res.isContentUnavailable(home)) throw new Error(`resolvedHomeSections: ${JSON.stringify(home)}`);
  });

  await t("v0, v5, v99, '3' (a string), a missing v and content that is not an object are each state 'error', and the storefront fails closed", async () => {
    const cases = [
      ["v0", { ...V3, v: 0 }],
      ["v5", { ...V3, v: 5 }],
      ["v99", { ...V3, v: 99 }],
      ["'3'", { ...V3, v: "3" }],
      ["v 3.0001", { ...V3, v: 3.0001 }],
      ["v true", { ...V3, v: true }],
      ["no v", (({ v, ...rest }) => rest)(V3)],
      ["v null", { ...V3, v: null }],
      ["an array", "[1,2,3]"],
      ["an array with v", Object.assign([], { v: 3 })],
      ["a string", '"v3"'],
      ["a number", "3"],
      ["null", "null"],
      ["not JSON", "{v:3"],
    ];
    for (const [label, content] of cases) {
      await putLive(VG, content);
      const s = await inVg(() => R.getLiveReleaseState());
      if (s.state !== "error") throw new Error(`${label}: expected error, got ${s.state} (v ${JSON.stringify(s.release?.v)})`);
      const e = await inVg(() => Res.contentSource().then(() => null, (x) => x));
      if (!Res.isContentUnavailable(e)) throw new Error(`${label}: contentSource did not fail closed`);
    }
  });

  await t("request-cache stub: 8 getters in parallel in one request read pointer plus release in ONE statement; a pointer with no row is still 'error'; no release tables is still 'none'", async () => {
    await putLive(VG, V3);
    const isReleaseRead = (sql) => /release_state|"releases"|\breleases\b/i.test(sql);
    const eight = () =>
      Promise.all([
        Res.resolvedAnnouncement(),
        Res.resolvedHero(),
        Res.resolvedHomeSections(),
        Res.resolvedNav("header"),
        Res.resolvedNav("footer"),
        Res.resolvedBrand(),
        Res.resolvedTheme(),
        Res.resolvedSurfaceTemplates(),
      ]);
    const one = await inVg(() => runRequest(() => watchStatements(currentDatabase().libsql, eight)));
    const reads = one.statements.filter(isReleaseRead);
    eq(reads.length, 1, `release statements in one request (${JSON.stringify(reads)}):`);
    if (!/release_state/i.test(reads[0]) || !/join/i.test(reads[0])) throw new Error(`not one joined read: ${reads[0]}`);
    eq(one.result[1].title, "VG live hero", "the getters read the live release:");
    // a second request reads again (the memo is per request), and the stub
    // is what makes the count: with no request scope every getter reads
    const two = await inVg(() => runRequest(() => watchStatements(currentDatabase().libsql, eight)));
    eq(two.statements.filter(isReleaseRead).length, 1, "second request:");
    const bare = await inVg(() => watchStatements(currentDatabase().libsql, eight));
    eq(bare.statements.filter(isReleaseRead).length, 8, "outside runRequest (no memo):");

    // a pointer naming no row: error, one statement
    await inVg(() => libsql.execute("UPDATE release_state SET live_release_id = 'rel_vg_ghost' WHERE id = 1"));
    const ghost = await inVg(() => runRequest(() => watchStatements(currentDatabase().libsql, () => R.getLiveReleaseState())));
    eq(ghost.result.state, "error", "pointer with no row:");
    eq(ghost.statements.filter(isReleaseRead).length, 1, "pointer with no row, statements:");
    const ghostSrc = await inVg(() => runRequest(() => Res.contentSource().then(() => null, (e) => e)));
    if (!Res.isContentUnavailable(ghostSrc)) throw new Error("pointer with no row: contentSource did not fail closed");
    // no pointer: none
    await inVg(() => libsql.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1"));
    eq((await inVg(() => runRequest(() => R.getLiveReleaseState()))).state, "none", "no pointer:");
    // no release tables: none (drafts serve, as before the first publish)
    const noTables = await withTenant(VGBARE, () => runRequest(() => R.getLiveReleaseState()));
    if (noTables.state !== "none") throw new Error(`no release tables: expected none, got ${noTables.state} (${noTables.error || ""})`);
    eq((await withTenant(VGBARE, () => runRequest(() => Res.contentSource()))).mode, "draft", "no release tables, contentSource:");
  });

  await t("listReleases hides a never-published, unscheduled row but lists the live row even with published_at null, plus past and scheduled rows", async () => {
    await inVg(async () => {
      await libsql.execute("DELETE FROM releases");
      const row = (id, at, scheduled, published) =>
        libsql.execute({
          sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, '', NULL, ?, ?, ?)",
          args: [id, R.stableStringify(V3), `h_${id}`, at, scheduled, published],
        });
      await row("rel_l_past", "2026-01-01T00:00:00.000Z", null, "2026-01-01T00:00:01.000Z");
      await row("rel_l_sched", "2026-01-02T00:00:00.000Z", "2099-01-01T00:00:00.000Z", null);
      await row("rel_l_lost", "2026-01-03T00:00:00.000Z", null, null);
      await row("rel_l_live", "2026-01-04T00:00:00.000Z", null, null); // flipped, not yet stamped
      await libsql.execute("UPDATE release_state SET live_release_id = 'rel_l_live' WHERE id = 1");
    });
    const list = await inVg(() => R.listReleases({ limit: 50 }));
    eq(list.releases.map((r) => r.id).join(), "rel_l_live,rel_l_sched,rel_l_past", "listed:");
    eq(list.live, "rel_l_live", "live:");
    // and with no pointer at all, the unstamped rows are both hidden
    await inVg(() => libsql.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1"));
    eq((await inVg(() => R.listReleases({ limit: 50 }))).releases.map((r) => r.id).join(), "rel_l_sched,rel_l_past", "no pointer:");
  });

  // ---- the storefront layout, rendered (Next's SWC, as test-preview-experiments does) ----
  const require = createRequire(import.meta.url);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const compile = async (file) =>
    (
      await swc.transform(await readFile(file, "utf8"), {
        filename: file,
        jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
        module: { type: "commonjs" },
      })
    ).code;
  const toFile = (from, id) => {
    const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
    return p.endsWith(".js") ? p : `${p}.js`;
  };
  const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
  async function loadJsx(file, stubs = {}, seen = new Map()) {
    if (seen.has(file)) return seen.get(file);
    const mod = { exports: {} };
    seen.set(file, mod.exports);
    const code = await compile(file);
    const deps = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || deps.has(id)) continue;
      if (id === "react" || id === "react/jsx-runtime") continue;
      if (id.startsWith("@/") || id.startsWith(".")) {
        const target = toFile(file, id);
        deps.set(id, isJsx(target) ? await loadJsx(target, stubs, seen) : await import(pathToFileURL(target).href));
      } else if (id === "next/headers") deps.set(id, await import("next/headers"));
      else deps.set(id, require(id));
    }
    const req = (id) => {
      if (id in stubs) return stubs[id];
      if (id === "react") return React;
      if (id === "react/jsx-runtime") return require("react/jsx-runtime");
      if (deps.has(id)) return deps.get(id);
      throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
    };
    new Function("require", "module", "exports", code)(req, mod, mod.exports);
    seen.set(file, mod.exports);
    return mod.exports;
  }
  const nothing = { __esModule: true, default: () => null };
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
  const font = () => ({ variable: "" });
  const STUBS = {
    "next/font/google": { Geist: font, Geist_Mono: font, Fraunces: font },
    "../globals.css": {},
    "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
    "./SearchBox": nothing,
    "./cart/CartButton": nothing,
    "@/components/cart/CartContext": { CartProvider: passthrough },
    "@/components/cart/CartDrawer": nothing,
    "@/components/ServiceWorkerRegister": nothing,
    "@/components/analytics/ConsentBanner": nothing,
    "@/components/analytics/Pixels": nothing,
    "@/components/analytics/ErrorReporter": nothing,
    "@/components/site/SiteNav": nothing,
    "@/components/preview/PreviewBridge": nothing,
  };
  const Layout = (await loadJsx(join(ROOT, "app/(storefront)/layout.js"), STUBS)).default;
  // the same layout, with one chrome getter failing for a reason that is not
  // ContentUnavailableError (a bug of ours): "other chrome failures"
  const LayoutBuggy = (
    await loadJsx(join(ROOT, "app/(storefront)/layout.js"), {
      ...STUBS,
      "@/lib/content/resolve": {
        ...Res,
        resolvedSurfaceTemplates: async () => {
          throw new TypeError("boom: a bug of ours");
        },
      },
    })
  ).default;
  const render = async (L, host, cookies = {}) => {
    globalThis.__vgateRequest = { host, cookies };
    try {
      return await runRequest(async () => renderToStaticMarkup(await L({ children: React.createElement("p", { id: "page" }, "page body") })));
    } finally {
      globalThis.__vgateRequest = null;
    }
  };
  const scroller = (html) => /<nav class="border-t border-header-fg\/10">/.test(html);
  const hasBrand = (html) => /id="brand-vars"|--accent-500:/.test(html);
  const kit = (html) => html.match(/<html[^>]*data-kit="([^"]*)"/)?.[1];
  // links into the catalog or the store's content (the fixed chrome links,
  // "Shop all" -> /collections, /contact, /wishlist, /account, are not nav)
  const navLinks = (html) => [...html.matchAll(/href="(\/collections\/[^"]+|\/about|\/policies\/[^"]+)"/g)].map((m) => m[1]);

  await t("rendered: a normal v3 store shows its nav, announcement and brand (the control for the next tests)", async () => {
    await putLive(VG, V3);
    const html = await render(Layout, "vg.test");
    ok(html.includes("VG Nav") && html.includes("VG live announcement"), "nav or announcement missing");
    ok(hasBrand(html), "brand missing");
    eq(kit(html), "glow-1", "kit:");
    ok(html.includes("page body"), "page missing");
  });

  await t("rendered: on ContentUnavailableError (a v4 release) the chrome holds no nav links, no collections scroller, no announcement and no tenant brand", async () => {
    await putLive(VG, V4);
    const html = await render(Layout, "vg.test");
    ok(html.includes("page body"), "page missing");
    same(navLinks(html), [], "nav links:");
    ok(!scroller(html), "the collections scroller shows (nav null, not [])");
    ok(!/VG Serums|VG Nav|VG Foot/.test(html), "store links show");
    ok(!/data-sec="announcement"/.test(html), "announcement shows");
    ok(!hasBrand(html), "tenant brand CSS shows");
    eq(kit(html), "pulse-1", "kit:");
    ok(!/VGate vg Store/.test(html), "the store's name shows");
    // and the same for a release that can't be read at all
    await putLive(VG, { ...V3, v: 7 });
    const bad = await render(Layout, "vg.test");
    ok(!scroller(bad) && navLinks(bad).length === 0 && !hasBrand(bad), "unreadable release: store chrome shows");
  });

  await t("rendered: other chrome failures behave as before (neutral name and brand, the collections scroller, no announcement)", async () => {
    await putLive(VG, V3);
    const html = await render(LayoutBuggy, "vg.test");
    ok(scroller(html) && html.includes("VG Serums"), "the collections scroller is gone (it showed before P2-VGATE)");
    ok(!/data-sec="announcement"/.test(html), "announcement shows");
    ok(!hasBrand(html), "brand shows");
    ok(!/VGate vg Store/.test(html), "the store's name shows");
  });

  await t("rendered: the maintenance page on ContentUnavailableError uses the neutral name and brand", async () => {
    await putTenant("vg", ".test-rel-vg.db", { ...BASE_CONFIG("vg"), maintenance: { enabled: true, message: "Back soon" } });
    const VGM = await C.getTenant("vg");
    await new Promise((r) => setTimeout(r, 80)); // PLATFORM_CACHE_MS
    try {
      await putLive(VGM, V4);
      const html = await render(Layout, "vg.test");
      ok(/Store will be right back\./.test(html), `not the neutral name: ${html.match(/<h1[\s\S]*?<\/h1>/)?.[0]}`);
      ok(!/VGate vg Store/.test(html), "the store's name shows");
      ok(!hasBrand(html), "tenant brand CSS shows");
      eq(kit(html), "pulse-1", "kit:");
      ok(!html.includes("page body"), "the page shows behind the curtain");
      // a legacy store's curtain still reads its own name, brand and theme
      await putLive(VGM, V3);
      const ok3 = await render(Layout, "vg.test");
      ok(/VGate vg Store will be right back\./.test(ok3), "a working store's curtain lost its name");
      ok(hasBrand(ok3), "a working store's curtain lost its brand");
      eq(kit(ok3), "glow-1", "a working store's kit:");
      // a bypass cookie still sees the store
      const team = await render(Layout, "vg.test", { _admin: "x" });
      ok(team.includes("page body") && team.includes("VG Nav"), "the team bypass lost the store");
    } finally {
      await putTenant("vg", ".test-rel-vg.db");
    }
  });

  // Fix round 1: a glow store's curtain now really renders as glow-1 (light
  // hero #fff1ee). Its "Scheduled maintenance" pill must use the kit-corrected
  // hero accent, and the CSS for it must be written even with no brand.
  await t("rendered: a glow store's maintenance pill is readable on the light hero, with and without a brand", async () => {
    const B = await import("../lib/brand.js");
    const heroBg = B.kitSurfaces("glow-1").hero.bg;
    await putTenant("vg", ".test-rel-vg.db", { ...BASE_CONFIG("vg"), maintenance: { enabled: true, message: "Back soon" } });
    const VGM = await C.getTenant("vg");
    await new Promise((r) => setTimeout(r, 80)); // PLATFORM_CACHE_MS
    const pill = (html) => html.match(/<p class="([^"]*)"><span class="([^"]*)"><\/span> Scheduled maintenance/);
    const heroAccent = (html) => html.match(/--sf-hero-accent:(#[0-9a-fA-F]{6})/)?.[1];
    try {
      for (const [label, brand] of [
        ["test brand #7c3aed", V3.brand],
        ["no brand", null],
      ]) {
        await putLive(VGM, { ...V3, brand });
        const html = await render(Layout, "vg.test");
        ok(/will be right back\./.test(html), `${label}: not the curtain`);
        eq(kit(html), "glow-1", `${label}: kit:`);
        const m = pill(html);
        ok(m, `${label}: no maintenance pill`);
        ok(/\btext-sf-hero-accent\b/.test(m[1]) && !/\btext-accent-400\b/.test(m[1]), `${label}: pill text is not the hero accent role: ${m[1]}`);
        ok(/\bbg-sf-hero-accent\b/.test(m[2]) && !/\bbg-accent-400\b/.test(m[2]), `${label}: pill dot is not the hero accent role: ${m[2]}`);
        const accent = heroAccent(html);
        ok(accent, `${label}: no --sf-hero-accent in the curtain's CSS (falls back to the raw accent-400)`);
        const ratio = B.contrastRatio(accent, heroBg);
        ok(ratio >= 4.5, `${label}: pill text ${accent} on ${heroBg} is ${ratio.toFixed(2)}:1, under 4.5:1`);
      }
      // no brand on a glow store: the kit's own correction
      eq(heroAccent(await render(Layout, "vg.test")), "#3f6212", "no brand glow hero accent:");
    } finally {
      await putTenant("vg", ".test-rel-vg.db");
    }
  });
}

console.log("— P2-GUARD: the guarded flip and the documents marker");
{
  const { runRequest, watchStatements } = await import("./support/request-cache.js");
  const { currentDatabase } = await import("../lib/db.js");
  const ok = (v, m) => {
    if (!v) throw new Error(m);
  };
  const mk = async (id, file) => {
    await C.upsertTenant({ id, name: `Guard ${id}`, domains: [`${id}.test`], dbUrl: `file:${file}`, config: { site: { name: `Guard ${id}` } }, secrets: { order_link_secret: `${id}-secret` } });
    const T = await C.getTenant(id);
    await withTenant(T, async () => {
      await libsql.executeMultiple(schema);
      await runMigrations(libsql, tenantMigrations);
    });
    return T;
  };
  const GD = await mk("gd", ".test-rel-gd.db");
  const inGd = (fn) => withTenant(GD, fn);
  const actor = { kind: "merchant", id: "u1" };
  const pointer = () => inGd(async () => (await libsql.execute("SELECT live_release_id AS id FROM release_state WHERE id = 1")).rows[0].id ?? null);
  const rows = () => inGd(async () => (await libsql.execute("SELECT id, note, published_at FROM releases ORDER BY created_at")).rows.map((r) => ({ ...r })));
  const hooked = async (hook, fn) => {
    R.__releaseTestHooks.beforeFlip = hook;
    try {
      return await fn();
    } finally {
      R.__releaseTestHooks.beforeFlip = null;
    }
  };
  // a v4 row (a documents list), never live
  const putV4 = (id) =>
    inGd(() =>
      libsql.execute({
        sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, 'v4', NULL, ?, NULL, NULL)",
        args: [id, R.stableStringify({ v: 4, list: { doc_header: "dv_1" } }), `h_${id}`, new Date().toISOString()],
      }),
    );

  await inGd(() => S.setBlock("hero", { title: "Guard hero" }));
  const first = await inGd(() => R.createRelease({ note: "base", actor }));

  await t("two legacy publishes from the same pointer, interleaved: one goes live, the other is a 409 and leaves no releases row; the pointer is the winner", async () => {
    eq(await pointer(), first.id, "start:");
    const before = await rows();
    await inGd(() => S.setBlock("hero", { title: "Raced hero" }));
    let winner = null;
    let fired = false;
    const loser = await hooked(
      async (info) => {
        if (fired || info.kind !== "publish") return;
        fired = true;
        // B reads the same pointer and goes live inside A's window
        winner = await R.createRelease({ note: "B wins", actor });
      },
      () => inGd(() => R.createRelease({ note: "A loses", actor }).then(() => null, (e) => e)),
    );
    ok(winner?.id, "B did not publish");
    ok(loser, "A did not fail: both went live (the old two-statement flip)");
    eq(loser.status, 409, "A status:");
    eq(loser.code, "PUBLISH_RACE", "A code:");
    eq(loser.message, "Another publish just went live, review again", "A message:");
    eq(await pointer(), winner.id, "pointer:");
    const after = await rows();
    eq(after.length, before.length + 1, "one new row:");
    ok(!after.some((r) => r.note === "A loses"), "the loser left a row");
    ok(after.find((r) => r.id === winner.id)?.published_at, "the winner is stamped");
  });

  await t("a forced failure of the published_at stamp inside the batch leaves the pointer and the releases table unchanged", async () => {
    await inGd(() => S.setBlock("hero", { title: "Stamp fails" }));
    const p0 = await pointer();
    const r0 = JSON.stringify(await rows());
    await inGd(() => libsql.execute("CREATE TRIGGER gd_stamp_fails BEFORE UPDATE OF published_at ON releases BEGIN SELECT RAISE(ABORT, 'stamp failed on purpose'); END"));
    try {
      const err = await inGd(() => R.createRelease({ note: "stamp fails", actor }).then(() => null, (e) => e));
      ok(err, "the publish reported success");
      ok(/stamp failed on purpose/.test(String(err?.message) + String(err?.cause?.message)), `wrong error: ${err?.message}`);
    } finally {
      await inGd(() => libsql.execute("DROP TRIGGER gd_stamp_fails"));
    }
    eq(await pointer(), p0, "pointer:");
    eq(JSON.stringify(await rows()), r0, "releases:");
  });

  await t("a scheduled legacy release whose job races a manual publish still goes live (re-read, then retry)", async () => {
    await inGd(() => S.setBlock("hero", { title: "Scheduled hero" }));
    const future = new Date(Date.now() + 60_000).toISOString();
    const sched = await inGd(() => R.createRelease({ note: "scheduled", actor, scheduledFor: future }));
    await inGd(() => S.setBlock("hero", { title: "Manual hero" }));
    const job = (await C.platformDb().execute({ sql: "SELECT id FROM jobs WHERE idempotency_key = ?", args: [`publish_${sched.id}`] })).rows[0];
    await C.platformDb().execute({ sql: "UPDATE jobs SET run_after = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), job.id] });
    const attempts = [];
    let manual = null;
    const res = await hooked(
      async (info) => {
        if (info.kind !== "scheduled") return;
        attempts.push(info.attempt);
        if (info.attempt === 1) manual = await R.createRelease({ note: "manual", actor }); // lands between the job's read and its flip
      },
      () => W.runJobById(job.id),
    );
    eq(res.ok, true, `job: ${JSON.stringify(res)}`);
    ok(manual?.id, "the manual publish did not go live");
    eq(attempts.join(), "1,2", "flip attempts:");
    eq(await pointer(), sched.id, "the scheduled release won:");
    ok((await rows()).find((r) => r.id === sched.id)?.published_at, "stamped");
  });

  await t("rollbackRelease to a v4 row is a 409 and the pointer stays; the scheduled job for a v4 row fails without flipping", async () => {
    await putV4("rel_gd_v4");
    const p0 = await pointer();
    const e = await inGd(() => R.rollbackRelease("rel_gd_v4", { actor }).then(() => null, (x) => x));
    ok(e, "rollback to a v4 row went through");
    eq([e.status, e.code].join(), "409,STORE_USES_DOCUMENTS", "rollback:");
    eq(await pointer(), p0, "pointer after rollback:");
    const j = await inGd(() => R.publishReleaseById("rel_gd_v4").then(() => null, (x) => x));
    ok(j, "the job flipped a v4 row");
    eq(j.code, "STORE_USES_DOCUMENTS", "job:");
    eq(await pointer(), p0, "pointer after the job:");
    // and a legacy rollback still works, through the same guarded flip
    await inGd(() => R.rollbackRelease(first.id, { actor }));
    eq(await pointer(), first.id, "legacy rollback:");
  });

  await t("rollback and the scheduled job refuse a store not on legacy, without flipping", async () => {
    const p0 = await pointer();
    await inGd(() => libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1"));
    try {
      const rb = await inGd(() => R.rollbackRelease(first.id, { actor }).then(() => null, (x) => x));
      eq(rb?.code, "STORE_USES_DOCUMENTS", "rollback:");
      const job = await inGd(() => R.publishReleaseById(first.id).then(() => null, (x) => x));
      eq(job?.code, "STORE_USES_DOCUMENTS", "job:");
      const pub = await inGd(() => R.createRelease({ actor }).then(() => null, (x) => x));
      eq(pub?.code, "STORE_USES_DOCUMENTS", "publish:");
    } finally {
      await inGd(() => libsql.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1"));
    }
    eq(await pointer(), p0, "pointer:");
  });

  // P4-GUARD (MIG-03): the legacy guard rides inside the flip's own batch.
  // Each caller of classifyAbort in lib/releases.js gets one case: the hook
  // moves the store off legacy AFTER the pre-check and before the batch.
  const M = await import("../lib/cms-mode.js");
  const setMode = (mode) => inGd(() => libsql.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] }));
  const modeWords = (mode) => (mode === "migrating" ? M.MIGRATING_MESSAGE : "This store publishes with the new editor, so nothing was published here. Publish from the editor instead.");
  const flipModeOnce = (mode, kind) => {
    let fired = 0;
    const hook = async (info) => {
      if (info.kind !== kind) return;
      fired++;
      if (fired === 1) await setMode(mode);
    };
    return { hook, fired: () => fired };
  };

  for (const mode of ["migrating", "documents"]) {
    await t(`P4-GUARD: createRelease whose store turns '${mode}' after the pre-check is refused inside the flip with the plain 409 words, never 'Another publish just went live'; no row, pointer unchanged`, async () => {
      await inGd(() => S.setBlock("hero", { title: `Guarded ${mode} publish` }));
      const p0 = await pointer();
      const r0 = JSON.stringify(await rows());
      const h = flipModeOnce(mode, "publish");
      let err;
      try {
        err = await hooked(h.hook, () => inGd(() => R.createRelease({ note: `guard ${mode}`, actor }).then(() => null, (e) => e)));
      } finally {
        await setMode("legacy");
      }
      eq(h.fired(), 1, "hook:");
      ok(err, "the publish went through on a store that left legacy");
      eq([err.status, err.code, err.message].join(" | "), `409 | STORE_USES_DOCUMENTS | ${modeWords(mode)}`, "refusal:");
      ok(err.code !== "PUBLISH_RACE" && !/Another publish/.test(err.message), "reported as a lost race");
      eq(await pointer(), p0, "pointer:");
      eq(JSON.stringify(await rows()), r0, "releases:");
    });

    await t(`P4-GUARD: rollbackRelease whose store turns '${mode}' after the pre-check is refused inside the flip (409 plain words, not a lost race); pointer unchanged`, async () => {
      await inGd(() => S.setBlock("hero", { title: `Rollback ${mode}` }));
      const target = (await inGd(() => R.createRelease({ note: `rb base ${mode}`, actor }))).id;
      await inGd(() => S.setBlock("hero", { title: `Rollback ${mode} newer` }));
      await inGd(() => R.createRelease({ note: `rb newer ${mode}`, actor }));
      const p0 = await pointer();
      const r0 = JSON.stringify(await rows());
      const h = flipModeOnce(mode, "rollback");
      let err;
      try {
        err = await hooked(h.hook, () => inGd(() => R.rollbackRelease(target, { actor }).then(() => null, (e) => e)));
      } finally {
        await setMode("legacy");
      }
      eq(h.fired(), 1, "hook:");
      ok(err, "the rollback went through on a store that left legacy");
      eq([err.status, err.code, err.message].join(" | "), `409 | STORE_USES_DOCUMENTS | ${modeWords(mode)}`, "refusal:");
      eq(await pointer(), p0, "pointer:");
      eq(JSON.stringify(await rows()), r0, "releases:");
    });

    await t(`P4-GUARD: publishReleaseById whose store turns '${mode}' after the pre-check returns {skipped:'mode'} after ONE attempt; the job completes and is not retried; pointer unchanged`, async () => {
      await inGd(() => S.setBlock("hero", { title: `Scheduled ${mode}` }));
      const sched = await inGd(() => R.createRelease({ note: `sched ${mode}`, actor, scheduledFor: new Date(Date.now() + 60_000).toISOString() }));
      const job = (await C.platformDb().execute({ sql: "SELECT id FROM jobs WHERE idempotency_key = ?", args: [`publish_${sched.id}`] })).rows[0];
      await C.platformDb().execute({ sql: "UPDATE jobs SET run_after = ? WHERE id = ?", args: [new Date(Date.now() - 1000).toISOString(), job.id] });
      const p0 = await pointer();
      const h = flipModeOnce(mode, "scheduled");
      let res;
      try {
        res = await hooked(h.hook, () => W.runJobById(job.id));
      } finally {
        await setMode("legacy");
      }
      eq(h.fired(), 1, "flip attempts:");
      eq(res.ok, true, `job: ${JSON.stringify(res)}`);
      eq([res.result?.skipped, res.result?.mode, res.result?.id].join(), `mode,${mode},${sched.id}`, "result:");
      const after = (await C.platformDb().execute({ sql: "SELECT status, attempts FROM jobs WHERE id = ?", args: [job.id] })).rows[0];
      eq([after.status, Number(after.attempts)].join(), "done,1", "the job is done, not retried:");
      eq(await pointer(), p0, "pointer:");
      ok(!(await rows()).find((r) => r.id === sched.id)?.published_at, "the scheduled row was stamped");
      // called directly, the same answer
      const h2 = flipModeOnce(mode, "scheduled");
      let direct;
      try {
        direct = await hooked(h2.hook, () => inGd(() => R.publishReleaseById(sched.id)));
      } finally {
        await setMode("legacy");
      }
      eq([direct.skipped, h2.fired()].join(), "mode,1", "direct:");
      eq(await pointer(), p0, "pointer after the direct call:");
    });
  }

  await t("P4-GUARD: a lost pointer race on a store still on legacy is still a lost race (classifyAbort re-reads the mode)", async () => {
    await inGd(() => S.setBlock("hero", { title: "Still a race" }));
    let fired = false;
    const loser = await hooked(
      async (info) => {
        if (fired || info.kind !== "publish") return;
        fired = true;
        await R.createRelease({ note: "race winner", actor });
      },
      () => inGd(() => R.createRelease({ note: "race loser", actor }).then(() => null, (e) => e)),
    );
    eq([loser?.status, loser?.code].join(), "409,PUBLISH_RACE", "loser:");
  });

  // gd4: a store whose live release is a documents list (v4)
  const GD4 = await mk("gd4", ".test-rel-gd4.db");
  const inGd4 = (fn) => withTenant(GD4, fn);
  await inGd4(async () => {
    await S.setBlock("hero", { title: "Legacy draft" });
    await S.setBlock("announcement", { enabled: true, text: "Legacy announcement" });
    await libsql.execute({
      sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_gd4', ?, 'h_gd4', 'v4', NULL, ?, NULL, ?)",
      args: [R.stableStringify({ v: 4, list: { doc_header: "dv_1" } }), new Date().toISOString(), new Date().toISOString()],
    });
    await libsql.execute("UPDATE release_state SET live_release_id = 'rel_gd4' WHERE id = 1");
  });

  await t("with a v4 pointer: getLiveRelease, releaseDiff, validateRelease and brandReadability give the documents marker, never 'every block customized'", async () => {
    const live = await inGd4(() => R.getLiveRelease());
    eq(JSON.stringify([live.id, live.v, live.documents, live.content]), JSON.stringify(["rel_gd4", 4, true, null]), "getLiveRelease:");
    const d = await inGd4(() => R.releaseDiff());
    eq(d.documents, true, "diff marker:");
    eq(d.message, "This store publishes with the new editor", "diff message:");
    eq(d.items.length, 0, `diff items: ${JSON.stringify(d.items)}`);
    eq(d.dirty, false, "diff dirty:");
    const snap = await inGd4(() => R.snapshotContent());
    const v = await inGd4(() => R.validateRelease({ ...snap.content, brand: { foreground: "#cccccc", background: "#ffffff" } }));
    eq(JSON.stringify([v.documents, v.ok, v.issues.length]), JSON.stringify([true, true, 0]), "validateRelease:");
    const { brandReadability } = await import("../lib/admin/brand-readability.js");
    const b = await inGd4(() => brandReadability({ foreground: "#cccccc", background: "#ffffff" }));
    eq(JSON.stringify([b.documents, b.blocking, b.warnings.length]), JSON.stringify([true, false, 0]), "brandReadability:");
    eq(b.message, "This store publishes with the new editor", "brand message:");
    // a legacy publish can't flip a v4 pointer back to old content
    const e = await inGd4(() => R.createRelease({ actor }).then(() => null, (x) => x));
    eq(e?.code, "STORE_USES_DOCUMENTS", "createRelease over a v4 pointer:");
  });

  await t("with a v4 pointer the platform overview gives the documents marker for that store", async () => {
    process.env.PLATFORM_ADMIN_PASSWORD = "guard-operator-pass";
    try {
      const { platformSessionToken } = await import("../lib/platform/admin-auth.js");
      const tok = await platformSessionToken();
      const route = await import("../app/api/platform/overview/route.js");
      const res = await route.GET({ cookies: { get: (n) => (n === "_platform" ? { value: tok } : undefined) }, headers: { get: () => null } });
      const body = await res.json();
      eq(res.status, 200, `overview: ${JSON.stringify(body).slice(0, 200)}`);
      const gd4 = body.fleet.find((f) => f.tenant === "gd4");
      ok(gd4?.reachable, `gd4: ${JSON.stringify(gd4)}`);
      eq(JSON.stringify([gd4.release?.id, gd4.release?.documents]), JSON.stringify(["rel_gd4", true]), "release:");
      eq(gd4.release.message, "This store publishes with the new editor", "message:");
      const gd = body.fleet.find((f) => f.tenant === "gd");
      ok(gd?.release && !gd.release.documents && /^[0-9a-f]{12}$/.test(gd.release.hash), `a legacy store keeps its hash: ${JSON.stringify(gd?.release)}`);
    } finally {
      delete process.env.PLATFORM_ADMIN_PASSWORD;
    }
  });

  await t("the documents-mode Publishing badge is one statement and counts draft_hash IS NOT published_hash", async () => {
    await inGd4(async () => {
      await libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
      const doc = (id, type, draft, published, archived = null) =>
        libsql.execute({
          sql: "INSERT INTO documents (id, type, label, draft, draft_hash, schema_version, published_hash, archived_at, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, 1, ?, ?, 'x', 'x')",
          args: [id, type, id, draft, published, archived],
        });
      await doc("doc_home", "home", "h1", "h0"); // dirty
      await doc("doc_header", "header", "h2", "h2"); // clean
      await doc("doc_footer", "footer", "h3", null); // never published: dirty
      await doc("doc_p_old", "page", "h4", "h0", "2026-01-01"); // archived: not counted
      await doc("doc_bp", "blueprint", "h5", "h0"); // blueprint: not counted
    });
    const one = await inGd4(() => runRequest(() => watchStatements(currentDatabase().libsql, () => R.publishingBadge())));
    eq(one.result, 2, "badge:");
    eq(one.statements.length, 1, `statements: ${JSON.stringify(one.statements)}`);
    ok(/documents/.test(one.statements[0]) && /draft_hash IS NOT published_hash/.test(one.statements[0]), `the statement: ${one.statements[0]}`);
    await inGd4(() => libsql.execute("UPDATE documents SET published_hash = draft_hash"));
    eq(await inGd4(() => R.publishingBadge()), null, "all published:");
    // a legacy store keeps today's dot
    await inGd(() => S.setBlock("hero", { title: "Unpublished edit" }));
    eq(await inGd(() => R.publishingBadge()), "•", "legacy dirty:");
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
