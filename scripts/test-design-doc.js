// P3-DESIGN (TOK-03): the design document (doc_design) in documents mode.
// Run for real: real tenant databases with every migration, the real console
// routes with real sessions, the real publish and Undo, storage re-read after
// every write or refusal.
//
//   1. kit apply: a doc_design DRAFT through the documents service, live and
//      the control-plane config untouched; legacy as before; migrating refuses
//   2. the brand API: save and reset refuse, sending the founder to the editor
//   3. two admins saving doc_design at once (the design form's saveDraft and
//      kit apply): one success, one 409 with the current document
//   4. listChanges for doc_design: the token rows and, under each, the live
//      sections that use that token group (lib/registry/token-usage.js)
//   5. theme_pin: a design publish and a design Undo write it (after-commit);
//      a failing pin write leaves the publish answer as it was
//   6. readers: onboarding, Help, the agency kit export and brand readability
//      read the LIVE doc_design; the operator screens read theme_pin
//   7. kits that leave an unpublishable draft say so, naming what to fix
//   8. the guard: no config.brand / config.theme read outside the allowlist
//
//   pnpm test:design-doc
import { readFile, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

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
process.env.DATABASE_URL = "file:.test-design-doc-default.db";
process.env.PLATFORM_DB_URL = "file:.test-design-doc-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.PLATFORM_ADMIN_PASSWORD = "design-doc-operator-pass";

const dbs = [".test-design-doc-default.db", ".test-design-doc-platform.db", ".test-design-doc-docs.db", ".test-design-doc-legacy.db"];
const cleanup = async () => {
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
};
await cleanup();

const started = Date.now();
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const A = await import("../lib/platform/agency.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const K = await import("../lib/themes/kits.js");
const Docs = await import("../lib/documents/service.js");
const After = await import("../lib/documents/after-commit.js");
const Ch = await import("../lib/documents/changes.js");
const TU = await import("../lib/registry/token-usage.js");
const R = await import("../lib/registry/index.js");
const B = await import("../lib/brand.js");
const BR = await import("../lib/admin/brand-readability.js");
const ON = await import("../lib/admin/onboarding.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const { DOCUMENTS_MESSAGE } = await import("../lib/cms-mode.js");
const { platformSessionToken } = await import("../lib/platform/admin-auth.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 3).join("\n   ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- stores and people ------------------------------------------------------------------
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");
const raw = {};
for (const [key, file] of [["docs", ".test-design-doc-docs.db"], ["legacy", ".test-design-doc-legacy.db"]]) {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS);
  raw[key] = c;
}
await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
// Both stores carry an OLD control-plane brand and pin (purple, pulse): on the
// documents store nothing may read them.
const STALE = { brand: { accent: "#7c3aed" }, theme: { kit: "pulse", version: 1, applied_at: "2026-01-01T00:00:00.000Z" } };
await C.upsertTenant({ id: "dd", name: "Design Docs", domains: ["dd.test"], dbUrl: "file:.test-design-doc-docs.db", config: { ...STALE, site: { name: "Design Docs" } }, secrets: {} });
await C.upsertTenant({ id: "dl", name: "Design Legacy", domains: ["dl.test"], dbUrl: "file:.test-design-doc-legacy.db", config: { ...STALE, site: { name: "Design Legacy" } }, secrets: {} });
const tenant = async (id) => C.getTenant(id);
const inD = async (fn) => withTenant(await tenant("dd"), fn);
const inL = async (fn) => withTenant(await tenant("dl"), fn);
const sql = async (store, q, args = []) => (await raw[store].execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const cfgOf = async (id) => JSON.parse(String((await C.platformDb().execute({ sql: "SELECT config FROM tenants WHERE id = ?", args: [id] })).rows[0].config));

const ownerU = await I.createUser({ email: "owner@dd.test", name: "Asha Rao", password: "owner-pass-design" });
const adminU = await I.createUser({ email: "admin@dd.test", name: "Meera Admin", password: "admin-pass-design" });
for (const tid of ["dd", "dl"]) {
  await I.addMembership(ownerU.id, tid, "owner");
  await I.addMembership(adminU.id, tid, "admin");
}
const tok = async (u) => (await S.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const ADMIN = await tok(adminU);

const reqFor = (host, body, { cookie = OWNER, cookies = {} } = {}) => {
  const url = new URL(`http://${host}/api/x`);
  const jar = { _admin: cookie, ...cookies };
  return {
    url: url.href,
    nextUrl: url,
    cookies: { get: (n) => (jar[n] != null ? { name: n, value: jar[n] } : undefined) },
    headers: { get: (k) => ({ host })[k.toLowerCase()] ?? null },
    json: async () => body,
  };
};
const hostOf = (store) => (store === "docs" ? "dd.test" : "dl.test");
async function route(store, path, method, body, opts = {}) {
  const mod = await import(`../app/api/${path}/route.js`);
  const res = await mod[method](reqFor(hostOf(store), body, opts), { params: Promise.resolve(opts.params || {}) });
  return { status: res.status, body: await res.json() };
}
const api = (body, { as = OWNER } = {}) => inD(() => handleDocumentsPut(reqFor("dd.test", body, { cookie: as })));
async function platformGet(path, params = {}) {
  const mod = await import(`../app/api/platform/${path}/route.js`);
  const tokv = await platformSessionToken();
  const res = await mod.GET({ cookies: { get: (n) => (n === "_platform" ? { value: tokv } : undefined) }, headers: { get: () => null }, nextUrl: new URL("http://ops.test/x") }, { params: Promise.resolve(params) });
  return { status: res.status, body: await res.json() };
}

async function logsOf(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => {
    const s = a.join(" ");
    try {
      lines.push(JSON.parse(s));
    } catch {
      orig(...a);
    }
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

const body = (type, { settings, sections, meta } = {}) => {
  const b = R.emptyBody(type);
  if (settings) b.settings = { ...(b.settings || {}), ...settings };
  if (sections) b.sections = sections;
  if (meta) b.meta = { ...b.meta, ...meta };
  return b;
};
const sec = (kind, id, settings = {}, extra = {}) => {
  const s = R.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings }, ...extra };
};
const doc = (id) => inD(() => Docs.getDocument(id));
async function publishOne(id, { as = OWNER } = {}) {
  const d = await doc(id);
  return api({ publish: { id, draftHash: d.draftHash }, revision: d.revision }, { as });
}
async function saveDesign(mutate, { as = OWNER, revision } = {}) {
  const d = await doc("doc_design");
  const next = structuredClone(d.body);
  mutate(next);
  return api({ saveDraft: { id: "doc_design", body: next }, revision: revision ?? d.revision }, { as });
}
const liveOf = async () => (await sql("docs", "SELECT live_release_id AS live FROM release_state WHERE id = 1"))[0].live;
const designRow = async () => (await sql("docs", "SELECT revision, draft, published_version_id, published_hash FROM documents WHERE id = 'doc_design'"))[0] || null;

// The live store: a home page (hero, banner, a HIDDEN faq, text), an about
// page (text) and the announcement bar on. Published before any design work.
await inD(async () => {
  await Docs.createDocument({
    type: "home",
    body: body("home", {
      sections: [
        sec("hero", "sec_hero", { title: "Welcome" }),
        sec("banner", "sec_banner", { title: "Sale", text: "Ten percent off" }),
        sec("faq", "sec_faq", { title: "Questions", items: [{ q: "Q?", a: "A." }] }, { enabled: false }),
        sec("text", "sec_text", { title: "Our story", body: ["We make things."] }),
      ],
    }),
  });
  await Docs.createDocument({ type: "page", body: body("page", { meta: { slug: "about", title: "About us" }, sections: [sec("text", "sec_about", { title: "About", body: ["Hello."] })] }) });
  await Docs.createDocument({ type: "announcement", body: body("announcement", { settings: { enabled: true, text: "Free shipping" } }) });
});
{
  const docsNow = await sql("docs", "SELECT id, revision, draft_hash FROM documents WHERE id IN ('doc_home', 'doc_announcement') OR type = 'page' ORDER BY id");
  const r = await api({ publishSet: docsNow.map((d) => ({ id: d.id, revision: Number(d.revision), draftHash: String(d.draft_hash) })) });
  if (r.status !== 200) throw new Error(`seed publish: ${JSON.stringify(r.body).slice(0, 400)}`);
}

// ======================================================================================
console.log("— 1. kit apply");

await t("unit: applyKit on a documents store writes the doc_design draft only: live, the published design and the config are unchanged; the hero preset is a doc_home draft", async () => {
  const cfg = await cfgOf("dd");
  const live = await liveOf();
  const releases = await sql("docs", "SELECT count(*) AS n FROM releases");
  const homeLive = (await sql("docs", "SELECT published_version_id, published_hash FROM documents WHERE id = 'doc_home'"))[0];
  eq(await designRow(), null, "no design document yet:");
  const r = await route("docs", "admin/theme", "POST", { action: "apply", kit: "glow" });
  eq(r.status, 200, `apply: ${JSON.stringify(r.body).slice(0, 300)}`);
  eq([r.body.applied.theme.kit, r.body.applied.presets, r.body.theme.kit, r.body.design.id], ["glow", ["hero"], "glow", "doc_design"], "answer:");
  const d = await designRow();
  const draft = JSON.parse(String(d.draft));
  eq([draft.settings.theme.kit, draft.settings.theme.version, draft.settings.brand.accent], ["glow", 1, K.KITS.glow.brand.accent], "the doc_design draft:");
  eq([d.published_version_id, d.published_hash], [null, null], "the design is not published:");
  eq(await liveOf(), live, "the live pointer:");
  eq(await sql("docs", "SELECT count(*) AS n FROM releases"), releases, "no release:");
  eq((await sql("docs", "SELECT published_version_id, published_hash FROM documents WHERE id = 'doc_home'"))[0], homeLive, "the live home:");
  const home = JSON.parse(String((await sql("docs", "SELECT draft FROM documents WHERE id = 'doc_home'"))[0].draft));
  eq(home.sections.find((s) => s.kind === "hero").settings.title, K.KITS.glow.presets.hero.title, "the hero preset is a home DRAFT:");
  eq(await cfgOf("dd"), cfg, "control-plane config (brand, theme) untouched:");
  eq(await sql("docs", "SELECT count(*) AS n FROM cms_blocks"), [{ n: 0 }], "no legacy block:");
  // GET answers the draft's look and its revision, with the editor's address
  const g = await route("docs", "admin/theme", "GET", null);
  eq([g.status, g.body.theme.kit, g.body.design.revision, g.body.design.editor], [200, "glow", Number(d.revision), "/admin/editor?doc=doc_design"], "GET:");
  // withBrand false keeps the draft's brand; a second apply is a new revision
  const keep = await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", withBrand: false, withPresets: false });
  eq(keep.status, 200, `apply without brand: ${JSON.stringify(keep.body).slice(0, 200)}`);
  const d2 = JSON.parse(String((await designRow()).draft));
  eq([d2.settings.theme.kit, d2.settings.brand.accent], ["pulse", K.KITS.glow.brand.accent], "look changed, brand kept:");
});

// P3-FIX4: the design draft saved, then the hero preset failed with something
// other than a race (a database error): the answer says the design was saved
// and the hero look was not, never "nothing was saved".
await t("P3-FIX4 unit: a kit apply whose design saved but whose hero write failed says the design was saved and the hero look was not", async () => {
  const before = await designRow();
  const homeBefore = (await sql("docs", "SELECT revision, draft FROM documents WHERE id = 'doc_home'"))[0];
  await raw.docs.execute("CREATE TRIGGER fix4_home_fails BEFORE UPDATE ON documents WHEN NEW.id = 'doc_home' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
  let r;
  try {
    r = await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", withBrand: false });
  } finally {
    await raw.docs.execute("DROP TRIGGER fix4_home_fails");
  }
  const after = await designRow();
  ok(Number(after.revision) === Number(before.revision) + 1 && JSON.parse(String(after.draft)).settings.theme.kit === "pulse", "setup: the design draft was saved");
  eq((await sql("docs", "SELECT revision, draft FROM documents WHERE id = 'doc_home'"))[0], homeBefore, "the hero was not written:");
  const words = String(r.body.note || r.body.error || "");
  ok(!/nothing was saved/i.test(JSON.stringify(r.body)), `says nothing was saved: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(/saved/i.test(words) && /hero/i.test(words) && /wasn't|couldn't|not/i.test(words), `says the design was saved and the hero was not: ${words}`);
  eq([r.status, r.body.ok, r.body.applied?.presets, r.body.applied?.document?.revision, r.body.design?.revision], [200, true, [], Number(after.revision), Number(after.revision)], `the answer: ${JSON.stringify(r.body).slice(0, 300)}`);
});

await t("unit: applyKit on legacy behaves as before (config pin and brand, the hero as a legacy draft); a migrating store refuses and writes nothing", async () => {
  const r = await route("legacy", "admin/theme", "POST", { action: "apply", kit: "glow" });
  eq([r.status, r.body.theme.kit, r.body.applied.presets], [200, "glow", ["hero"]], `legacy apply: ${JSON.stringify(r.body).slice(0, 200)}`);
  const cfg = await cfgOf("dl");
  eq([cfg.theme.kit, cfg.brand.accent], ["glow", K.KITS.glow.brand.accent], "legacy config:");
  eq((await sql("legacy", "SELECT count(*) AS n FROM cms_blocks WHERE key = 'hero'"))[0].n, 1, "legacy hero block:");
  eq((await sql("legacy", "SELECT count(*) AS n FROM documents")), [{ n: 0 }], "no document on legacy:");
  const g = await route("legacy", "admin/theme", "GET", null);
  eq([g.body.theme.kit, g.body.design], ["glow", undefined], "legacy GET:");
  // migrating
  await raw.docs.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  try {
    const before = await designRow();
    const m = await route("docs", "admin/theme", "POST", { action: "apply", kit: "glow" });
    eq([m.status, m.body.code], [409, "STORE_USES_DOCUMENTS"], "migrating:");
    eq(await designRow(), before, "nothing written:");
  } finally {
    await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  }
});

// ======================================================================================
console.log("— 2. the brand API");

await t("unit: the brand API on a documents store refuses save and reset with the documents message and the editor's address; GET reads the design draft; preview stays open", async () => {
  const before = await designRow();
  const cfg = await cfgOf("dd");
  for (const b of [{ brand: { accent: "#0f766e" } }, { reset: true }]) {
    const r = await route("docs", "admin/brand", "PUT", b);
    eq([r.status, r.body.code, r.body.editor], [409, "STORE_USES_DOCUMENTS", "/admin/editor?doc=doc_design"], `${JSON.stringify(b)}:`);
    ok(r.body.error.startsWith(DOCUMENTS_MESSAGE) && /editor/.test(r.body.error) && /nothing was saved/.test(r.body.error), `words: ${r.body.error}`);
  }
  eq(await designRow(), before, "design untouched:");
  eq(await cfgOf("dd"), cfg, "config untouched:");
  const g = await route("docs", "admin/brand", "GET", null);
  eq([g.status, g.body.documents, g.body.brand.accent, g.body.editor], [200, true, K.KITS.glow.brand.accent, "/admin/editor?doc=doc_design"], "GET reads the doc_design draft, not config.brand:");
  const p = await route("docs", "admin/brand", "PUT", { preview: { accent: "#0f766e" } });
  eq([p.status, p.body.ok], [200, true], "preview:");
  // legacy GET is unchanged
  const lg = await route("legacy", "admin/brand", "GET", null);
  eq([lg.body.brand.accent, lg.body.documents], [K.KITS.glow.brand.accent, undefined], "legacy GET:");
});

// ======================================================================================
console.log("— 3. two admins");

await t("unit: two admins saving doc_design at once (the design form's save and kit apply, both from revision N) give one success and one 409 with the current document, in either order", async () => {
  for (const order of ["form first", "kit first"]) {
    const d = await doc("doc_design");
    const N = d.revision;
    const form = () => saveDesign((b) => (b.settings.brand = { ...b.settings.brand, accent: "#0f766e" }), { as: OWNER, revision: N });
    const kitApply = () => route("docs", "admin/theme", "POST", { action: "apply", kit: "glow", withPresets: false, revision: N }, { cookie: ADMIN });
    const [a, b] = order === "form first" ? await Promise.all([form(), kitApply()]) : await Promise.all([kitApply(), form()]);
    const answers = [a, b];
    const won = answers.filter((x) => x.status === 200);
    const lost = answers.filter((x) => x.status === 409);
    eq([won.length, lost.length], [1, 1], `${order}: ${answers.map((x) => `${x.status} ${x.body.code || ""}`).join(", ")}`);
    eq(lost[0].body.code, "DOCUMENT_CHANGED", `${order} code:`);
    ok(lost[0].body.current && lost[0].body.current.id === "doc_design" && lost[0].body.current.revision === N + 1, `${order} current: ${JSON.stringify(lost[0].body.current).slice(0, 160)}`);
    ok(typeof lost[0].body.current.updatedByName === "string" && lost[0].body.current.updatedByName.length > 0, `${order} names who saved:`);
    eq((await doc("doc_design")).revision, N + 1, `${order}: exactly one write:`);
  }
  // a stale revision on its own is the same 409, nothing written
  const d = await doc("doc_design");
  const stale = await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", revision: d.revision - 1 });
  eq([stale.status, stale.body.code, stale.body.current?.revision], [409, "DOCUMENT_CHANGED", d.revision], "stale revision:");
  eq((await doc("doc_design")).revision, d.revision, "nothing written:");
});

// ======================================================================================
console.log("— 4. the design change list");

await t("unit: every registered section kind has a token-usage entry; groupsOfRow and affectsWords say it in plain words", async () => {
  const missing = R.sectionKinds().filter((k) => !TU.SECTION_TOKENS[k]);
  eq(missing, [], "section kinds without an entry:");
  for (const [k, groups] of Object.entries(TU.SECTION_TOKENS)) ok(R.sectionType(k) && groups.every((g) => TU.TOKEN_GROUPS.includes(g)), `${k}: ${groups}`);
  eq(TU.groupsOfRow("Colours: accent changed"), ["colours"], "colours:");
  eq(TU.groupsOfRow("Look: a different look chosen"), ["look"], "look:");
  eq(TU.groupsOfRow("Brand: other settings changed"), TU.TOKEN_GROUPS, "anything else is every group:");
  const live = { chrome: ["header", "footer"], pages: [{ label: "Home page", sections: [{ kind: "hero", label: "Hero" }, { kind: "text", label: "Text" }, { kind: "text", label: "Text" }] }] };
  eq(TU.affectsWords(["spacing"], live), [{ words: "Home page: Text" }], "spacing skips the hero and the chrome:");
  eq(TU.affectsWords(["look"], live), [{ words: "Every page: header" }, { words: "Home page: Hero" }], "look:");
  const many = { chrome: [], pages: Array.from({ length: 9 }, (_, i) => ({ label: `P${i}`, sections: [{ kind: "text", label: "Text" }] })) };
  const w = TU.affectsWords(["colours"], many);
  eq([w.length, w[w.length - 1].words], [TU.AFFECTS_PAGE_CAP + 1, "and 3 more pages"], "capped:");
  eq(TU.affectsWords([], live), [], "no group, no rows:");
});

// P3-FIX4: the design panel's 'affects' rows never name an offline page or a
// turned-off announcement bar (the DESIGN reviewer's two surviving edits).
await t("P3-FIX4 unit: liveParts and the affects rows never name an offline page or a turned-off announcement bar", async () => {
  const [about] = await sql("docs", "SELECT id FROM documents WHERE type = 'page' AND slug = 'about'");
  const before = await inD(() => Ch.liveParts());
  const brand0 = structuredClone((await doc("doc_design")).body.settings.brand);
  ok(before.chrome.includes("announcement") && before.pages.some((p) => p.label === "About us"), `setup: ${JSON.stringify(before)}`);
  // take About offline, and turn the bar off and publish it
  const a = await doc(about.id);
  const off = await api({ unpublish: { id: about.id }, revision: a.revision });
  eq(off.status, 200, `take offline: ${JSON.stringify(off.body).slice(0, 200)}`);
  const bar = await doc("doc_announcement");
  eq((await api({ saveDraft: { id: "doc_announcement", body: { ...bar.body, settings: { ...bar.body.settings, enabled: false } } }, revision: bar.revision })).status, 200, "bar off:");
  eq((await publishOne("doc_announcement")).status, 200, "publish the bar off:");
  try {
    const live = await inD(() => Ch.liveParts());
    eq(live.chrome, ["header", "footer"], "the hidden bar is not chrome:");
    ok(!live.pages.some((p) => p.label === "About us"), `the offline page is listed: ${JSON.stringify(live.pages.map((p) => p.label))}`);
    ok(live.pages.some((p) => p.label === "Home page"), "the live home page is");
    // and through the design panel's rows: a colours change touches every part
    eq((await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, accent: "#9333ea" }))).status, 200, "save colours:");
    const rows = (await api({ listChanges: "doc_design" })).body.rows;
    const colours = rows.find((r) => r.words.startsWith("Colours:"));
    eq(colours?.affects, [{ words: "Every page: header and footer" }, { words: "Home page: Hero, Banner and Text" }], `the colours row: ${JSON.stringify(rows)}`);
  } finally {
    // put everything back: the design draft, the bar and About
    await saveDesign((b) => (b.settings.brand = brand0));
    const bar2 = await doc("doc_announcement");
    await api({ saveDraft: { id: "doc_announcement", body: { ...bar2.body, settings: { ...bar2.body.settings, enabled: true } } }, revision: bar2.revision });
    eq((await publishOne("doc_announcement")).status, 200, "bar on again:");
    const a2 = await doc(about.id);
    const back = await api({ publish: { id: about.id, draftHash: a2.draftHash, confirmRepublish: true }, revision: a2.revision });
    eq(back.status, 200, `About back online: ${JSON.stringify(back.body).slice(0, 200)}`);
  }
  const after = await inD(() => Ch.liveParts());
  eq(after, before, "restored:");
  eq((await doc("doc_design")).body.settings.brand, brand0, "the design draft is as it was:");
});

await t("unit: listChanges for doc_design lists the changed token rows and, under each, the live sections that use that group, in plain words (hidden sections and drafts left out)", async () => {
  // a design never published is compared with the platform default
  const first = await api({ listChanges: "doc_design" });
  eq([first.status, first.body.firstPublish], [200, false], `never published: ${JSON.stringify(first.body).slice(0, 300)}`);
  const look = first.body.rows.find((r) => r.words.startsWith("Look:"));
  eq(look?.affects, [{ words: "Every page: header" }, { words: "Home page: Hero" }], "the look row:");
  const colours = first.body.rows.find((r) => r.words.startsWith("Colours:"));
  ok(colours, `a colours row: ${JSON.stringify(first.body.rows)}`);
  eq(colours.affects, [{ words: "Every page: header, footer and announcement bar" }, { words: "Home page: Hero, Banner and Text" }, { words: "About us: Text" }], "the colours row:");
  // publish it, then change only the spacing: one row, and the hero is not in it
  eq(first.body.neverPublished, true, "never published says so (P3-FIX4):");
  const p = await publishOne("doc_design");
  eq(p.status, 200, `publish design: ${JSON.stringify(p.body).slice(0, 200)}`);
  eq((await api({ listChanges: "doc_design" })).body.rows, [], "nothing changed:");
  // P3-FIX4: Recently published offers no Undo of the first design publish
  // (there is nothing earlier), and the editor sees neverPublished no more
  const recent = await api({ listRecentlyPublished: {} });
  const firstRow = (recent.body.groups || recent.body.rows || []).flatMap((g) => g.rows || [g]).find((r) => r.documentId === "doc_design");
  eq([recent.status, firstRow?.action, firstRow?.canUndo, firstRow?.undo], [200, "publish", false, null], `the first design publish row: ${JSON.stringify(recent.body).slice(0, 400)}`);
  await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, section_spacing: "airy" }));
  ok(!Object.hasOwn((await api({ listChanges: "doc_design" })).body, "neverPublished"), "a published design has no neverPublished");
  await saveDesign((b) => delete b.settings.brand.section_spacing);
  // a draft-only section on home must not count: it isn't live
  await inD(async () => {
    const h = await Docs.getDocument("doc_home");
    await Docs.saveDraft({ id: "doc_home", revision: h.revision, body: { ...h.body, sections: [...h.body.sections, sec("faq", "sec_draftfaq", { title: "Draft FAQ", items: [{ q: "q", a: "a" }] })] } });
  });
  const s = await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, section_spacing: "airy" }));
  eq(s.status, 200, "save spacing:");
  const rows = (await api({ listChanges: "doc_design" })).body.rows;
  eq(rows, [{ kind: "settings", words: "Spacing: space between sections changed", affects: [{ words: "Home page: Banner and Text" }, { words: "About us: Text" }] }], "spacing only:");
  // the words carry no ids, hashes or kinds
  ok(rows.every((r) => r.affects.every((a) => !/sec_|doc_|ver_|[0-9a-f]{16}/.test(a.words))), "plain words:");
  // when the live parts can't be read the row says so, the list still answers
  const [live0] = await sql("docs", "SELECT r.id AS id, r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  await raw.docs.execute({ sql: "UPDATE releases SET content = 'not a list' WHERE id = ?", args: [live0.id] });
  let broken;
  try {
    broken = await api({ listChanges: "doc_design" });
  } finally {
    await raw.docs.execute({ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [live0.content, live0.id] });
  }
  eq([broken.status, broken.body.rows.map((r) => r.affects)], [200, [[{ words: Ch.AFFECTS_UNKNOWN }]]], "unknown:");
  // put the spacing back so later tests start from the published design
  await saveDesign((b) => delete b.settings.brand.section_spacing);
});

// ======================================================================================
console.log("— 5. theme_pin");

await t("unit: a design publish and a design Undo each write theme_pin; publishing another document leaves it", async () => {
  // the design published in test 4 holds glow
  const pin1 = (await cfgOf("dd")).theme_pin;
  eq([pin1?.kit, pin1?.version], ["glow", 1], `after the design publish: ${JSON.stringify(pin1)}`);
  ok(typeof pin1.release === "string" && pin1.release === (await liveOf()), "names the release it came from:");
  // the old control-plane pin is still there and still stale: the pin is separate
  eq((await cfgOf("dd")).theme.kit, "pulse", "config.theme is not written:");
  // a new look, published
  const a = await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", withPresets: false, withBrand: false });
  eq(a.status, 200, "apply pulse:");
  const p = await publishOne("doc_design");
  eq(p.status, 200, `publish pulse: ${JSON.stringify(p.body).slice(0, 200)}`);
  eq((await cfgOf("dd")).theme_pin.kit, "pulse", "after the second publish:");
  // another document's publish: the pin stays
  await inD(async () => {
    const h = await Docs.getDocument("doc_home");
    await Docs.saveDraft({ id: "doc_home", revision: h.revision, body: h.body });
  });
  const pinBefore = (await cfgOf("dd")).theme_pin;
  eq((await publishOne("doc_home")).status, 200, "publish home:");
  eq((await cfgOf("dd")).theme_pin, pinBefore, "home publish leaves the pin:");
  // Undo the pulse publish: the pin is glow again
  const undo = p.body.items?.[0]?.undo || p.body.published?.[0]?.undo;
  ok(undo?.logId, `the publish answer offers Undo: ${JSON.stringify(p.body).slice(0, 300)}`);
  const d = await doc("doc_design");
  const u = await api({ undo: { id: "doc_design", logId: undo.logId }, revision: d.revision });
  eq(u.status, 200, `undo: ${JSON.stringify(u.body).slice(0, 300)}`);
  const pin3 = (await cfgOf("dd")).theme_pin;
  eq([pin3.kit, pin3.release], ["glow", await liveOf()], "after Undo, the live look again:");
});

await t("unit: a failing pin write does not change the publish result (logged, the old pin stays)", async () => {
  const pinBefore = (await cfgOf("dd")).theme_pin;
  await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", withPresets: false, withBrand: false });
  const d = await doc("doc_design");
  After.setThemePinWriter(async () => {
    throw new Error("control plane is down");
  });
  let r;
  let lines;
  try {
    ({ result: r, lines } = await logsOf(() => publishOne("doc_design")));
  } finally {
    After.setThemePinWriter(null);
  }
  eq(r.status, 200, `publish: ${JSON.stringify(r.body).slice(0, 300)}`);
  const item = (r.body.items || r.body.published || [])[0];
  eq([item?.id, (await doc("doc_design")).publishedVersionId === item?.versionId], ["doc_design", true], "the design went live:");
  ok(r.body.ok === true && !r.body.error && !r.body.code, `a plain success: ${JSON.stringify(r.body).slice(0, 200)}`);
  ok(lines.some((l) => l.evt === "documents_after_commit_failed" && l.handler === "themePin" && /control plane is down/.test(l.error)), `logged: ${JSON.stringify(lines.map((l) => l.evt))}`);
  eq((await cfgOf("dd")).theme_pin, pinBefore, "the old pin stays:");
  eq((await doc("doc_design")).revision, d.revision, "the publish itself writes no draft:");
  // the next publish writes it again
  await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, accent: "#0f766e" }));
  eq((await publishOne("doc_design")).status, 200, "publish again:");
  eq((await cfgOf("dd")).theme_pin.kit, "pulse", "written by the next publish:");
});

// P3-FIX4: a design with no look of its own writes theme_pin null (the DESIGN
// reviewer's `if (!pin) return;` edit must fail this).
await t("P3-FIX4 unit: a design published with settings.theme null writes theme_pin null; the next look writes it again", async () => {
  ok((await cfgOf("dd")).theme_pin?.kit, "setup: a look is pinned");
  const saved = await saveDesign((b) => (b.settings.theme = null));
  eq(saved.status, 200, `save: ${JSON.stringify(saved.body).slice(0, 200)}`);
  eq((await publishOne("doc_design")).status, 200, "publish the default look:");
  const cfg = await cfgOf("dd");
  ok(Object.hasOwn(cfg, "theme_pin") && cfg.theme_pin === null, `theme_pin is null: ${JSON.stringify(cfg.theme_pin)}`);
  eq(K.themePinOf(cfg), null, "the operator screens read the platform default, not the legacy pin:");
  eq((await C.getTenant("dd")).config.theme_pin, null, "this instance's cached tenant is refreshed:");
  // back to pulse for the tests below
  eq((await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", withPresets: false, withBrand: false })).status, 200, "apply pulse:");
  eq((await publishOne("doc_design")).status, 200, "publish pulse:");
  eq((await cfgOf("dd")).theme_pin.kit, "pulse", "pinned again:");
});

// P3-FIX4: the pin is one targeted UPDATE. A settings or secrets save that lands
// between any two control-plane statements of the publish survives. A whole-row
// read-then-write (the old patchTenant) loses the one that lands in between.
await t("P3-FIX4 unit: the theme_pin write is a targeted json_set; a settings and secrets save landing during the publish survives", async () => {
  await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, accent: "#1d4ed8" }));
  const db = C.platformDb();
  const orig = db.execute;
  const seen = [];
  let n = 0;
  let busy = false;
  db.execute = async function (q) {
    const text = typeof q === "string" ? q : q.sql;
    if (!busy && /\btenants\b/.test(text)) {
      busy = true;
      try {
        n++;
        // another admin's save of other settings and a secret, done the way the console does it
        await C.patchTenant("dd", { config: { fix4_setting: n }, secrets: { fix4_secret: `s${n}` } });
      } finally {
        busy = false;
      }
      seen.push(text);
    }
    return orig.call(this, q);
  };
  let r;
  try {
    r = await publishOne("doc_design");
  } finally {
    db.execute = orig;
  }
  eq(r.status, 200, `publish: ${JSON.stringify(r.body).slice(0, 200)}`);
  const writes = seen.filter((q) => /^\s*(UPDATE|INSERT)/i.test(q));
  ok(writes.length === 1 && /json_set\(/.test(writes[0]) && /\$\.theme_pin/.test(writes[0]) && !/secrets_enc/.test(writes[0]), `one targeted write: ${JSON.stringify(writes)}`);
  ok(n >= 2, `a save landed before and after the pin write (${n})`);
  const cfg = await cfgOf("dd");
  eq([cfg.fix4_setting, cfg.theme_pin?.kit], [n, "pulse"], "the last concurrent setting and the pin are both kept:");
  const fresh = await C.getTenant("dd", { fresh: true });
  ok(fresh.secrets.fix4_secret === `s${n}`, "the last concurrent secret is kept");
});

// P3-FIX4: a slow control plane can't fail a publish that is already live.
await t("P3-FIX4 unit: a hanging after-commit handler times out; the publish answers success and the timeout is logged", async () => {
  eq(After.AFTER_COMMIT_TIMEOUT_MS <= 5000 && After.AFTER_COMMIT_TIMEOUT_MS > 0, true, "a short default wait:");
  await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, accent: "#be123c" }));
  let release;
  After.setAfterCommitTimeout(100);
  After.setThemePinWriter(() => new Promise((resolve) => (release = setTimeout(resolve, 4000))));
  let r;
  let lines;
  const t0 = Date.now();
  try {
    ({ result: r, lines } = await logsOf(() => publishOne("doc_design")));
  } finally {
    After.setThemePinWriter(null);
    After.setAfterCommitTimeout(null);
  }
  const took = Date.now() - t0;
  clearTimeout(release);
  eq(r.status, 200, `publish: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(r.body.ok === true && !r.body.code, `a plain success: ${JSON.stringify(r.body).slice(0, 200)}`);
  ok(took < 3000, `the answer waited for the handler (${took} ms)`);
  const item = (r.body.items || r.body.published || [])[0];
  ok((await doc("doc_design")).publishedVersionId === item?.versionId, "the design is live");
  ok(lines.some((l) => l.evt === "documents_after_commit_timeout" && l.handler === "themePin" && l.ms === 100), `logged: ${JSON.stringify(lines.map((l) => l.evt))}`);
  // the next publish pins again
  await saveDesign((b) => (b.settings.brand = { ...b.settings.brand, accent: "#0f766e" }));
  eq((await publishOne("doc_design")).status, 200, "publish again:");
  eq((await cfgOf("dd")).theme_pin.kit, "pulse", "pinned by the next publish:");
});

// P3-FIX5 (FIX4 review survivors): writeThemePin's guards, each pinned.
await t("P3-FIX5 unit: writeThemePin refuses a corrupt config (writes nothing), a missing row is logged as a failure, the cache is refreshed, and a late write never replaces a newer pin", async () => {
  const pdb = C.platformDb();
  const cfgRaw = async (id) => String((await pdb.execute({ sql: "SELECT config FROM tenants WHERE id = ?", args: [id] })).rows[0].config);
  const pin = (kit, at) => ({ kit, version: 1, applied_at: null, published_at: at, release: `rel_${kit}` });
  // 1. a config that isn't valid JSON: thrown, and the row is left exactly as it was
  await C.upsertTenant({ id: "dbad", name: "Broken config", domains: ["dbad.test"], dbUrl: "file:.test-design-doc-default.db", config: {}, secrets: {} });
  await pdb.execute({ sql: "UPDATE tenants SET config = ? WHERE id = 'dbad'", args: ['{"site": {"name": "Broken"'] });
  let err = null;
  try {
    await After.writeThemePin("dbad", pin("pulse", "2026-11-04T10:00:00.000Z"));
  } catch (e) {
    err = e;
  }
  ok(err && /not valid JSON/.test(err.message), `throws on a corrupt config: ${err?.message}`);
  eq(await cfgRaw("dbad"), '{"site": {"name": "Broken"', "the corrupt config is not replaced:");
  await pdb.execute("DELETE FROM tenants WHERE id = 'dbad'");
  // 2. no row changed (a missing tenant): a failure, never theme_pin_written
  let missing = null;
  try {
    await After.writeThemePin("no_such_store", pin("pulse", "2026-11-04T10:00:00.000Z"));
  } catch (e) {
    missing = e;
  }
  ok(missing && /not found/.test(missing.message), `a missing row throws: ${missing?.message}`);
  const { lines } = await logsOf(() =>
    withTenant({ id: "no_such_store", config: {}, secrets: {} }, () => After.runAfterCommit({ build: { versions: [{ document_id: "doc_design", body: JSON.stringify({ settings: { theme: { kit: "pulse", version: 1 } } }) }], now: "2026-11-04T10:00:00.000Z", releaseId: "rel_x" }, items: [] })),
  );
  ok(lines.some((l) => l.evt === "documents_after_commit_failed" && l.handler === "themePin" && /not found/.test(l.error)), `rowsAffected 0 is logged as a failure: ${JSON.stringify(lines.map((l) => l.evt))}`);
  ok(!lines.some((l) => l.evt === "theme_pin_written"), "and never as written");
  // 3. the cache: with a 60 s tenant cache warmed, the next cached read shows the new pin
  const was = process.env.PLATFORM_CACHE_MS;
  process.env.PLATFORM_CACHE_MS = "60000";
  try {
    const cur = await cfgOf("dd");
    const stamp = new Date(Date.parse(cur.theme_pin_at || cur.theme_pin?.published_at || "2026-01-01T00:00:00.000Z") + 1000).toISOString();
    await C.getTenant("dd", { fresh: true }); // warm
    eq(await After.writeThemePin("dd", pin("glow", stamp), { at: stamp }), "written", "written:");
    eq((await C.getTenant("dd")).config.theme_pin?.kit, "glow", "this instance's cached tenant shows the new pin (getTenant fresh after the write):");
    // 4. a late write (an older build's) never replaces the newer pin
    const older = new Date(Date.parse(stamp) - 5000).toISOString();
    const { result: late, lines: lateLines } = await logsOf(() => After.writeThemePin("dd", pin("pulse", older), { at: older }));
    eq(late, "newer", "the late write answers newer:");
    eq([(await cfgOf("dd")).theme_pin.kit, (await cfgOf("dd")).theme_pin_at], ["glow", stamp], "the newer pin stays:");
    ok(lateLines.some((l) => l.evt === "theme_pin_skipped_newer"), "logged as skipped");
    // a late null pin (a design with no look) never replaces it either
    eq(await After.writeThemePin("dd", null, { at: older }), "newer", "a late null:");
    eq((await cfgOf("dd")).theme_pin.kit, "glow", "still the newer pin:");
    // the same build again (a retry) or a newer one writes
    const newer = new Date(Date.parse(stamp) + 5000).toISOString();
    eq(await After.writeThemePin("dd", pin("pulse", newer), { at: newer }), "written", "a newer write:");
    eq((await cfgOf("dd")).theme_pin.kit, "pulse", "pulse again:");
    // through the handler: a late build is not logged as written
    const lateBuild = { versions: [{ document_id: "doc_design", body: JSON.stringify({ settings: { theme: { kit: "glow", version: 1 } } }) }], now: older, releaseId: "rel_late" };
    const { lines: hl } = await logsOf(() => inD(() => After.runAfterCommit({ build: lateBuild, items: [] })));
    ok(!hl.some((l) => l.evt === "theme_pin_written") && hl.some((l) => l.evt === "theme_pin_skipped_newer"), `the handler skips a late build: ${JSON.stringify(hl.map((l) => l.evt))}`);
    eq((await cfgOf("dd")).theme_pin.kit, "pulse", "the newer pin stays after the late handler:");
  } finally {
    process.env.PLATFORM_CACHE_MS = was;
  }
  // a pin written before this item (no theme_pin_at) is ordered by its published_at
  const cfg = await cfgOf("dd");
  await C.patchTenant("dd", { config: { theme_pin_at: null, theme_pin: { ...cfg.theme_pin, published_at: "2099-01-01T00:00:00.000Z" } } });
  eq(await After.writeThemePin("dd", pin("glow", "2098-01-01T00:00:00.000Z"), { at: "2098-01-01T00:00:00.000Z" }), "newer", "an old-style pin's published_at orders it:");
  // put a current pin back for the tests below
  await C.patchTenant("dd", { config: { theme_pin_at: null, theme_pin: { ...cfg.theme_pin } } });
  await pdb.execute({ sql: "UPDATE tenants SET config = json_remove(config, '$.theme_pin_at') WHERE id = 'dd'" });
});

// P3-FIX5: the theme route records only the design's save as "the design saved".
// A failure after the hero's doc_home save must still answer with the design.
await t("P3-FIX5 unit: the theme route's partial answer names the design's save, never another document's (watchDesignSave's DESIGN_ID check)", async () => {
  const design = await designRow();
  const orig = console.log;
  let armed = 0;
  console.log = (...a) => {
    const s = a.map(String).join(" ");
    // the content_write line after doc_home's save, and slog's fallback line: fail both
    if (armed === 0 && /"evt":"content_write"/.test(s) && /"document":"doc_home"/.test(s)) {
      armed = 1;
      throw new Error("simulated failure after the hero write");
    }
    if (armed === 1) {
      armed = 2;
      throw new Error("simulated failure after the hero write (fallback)");
    }
    orig(...a);
  };
  let r;
  try {
    r = await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse", withBrand: false });
  } finally {
    console.log = orig;
  }
  eq(armed, 2, "setup: the failure happened after the doc_home save:");
  const after = await designRow();
  eq(Number(after.revision), Number(design.revision) + 1, "setup: the design saved:");
  eq([r.status, r.body.ok, r.body.heroApplied, r.body.applied?.document?.id, r.body.applied?.document?.revision], [200, true, false, "doc_design", Number(after.revision)], `the answer names the design's save: ${JSON.stringify(r.body).slice(0, 300)}`);
});

await t("unit: themePinOf reads a build's design version; a design with no look of its own pins null; kits.themePinOf falls back to the legacy pin only when no theme_pin was ever written", async () => {
  const v = (theme) => ({ versions: [{ document_id: "doc_design", body: JSON.stringify({ type: "design", settings: { brand: null, theme } }) }], now: "t", releaseId: "rel_x" });
  eq(After.themePinOf({ versions: [{ document_id: "doc_home", body: "{}" }] }), undefined, "no design in the build:");
  eq(After.themePinOf(v(null)), null, "the platform default:");
  eq(After.themePinOf(v({ kit: "glow", version: 1, applied_at: "a" })), { kit: "glow", version: 1, applied_at: "a", published_at: "t", release: "rel_x" }, "a look:");
  eq(K.themePinOf({ theme: { kit: "glow", version: 1 } }), { kit: "glow", version: 1 }, "legacy pin:");
  eq(K.themePinOf({ theme: { kit: "glow", version: 1 }, theme_pin: null }), null, "a published default wins over the legacy pin:");
  eq(K.themePinOf({ theme: { kit: "glow", version: 1 }, theme_pin: { kit: "pulse", version: 1 } }).kit, "pulse", "theme_pin wins:");
  eq(K.themePinOf(null), null, "no config:");
});

// ======================================================================================
console.log("— 6. readers");

await t("unit: onboarding, Help, the agency kit export and brand readability read the LIVE doc_design in documents mode (never config.brand / config.theme); legacy reads its config as before", async () => {
  // the live design now: pulse, accent #0f766e (test 5). The config still says
  // purple and pulse; a draft says something else again.
  await saveDesign((b) => {
    b.settings.brand = { ...b.settings.brand, accent: "#dc2626" };
    b.settings.theme = { kit: "glow", version: 1, applied_at: "2026-11-01T00:00:00.000Z" };
  });
  const live = await inD(() => BR.liveDesign());
  eq([live.brand.accent, live.theme.kit], ["#0f766e", "pulse"], "liveDesign (not the draft):");
  // onboarding: done from the live design, linking to the editor
  const ob = await inD(() => ON.buildChecklist());
  const step = ob.items.find((i) => i.id === "brand");
  eq([step.done, step.href], [true, "/admin/editor?doc=doc_design"], "onboarding:");
  // Help: the live look (the old config pin is moved to glow so the two differ)
  const cfg0 = await cfgOf("dd");
  await C.patchTenant("dd", { config: { theme: { kit: "glow", version: 1 } } });
  let h;
  try {
    h = await route("docs", "admin/help", "GET", null);
  } finally {
    await C.patchTenant("dd", { config: { theme: cfg0.theme } });
  }
  eq([h.status, h.body.diagnostics.theme], [200, "pulse@1"], "help:");
  // agency export: the live brand
  const agency = await A.createAgency({ name: "Design Studio" });
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@dd.test", role: "staff" });
  ok(await A.acceptGrant(inv.token, { tenantId: "dd", actorEmail: "owner@dd.test" }), "grant accepted");
  const kitRow = await A.exportAgencyKit({ agencyId: agency.id, tenantId: "dd", name: "From docs" });
  eq(kitRow.payload.brand?.accent, "#0f766e", "agency export:");
  // brand readability: compared with the live design (#cccccc text kept as
  // live is a warning, not a block); with no live brand it would block
  // A publish refuses unreadable grey text, so the live design that already
  // has it is set up in the live list directly (as a store that published it
  // before TOK-02 would be).
  const [rel] = await sql("docs", "SELECT r.id AS id, r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const list = JSON.parse(String(rel.content));
  const liveBody = JSON.parse(String((await sql("docs", "SELECT body FROM document_versions WHERE id = ?", [list.documents.doc_design.version]))[0].body));
  const greyBrand = { ...liveBody.settings.brand, foreground: "#cccccc" };
  const grey = { ...liveBody, settings: { ...liveBody.settings, brand: greyBrand } };
  const strict = await inD(() => BR.brandReadability(greyBrand));
  eq([strict.documents, strict.blocking], [true, true], `before: the live design has dark text, so grey text blocks: ${JSON.stringify(strict).slice(0, 200)}`);
  await raw.docs.execute({
    sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at) VALUES ('ver_greytext000000', 'doc_design', 'published', ?, 'h', 1, NULL, NULL, ?)",
    args: [JSON.stringify(grey), new Date().toISOString()],
  });
  await raw.docs.execute({ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [JSON.stringify({ ...list, documents: { ...list.documents, doc_design: { version: "ver_greytext000000", hash: "h" } } }), rel.id] });
  try {
    const rd = await inD(() => BR.brandReadability(greyBrand));
    eq([rd.documents, rd.blocking, rd.warnings.length], [true, false, 1], `readability against the live design (grey kept as live warns): ${JSON.stringify(rd).slice(0, 200)}`);
  } finally {
    await raw.docs.execute({ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [rel.content, rel.id] });
  }
  // legacy readers: their config, as before
  const lob = await inL(() => ON.buildChecklist());
  eq([lob.items.find((i) => i.id === "brand").done, lob.items.find((i) => i.id === "brand").href], [true, "/admin/theme"], "legacy onboarding:");
  const lh = await route("legacy", "admin/help", "GET", null);
  eq(lh.body.diagnostics.theme, "glow@1", "legacy help (its config pin):");
  const inv2 = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@dd.test", role: "staff" });
  await A.acceptGrant(inv2.token, { tenantId: "dl", actorEmail: "owner@dd.test" });
  eq((await A.exportAgencyKit({ agencyId: agency.id, tenantId: "dl", name: "From legacy" })).payload.brand?.accent, K.KITS.glow.brand.accent, "legacy agency export:");
});

await t("unit: onboarding on a documents store with no published design is not done, even with an old config brand", async () => {
  // a second documents store whose config has a brand and no design document
  const c = createClient({ url: "file:.test-design-doc-default.db" });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS);
  await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  await C.upsertTenant({ id: "dn", name: "Design New", domains: ["dn.test"], dbUrl: "file:.test-design-doc-default.db", config: { ...STALE }, secrets: {} });
  const ob = await withTenant(await tenant("dn"), () => ON.buildChecklist());
  const step = ob.items.find((i) => i.id === "brand");
  eq([step.done, step.href], [false, "/admin/editor?doc=doc_design"], "not done on the old config:");
  c.close();
});

// P3-FIX4: a live design version that can't be read is an error, never a quiet
// "platform default" (onboarding would mark the step not done, and brand
// readability would check against the wrong look).
await t("P3-FIX4 unit: a corrupt or missing live design version makes liveDesign and storeDesign throw, never answer the platform default", async () => {
  const good = await inD(() => BR.liveDesign());
  ok(good.versionId && good.theme?.kit, `setup: a published design: ${JSON.stringify(good).slice(0, 200)}`);
  // versions are frozen, so the live list is pointed at a broken one instead
  const [live0] = await sql("docs", "SELECT r.id AS id, r.content AS content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1");
  const pointAt = async (version) => {
    const list = JSON.parse(live0.content);
    list.documents.doc_design = { ...list.documents.doc_design, version };
    await raw.docs.execute({ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [JSON.stringify(list), live0.id] });
  };
  const failsWith = async (fn) => fn().then((v) => `no error: ${JSON.stringify(v).slice(0, 200)}`, (e) => String(e?.message || e));
  const broken = { ver_fix4badjson0: "not json", ver_fix4nullbody0: "null" };
  try {
    for (const [id, text] of Object.entries(broken)) {
      await raw.docs.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES (?, 'doc_design', 'checkpoint', ?, 'x', 1, ?)", args: [id, text, new Date().toISOString()] });
    }
    for (const id of [...Object.keys(broken), "ver_fix4missing00"]) {
      await pointAt(id);
      const said = await failsWith(() => inD(() => BR.liveDesign()));
      ok(said.includes(`the live design version ${id} couldn't be read`), `liveDesign at ${id}: ${said}`);
      const viaStore = await failsWith(() => inD(() => BR.storeDesign()));
      ok(viaStore.includes("couldn't be read"), `storeDesign at ${id}: ${viaStore}`);
    }
  } finally {
    await raw.docs.execute({ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [live0.content, live0.id] });
    for (const id of Object.keys(broken)) await raw.docs.execute({ sql: "DELETE FROM document_versions WHERE id = ?", args: [id] });
  }
  eq(await inD(() => BR.liveDesign()), good, "restored:");
});

await t("unit: the operator screens read theme_pin (overview, themes, tenant detail); a store with no pin yet shows its legacy pin", async () => {
  const cfg = await cfgOf("dd");
  eq([cfg.theme.kit, cfg.theme_pin.kit], ["pulse", "pulse"], "setup:");
  // make the two differ so the screens show which one they read
  await C.patchTenant("dd", { config: { theme_pin: { ...cfg.theme_pin, kit: "glow", version: 1 } } });
  const ov = await platformGet("overview");
  eq(ov.status, 200, `overview: ${JSON.stringify(ov.body).slice(0, 200)}`);
  eq(ov.body.fleet.find((f) => f.tenant === "dd")?.kit, "glow-1", "overview, documents store:");
  eq(ov.body.fleet.find((f) => f.tenant === "dl")?.kit, "glow-1", "overview, legacy store (its config pin):");
  const th = await platformGet("themes");
  const row = th.body.tenants.find((x) => x.id === "dd");
  eq([row.kit, row.version, row.pinned], ["glow", 1, true], "themes:");
  const det = await platformGet("tenants/[id]", { id: "dd" });
  eq([det.status, det.body.tenant.config.theme_pin?.kit, Object.hasOwn(det.body.tenant.config, "theme")], [200, "glow", false], `tenant detail: ${JSON.stringify(det.body.tenant?.config).slice(0, 200)}`);
  const src = await readFile(join(ROOT, "components/platform/TenantDetail.js"), "utf8");
  ok(/t\.config\.theme_pin/.test(src) && !/t\.config\.theme\b(?!_)/.test(src), "TenantDetail shows theme_pin:");
  // a published default look pins null: no kit on the detail, the default on the overview
  await C.patchTenant("dd", { config: { theme_pin: null } });
  eq((await platformGet("overview")).body.fleet.find((f) => f.tenant === "dd")?.kit, "pulse-1", "overview, default look:");
  eq((await platformGet("tenants/[id]", { id: "dd" })).body.tenant.config.theme_pin, null, "detail, default look:");
  await C.patchTenant("dd", { config: { theme_pin: cfg.theme_pin } });
});

// ======================================================================================
console.log("— 7. kits that leave an unpublishable draft");

await t("unit: an agency kit that leaves the home draft unpublishable says so in plain words and names what to fix; a theme kit whose draft publishes says nothing", async () => {
  const agency = await A.createAgency({ name: "Broken Kits" });
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@dd.test", role: "staff" });
  await A.acceptGrant(inv.token, { tenantId: "dd", actorEmail: "owner@dd.test" });
  await C.platformDb().execute({
    sql: "INSERT INTO agency_kits (id, agency_id, name, source_note, payload, created_at) VALUES (?, ?, ?, 'x', ?, ?)",
    args: ["akit_offsite_dd", agency.id, "offsite", JSON.stringify({ home_sections: [{ kind: "banner", title: "Sale", text: "", label: "Shop", href: "https://elsewhere.example/sale" }] }), new Date().toISOString()],
  });
  const r = await A.applyAgencyKit({ agencyId: agency.id, kitId: "akit_offsite_dd", tenantId: "dd" });
  ok(Array.isArray(r.unpublishable) && r.unpublishable[0]?.documentId === "doc_home", `unpublishable: ${JSON.stringify(r).slice(0, 300)}`);
  ok(/The home page was saved as a draft but can't be published yet\. Fix this in the editor first: Banner/.test(r.note), `the note names it: ${r.note}`);
  ok(!/sec_|doc_|LINK_NOT|incomplete/.test(r.note), `plain words: ${r.note}`);
  // a theme kit on a clean home: no unpublishable note
  await inD(async () => {
    const h = await Docs.getDocument("doc_home");
    await Docs.discardDraft({ id: "doc_home", revision: h.revision }); // back to the live home
  });
  const k = await route("docs", "admin/theme", "POST", { action: "apply", kit: "glow" });
  eq([k.status, k.body.applied.unpublishable, k.body.note], [200, undefined, undefined], `clean: ${JSON.stringify(k.body.applied).slice(0, 300)}`);
  // a theme kit whose hero preset lands in a home draft that can't publish: said
  await inD(async () => {
    const h = await Docs.getDocument("doc_home");
    await Docs.saveDraft({ id: "doc_home", revision: h.revision, body: { ...h.body, sections: [...h.body.sections, sec("banner", "sec_bad", { title: "Bad", text: "x", button: { label: "Go", link: { type: "url", href: "https://elsewhere.example/" } } })] } });
  });
  const k2 = await route("docs", "admin/theme", "POST", { action: "apply", kit: "pulse" });
  eq(k2.status, 200, "applied:");
  ok(/Your home page was saved as a draft but can't be published yet\. Fix this in the editor first: Banner/.test(k2.body.note || ""), `the theme kit says so: ${k2.body.note}`);
  eq(k2.body.applied.unpublishable?.[0]?.label, "Your home page", "named:");
  ok(K.unpublishableNote([]) === null && K.unpublishableNote([{ label: "X", problems: ["a.", "b.", "c.", "d."] }]).endsWith("(and 1 more)"), "note helper:");
});

// ======================================================================================
console.log("— 8. the guard");

// Reads of the control-plane brand and theme pin. Comments are stripped
// first; writes (patchTenant({ config: { brand } })) are not reads.
const READ_PATTERNS = [
  /\bconfig\s*\??\.\s*(brand|theme)\b(?!_)/g, // config.brand, config?.theme (not theme_pin)
  /\bconfig\s*\??\.?\s*\[\s*["'`](brand|theme)["'`]\s*\]/g, // config["brand"], config?.["theme"]
  /\b(?:tenantOwnCfg|tenantCfg|cfg)\s*\(\s*["'`](brand|theme)["'`]/g, // tenantOwnCfg("brand")
  /\{[^{}]*\b(brand|theme)\b[^{}]*\}\s*=\s*[\w.?]*\bconfig\b/g, // const { brand } = tenant.config
];
// file -> why it may read them
const ALLOW = {
  "lib/brand.js": "the brand engine itself; legacy-mode reads of the brand",
  "lib/cms/schemas.js": "legacy (v1-v3) block schemas",
  "lib/releases.js": "legacy releases snapshot config.brand and config.theme (legacy mode only)",
  "lib/content/resolve.js": "the legacy draft branch of resolvedBrand / resolvedTheme (v4 reads doc_design)",
  "lib/themes/kits.js": "legacy applyKit, and draftDesignOf / themePinOf, the one place other files read through",
  "app/api/admin/theme/route.js": "the legacy branch of the theme API",
  "app/api/admin/brand/route.js": "the legacy branch of the brand API",
  "app/(console)/admin/(authed)/brand/page.js": "the legacy Brand screen; P3-ROUTES redirects it in documents mode",
  "app/(console)/admin/(authed)/theme/page.js": "the legacy Theme screen; P3-ROUTES redirects it in documents mode",
};

const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

export function configReads(src) {
  const code = stripComments(src);
  const out = [];
  for (const re of READ_PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(code)); ) out.push({ line: code.slice(0, m.index).split("\n").length, text: m[0].replace(/\s+/g, " ").slice(0, 80) });
  }
  return out;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...(await walk(p)));
    } else if (/\.(m?js|jsx|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

await t("unit: the scanner catches every read form it claims to (and skips comments, writes and theme_pin)", async () => {
  const bad = ["x = tenant.config.brand", "x = t?.config?.theme", "x = cfg.config['brand']", 'x = tenantOwnCfg("theme", null, null)', "const { brand } = tenant.config"];
  for (const b of bad) eq(configReads(b).length, 1, `caught: ${b}`);
  const fine = ["// tenant.config.brand in a comment", "/* config.theme */ x = 1", "patchTenant(id, { config: { brand: v } })", "x = tenant.config.theme_pin", "x = t.config?.billing"];
  for (const f of fine) eq(configReads(f).length, 0, `not a read: ${f}`);
});

await t("unit: the guard finds no config.brand or config.theme read outside the allowlist (lib, app, components)", async () => {
  const files = [...(await walk(join(ROOT, "lib"))), ...(await walk(join(ROOT, "app"))), ...(await walk(join(ROOT, "components")))];
  ok(files.length > 200, `scanned ${files.length} files`);
  const found = [];
  const allowedHits = new Set();
  for (const f of files) {
    const rel = relative(ROOT, f).split("\\").join("/");
    const hits = configReads(await readFile(f, "utf8"));
    if (!hits.length) continue;
    if (Object.hasOwn(ALLOW, rel)) allowedHits.add(rel);
    else found.push(...hits.map((h) => `${rel}:${h.line} ${h.text}`));
  }
  eq(found, [], "reads outside the allowlist:");
  // every allowlisted file exists and has a reason
  for (const [f, why] of Object.entries(ALLOW)) {
    ok(why.length > 10, `${f} has a reason`);
    await readFile(join(ROOT, f), "utf8");
  }
  // the readers this item moved really read nothing themselves
  for (const f of ["lib/admin/onboarding.js", "app/api/admin/help/route.js", "lib/platform/agency.js", "lib/admin/brand-readability.js", "app/api/platform/overview/route.js", "app/api/platform/themes/route.js", "app/api/platform/tenants/[id]/route.js", "components/platform/TenantDetail.js"]) {
    eq(configReads(await readFile(join(ROOT, f), "utf8")), [], `${f}:`);
  }
  ok(allowedHits.has("lib/themes/kits.js") && allowedHits.has("lib/content/resolve.js"), `the allowlist is used: ${[...allowedHits]}`);
});

// ======================================================================================
await cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
