// Releases suite (Session 36 / BE09 + SF23): snapshot determinism + content
// hashing, atomic publish with no draft→live leakage, rollback that preserves
// drafts, publish validation (required slots, dead catalog links, brand
// contrast), scheduled publish through the real jobs queue, and preview
// token expiry/tamper/tenant-binding.
//   pnpm test:releases
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rel-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rel-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-rel-default.db", ".test-rel-platform.db", ".test-rel-t1.db"];
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
  if (!/Brand:/.test(r.errors[0])) throw new Error(`wrong error: ${r.errors}`);
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
  const navWarnings = v.warnings.filter((w) => /nav/.test(w) && /isn't a storefront route/.test(w));
  eq(navWarnings.length, 0, `spurious warnings: ${navWarnings.join(" | ")}`);
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
  const before = (await inTenant(() => R.listReleases({ limit: 50 }))).releases.length;
  try {
    await inTenant(() => R.createRelease({ actor: { kind: "merchant", id: "u1" }, expectedDraftHash: "sha-of-something-older" }));
    throw new Error("expected DRAFTS_CHANGED");
  } catch (e) {
    if (e.code !== "DRAFTS_CHANGED") throw e;
  }
  const after = (await inTenant(() => R.listReleases({ limit: 50 }))).releases.length;
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

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
