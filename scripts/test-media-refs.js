// P4-MEDIA (MED-03): the reference index and the media archive.
//   1. extraction: images and links inside text, the id form, the regex belt
//      (lib/registry/settings.js refsOfText, lib/documents/refs.js);
//   2. every version kind is indexed (lib/documents/service.js, build.js,
//      commit.js), and usage on a documents store reads the index joined to
//      document_versions, the drafts, the settings and release:<id> rows,
//      never document_versions.body or releases.content (lib/media.js);
//   3. delete refusals: documents stores (forced too), stores being moved,
//      legacy stores (today's force), and the DELETE's own guard;
//   4. archive (migration 0025) and a store at 0024 without the column;
//   5. the reindex (reindexTenant and scripts/reindex-document-refs.js).
// File databases only (scripts/support/tenant-fixture.js).
//   pnpm test:media-refs
import "./support/request-cache.js";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-mr-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("mr");
const plat = await F.makePlatform({ name: "mr" });
const { watchStatements } = await import("./support/request-cache.js");
const { currentDatabase } = await import("../lib/db.js");
const R = await import("../lib/registry/index.js");
const Set_ = await import("../lib/registry/settings.js");
const Refs = await import("../lib/documents/refs.js");
const Docs = await import("../lib/documents/service.js");
const V = await import("../lib/documents/versions.js");
const Pub = await import("../lib/documents/publish.js");
const U = await import("../lib/documents/undo.js");
const M = await import("../lib/media.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 4).join("\n   ") || e}`);
  } finally {
    V.setCheckpointInterval(null);
  }
}
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const eq = (got, want, label = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${label} expected ${canon(want).slice(0, 900)}, got ${canon(got).slice(0, 900)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const codeOf = (p) => p.then(() => "ok", (e) => e?.code || String(e?.message || e));

// ---- stores ------------------------------------------------------------------------------
const CONFIG = { site: { name: "MR Store" }, site_url: "https://mr.test" };
const docs = await F.makeTenant({ name: "mr-docs", id: "mrdocs", config: CONFIG });
const legacy = await F.makeTenant({ name: "mr-legacy", id: "mrlegacy", config: CONFIG });
const moving = await F.makeTenant({ name: "mr-moving", id: "mrmoving", config: CONFIG });
const old24 = await F.makeTenant({ name: "mr-old24", id: "mrold24", stage: "0024", config: CONFIG });
const cli = await F.makeTenant({ name: "mr-cli", id: "mrcli", config: CONFIG });
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
// the legacy tables (cms_blocks, cms_pages) live in lib/schema.sql
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
for (const fx of [docs, legacy, moving, old24, cli]) await raw(fx).executeMultiple(schema);
for (const fx of [docs, cli]) await raw(fx).execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw(moving).execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");

const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n & 255, (n >> 8) & 255, 2, 3, 4, 5, 6, 7]);
let pngN = 1;
const upload = (fx, extra = {}) => fx.run(() => M.saveMedia({ filename: `p${pngN}.png`, mime: "image/png", bytes: PNG(pngN++), ...extra }));
const stored = async (fx, id) => Number((await sql(fx, "SELECT count(*) AS n FROM media WHERE id = ?", [id]))[0].n);
const usage = async (fx, id) => (await fx.run(() => M.mediaUsage(id))).map((u) => (u.document ? [u.label, u.document] : [u.where]));
const ACTOR = { kind: "merchant", id: "u_mr" };

const sec = (kind, id, settings = {}) => {
  const s = R.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings } };
};
const hero = (id, src) => sec("hero", id, { title: "Hello", image: src ? { media: src, alt: "Jar" } : null });
const imageText = (id, src) => sec("image_with_text", id, { image: { media: src, alt: "Jar" }, title: "Pic" });
const pageBody = (slug, sections) => ({ ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug, title: slug }, sections });
const homeBody = (sections) => ({ ...R.emptyBody("home"), sections });
const refsOfVersion = (fx, versionId) => sql(fx, "SELECT ref_type, ref_id FROM document_refs WHERE version_id = ? ORDER BY ref_type, ref_id", [versionId]);

// =============================================================================
// 1. extraction
// =============================================================================
console.log("— extraction (registry with text refs, id form, the belt)");

await t("a rich_text <img src=/api/media/med_x> and a FAQ-answer image each give media ref med_x; https://host/api/media/med_x?w=400 is stored as med_x", () => {
  const rich = sec("rich_text", "sec_rt1", { html: "<p>Look <img src=/api/media/med_x></p>" });
  const faq = sec("faq", "sec_fq1", { items: [{ q: "Which jar?", a: '<p>This one: <img src="/api/media/med_x" alt="jar"></p>' }] });
  const abs = imageText("sec_iw1", "https://host.example/api/media/med_x?w=400");
  for (const [name, s] of [["rich text", rich], ["faq answer", faq], ["absolute image", abs]]) {
    const rows = Refs.refRows("ver_t1", pageBody("x", [s]));
    eq(rows.filter((r) => r.ref_type === "media"), [{ version_id: "ver_t1", ref_type: "media", ref_id: "med_x" }], `${name}:`);
  }
  // the registry itself sees them (not only the belt): text refs on request
  eq(Set_.refsOfSetting({ key: "html", kind: "rich_text" }, rich.settings.html, "html", { text: true }), [{ field: "html", ref: "media", src: "/api/media/med_x", inText: true }], "rich text through the registry:");
  eq(Set_.refsOfSetting({ key: "items", kind: "qa_list" }, faq.settings.items, "items", { text: true }).map((r) => [r.field, Refs.mediaIdOf(r.src)]), [["items.0.a", "med_x"]], "faq answer through the registry:");
  eq(Refs.mediaIdOf("https://host.example/api/media/med_x?w=400"), "med_x", "absolute with a query:");
  eq(Refs.mediaIdOf("//cdn.example/api/media/med_x#a"), "med_x", "protocol-relative:");
  eq(Refs.mediaIdOf("https://cdn.shopify.com/s/files/x.jpg"), null, "not a library file:");
  eq(Refs.mediaIdOf("/api/mediax/med_x"), null, "a look-alike path:");
  // no media row is ever stored by its address
  ok(!Refs.refRows("ver_t2", pageBody("y", [rich, faq, abs])).some((r) => r.ref_type === "media" && r.ref_id.includes("/")), "no src-form media row:");
});

await t("links and images inside text: <a href> to a product, a collection and a policy page; paragraphs; the publish checks still see no text refs (default off)", () => {
  const rich = sec("rich_text", "sec_rt2", {
    html: `<p><a href="/products/tee">Tee</a> <a href='/collections/summer?sort=new'>Summer</a> <a href=/policies/shipping>Shipping</a> <a href="https://elsewhere.example/x">Out</a> <img src="/api/media/med_r&amp;x" alt=""></p>`,
  });
  const text = sec("text", "sec_tx1", { title: "T", body: ["see <img src='/api/media/med_p'>", "plain words"] });
  const rows = Refs.refRows("ver_l1", pageBody("z", [rich, text]));
  eq(
    rows.map((r) => [r.ref_type, r.ref_id]),
    [["collection", "summer"], ["document", "slug:page:shipping"], ["media", "med_p"], ["media", "med_r"], ["product", "tee"]],
    "rows:",
  );
  // without { text: true } refsOfSetting is what it was: lib/documents/checks.js
  // and every other caller see no text refs
  eq(Set_.refsOfSetting({ key: "html", kind: "rich_text" }, rich.settings.html), [], "rich text, default:");
  eq(Set_.refsOfSetting({ key: "body", kind: "paragraphs" }, text.settings.body), [], "paragraphs, default:");
  eq(R.refsOf(rich), [], "registry refsOf (checks):");
});

// P5-BLOCKS: the bundle blocks hold bundle ids only. Their photos are read live
// (the products' own), so a bundle section references no media, and its
// references are the bundles, by id.
await t("P5-BLOCKS: bundle_card and bundle_grid worst cases reference no media; their refs are bundles by id", () => {
  for (const kind of ["bundle_card", "bundle_grid"]) {
    ok(R.sectionKinds().includes(kind), `${kind} registered`);
    for (const c of R.worstCase(kind).cases) {
      const refs = R.refsOf(c.section);
      ok(refs.length > 0 && refs.every((r) => r.ref === "bundle" && typeof r.id === "string"), `${kind}/${c.name}: ${JSON.stringify(refs)}`);
      eq(Refs.mediaIdsIn(R.stableStringify(c.section)), [], `${kind}/${c.name} media in the body:`);
      eq(Refs.refRows("ver_bun", { type: "home", sections: [c.section] }).filter((r) => r.ref_type === "media"), [], `${kind}/${c.name} media rows:`);
    }
  }
  const grid = R.worstCase("bundle_grid").cases.find((c) => c.name === "max_items").section;
  eq(R.refsOf(grid).map((r) => r.id), Array.from({ length: 12 }, (_, j) => `bun-worst-${j + 1}`), "the grid's 12 bundles, in order:");
});

await t("across every section fixture (worstCase of every kind, plus text images and an unknown kind) the registry's media set is a subset of the belt's", () => {
  const registrySet = (s) => {
    const rows = Refs.refRows("ver_sub", { type: "page", sections: [s] });
    void rows;
    const d = R.sectionType(s.kind);
    const out = new Set();
    if (!d) return out;
    for (const st of d.settings) for (const r of Set_.refsOfSetting(st, s.settings?.[st.key], st.key, { text: true })) if (r.ref === "media" && Refs.mediaIdOf(r.src)) out.add(Refs.mediaIdOf(r.src));
    for (const r of d.refs(s) || []) if (r.ref === "media" && Refs.mediaIdOf(r.src)) out.add(Refs.mediaIdOf(r.src));
    return out;
  };
  let checked = 0;
  let withMedia = 0;
  const sections = [];
  for (const kind of R.sectionKinds()) {
    for (const c of R.worstCase(kind).cases) {
      sections.push([`${kind}/${c.name}`, c.section]);
      // the same case with an image written into every text setting
      const d = R.sectionType(kind);
      const s2 = JSON.parse(JSON.stringify(c.section));
      for (const st of d.settings) {
        if (st.kind === "rich_text") s2.settings[st.key] = `${s2.settings[st.key] || ""}<p><img src="/api/media/med_rt${kind.length}"></p>`;
        if (st.kind === "paragraphs") s2.settings[st.key] = [...(s2.settings[st.key] || []), "<img src=/api/media/med_pg>"];
        if (st.kind === "qa_list") s2.settings[st.key] = [...(s2.settings[st.key] || []), { q: "Q", a: "<p><img src='https://h.example/api/media/med_qa?w=1'></p>" }];
      }
      sections.push([`${kind}/${c.name}+text`, s2]);
    }
  }
  sections.push(["unknown kind", { id: "sec_unk1", kind: "legacy_gallery", v: 1, enabled: true, settings: { pics: ["/api/media/med_unknown"] }, blocks: [] }]);
  for (const [name, s] of sections) {
    const reg = registrySet(s);
    const belt = new Set(Refs.mediaIdsIn(R.stableStringify(s)));
    for (const id of reg) ok(belt.has(id), `${name}: ${id} found by the registry but not by the belt`);
    // and refRows holds both
    const rows = new Set(Refs.refRows("ver_sub", { type: "page", sections: [s] }).filter((r) => r.ref_type === "media").map((r) => r.ref_id));
    for (const id of belt) ok(rows.has(id), `${name}: belt id ${id} missing from refRows`);
    checked++;
    if (reg.size) withMedia++;
  }
  ok(withMedia >= 5, `only ${withMedia} fixtures had registry media`);
  const unknown = Refs.refRows("ver_unk", { type: "page", sections: [sections[sections.length - 1][1]] });
  eq(unknown.map((r) => r.ref_id), ["med_unknown"], "the belt catches an unknown kind:");
  console.log(`    (${checked} section fixtures, ${withMedia} with registry media)`);
});

await t("refRowsForBody takes an object or stored JSON (a text that isn't JSON still gets the belt); releaseRefRows reads release content", () => {
  const body = pageBody("rb", [imageText("sec_iw9", "/api/media/med_obj")]);
  eq(Refs.refRowsForBody("doc_a", "ver_a", body), Refs.refRows("ver_a", body), "object:");
  eq(Refs.refRowsForBody("doc_a", "ver_a", R.stableStringify(body)), Refs.refRows("ver_a", body), "JSON text:");
  eq(Refs.refRowsForBody("doc_a", "ver_b", "not json /api/media/med_t1 and /api/media/med_t2?x"), [
    { version_id: "ver_b", ref_type: "media", ref_id: "med_t1" },
    { version_id: "ver_b", ref_type: "media", ref_id: "med_t2" },
  ], "text:");
  eq(Refs.releaseRefRows({ id: "rel_1", content: JSON.stringify({ v: 2, blocks: { hero: { image: "https://s.example/api/media/med_rel?w=3" } }, x: "/api/media/med_rel" }) }), [{ version_id: "release:rel_1", ref_type: "media", ref_id: "med_rel" }], "release:");
});

// =============================================================================
// 2. every version kind, and usage on a documents store
// =============================================================================
console.log("— every version kind is indexed; usage reads the index (documents store)");

const homeState = {};
await t("createDocument's first checkpoint, a due checkpoint, saveVersion and keepEarlierDraft are indexed by id; a checkpoint that wasn't due leaves no refs", async () => {
  const a = await upload(docs);
  const p = await docs.run(() => Docs.createDocument({ type: "page", meta: { slug: "kinds", title: "Kinds" }, body: pageBody("kinds", [imageText("sec_k1", M.mediaUrl(a.id))]), actor: ACTOR }));
  const first = await sql(docs, "SELECT id, kind FROM document_versions WHERE document_id = ?", [p.document.id]);
  eq(first.map((v) => v.kind), ["checkpoint"], "one checkpoint:");
  eq(await refsOfVersion(docs, first[0].id), [{ ref_type: "media", ref_id: a.id }], "first checkpoint's refs:");

  // a save inside the interval: no checkpoint, so no refs
  const b = await upload(docs);
  let d = (await docs.run(() => Docs.saveDraft({ id: p.document.id, revision: 1, body: pageBody("kinds", [imageText("sec_k1", M.mediaUrl(b.id))]), actor: ACTOR }))).document;
  eq(Number((await sql(docs, "SELECT count(*) AS n FROM document_versions WHERE document_id = ?", [p.document.id]))[0].n), 1, "no new checkpoint:");
  eq(Number((await sql(docs, "SELECT count(*) AS n FROM document_refs WHERE ref_id = ?", [b.id]))[0].n), 0, "no refs for it:");
  // a due checkpoint
  V.setCheckpointInterval(0);
  const c = await upload(docs);
  d = (await docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: pageBody("kinds", [imageText("sec_k1", M.mediaUrl(c.id))]), actor: ACTOR }))).document;
  const cp = await sql(docs, "SELECT v.id FROM document_versions v JOIN document_refs r ON r.version_id = v.id WHERE r.ref_id = ? AND v.kind = 'checkpoint'", [c.id]);
  eq(cp.length, 1, "the due checkpoint is indexed:");
  // saveVersion (undo_saved)
  const s = await upload(docs);
  const sv = await docs.run(() => Docs.saveVersion({ documentId: d.id, kind: "undo_saved", body: pageBody("kinds", [imageText("sec_k1", M.mediaUrl(s.id))]), actor: ACTOR }));
  eq(await refsOfVersion(docs, sv.id), [{ ref_type: "media", ref_id: s.id }], "saveVersion refs:");
  // keepEarlierDraft (undo_saved, kept from another tab)
  const k = await upload(docs);
  const kept = await docs.run(() => Docs.keepEarlierDraft({ id: d.id, body: pageBody("kinds", [imageText("sec_k1", M.mediaUrl(k.id))]), actor: ACTOR }));
  eq(kept.stored, true, "kept:");
  eq(await refsOfVersion(docs, kept.savedVersion.id), [{ ref_type: "media", ref_id: k.id }], "keepEarlierDraft refs:");
  // the same body again stores nothing new, and no refs for the id it didn't store
  const again = await docs.run(() => Docs.keepEarlierDraft({ id: d.id, body: pageBody("kinds", [imageText("sec_k1", M.mediaUrl(k.id))]), actor: ACTOR }));
  eq(again.stored, false, "deduped:");
  eq(Number((await sql(docs, "SELECT count(*) AS n FROM document_refs r LEFT JOIN document_versions v ON v.id = r.version_id WHERE r.ref_id = ? AND v.id IS NULL", [k.id]))[0].n), 0, "no orphan refs from the refused keep:");
  // restore keeps the replaced draft as a checkpoint, indexed
  const before = (await docs.run(() => Docs.getDocument(d.id))).body;
  const r = await docs.run(() => Docs.restoreVersion({ id: d.id, versionId: sv.id, revision: d.revision, actor: ACTOR }));
  const keptCp = await sql(docs, "SELECT id FROM document_versions WHERE document_id = ? AND note = 'Before restoring an earlier version'", [d.id]);
  eq(keptCp.length, 1, "restore kept a checkpoint:");
  eq((await refsOfVersion(docs, keptCp[0].id)).map((x) => x.ref_id), Refs.refRows("x", before).filter((x) => x.ref_type === "media").map((x) => x.ref_id), "its refs:");
  ok(r.document.revision > d.revision, "restored");
});

await t("a file used only by an older published version shows as used (stored by id); after Undo to that version its images are found live; an undo_saved version's images are indexed", async () => {
  const p1 = await upload(docs);
  const p2 = await upload(docs);
  // the store opens with its home page: created without an image
  let home = (await docs.run(() => Docs.createDocument({ type: "home", body: homeBody([hero("sec_h1", null)]), actor: ACTOR }))).document;
  home = (await docs.run(() => Docs.saveDraft({ id: home.id, revision: home.revision, body: homeBody([hero("sec_h1", M.mediaUrl(p1.id))]), actor: ACTOR }))).document;
  const pub1 = await docs.run(() => Pub.publish({ ids: [{ id: home.id, revision: home.revision, draftHash: home.draftHash }], actor: ACTOR }));
  const v1 = pub1.published[0].versionId;
  eq(await refsOfVersion(docs, v1), [{ ref_type: "media", ref_id: p1.id }], "v1 refs by id:");
  home = await docs.run(() => Docs.getDocument(home.id));
  home = (await docs.run(() => Docs.saveDraft({ id: home.id, revision: home.revision, body: homeBody([hero("sec_h1", null)]), actor: ACTOR }))).document;
  const pub2 = await docs.run(() => Pub.publish({ ids: [{ id: home.id, revision: home.revision, draftHash: home.draftHash }], actor: ACTOR }));
  ok(pub2.published[0].versionId !== v1, "v2 published");
  eq(await usage(docs, p1.id), [["older version", "doc_home"]], "p1 only in the older published version:");
  eq((await sql(docs, "SELECT kind FROM document_versions WHERE id = ?", [v1]))[0].kind, "published", "it is a published version:");
  homeState.p1 = p1;
  homeState.v1 = v1;

  // a newer unpublished draft with p2, then Undo the second publish
  home = await docs.run(() => Docs.getDocument(home.id));
  home = (await docs.run(() => Docs.saveDraft({ id: home.id, revision: home.revision, body: homeBody([hero("sec_h1", M.mediaUrl(p2.id))]), actor: ACTOR }))).document;
  eq(await usage(docs, p2.id), [["draft", "doc_home"]], "p2 in the draft only:");
  const log = await sql(docs, "SELECT id FROM publish_log WHERE document_id = ? AND action = 'publish' ORDER BY created_at DESC, rowid DESC LIMIT 1", [home.id]);
  const u = await docs.run(() => U.undo({ kind: "undo", id: home.id, logId: log[0].id, revision: home.revision, hasRevision: true }, { actor: ACTOR }));
  eq(u.status, 200, `undo: ${JSON.stringify(u.body).slice(0, 300)}`);
  ok(u.body.savedVersion?.id, "the newer draft was saved before Undo");
  eq((await usage(docs, p1.id)).sort(), [["draft", "doc_home"], ["live", "doc_home"], ["older version", "doc_home"]], "after Undo, p1 is live again:");
  // p2 is now only in the undo_saved version
  eq(await usage(docs, p2.id), [["older version", "doc_home"]], "p2 in the undo_saved version:");
  eq((await sql(docs, "SELECT kind FROM document_versions WHERE id = ?", [u.body.savedVersion.id]))[0].kind, "undo_saved", "kind:");
  eq(await refsOfVersion(docs, u.body.savedVersion.id), [{ ref_type: "media", ref_id: p2.id }], "the undo_saved version's refs:");
  homeState.p2 = p2;
});

await t("a ref from a pruned checkpoint is not counted (its row stays, usage joins document_versions); the file then deletes", async () => {
  V.setCheckpointInterval(0);
  const q = await upload(docs);
  let d = (await docs.run(() => Docs.createDocument({ type: "page", meta: { slug: "prune", title: "Prune" }, body: pageBody("prune", [sec("text", "sec_p1", { title: "P", body: ["start"] })]), actor: ACTOR }))).document;
  d = (await docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: pageBody("prune", [imageText("sec_p2", M.mediaUrl(q.id))]), actor: ACTOR }))).document;
  const cp = (await sql(docs, "SELECT r.version_id AS v FROM document_refs r WHERE r.ref_id = ?", [q.id]))[0].v;
  for (let i = 0; i < V.CHECKPOINT_CAP + 2; i++) {
    d = (await docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: pageBody("prune", [sec("text", "sec_p1", { title: "P", body: [`words ${i}`] })]), actor: ACTOR }))).document;
  }
  eq((await sql(docs, "SELECT count(*) AS n FROM document_versions WHERE id = ?", [cp]))[0].n, 0, "the checkpoint was pruned:");
  eq((await sql(docs, "SELECT count(*) AS n FROM document_refs WHERE version_id = ? AND ref_id = ?", [cp, q.id]))[0].n, 1, "its ref row is still there:");
  eq(await usage(docs, q.id), [], "not counted:");
  eq((await docs.run(() => M.deleteMedia(q.id))).deleted, q.id, "deletes:");
  eq(await stored(docs, q.id), 0, "gone:");
});

await t("on a documents store a counted client shows usage issues no statement reading document_versions.body or releases.content; variants fold to their original", async () => {
  const orig = await upload(docs);
  const thumb = await upload(docs, { variant: "thumb", parentId: orig.id });
  let d = (await docs.run(() => Docs.createDocument({ type: "page", meta: { slug: "counted", title: "Counted" }, body: pageBody("counted", [imageText("sec_c1", M.mediaUrl(thumb.id))]), actor: ACTOR }))).document;
  void d;
  const run = () => docs.run(() => watchStatements(currentDatabase().libsql, () => M.mediaUsage(orig.id)));
  const { result, statements } = await run();
  eq(result.map((u) => [u.label, u.name]).sort(), [["draft", "Counted"], ["older version", "Counted"]], "the thumb's uses count for the original:");
  ok(statements.some((s) => /document_refs/.test(s)), `the index was read: ${statements.join(" | ")}`);
  for (const s of statements) {
    ok(!/\bbody\b/i.test(s), `a statement reads a version body: ${s}`);
    ok(!/\bcontent\b/i.test(s), `a statement reads release content: ${s}`);
  }
  // the delete path too
  const del = await docs.run(() => watchStatements(currentDatabase().libsql, () => codeOf(M.deleteMedia(orig.id, { force: true }))));
  eq(del.result, "MEDIA_IN_USE", "refused:");
  for (const s of del.statements) ok(!/\bbody\b|\bcontent\b/i.test(s), `the delete path reads a body or content: ${s}`);
});

// P6-LOGO-REG (MED-03, GEN-04): the design document's logo is a library file,
// indexed through the registry (refsOfSetting case "logo"), so usage, the
// delete guard and the publish checks see it.
const designBody = (logo) => ({ ...R.emptyBody("design"), settings: { brand: null, theme: { kit: "pulse", version: 1 }, logo } });
await t("P6-LOGO-REG: a doc_design draft with a logo indexes one document_refs row for that file; a draft without it has none; deleting the file is refused while that design is live, and allowed once nothing keeps it", async () => {
  // pure: the registry gives the logo as a media ref (not only the belt)
  const L = await upload(docs);
  const decl = R.documentType("design").settings.find((s) => s.key === "logo");
  eq(Set_.refsOfSetting(decl, { media: M.mediaUrl(L.id), alt: "Shop" }, "logo", { text: true }), [{ field: "logo.media", ref: "media", src: M.mediaUrl(L.id) }], "the registry's ref:");
  eq(Refs.refRows("ver_lg", designBody({ media: M.mediaUrl(L.id) })), [{ version_id: "ver_lg", ref_type: "media", ref_id: L.id }], "refRows with the logo:");
  eq(Refs.refRows("ver_lg", designBody(null)), [], "refRows without:");
  // the real store: the design's first checkpoint holds exactly one row for it
  V.setCheckpointInterval(0);
  let d = (await docs.run(() => Docs.createDocument({ type: "design", body: designBody({ media: M.mediaUrl(L.id), alt: "Shop" }), actor: ACTOR }))).document;
  eq(d.id, "doc_design", "the design singleton:");
  const first = await sql(docs, "SELECT id FROM document_versions WHERE document_id = 'doc_design' ORDER BY created_at, rowid");
  eq(first.length, 1, "one checkpoint:");
  eq(await refsOfVersion(docs, first[0].id), [{ ref_type: "media", ref_id: L.id }], "its refs:");
  eq(Number((await sql(docs, "SELECT count(*) AS n FROM document_refs WHERE ref_id = ?", [L.id]))[0].n), 1, "one row for the logo file:");
  eq(await usage(docs, L.id), [["draft", "doc_design"], ["older version", "doc_design"]].sort(), "the draft uses it:");
  // published: the live version holds the row, and a delete (forced too) is refused
  const pub = await docs.run(() => Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }], actor: ACTOR }));
  const live = pub.published[0].versionId;
  eq(await refsOfVersion(docs, live), [{ ref_type: "media", ref_id: L.id }], "the live version's refs:");
  // the founder removes the logo: the new draft's version holds no row for it
  d = await docs.run(() => Docs.getDocument(d.id));
  d = (await docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: designBody(null), actor: ACTOR }))).document;
  const latest = (await sql(docs, "SELECT id FROM document_versions WHERE document_id = 'doc_design' AND kind = 'checkpoint' ORDER BY created_at DESC, rowid DESC LIMIT 1"))[0].id;
  eq(await refsOfVersion(docs, latest), [], "the logo-less draft's version has no row:");
  ok(!(await usage(docs, L.id)).some(([label]) => label === "draft"), "the draft no longer uses it");
  for (const force of [false, true]) {
    const e = await docs.run(() => M.deleteMedia(L.id, { force }).then(() => null, (x) => x));
    eq(e?.code, "MEDIA_IN_USE", `force ${force}, refused while the design is live:`);
    ok(!/med_|doc_|ver_|document_/.test(e.message), `plain words: ${e.message}`);
  }
  eq(await stored(docs, L.id), 1, "the logo file stays:");
  // a second, unused file deletes (the guard is about this file, not every file)
  const U2 = await upload(docs);
  eq((await docs.run(() => M.deleteMedia(U2.id))).deleted, U2.id, "an unused file deletes:");
});

await t("P6-LOGO-REG: the publish checks see the logo: a design whose logo file was deleted warns MEDIA_MISSING on logo.media; a present file is silent", async () => {
  const Checks = await import("../lib/documents/checks.js");
  const there = await upload(docs);
  const doc = { id: "doc_design", type: "design" };
  const run = (src) => docs.run(() => Checks.referenceChecks({ items: [{ doc, body: designBody({ media: src }) }], list: { pages: [], redirects: [] } }));
  eq((await run(M.mediaUrl(there.id))).issues.filter((i) => i.code === Checks.MEDIA_MISSING), [], "the file is there:");
  const gone = (await run("/api/media/med_logo_gone")).issues.filter((i) => i.code === Checks.MEDIA_MISSING);
  eq(gone.map((i) => [i.code, i.severity, i.field, i.sectionId]), [["MEDIA_MISSING", "warning", "logo.media", null]], "a deleted logo warns:");
});

// =============================================================================
// 3. deletes
// =============================================================================
console.log("— deletes: documents (forced too), moving stores, legacy force, the DELETE's guard");

await t("documents store, force: true: a file used by a retained version is refused, in plain words; the file stays", async () => {
  const p1 = homeState.p1;
  ok(p1, "the older-version file from the test above");
  const e = await docs.run(() => M.deleteMedia(p1.id, { force: true }).then(() => null, (x) => x));
  eq(e?.code, "MEDIA_IN_USE", "refused:");
  ok(/Home page/.test(e.message), `names the page: ${e.message}`);
  ok(!/med_|doc_|ver_|release:|document_|_at\b/.test(e.message), `no ids or table names: ${e.message}`);
  eq(await stored(docs, p1.id), 1, "still stored:");
});

await t("documents store: a release:<id> row written by reindexTenant --releases refuses a forced delete; before it, release content is never read", async () => {
  const r = await upload(docs);
  await raw(docs).execute({
    sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, 'h', '', NULL, ?, NULL, ?)",
    args: ["rel_mrold", JSON.stringify({ v: 2, blocks: { home_sections: [{ kind: "hero", image: M.mediaUrl(r.id) }] } }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  });
  eq(await usage(docs, r.id), [], "not indexed yet (content is not scanned):");
  const c = docs.client();
  try {
    const rep = await Refs.reindexTenant(c, { releases: true });
    ok(rep.releases >= 1 && rep.added >= 1, `reindexed: ${JSON.stringify(rep)}`);
  } finally {
    c.close();
  }
  eq(await sql(docs, "SELECT version_id, ref_id FROM document_refs WHERE version_id LIKE 'release:%' AND ref_id = ?", [r.id]), [{ version_id: "release:rel_mrold", ref_id: r.id }], "the release row:");
  eq(await usage(docs, r.id), [["retained release:rel_mrold"]], "used by the old release:");
  const e = await docs.run(() => M.deleteMedia(r.id, { force: true }).then(() => null, (x) => x));
  eq(e?.code, "MEDIA_IN_USE", "forced delete refused:");
  ok(/an earlier published version of your store/.test(e.message) && !/rel_|release:/.test(e.message), `plain words: ${e.message}`);
  eq(await stored(docs, r.id), 1, "still stored:");
});

await t("documents store: the brand and site settings count (read live); an unused file deletes", async () => {
  const b = await upload(docs);
  const tenant = { ...docs.tenant, config: { ...docs.tenant.config, brand: { logo: M.mediaUrl(b.id) } } };
  const { withTenant } = await import("../lib/tenant-context.js");
  const uses = await withTenant(tenant, () => M.mediaUsage(b.id));
  eq(uses.map((u) => u.where), ["brand settings"], "brand:");
  const e = await withTenant(tenant, () => M.deleteMedia(b.id, { force: true }).then(() => null, (x) => x));
  eq(e?.code, "MEDIA_IN_USE", "refused:");
  ok(/your brand settings/.test(e.message), e.message);
  eq((await docs.run(() => M.deleteMedia(b.id))).deleted, b.id, "unused (without that setting) deletes:");
});

await t("documents store not reindexed yet: refs stored by address before this code ('/api/media/<id>', or a full address with a query) still count; a plain or forced delete is refused and the live image stays", async () => {
  // publish a page with image A, then put its ref back in the pre-branch form
  const a = await upload(docs);
  let d = (await docs.run(() => Docs.createDocument({ type: "page", meta: { slug: "oldform", title: "Old form" }, body: pageBody("oldform", [imageText("sec_o1", M.mediaUrl(a.id))]), actor: ACTOR }))).document;
  const pub = await docs.run(() => Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }], actor: ACTOR }));
  const live = pub.published[0].versionId;
  await raw(docs).execute({ sql: "DELETE FROM document_refs WHERE ref_type = 'media' AND ref_id = ?", args: [a.id] });
  await raw(docs).execute({ sql: "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES (?, 'media', ?)", args: [live, M.mediaUrl(a.id)] });
  // the draft moves on without the image
  d = await docs.run(() => Docs.getDocument(d.id));
  d = (await docs.run(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: pageBody("oldform", [sec("text", "sec_o2", { title: "T", body: ["no image"] })]), actor: ACTOR }))).document;
  eq(await usage(docs, a.id), [["live", d.id]], "the live version still uses it:");
  for (const force of [false, true]) {
    const e = await docs.run(() => M.deleteMedia(a.id, { force }).then(() => null, (x) => x));
    eq(e?.code, "MEDIA_IN_USE", `force ${force}, refused:`);
    ok(/oldform \(live\)/.test(e.message), e.message);
  }
  eq(await stored(docs, a.id), 1, "still stored:");
  // a full address with a query string, on an older version
  const b = await upload(docs);
  await raw(docs).execute({ sql: "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES (?, 'media', ?)", args: [live, `https://mr.test${M.mediaUrl(b.id)}?w=640`] });
  eq(await usage(docs, b.id), [["live", d.id]], "full address counts:");
  eq(await docs.run(() => codeOf(M.deleteMedia(b.id))), "MEDIA_IN_USE", "full address refuses:");
  // a variant's address counts for its original
  const o = await upload(docs);
  const th = await upload(docs, { variant: "thumb", parentId: o.id });
  await raw(docs).execute({ sql: "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES (?, 'media', ?)", args: [live, M.mediaUrl(th.id)] });
  eq(await docs.run(() => codeOf(M.deleteMedia(o.id, { force: true }))), "MEDIA_IN_USE", "variant address refuses the original:");
  eq(await stored(docs, o.id), 1, "original kept:");
});

await t("the DELETE's own guard also counts an address-form ref that lands between the check and the DELETE", async () => {
  const g = await upload(docs);
  const db = await docs.run(() => currentDatabase());
  const send = db.libsql.execute;
  let injected = 0;
  db.libsql.execute = async (stmt, ...rest) => {
    if (/^DELETE FROM media/.test(typeof stmt === "string" ? stmt : stmt?.sql || "") && !injected++) {
      await raw(docs).execute({ sql: "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES (?, 'media', ?) ON CONFLICT DO NOTHING", args: [homeState.v1, M.mediaUrl(g.id)] });
    }
    return send.call(db.libsql, stmt, ...rest);
  };
  let out;
  try {
    out = await docs.run(() => codeOf(M.deleteMedia(g.id, { force: true })));
  } finally {
    delete db.libsql.execute;
  }
  eq(out, "MEDIA_IN_USE", "refused by the guard:");
  eq(await stored(docs, g.id), 1, "kept:");
});

await t("a store being moved: every delete is refused, forced or not, used or not, with 'Your store is being updated…'; the files stay", async () => {
  const unused = await upload(moving);
  for (const force of [false, true]) {
    const e = await moving.run(() => M.deleteMedia(unused.id, { force }).then(() => null, (x) => x));
    eq([e?.code, e?.status], ["STORE_MIGRATING", 409], `force ${force}:`);
    eq(e.message, M.MIGRATING_MESSAGE, "words:");
    ok(/^Your store is being updated/.test(e.message), "starts with the plain words:");
  }
  eq(await stored(moving, unused.id), 1, "still stored:");
});

await t("legacy store: force keeps today's meaning (a page use refuses, force deletes); usage is the full scan", async () => {
  const f = await upload(legacy);
  await raw(legacy).execute({ sql: "INSERT INTO cms_pages (slug, title, sections, enabled, updated_at) VALUES ('uses-it', 'U', ?, 1, 'x')", args: [JSON.stringify([{ kind: "image", src: M.mediaUrl(f.id) }])] });
  eq(await usage(legacy, f.id), [["page:uses-it"]], "the scan:");
  eq(await legacy.run(() => codeOf(M.deleteMedia(f.id))), "MEDIA_IN_USE", "unforced:");
  eq((await legacy.run(() => M.deleteMedia(f.id, { force: true }))).deleted, f.id, "forced deletes:");
  eq(await stored(legacy, f.id), 0, "gone:");
});

await t("the DELETE guards itself: a ref written between the check and the DELETE, or a move that starts then, deletes nothing", async () => {
  // documents: a publish lands a ref right before the DELETE runs
  const g = await upload(docs);
  const inst = docs.run(() => currentDatabase());
  const db = await inst;
  const send = db.libsql.execute;
  db.libsql.execute = async (stmt, ...rest) => {
    if (/^DELETE FROM media/.test(typeof stmt === "string" ? stmt : stmt?.sql || "")) {
      await raw(docs).execute({ sql: "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES (?, 'media', ?) ON CONFLICT DO NOTHING", args: [homeState.v1, g.id] });
    }
    return send.call(db.libsql, stmt, ...rest);
  };
  let out;
  try {
    out = await docs.run(() => codeOf(M.deleteMedia(g.id, { force: true })));
  } finally {
    delete db.libsql.execute;
  }
  eq(out, "MEDIA_IN_USE", "refused by the guard:");
  eq(await stored(docs, g.id), 1, "kept:");
  // legacy: the move starts right before the DELETE
  const h = await upload(legacy);
  const ldb = await legacy.run(() => currentDatabase());
  const lsend = ldb.libsql.execute;
  ldb.libsql.execute = async (stmt, ...rest) => {
    if (/^DELETE FROM media/.test(typeof stmt === "string" ? stmt : stmt?.sql || "")) await raw(legacy).execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
    return lsend.call(ldb.libsql, stmt, ...rest);
  };
  try {
    out = await legacy.run(() => codeOf(M.deleteMedia(h.id, { force: true })));
  } finally {
    delete ldb.libsql.execute;
    await raw(legacy).execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
  }
  eq(out, "STORE_MIGRATING", "refused by the guard:");
  eq(await stored(legacy, h.id), 1, "kept:");
});

// The legacy scan's output, frozen from HEAD's lib/media.js (607cde2) on this
// exact fixture. A legacy store must answer byte for byte the same.
const LEGACY_SNAPSHOT =
  '[{"where":"block:home_sections"},{"where":"page:thumbs"},{"where":"product modules:gid://shopify/Product/77"},{"where":"live release:rel_lglive"},{"where":"scheduled release:rel_lgsched"},{"where":"retained release:rel_lgold"},{"where":"draft:doc_lgdraft","label":"draft","document":"doc_lgdraft","name":"Legacy draft"},{"where":"live:doc_lgdraft","label":"live","document":"doc_lgdraft","name":"Legacy draft","version":"ver_lglive"},{"where":"older version:doc_lgdraft","label":"older version","document":"doc_lgdraft","name":"Legacy draft","version":"ver_lgold"}]';
await t("legacy usage output is byte-identical to before (frozen from HEAD on a fixture with blocks, pages, modules, live/scheduled/retained releases, drafts and versions)", async () => {
  const L = raw(legacy);
  const P = "med_aaaaaaaaaaaaaaaaaa";
  const T = "med_aaaaaaaaaaaaaaaaab";
  const url = (id) => `/api/media/${id}`;
  const at = "2026-02-02T00:00:00.000Z";
  await L.execute({ sql: "INSERT INTO media (id, filename, mime, size, sha256, data, created_at) VALUES (?, 'a.png', 'image/png', 1, 'lg1', x'01', ?)", args: [P, at] });
  await L.execute({ sql: "INSERT INTO media (id, filename, mime, size, sha256, data, created_at, variant, parent_id) VALUES (?, 't.png', 'image/png', 1, 'lg2', x'01', ?, 'thumb', ?)", args: [T, at, P] });
  await L.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at) VALUES ('home_sections', ?, ?)", args: [JSON.stringify([{ kind: "hero", image: url(P) }]), at] });
  await L.execute({ sql: "INSERT INTO cms_pages (slug, title, sections, enabled, updated_at) VALUES ('thumbs', 'T', ?, 1, ?)", args: [JSON.stringify([{ src: url(T) }]), at] });
  await L.execute({ sql: "INSERT INTO product_overrides (product_id, modules, updated_at) VALUES ('gid://shopify/Product/77', ?, ?)", args: [JSON.stringify([{ title: "M", html: `<img src="${url(P)}">` }]), at] });
  const rel = (id, extra) => L.execute({ sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, 'h', '', NULL, ?, ?, ?)", args: [id, JSON.stringify({ v: 2, img: url(P) }), extra.created, extra.scheduled ?? null, extra.published ?? null] });
  await rel("rel_lglive", { created: "2026-02-01T00:00:00.000Z", published: at });
  await rel("rel_lgsched", { created: "2026-02-03T00:00:00.000Z", scheduled: "2099-01-01T00:00:00.000Z" });
  await rel("rel_lgold", { created: "2026-01-01T00:00:00.000Z", published: "2026-01-01T00:00:00.000Z" });
  await L.execute("UPDATE release_state SET live_release_id = 'rel_lglive' WHERE id = 1");
  const draft = JSON.stringify({ type: "page", sections: [{ src: url(P) }] });
  await L.execute({ sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_lgdraft', 'page', 'lg', 'Legacy draft', ?, 'dh', 1, 1, 'ver_lglive', ?, ?)", args: [draft, at, at] });
  await L.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES ('ver_lglive', 'doc_lgdraft', 'published', ?, 'b1', 1, ?)", args: [draft, "2026-02-02T00:00:00.000Z"] });
  await L.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES ('ver_lgold', 'doc_lgdraft', 'published', ?, 'b2', 1, ?)", args: [JSON.stringify({ src: url(T) }), "2026-01-01T00:00:00.000Z"] });
  const got = JSON.stringify(await legacy.run(() => M.mediaUsage(P)));
  eq(got, LEGACY_SNAPSHOT, "byte for byte:");
  ok(got === LEGACY_SNAPSHOT, "identical strings");
});

// =============================================================================
// 4. archive (0025) and a store at 0024
// =============================================================================
console.log("— archive (migration 0025) and a store without it");

await t("a store at 0024 (no archived_at) lists and deletes as before, and archive is refused in plain words; after 0025 an archived file is hidden from listMedia and still served at /api/media/<id>", async () => {
  const cols = async () => (await sql(old24, "PRAGMA table_info(media)")).map((c) => c.name);
  ok(!(await cols()).includes("archived_at"), "no column at 0024");
  const a = await upload(old24);
  const b = await upload(old24);
  const listed = await old24.run(() => M.listMedia());
  eq(listed.map((m) => m.id).sort(), [a.id, b.id].sort(), "lists:");
  ok(listed.every((m) => !("archived_at" in m)), "the same row shape as before");
  for (const archived of [true, false]) {
    const e = await old24.run(() => (archived ? M.archiveMedia(a.id) : M.unarchiveMedia(a.id)).then(() => null, (x) => x));
    eq([e?.code, e?.status], ["MEDIA_ARCHIVE_UNAVAILABLE", 409], `archive ${archived}:`);
    eq(e.message, M.ARCHIVE_UNAVAILABLE_MESSAGE, "plain words:");
    ok(!/archived_at|column|0025|migration/i.test(e.message), e.message);
  }
  eq((await old24.run(() => M.deleteMedia(b.id))).deleted, b.id, "deletes:");
  eq(await stored(old24, b.id), 0, "gone:");
  // a dedupe upload of a file still works without the column
  eq((await old24.run(() => M.saveMedia({ filename: "again.png", mime: "image/png", bytes: PNG(Number(a.filename.replace(/\D/g, ""))) }))).id, a.id, "dedupe:");

  await old24.migrateTo("latest");
  ok((await cols()).includes("archived_at"), "column after 0025");
  const ar = await old24.run(() => M.archiveMedia(a.id));
  ok(ar.archived_at, "archived");
  eq((await old24.run(() => M.listMedia())).map((m) => m.id), [], "hidden from the library:");
  eq((await old24.run(() => M.listMedia({ includeArchived: true }))).map((m) => [m.id, !!m.archived_at]), [[a.id, true]], "listed when asked:");
  const file = await old24.run(() => M.getMediaFile(a.id));
  ok(file && file.data.length === 16, "getMediaFile still reads it");
  // the public route, through the real tenantHandler and the store's host
  const route = await import("../app/api/media/[id]/route.js");
  const res = await route.GET({ headers: { get: (k) => (k.toLowerCase() === "host" ? "mrold24.test" : null) }, url: `https://mrold24.test/api/media/${a.id}` }, { params: Promise.resolve({ id: a.id }) });
  eq(res.status, 200, "served:");
  eq(new Uint8Array(await res.arrayBuffer()).length, 16, "the bytes:");
  // archive changes nothing a delete checks, and unarchive brings it back
  await old24.run(() => M.unarchiveMedia(a.id));
  eq((await old24.run(() => M.listMedia())).map((m) => m.id), [a.id], "back:");
  // an upload that dedupes onto an archived file brings it back too
  await old24.run(() => M.archiveMedia(a.id));
  await old24.run(() => M.saveMedia({ filename: "again.png", mime: "image/png", bytes: PNG(Number(a.filename.replace(/\D/g, ""))) }));
  eq((await old24.run(() => M.listMedia())).map((m) => m.id), [a.id], "a re-upload unarchives:");
  eq(await old24.run(() => codeOf(M.archiveMedia("med_000000000000000000"))), "MEDIA_NOT_FOUND", "a missing file:");
});

await t("P4-FIX2: bytes that match an archived file bring it back on purpose and say so (unarchived: true); the file handed back is never still archived; a plain dedupe says unarchived: false; the upload route passes it on", async () => {
  const n = pngN++;
  const a = await docs.run(() => M.saveMedia({ filename: `fix2-${n}.png`, mime: "image/png", bytes: PNG(n) }));
  eq([a.deduped, a.unarchived], [false, undefined], "a new file:");
  await docs.run(() => M.archiveMedia(a.id));
  const archivedRow = async () => (await sql(docs, "SELECT archived_at FROM media WHERE id = ?", [a.id]))[0].archived_at;
  ok((await archivedRow()) != null, "archived");
  const again = await docs.run(() => M.saveMedia({ filename: "same-bytes.png", mime: "image/png", bytes: PNG(n) }));
  eq([again.id, again.deduped, again.unarchived], [a.id, true, true], "the same file, brought back and said:");
  eq(await archivedRow(), null, "not archived any more:");
  ok((await docs.run(() => M.listMedia())).some((m) => m.id === a.id), "back in the picker's list");
  const third = await docs.run(() => M.saveMedia({ filename: "same-bytes.png", mime: "image/png", bytes: PNG(n) }));
  eq([third.id, third.deduped, third.unarchived], [a.id, true, false], "a plain dedupe:");
  // the upload route answers shape(original) = { ...saveMedia's row, url }, so
  // the flag reaches the media screen and the picker
  const routeSrc = await readFile(join(ROOT, "app/api/admin/media/route.js"), "utf8");
  ok(/const shape = \(m\) => \(\{ \.\.\.m, url: mediaUrl\(m\.id\) \}\)/.test(routeSrc) && /media: shape\(original\)/.test(routeSrc), "the route passes saveMedia's answer through");
});

// =============================================================================
// 5. the reindex
// =============================================================================
console.log("— the reindex (reindexTenant and pnpm media:reindex)");

const dumpRefs = async (fx) => sql(fx, "SELECT version_id, ref_type, ref_id FROM document_refs ORDER BY version_id, ref_type, ref_id");
const runCli = (args) =>
  spawnSync(process.execPath, ["scripts/reindex-document-refs.js", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, PLATFORM_DB_URL: process.env.PLATFORM_DB_URL, PLATFORM_DB_TOKEN: "", PLATFORM_SECRET: process.env.PLATFORM_SECRET },
  });

await t("reindex-document-refs: --dry-run writes nothing; a run rewrites src-form media rows and adds the missing ones; run twice gives identical rows", async () => {
  const a = await upload(cli);
  const b = await upload(cli);
  const d = (await cli.run(() => Docs.createDocument({ type: "page", meta: { slug: "re", title: "Re" }, body: pageBody("re", [imageText("sec_r1", M.mediaUrl(a.id)), sec("rich_text", "sec_r2", { html: `<p><img src="https://x.example${M.mediaUrl(b.id)}?w=2"></p>` })]), actor: ACTOR }))).document;
  const v = (await sql(cli, "SELECT id FROM document_versions WHERE document_id = ?", [d.id]))[0].id;
  // what the old code stored: the src, and nothing from text
  await raw(cli).execute({ sql: "DELETE FROM document_refs WHERE version_id = ?", args: [v] });
  await raw(cli).execute({ sql: "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES (?, 'media', ?)", args: [v, M.mediaUrl(a.id)] });
  await raw(cli).execute({
    sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES ('rel_cliold', ?, 'h', '', NULL, '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')",
    args: [JSON.stringify({ v: 1, hero: M.mediaUrl(b.id) })],
  });
  const before = await dumpRefs(cli);
  const dry = runCli(["--tenant", "mrcli", "--releases", "--dry-run"]);
  eq(dry.status, 0, `dry run: ${dry.stderr}${dry.stdout}`);
  ok(/dry run, nothing written/.test(dry.stdout), dry.stdout);
  const dryRep = JSON.parse(dry.stdout.trim().split("\n").pop());
  ok(dryRep.rewritten === 1 && dryRep.added >= 3, `dry report: ${JSON.stringify(dryRep)}`);
  eq(await dumpRefs(cli), before, "dry run wrote nothing:");

  const one = runCli(["--tenant", "mrcli", "--releases"]);
  eq(one.status, 0, `run: ${one.stderr}${one.stdout}`);
  const rows1 = await dumpRefs(cli);
  ok(!rows1.some((r) => r.ref_type === "media" && r.ref_id.includes("/")), "no src-form rows left");
  eq(rows1.filter((r) => r.version_id === v && r.ref_type === "media").map((r) => r.ref_id).sort(), [a.id, b.id].sort(), "the version's media rows by id:");
  ok(rows1.some((r) => r.version_id === "release:rel_cliold" && r.ref_id === b.id), "the release row");
  const two = runCli(["--tenant", "mrcli", "--releases"]);
  eq(two.status, 0, `second run: ${two.stderr}`);
  const rep2 = JSON.parse(two.stdout.trim().split("\n").pop());
  eq([rep2.added, rep2.rewritten], [0, 0], "second run adds nothing:");
  eq(await dumpRefs(cli), rows1, "identical rows:");
  // reindexTenant itself, twice, the same
  const c = cli.client();
  try {
    await Refs.reindexTenant(c, { releases: true });
    await Refs.reindexTenant(c, { releases: true });
  } finally {
    c.close();
  }
  eq(await dumpRefs(cli), rows1, "reindexTenant twice, identical rows:");
  ok(!/token|secret/i.test(one.stdout + one.stderr), "prints no secrets");
});

await t("reindex-document-refs refuses a libsql:// store without --hosted --confirm <id> (and a wrong confirm), and --hosted on a local store; no --tenant is a usage error", async () => {
  await plat.control.upsertTenant({ id: "mrremote", name: "Remote", domains: ["mrremote.test"], dbUrl: "libsql://mr-remote.example.invalid", config: {}, secrets: {} });
  for (const args of [["--tenant", "mrremote"], ["--tenant", "mrremote", "--hosted"], ["--tenant", "mrremote", "--confirm", "mrremote"], ["--tenant", "mrremote", "--hosted", "--confirm", "someone-else"]]) {
    const r = runCli(args);
    eq(r.status, 1, `${args.join(" ")} exit:`);
    ok(/refusing: "mrremote" is not a local database/.test(r.stderr), `${args.join(" ")}: ${r.stderr}`);
    ok(!/mr-remote\.example/.test(r.stdout + r.stderr), "never prints the address");
  }
  const local = runCli(["--tenant", "mrcli", "--hosted", "--confirm", "mrcli"]);
  eq(local.status, 1, "--hosted on a local store:");
  const none = runCli([]);
  eq(none.status, 1, "no tenant:");
  ok(/Usage/.test(none.stderr), none.stderr);
  const gone = runCli(["--tenant", "nobody"]);
  eq(gone.status, 1, "unknown store:");
});

await t("the console route /api/admin/media: PATCH {archived} archives and brings back, GET hides archived unless ?archived=include, a store at 0024 gets 409 in plain words, a moving store's DELETE gets 409 STORE_MIGRATING", async () => {
  const I = await import("../lib/platform/identity.js");
  const Sess = await import("../lib/platform/sessions.js");
  const route = await import("../app/api/admin/media/route.js");
  const at24 = await F.makeTenant({ name: "mr-at24", id: "mrat24", stage: "0024", config: CONFIG });
  const u = await I.createUser({ email: "owner@mr.test", name: "Owner", password: "mr-owner-pass-1" });
  for (const id of ["mrold24", "mrmoving", "mrat24"]) await I.addMembership(u.id, id, "owner");
  const tok = (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
  const req = (tenantId, body, path = "/api/admin/media") => ({
    cookies: { get: (n) => (n === "_admin" ? { value: tok } : undefined) },
    headers: { get: (k) => ({ host: `${tenantId}.test` })[k.toLowerCase()] ?? null },
    url: `https://${tenantId}.test${path}`,
    nextUrl: { pathname: path.split("?")[0] },
    json: async () => body,
  });
  const call = async (fn, r) => {
    const res = await fn(r, {});
    return { status: res.status, body: await res.json() };
  };
  try {
    const f = await upload(old24);
    let r = await call(route.PATCH, req("mrold24", { id: f.id, archived: true }));
    eq([r.status, r.body.ok, !!r.body.archived_at], [200, true, true], `archive: ${JSON.stringify(r.body)}`);
    r = await call(route.GET, req("mrold24", null));
    ok(!r.body.media.some((m) => m.id === f.id), "hidden from GET");
    r = await call(route.GET, req("mrold24", null, "/api/admin/media?archived=include"));
    ok(r.body.media.some((m) => m.id === f.id && m.archived_at), "listed with ?archived=include");
    r = await call(route.PATCH, req("mrold24", { id: f.id, archived: false }));
    eq([r.status, r.body.archived_at], [200, null], "brought back:");
    r = await call(route.PATCH, req("mrold24", { id: "med_000000000000000001", archived: true }));
    eq([r.status, r.body.code], [404, "MEDIA_NOT_FOUND"], "missing:");
    const g = await upload(at24);
    r = await call(route.PATCH, req("mrat24", { id: g.id, archived: true }));
    eq([r.status, r.body.code, r.body.error], [409, "MEDIA_ARCHIVE_UNAVAILABLE", M.ARCHIVE_UNAVAILABLE_MESSAGE], "0024:");
    r = await call(route.PATCH, req("mrat24", { id: g.id, alt: "still edits alt" }));
    eq(r.status, 200, "alt still saves at 0024:");
    const h = await upload(moving);
    r = await call(route.DELETE, req("mrmoving", { id: h.id, force: true }));
    eq([r.status, r.body.code, r.body.error], [409, "STORE_MIGRATING", M.MIGRATING_MESSAGE], "moving:");
    eq(await stored(moving, h.id), 1, "kept:");
  } finally {
    await at24.cleanup();
  }
});

// ---- done --------------------------------------------------------------------------------
for (const c of raws.values()) c.close();
for (const fx of [docs, legacy, moving, old24, cli]) await fx.cleanup();
await plat.cleanup();
await F.removeFixtureFiles("mr");
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
