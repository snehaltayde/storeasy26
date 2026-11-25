// P3-DESIGN (TOK-03): the design document (doc_design) in documents mode.
// Run for real: real tenant databases with every migration, the real console
// routes with real sessions, the real publish and Undo, storage re-read after
// every write or refusal.
//
//   1. kit apply: a doc_design DRAFT through the documents service, live and
//      the control-plane config untouched; legacy as before; a stored
//      'migrating' mode refuses (STORE_MODE_INVALID)
//   2. the brand API: save and reset refuse, sending the founder to the editor
//   3. two admins saving doc_design at once (the design form's saveDraft and
//      kit apply): one success, one 409 with the current document
//   4. listChanges for doc_design: the token rows and, under each, the live
//      sections that use that token group (lib/registry/token-usage.js)
//   5. theme_pin: a design publish and a design Undo write it (after-commit);
//      a failing pin write leaves the publish answer as it was
//   6. readers: onboarding, Help and brand readability
//      read the LIVE doc_design; the operator screens read theme_pin
//   7. kits that leave an unpublishable draft say so, naming what to fix
//   8. the guard: no config.brand / config.theme read outside the allowlist
//   9. P6-LOGO-REG (GEN-04): designFromBody's logo, resolvedLogo per mode,
//      and the preview of a design that was never published
//  10. P6-LOGO-RENDER (GEN-04): the picture logo in both Header variants and
//      both Footer spots, the real layout per mode, and the preview bar's
//      design line
//
//   pnpm test:design-doc
// request-cache must load before any app module that imports react
// (P6-LOGO-REG: the storefront getters run in simulated requests below).
import "./support/request-cache.js";
import { fontModule } from "./support/font-stub.js";
import { readFile, readdir, rm } from "node:fs/promises";
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

// P6-LOGO-REG: next/headers answers for one simulated request at a time (as in
// test-preview-overlay); outside one, headers() and cookies() throw, as the
// real module does outside a request.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__readRequest;
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

// P6-LOGO-REG: four more stores for the logo readers (open with a logo, open
// without one, closed, moving)
const LOGO_STORES = ["lgopen", "lgplain", "lgclosed", "lgmoving"];
const dbs = [".test-design-doc-default.db", ".test-design-doc-platform.db", ".test-design-doc-docs.db", ".test-design-doc-legacy.db", ...LOGO_STORES.map((k) => `.test-design-doc-${k}.db`)];
const cleanup = async () => {
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
};
await cleanup();

const started = Date.now();
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
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
const ON = await import("../lib/onboarding/service.js");
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

await t("unit: a store whose stored mode is 'migrating' refuses applyKit with 500 STORE_MODE_INVALID and writes nothing", async () => {
  await raw.docs.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  try {
    const before = await designRow();
    const m = await route("docs", "admin/theme", "POST", { action: "apply", kit: "glow" });
    eq([m.status, m.body.code], [500, "STORE_MODE_INVALID"], "migrating:");
    eq(await designRow(), before, "nothing written:");
  } finally {
    await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  }
});

// (Legacy /api/admin/brand route removed in Phase 1.1)

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
  // P5-BLOCKS: the bundle blocks are cards with photos, a button and a sale chip
  eq([TU.SECTION_TOKENS.bundle_card, TU.SECTION_TOKENS.bundle_grid], [["colours", "fonts", "shapes", "spacing"], ["colours", "fonts", "shapes", "spacing"]], "bundle kinds:");
  eq(Object.keys(TU.SECTION_TOKENS).sort(), [...R.sectionKinds()].sort(), "one entry per registered kind, no more:");
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

await t("unit: onboarding, Help and brand readability read the LIVE doc_design in documents mode (never config.brand / config.theme); legacy reads its config as before", async () => {
  // the live design now: pulse, accent #0f766e (test 5). The config still says
  // purple and pulse; a draft says something else again.
  await saveDesign((b) => {
    b.settings.brand = { ...b.settings.brand, accent: "#dc2626" };
    b.settings.theme = { kit: "glow", version: 1, applied_at: "2026-11-01T00:00:00.000Z" };
  });
  const live = await inD(() => BR.liveDesign());
  eq([live.brand.accent, live.theme.kit], ["#0f766e", "pulse"], "liveDesign (not the draft):");
  // onboarding (Phase 1 line 3): the Brand step counts the live design's brand;
  // it is done once doc_home exists too, else in progress
  const ob = await inD(() => ON.onboardingFor({ role: "owner" }));
  const step = ob.steps.find((i) => i.id === "brand");
  eq([step.facts.brandRecorded, step.state], [true, step.facts.hasHome ? "done" : "in_progress"], "onboarding:");
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
});

await t("unit: onboarding on a documents store with no published design is not done, even with an old config brand", async () => {
  // a second documents store whose config has a brand and no design document
  const c = createClient({ url: "file:.test-design-doc-default.db" });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS);
  await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  await C.upsertTenant({ id: "dn", name: "Design New", domains: ["dn.test"], dbUrl: "file:.test-design-doc-default.db", config: { ...STALE }, secrets: {} });
  const ob = await withTenant(await tenant("dn"), () => ON.onboardingFor({ role: "owner" }));
  const step = ob.steps.find((i) => i.id === "brand");
  eq([step.facts.brandRecorded, step.state], [false, step.facts.hasHome ? "in_progress" : "ready"], "not done on the old config:");
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
  const th = await platformGet("themes");
  const row = th.body.tenants.find((x) => x.id === "dd");
  eq([row.kit, row.version, row.pinned], ["glow", 1, true], "themes:");
  const det = await platformGet("tenants/[id]", { id: "dd" });
  eq([det.status, det.body.tenant.config.theme_pin?.kit, Object.hasOwn(det.body.tenant.config, "theme")], [200, "glow", false], `tenant detail: ${JSON.stringify(det.body.tenant?.config).slice(0, 200)}`);
  // Phase 3 line 7: the old TenantDetail went; the store page shows the pin through themePinLabel
  const { themePinLabel } = await import("../lib/platform/stores-list.js");
  eq(themePinLabel({ theme_pin: { kit: "glow", version: 1 } }), "glow-1", "the store page shows theme_pin:");
  // a published default look pins null: no kit on the detail, the default on the overview
  await C.patchTenant("dd", { config: { theme_pin: null } });
  eq((await platformGet("overview")).body.fleet.find((f) => f.tenant === "dd")?.kit, "pulse-1", "overview, default look:");
  eq((await platformGet("tenants/[id]", { id: "dd" })).body.tenant.config.theme_pin, null, "detail, default look:");
  await C.patchTenant("dd", { config: { theme_pin: cfg.theme_pin } });
});

// ======================================================================================
console.log("— 7. kits that leave an unpublishable draft");

await t("unit: a theme kit whose draft publishes says nothing; one that leaves the home draft unpublishable says so in plain words and names what to fix", async () => {
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
  ok(!/sec_|doc_|LINK_NOT|incomplete/.test(k2.body.note), `plain words: ${k2.body.note}`);
  ok(K.unpublishableNote([]) === null && K.unpublishableNote([{ label: "X", problems: ["a.", "b.", "c.", "d."] }]).endsWith("(and 1 more)"), "note helper:");
});

// ======================================================================================
console.log("— 9. P6-LOGO-REG: the logo in the design document (registry and readers)");

const Reader = await import("../lib/content/documents-reader.js");
const Res = await import("../lib/content/resolve.js");
const Pub = await import("../lib/documents/publish.js");
const PS = await import("../lib/preview-sessions.js");
const { runRequest } = await import("./support/request-cache.js");
const LOGO_ACTOR = { kind: "merchant", id: ownerU.id };
for (const key of LOGO_STORES) {
  const c = createClient({ url: `file:.test-design-doc-${key}.db` });
  await c.executeMultiple(schema);
  await runMigrations(c, MIGRATIONS);
  raw[key] = c;
  // every logo store carries an old control-plane brand: no logo reader may use it
  await C.upsertTenant({ id: key, name: `Logo ${key}`, domains: [`${key}.test`], dbUrl: `file:.test-design-doc-${key}.db`, config: { ...STALE, site: { name: `Logo ${key}` } }, secrets: {} });
}
await raw.lgopen.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw.lgplain.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw.lgclosed.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await raw.lgmoving.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
const inS = async (id, fn) => withTenant(await tenant(id), fn);
// one simulated storefront request on a store's host, with these cookies
async function asRequest(id, fn, cookies = {}) {
  globalThis.__readRequest = { host: `${id}.test`, cookies };
  try {
    return await runRequest(() => inS(id, fn));
  } finally {
    globalThis.__readRequest = null;
  }
}
const LOGO_A = { media: "/api/media/med_logoa1", alt: "Logo open" };
const LOGO_B = { media: "/api/media/med_logob2", alt: "Logo open, new" };
const BRAND_A = { accent: "#1d4ed8", background: "#ffffff", foreground: "#0a0a0b" };
const BRAND_B = { accent: "#047857", background: "#ffffff", foreground: "#0a0a0b" };
const designWith = (brand, logo) => body("design", { settings: { brand, theme: { kit: "pulse", version: 1 }, logo } });
async function publishIn(id, ids) {
  return inS(id, async () => {
    const items = [];
    for (const x of ids) {
      const d = await Docs.getDocument(x);
      items.push({ id: d.id, revision: d.revision, draftHash: d.draftHash });
    }
    return Pub.publish({ ids: items, actor: LOGO_ACTOR });
  });
}
// open, with a logo: a home page and the design published together
await inS("lgopen", async () => {
  await Docs.createDocument({ type: "home", body: body("home", { sections: [sec("text", "sec_lgo1", { title: "Hello", body: ["Words."] })] }), actor: LOGO_ACTOR });
  await Docs.createDocument({ type: "design", body: designWith(BRAND_A, LOGO_A), actor: LOGO_ACTOR });
});
await publishIn("lgopen", ["doc_home", "doc_design"]);
// open, its design published with no logo
await inS("lgplain", async () => {
  await Docs.createDocument({ type: "home", body: body("home", { sections: [sec("text", "sec_lgp1", { title: "Hello", body: ["Words."] })] }), actor: LOGO_ACTOR });
  await Docs.createDocument({ type: "design", body: designWith(BRAND_A, null), actor: LOGO_ACTOR });
});
await publishIn("lgplain", ["doc_home", "doc_design"]);
// closed: never published, a design draft with a logo
await inS("lgclosed", () => Docs.createDocument({ type: "design", body: designWith(BRAND_B, LOGO_B), actor: LOGO_ACTOR }));
// legacy (dl) and moving stores keep the text wordmark, whatever their config holds
const legacyLogoCfg = { ...STALE, brand: { ...STALE.brand, logo: "/api/media/med_cfglogo" } };

await t("P6-LOGO-REG unit: designFromBody returns the logo ({ media, alt? }) or null: no key, null, a broken value and another site's address are all null; brand and theme as before", async () => {
  eq(Reader.designFromBody(designWith(BRAND_A, LOGO_A)), { brand: BRAND_A, theme: { kit: "pulse", version: 1 }, logo: LOGO_A }, "with a logo:");
  eq(Reader.designFromBody(designWith(BRAND_A, { media: "/api/media/med_x" })).logo, { media: "/api/media/med_x" }, "no alt:");
  eq(Reader.designFromBody(designWith(BRAND_A, { media: "/api/media/med_x", alt: "" })).logo, { media: "/api/media/med_x", alt: "" }, "empty alt kept as it is:");
  const old = { schema: 1, type: "design", meta: {}, settings: { brand: BRAND_A, theme: null } };
  eq(Reader.designFromBody(old), { brand: BRAND_A, theme: null, logo: null }, "a design from before phase 6:");
  for (const bad of [null, 5, "/api/media/med_x", { media: "https://elsewhere.example/logo.png" }, { media: "/other/path" }, { alt: "x" }]) eq(Reader.designFromBody(designWith(null, bad)).logo, null, `${JSON.stringify(bad)}:`);
  eq(Reader.designFromBody(null), { brand: null, theme: null, logo: null }, "no body:");
});

await t("P6-LOGO-REG unit: resolvedLogo() is the logo for a v4 release with a design logo, and null for a v4 release without one or a closed store; resolvedBrand reads as before", async () => {
  eq(await asRequest("lgopen", () => Res.resolvedLogo()), LOGO_A, "open, with a logo:");
  eq(await asRequest("lgopen", () => Res.resolvedBrand()), BRAND_A, "open, its brand:");
  eq(await asRequest("lgplain", () => Res.resolvedLogo()), null, "open, no logo:");
  eq((await asRequest("lgclosed", () => Res.contentSource())).mode, "closed", "closed mode:");
  eq(await asRequest("lgclosed", () => Res.resolvedLogo()), null, "closed (a draft logo is never a shopper's):");
  eq(await asRequest("lgclosed", () => Res.resolvedBrand()), null, "closed brand as before:");
  // the getters bound to a source (P4-SEAM) give the same answer
  const G = Res.contentGettersFor(await asRequest("lgopen", () => Res.contentSource()));
  eq(await asRequest("lgopen", () => G.resolvedLogo()), LOGO_A, "contentGettersFor:");
});

await t("P6-LOGO-REG unit: the preview of a store with no live design shows the draft brand and logo without 'Show them'; a store with a live design still needs it", async () => {
  // closed: no live design entry, so the draft shows at once
  const closed = await inS("lgclosed", () => PS.createPreviewSession({ actor: LOGO_ACTOR }));
  const cookies = { [Res.PREVIEW_COOKIE]: closed.token };
  const src = await asRequest("lgclosed", () => Res.contentSource(), cookies);
  eq([src.preview, src.overlay.showDesign, src.overlay.designDirty, src.overlay.designShown], [true, false, true, true], "closed preview, toggle off:");
  eq(await asRequest("lgclosed", () => Res.resolvedLogo(), cookies), LOGO_B, "the draft logo:");
  eq(await asRequest("lgclosed", () => Res.resolvedBrand(), cookies), BRAND_B, "the draft brand:");
  eq(await asRequest("lgclosed", () => Res.resolvedLogo()), null, "a shopper still sees nothing:");
  // the toggle changes nothing here (known limit)
  await inS("lgclosed", () => PS.setShowDesign({ sid: closed.sid, on: true }));
  eq(await asRequest("lgclosed", () => Res.resolvedLogo(), cookies), LOGO_B, "toggle on, the same:");
  await inS("lgclosed", () => PS.setShowDesign({ sid: closed.sid, on: false }));

  // open with a live design: a new draft (brand and logo) waits for the toggle
  await inS("lgopen", async () => {
    const d = await Docs.getDocument("doc_design");
    await Docs.saveDraft({ id: d.id, revision: d.revision, body: designWith(BRAND_B, LOGO_B), actor: LOGO_ACTOR });
  });
  const open = await inS("lgopen", () => PS.createPreviewSession({ actor: LOGO_ACTOR }));
  const oc = { [Res.PREVIEW_COOKIE]: open.token };
  const off = await asRequest("lgopen", () => Res.contentSource(), oc);
  eq([off.preview, off.overlay.designDirty, off.overlay.designShown], [true, true, false], "open preview, toggle off:");
  eq(await asRequest("lgopen", () => Res.resolvedLogo(), oc), LOGO_A, "the live logo until asked:");
  eq(await asRequest("lgopen", () => Res.resolvedBrand(), oc), BRAND_A, "the live brand until asked:");
  await inS("lgopen", () => PS.setShowDesign({ sid: open.sid, on: true }));
  eq((await asRequest("lgopen", () => Res.contentSource(), oc)).overlay.designShown, true, "toggle on: shown:");
  eq(await asRequest("lgopen", () => Res.resolvedLogo(), oc), LOGO_B, "the draft logo once asked:");
  eq(await asRequest("lgopen", () => Res.resolvedBrand(), oc), BRAND_B, "the draft brand once asked:");
  eq(await asRequest("lgopen", () => Res.resolvedLogo()), LOGO_A, "shoppers keep the live logo:");

  // the rule itself (overlayList): a base with no doc_design entry overlays it
  const rows = [{ id: "doc_design", type: "design", draft: JSON.stringify(designWith(BRAND_B, LOGO_B)), draft_hash: "h1" }];
  const empty = Reader.previewBaseList();
  eq(empty.documents.doc_design, null, "the never-published base has no design entry:");
  eq(Reader.overlayList(empty, rows).documents, ["doc_design"], "no live design: overlaid without the toggle:");
  const liveBase = { ...empty, documents: { ...empty.documents, doc_design: { version: "ver_live", hash: "h0" } } };
  eq(Reader.overlayList(liveBase, rows).documents, [], "a live design: not without the toggle:");
  eq(Reader.overlayList(liveBase, rows, { showDesign: true }).documents, ["doc_design"], "a live design: with it:");
  eq([Reader.overlayList(empty, rows).designDirty, Reader.overlayList(liveBase, rows).designDirty], [true, true], "designDirty either way:");
});

// ======================================================================================
console.log("— 10. P6-LOGO-RENDER: the picture logo in the storefront chrome");

// The SWC render pattern of test-copy and test-preview-overlay: compile the real
// JSX file with Next's own SWC build, load its app imports for real, stub only
// what can't run outside Next (fonts, CSS, the client cart, analytics).
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compileJsx = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const jsxTarget = (from, id) => {
  const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolvePath(dirname(from), id);
  return p.endsWith(".js") ? p : `${p}.js`;
};
const isJsxFile = (file) => /^(app|components)\//.test(relative(ROOT, file));
async function loadJsx(file, stubs = {}, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compileJsx(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      const target = jsxTarget(file, id);
      deps.set(id, isJsxFile(target) ? await loadJsx(target, stubs, seen) : await import(pathToFileURL(target).href));
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
const nothingC = { __esModule: true, default: () => null };
const passthroughC = ({ children }) => React.createElement(React.Fragment, null, children);
const LINK_STUB = { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) };
const CHROME_STUBS = { "next/link": LINK_STUB, "./SearchBox": nothingC, "./cart/CartButton": nothingC };
const HeaderMod = await loadJsx(join(ROOT, "components/Header.js"), CHROME_STUBS);
const FooterMod = await loadJsx(join(ROOT, "components/Footer.js"), CHROME_STUBS);
const BannerMod = await loadJsx(join(ROOT, "components/PreviewBanner.js"), CHROME_STUBS);
const html = (C, props) => renderToStaticMarkup(React.createElement(C, props));
// the four wordmark spots, each rendered whole
const SPOTS = {
  "header standard": (logo) => html(HeaderMod.default, { logo, variant: "standard" }),
  "header centered": (logo) => html(HeaderMod.default, { logo, variant: "centered" }),
  "footer columns": (logo) => html(FooterMod.default, { logo, variant: "columns", legalName: "Acme Ltd" }),
  "footer minimal": (logo) => html(FooterMod.default, { logo, variant: "minimal", legalName: "Acme Ltd" }),
};
const imgsOf = (h) => [...h.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const attrOf = (tag, a) => tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1] ?? null;
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

await t("P6-LOGO-RENDER rendered: both Header variants and both Footer spots with logo.image { media:'/api/media/x', alt:'Acme' } render one img with that src and alt and the size styles, inside the header's home link", async () => {
  const logo = { image: { media: "/api/media/x", alt: "Acme" }, name: "Acme Store", text1: "Acme", text2: "" };
  for (const [spot, render] of Object.entries(SPOTS)) {
    const h = render(logo);
    const imgs = imgsOf(h);
    eq(imgs.length, 1, `${spot}: one img:`);
    eq([attrOf(imgs[0], "src"), attrOf(imgs[0], "alt")], ["/api/media/x", "Acme"], `${spot}: src and alt:`);
    const cls = attrOf(imgs[0], "class").split(" ");
    if (spot.startsWith("header")) {
      // 32px on a phone, 40px from md up, at most 180px wide, an explicit height
      for (const c of ["h-8", "max-h-8", "md:h-10", "md:max-h-10", "max-w-[180px]", "w-auto", "object-contain", "block"]) ok(cls.includes(c), `${spot}: class ${c} in ${cls}`);
      // the img sits inside the same home link, which takes its name from the alt
      ok(/<a href="\/" class="shrink-0 text-xl font-extrabold tracking-tight[^"]*"><img [^>]*\/><\/a>/.test(h), `${spot}: the img is the home link's only content: ${h.slice(0, 900)}`);
      eq(HeaderMod.HEADER_LOGO_CLASS.split(" ").sort(), [...cls].sort(), `${spot}: the exported class:`);
    } else {
      for (const c of ["h-12", "max-h-12", "w-auto", "max-w-full", "object-contain", "block"]) ok(cls.includes(c), `${spot}: class ${c} in ${cls}`);
      ok(/<p class="text-xl font-extrabold"><img [^>]*\/><\/p>/.test(h), `${spot}: the img replaces the text wordmark: ${h}`);
      if (spot === "footer minimal") ok(cls.includes("mx-auto"), "footer minimal: centred");
    }
  }
});

await t("P6-LOGO-RENDER rendered: with alt '' (or no alt) and a split wordmark (BEAST / LIFE), the alt is the store's name 'Beast Life Store', never 'BEAST', in all four spots", async () => {
  for (const image of [{ media: "/api/media/med_bl", alt: "" }, { media: "/api/media/med_bl" }]) {
    const logo = { image, name: "Beast Life Store", text1: "BEAST", text2: "LIFE" };
    for (const [spot, render] of Object.entries(SPOTS)) {
      const h = render(logo);
      const imgs = imgsOf(h);
      eq(imgs.length, 1, `${spot}: one img:`);
      eq(attrOf(imgs[0], "alt"), "Beast Life Store", `${spot} (${JSON.stringify(image)}): alt:`);
      ok(!/>BEAST|>LIFE</.test(h), `${spot}: no text wordmark beside the picture`);
    }
  }
});

// The four spots with no picture, rendered by the code before this item
// (7506c9e) and pinned here by hash: a change to any byte fails.
const TODAY = {
  split: { text1: "BEAST", text2: "LIFE" },
  single: { text1: "Acme", text2: "" },
};
const TODAY_HASHES = {"split":{"header standard":"b5c6b41110c63015","header centered":"76567f75047facab","footer columns":"9532db6dd6be4462","footer minimal":"2e28c4d69bedfcbb"},"single":{"header standard":"35278827511c355d","header centered":"0a921dc0167fc7c4","footer columns":"58a067fa1a079375","footer minimal":"62dc0cbd440a6922"}};
await t("P6-LOGO-RENDER rendered: with no image the text wordmark markup is byte-identical to today in all four spots (no image key, image null, a library-less image, a name)", async () => {
  for (const [k, base] of Object.entries(TODAY)) {
    for (const [spot, render] of Object.entries(SPOTS)) {
      const want = TODAY_HASHES[k][spot];
      eq(sha(render(base)), want, `${k} ${spot}, today's props:`);
      eq(sha(render({ ...base, image: null, name: "Beast Life Store" })), want, `${k} ${spot}, image null:`);
      eq(sha(render({ ...base, image: { alt: "No file" }, name: "Beast Life Store" })), want, `${k} ${spot}, no media:`);
      ok(!render(base).includes("<img"), `${k} ${spot}: no img`);
    }
  }
  // and the wordmark itself, written out
  ok(SPOTS["header standard"](TODAY.split).includes('<a href="/" class="shrink-0 text-xl font-extrabold tracking-tight ">BEAST<span class="text-sf-header-accent">LIFE</span></a>'), "header wordmark:");
  ok(SPOTS["footer columns"](TODAY.split).includes('<p class="text-xl font-extrabold">BEAST<span class="text-sf-accent-strong">LIFE</span></p>'), "footer wordmark:");
});

// The real storefront layout, rendered inside a simulated request (section 9's
// asRequest). Header is wrapped so the test sees exactly the logo it was given.
const handed = [];
const RealHeader = HeaderMod.default;
const LAYOUT_STUBS = {
  ...CHROME_STUBS,
  "next/font/local": fontModule,
  "@/app/fonts/fonts": fontModule,
  "../globals.css": {},
  "@/components/Header": { __esModule: true, default: (props) => (handed.push(props), React.createElement(RealHeader, props)) },
  "@/components/cart/CartContext": { CartProvider: passthroughC },
  "@/components/cart/CartDrawer": nothingC,
  "@/components/ServiceWorkerRegister": nothingC,
  // Phase 4 line 2: plugin slots are async server components (they read the store); not rendered here
  "@/components/plugins/PluginSlot": nothingC,
  "@/components/analytics/ConsentBanner": nothingC,
  "@/components/analytics/Pixels": nothingC,
  "@/components/analytics/ErrorReporter": nothingC,
  "@/components/site/SiteNav": nothingC,
  "@/components/preview/PreviewBridge": nothingC,
};
const Layout = (await loadJsx(join(ROOT, "app/(storefront)/layout.js"), LAYOUT_STUBS)).default;
async function layoutOf(id, cookies = {}) {
  handed.length = 0;
  const out = await asRequest(id, async () => renderToStaticMarkup(await Layout({ children: React.createElement("p", { id: "page" }, "page body") })), cookies);
  return { html: out, header: handed.at(-1) || null };
}
const headerHtml = (h) => h.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? null;
const footerHtml = (h) => h.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? null;
const barText = (h) => (h.match(/<div data-preview-bar=""[\s\S]*?<\/div>/)?.[0] ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

await t("P6-LOGO-RENDER rendered: the layout on an open documents store renders its live logo in the header and footer, and a store with no logo keeps its text wordmark; shoppers never see the draft logo", async () => {
  const { html: page, header } = await layoutOf("lgopen");
  eq(header.logo, { image: LOGO_A, name: "Logo lgopen", text1: "Logo lgopen", text2: "" }, "the logo handed to the Header:");
  for (const [where, part] of [["header", headerHtml(page)], ["footer", footerHtml(page)]]) {
    const imgs = imgsOf(part);
    eq(imgs.length, 1, `${where}: one img:`);
    eq([attrOf(imgs[0], "src"), attrOf(imgs[0], "alt")], [LOGO_A.media, LOGO_A.alt], `${where}: the live logo:`);
  }
  ok(!page.includes(LOGO_B.media), "the draft logo (section 9 saved one) is not a shopper's");
  // a live logo with no alt: the store's name
  const plain = await layoutOf("lgplain");
  eq(plain.header.logo, { image: null, name: "Logo lgplain", text1: "Logo lgplain", text2: "" }, "no logo: image null:");
  ok(!plain.html.includes("<img"), "no logo: no img");
  ok(headerHtml(plain.html).includes('tracking-tight ">Logo lgplain</a>'), "no logo: the text wordmark");
});

await t("P6-LOGO-RENDER unit: a closed documents store renders StoreClosed with no logo image, no draft logo, alt or colour, and no Header", async () => {
  const { html: page, header } = await layoutOf("lgclosed");
  eq(header, null, "no Header:");
  ok(page.includes("Opening soon") && page.includes("Logo lgclosed"), "StoreClosed with the name");
  for (const leak of ["<img", "/api/media", LOGO_B.media, LOGO_B.alt, BRAND_B.accent.slice(1), "<header", "<footer", "data-preview-bar"]) ok(!page.toLowerCase().includes(leak.toLowerCase()), `the closed page shows ${leak}`);
});

await t("P6-LOGO-RENDER rendered: the preview bar never says the new colours are not shown while they are (closed store, toggle off and on; open store with a live design)", async () => {
  // closed, toggle off: the draft design is shown (P6-LOGO-REG), so is its logo
  const s = await inS("lgclosed", () => PS.createPreviewSession({ actor: LOGO_ACTOR }));
  const ck = { [Res.PREVIEW_COOKIE]: s.token };
  const src = await asRequest("lgclosed", () => Res.contentSource(), ck);
  eq([src.overlay.designDirty, src.overlay.showDesign, src.overlay.designShown], [true, false, true], "closed, toggle off:");
  const off = await layoutOf("lgclosed", ck);
  ok(barText(off.html).includes(BannerMod.DESIGN_SHOWN_LINE), `the bar says shown: ${barText(off.html)}`);
  ok(!barText(off.html).includes(BannerMod.DESIGN_HIDDEN_LINE) && !barText(off.html).includes("Show them"), `the bar: ${barText(off.html)}`);
  eq(attrOf(imgsOf(headerHtml(off.html))[0] || "", "src"), LOGO_B.media, "the preview header shows the draft logo:");
  // toggle on: the same words, with Hide them
  await inS("lgclosed", () => PS.setShowDesign({ sid: s.sid, on: true }));
  const on = await layoutOf("lgclosed", ck);
  ok(barText(on.html).includes(`${BannerMod.DESIGN_SHOWN_LINE} Hide them`) && !barText(on.html).includes(BannerMod.DESIGN_HIDDEN_LINE), `toggle on: ${barText(on.html)}`);
  await inS("lgclosed", () => PS.setShowDesign({ sid: s.sid, on: false }));
  // open with a live design and a draft (section 9): the toggle still decides
  const o = await inS("lgopen", () => PS.createPreviewSession({ actor: LOGO_ACTOR }));
  const oc = { [Res.PREVIEW_COOKIE]: o.token };
  const hidden = await layoutOf("lgopen", oc);
  ok(barText(hidden.html).includes(`${BannerMod.DESIGN_HIDDEN_LINE} Show them`), `open, toggle off: ${barText(hidden.html)}`);
  eq(attrOf(imgsOf(headerHtml(hidden.html))[0] || "", "src"), LOGO_A.media, "open, toggle off: the live logo");
  await inS("lgopen", () => PS.setShowDesign({ sid: o.sid, on: true }));
  const shown = await layoutOf("lgopen", oc);
  ok(barText(shown.html).includes(`${BannerMod.DESIGN_SHOWN_LINE} Hide them`), `open, toggle on: ${barText(shown.html)}`);
  eq(attrOf(imgsOf(headerHtml(shown.html))[0] || "", "src"), LOGO_B.media, "open, toggle on: the draft logo");
  // the banner on its own, every combination: 'not shown' only when not shown
  for (const designShown of [true, false, undefined]) {
    for (const showDesign of [true, false]) {
      const text = html(BannerMod.default, { overlay: { designDirty: true, showDesign, designShown } }).replace(/<[^>]+>/g, " ");
      const really = designShown ?? showDesign;
      eq(text.includes(BannerMod.DESIGN_HIDDEN_LINE), !really, `designShown ${designShown}, showDesign ${showDesign}: 'not shown':`);
      eq(text.includes(BannerMod.DESIGN_SHOWN_LINE), really, `designShown ${designShown}, showDesign ${showDesign}: 'shown':`);
      eq(text.includes("Show them") || text.includes("Hide them"), !(really && !showDesign), `designShown ${designShown}, showDesign ${showDesign}: a button:`);
    }
  }
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
  "lib/brand.js": "the brand engine itself",
  "lib/themes/kits.js": "draftDesignOf / themePinOf fallback for unmigrated configs",
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
  for (const f of ["lib/onboarding/service.js", "lib/onboarding/steps.js", "app/api/admin/help/route.js", "lib/admin/brand-readability.js", "app/api/platform/overview/route.js", "app/api/platform/themes/route.js", "app/api/platform/tenants/[id]/route.js", "components/platform/stores/StoreDetail.js"]) {
    eq(configReads(await readFile(join(ROOT, f), "utf8")), [], `${f}:`);
  }
  ok(allowedHits.has("lib/themes/kits.js"), `the allowlist is used: ${[...allowedHits]}`);
});

// ======================================================================================
await cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
