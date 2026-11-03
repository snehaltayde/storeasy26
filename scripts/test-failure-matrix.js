// Failure matrix (DOC-04, goal G3): every known save, preview and publish
// failure, each forced through the REAL handlers (lib/admin/cms-api.js behind
// /api/admin/storefront, lib/admin/releases-api.js behind /api/admin/releases)
// with real requireAdmin, real sessions and real tenant databases, broken the
// way production breaks them: a database that doesn't answer, one that went
// read-only, one that missed a migration, a table whose reads fail, two first
// saves racing. Each row must answer with the right status class and a message
// a founder can act on, and a database failure must never come back as a
// validation problem (422, or anything carrying an issue list).
//   pnpm test:failure-matrix
import { readFile, rm, chmod, writeFile, readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Route files use the "@/" alias; resolve it the way test:media-upload does,
// so one /api/admin route runs for real below.
// next/headers: outside a request it throws, as Next's does; inside one the
// suite opens (globalThis.__fmRequest, for a console page's server load) it
// answers with that request's host and cookies.
const FM_HEADERS =
  "data:text/javascript," +
  encodeURIComponent(`
    const req = () => { const q = globalThis.__fmRequest; if (!q) throw new Error("\`headers\` was called outside a request scope"); return q; };
    export async function headers() { return new Headers({ host: req().host }); }
    export async function cookies() { const q = req(); return { get: (n) => (q.cookies?.[n] != null ? { name: n, value: q.cookies[n] } : undefined) }; }
    export function draftMode() { return { isEnabled: false }; }
  `);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(root, spec.endsWith(".js") ? spec.slice(2) : `${spec.slice(2)}.js`)).href, ctx);
    if (spec === "next/headers") return { url: FM_HEADERS, shortCircuit: true };
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-failmatrix-default.db";
process.env.PLATFORM_DB_URL = "file:.test-failmatrix-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const FILES = {
  ok: ".test-failmatrix-ok.db",
  readonly: ".test-failmatrix-readonly.db",
  bare: ".test-failmatrix-bare.db",
  old: ".test-failmatrix-old.db",
  broken: ".test-failmatrix-broken.db",
  links: ".test-failmatrix-links.db",
  race: ".test-failmatrix-race.db",
  norel: ".test-failmatrix-norel.db",
  nopages: ".test-failmatrix-nopages.db",
  noappr: ".test-failmatrix-noappr.db",
  notnull: ".test-failmatrix-notnull.db",
  words: ".test-failmatrix-words.db",
  badtitles: ".test-failmatrix-badtitles.db",
  badrevs: ".test-failmatrix-badrevs.db",
  oldpages: ".test-failmatrix-oldpages.db",
  noredir: ".test-failmatrix-noredir.db",
  // P1-FIX-C: schema errors that are NOT a store from before a migration, and
  // the stores from before a migration that must keep working
  nocol: ".test-failmatrix-nocol.db",
  nofamily: ".test-failmatrix-nofamily.db",
  nopagestable: ".test-failmatrix-nopagestable.db",
  relview: ".test-failmatrix-relview.db",
  redirview: ".test-failmatrix-redirview.db",
  apprview: ".test-failmatrix-apprview.db",
  // P1-FIX-C: the offer go-back route (c513d27)
  offers: ".test-failmatrix-offers.db",
  nooffers: ".test-failmatrix-nooffers.db",
};
const dbs = [".test-failmatrix-default.db", ".test-failmatrix-platform.db", ...Object.values(FILES)];
const cleanup = async () => {
  for (const f of dbs) {
    await chmod(join(root, f), 0o644).catch(() => {});
    await rm(join(root, f), { force: true });
  }
};
await cleanup();

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const Sess = await import("../lib/platform/sessions.js");
const Id = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { handleStorefrontGet, handleStorefrontPut } = await import("../lib/admin/cms-api.js");
const { handleReleasesGet, handleReleasesPost } = await import("../lib/admin/releases-api.js");
const { previewToken } = await import("../lib/releases.js");
const { setBlock } = await import("../lib/cms/store.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const issuesModule = await import("../lib/cms/issues.js").catch(() => ({}));
const api = await import("../components/admin/cms/api.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
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

// --- tenants, each database broken one way ------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {}); // the local test control plane only: the job queue a schedule writes to
const schema =await readFile(join(here, "../lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
const build = async (file) => {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(schema);
  await runMigrations(c, migrations);
  return c;
};
// a table whose every read fails with a plain SQLite error (not "missing")
const breakReads = (c, table) => c.executeMultiple(`ALTER TABLE ${table} RENAME TO ${table}_data; CREATE VIEW ${table} AS SELECT *, nosuch_fn(1) AS boom FROM ${table}_data;`);
// a table where reading ONE column fails (at run time, so only a query that
// asks for that column fails): the page list and the page revisions read
// different columns of cms_pages, so each can be broken on its own
const breakColumn = async (c, table, column, { drop = null } = {}) => {
  const cols = (await c.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name).filter((n) => n !== drop);
  const list = cols.map((n) => (n === column ? `json_extract('not json', '$') AS ${n}` : n)).join(", ");
  await c.executeMultiple(`ALTER TABLE ${table} RENAME TO ${table}_data; CREATE VIEW ${table} AS SELECT ${list} FROM ${table}_data;`);
};

{
  await build(FILES.ok);
  // read-only: a healthy database with content, then the file goes read-only
  const ro = await build(FILES.readonly);
  await ro.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES ('hero', ?, '2026-01-01', 1, 1)", args: [JSON.stringify({ title: "Stored hero" })] });
  ro.close();
  await chmod(join(root, FILES.readonly), 0o444);
  // bare: a database nobody migrated (no tables at all)
  await writeFile(join(root, FILES.bare), "");
  // old: a tenant that missed migration 0016 (S59's live preview table)
  const old = await build(FILES.old);
  await old.execute("DROP TABLE cms_preview_candidates");
  await old.execute("DROP TABLE cms_templates");
  // broken: reads of the content tables fail
  const br = await build(FILES.broken);
  await breakReads(br, "cms_blocks");
  await breakReads(br, "cms_pages");
  // a delete that "succeeds" touching nothing, so only the read after it can tell
  await br.execute("CREATE TRIGGER blocks_delete_nothing INSTEAD OF DELETE ON cms_blocks BEGIN SELECT 1; END");
  // links: content reads fine, but the catalog lookup behind link checks fails
  const ln = await build(FILES.links);
  await ln.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES ('hero', ?, '2026-01-01', 1, 1)", args: [JSON.stringify({ title: "Hi", primary: { label: "Shop", href: "/collections/gear" } })] });
  await breakReads(ln, "collections");
  // race: another first save lands between our read and our insert
  const rc = await build(FILES.race);
  await rc.execute("CREATE TRIGGER race_blocks BEFORE INSERT ON cms_blocks BEGIN INSERT OR IGNORE INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES (NEW.key, '{\"title\":\"Theirs\"}', 'x', 1, 1); END");
  await rc.execute("CREATE TRIGGER race_pages BEFORE INSERT ON cms_pages BEGIN INSERT OR IGNORE INTO cms_pages (slug, title, description, sections, enabled, revision, updated_at, family, schema_version) VALUES (NEW.slug, 'Theirs', '', '[]', 1, 1, 'x', 'page', 3); END");
  // norel: the release tables are missing
  const nr = await build(FILES.norel);
  await nr.execute("DROP TABLE releases");
  // nopages: blocks save fine, but reading the pages fails, so the editor's
  // refresh AFTER a save fails (and so does the editor load)
  const np = await build(FILES.nopages);
  await np.execute({ sql: "INSERT INTO cms_pages (slug, title, description, sections, enabled, revision, updated_at, family, schema_version) VALUES ('kept', 'Kept', '', '[]', 1, 1, 'x', 'page', 3)", args: [] });
  await breakReads(np, "cms_pages");
  // noappr: publishing works, but the approval read behind the panel's refresh fails
  const na = await build(FILES.noappr);
  await na.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES ('hero', ?, '2026-01-01', 1, 1)", args: [JSON.stringify({ title: "Ready" })] });
  await breakReads(na, "cms_approvals");
  // notnull: a first save breaks a NOT NULL rule (a bug of ours, not a race)
  const nn = await build(FILES.notnull);
  await nn.executeMultiple("CREATE TABLE nn_guard (x TEXT NOT NULL); CREATE TRIGGER nn_blocks BEFORE INSERT ON cms_blocks BEGIN INSERT INTO nn_guard (x) VALUES (NULL); END;");
  // badtitles / badrevs: only the page list's read fails, or only the page
  // revisions' read fails (the editors' view needs both)
  // oldpages: a store from before page families (no `family` column), whose
  // page list then can't be read either: the list's fallback read must stay strict
  for (const [file, column, drop] of [[FILES.badtitles, "title"], [FILES.badrevs, "revision"], [FILES.oldpages, "title", "family"]]) {
    const c = await build(file);
    await c.execute({ sql: "INSERT INTO cms_pages (slug, title, description, sections, enabled, revision, updated_at, family, schema_version) VALUES ('kept', 'Kept', '', '[]', 1, 1, 'x', 'page', 3)", args: [] });
    await breakColumn(c, "cms_pages", column, { drop });
  }
  // noredir: the release snapshot's other tables (here the slug redirects) can't be read
  const nd = await build(FILES.noredir);
  await nd.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES ('hero', ?, '2026-01-01', 1, 1)", args: [JSON.stringify({ title: "Ready" })] });
  await breakReads(nd, "page_redirects");
  // words: a healthy store whose own words contain "network" and "timeout",
  // for the routes whose refusals quote them (DOC-04 fix round 1)
  const wd = await build(FILES.words);
  await wd.executeMultiple(`
    INSERT INTO products (id, handle, title, available) VALUES ('gid://shopify/Product/1', 'network-switch', 'Network Switch 8-port', 0);
    INSERT INTO variants (id, product_id, title, price, available, position) VALUES ('gid://shopify/ProductVariant/1', 'gid://shopify/Product/1', 'Default', 500, 0, 0);
    INSERT INTO products (id, handle, title, available) VALUES ('gid://shopify/Product/2', 'patch-cable', 'Patch Cable', 1);
    INSERT INTO variants (id, product_id, title, price, available, position) VALUES ('gid://shopify/ProductVariant/2', 'gid://shopify/Product/2', 'Default', 100, 1, 0);
  `);
  await wd.execute({
    sql: "INSERT INTO cms_pages (slug, title, description, sections, enabled, revision, updated_at, family, schema_version) VALUES ('partner-network', 'Partner network', '', ?, 1, 1, 'x', 'page', 3)",
    args: [JSON.stringify([{ id: "sec_img1", kind: "image", src: "/api/media/med_net1", alt: "Our partners" }])],
  });

  // P1-FIX-C. nocol: every cms_pages read fails "no such column" because the
  // table is now a view naming a column that doesn't exist (P1-DRILLS finding
  // 5). That is a broken schema, not a store from before a migration.
  const KEPT_PAGE = { sql: "INSERT INTO cms_pages (slug, title, description, sections, enabled, revision, updated_at, family, schema_version) VALUES ('kept', 'Kept', '', ?, 1, 1, 'x', 'page', 3)", args: [JSON.stringify([{ id: "sec_kept1", kind: "text", heading: "Kept", body: ["Still here."] }])] };
  const nc = await build(FILES.nocol);
  await nc.execute(KEPT_PAGE);
  const ncCols = (await nc.execute("PRAGMA table_info(cms_pages)")).rows.map((r) => r.name);
  await nc.executeMultiple(`ALTER TABLE cms_pages RENAME TO cms_pages_data; CREATE VIEW cms_pages AS SELECT ${ncCols.map((n) => (n === "title" ? "nosuch_col AS title" : n)).join(", ")} FROM cms_pages_data;`);
  // nofamily: a real store from before page families (migration 0009): no
  // family or window columns, otherwise healthy. It must keep working.
  const nf = await build(FILES.nofamily);
  await nf.execute(KEPT_PAGE);
  const nfCols = (await nf.execute("PRAGMA table_info(cms_pages)")).rows.map((r) => r.name).filter((n) => !["family", "window_start", "window_end"].includes(n));
  await nf.executeMultiple(`ALTER TABLE cms_pages RENAME TO cms_pages_data; CREATE VIEW cms_pages AS SELECT ${nfCols.join(", ")} FROM cms_pages_data;`);
  // nopagestable: a store from before content pages: no cms_pages at all
  const npt = await build(FILES.nopagestable);
  await npt.execute("DROP TABLE cms_pages");
  // relview: the live pointer table is a view over a table that's gone. Its
  // read fails "no such table: main.<other>", which is not release_state
  // missing: "no release yet" would serve drafts to shoppers.
  const rv = await build(FILES.relview);
  await rv.executeMultiple("ALTER TABLE release_state RENAME TO release_state_data; CREATE VIEW release_state AS SELECT * FROM release_state_gone;");
  // redirview: the same for the slug redirects a publish freezes
  const rdv = await build(FILES.redirview);
  await rdv.execute({ sql: "INSERT INTO cms_blocks (key, value, updated_at, revision, schema_version) VALUES ('hero', ?, '2026-01-01', 1, 1)", args: [JSON.stringify({ title: "Ready" })] });
  await rdv.execute("INSERT INTO page_redirects (from_slug, to_slug, created_at) VALUES ('old-post', 'new-post', 'x')");
  await rdv.executeMultiple("ALTER TABLE page_redirects RENAME TO page_redirects_data; CREATE VIEW page_redirects AS SELECT * FROM page_redirects_gone;");
  // apprview: the approvals table is a view over a table that's gone
  const av = await build(FILES.apprview);
  await av.executeMultiple("ALTER TABLE cms_approvals RENAME TO cms_approvals_data; CREATE VIEW cms_approvals AS SELECT * FROM cms_approvals_gone;");
  // offers: the go-back route's every answer. Each offer is stored the way
  // lib/offers/store.js stores it, with the settings before its last change.
  const coupon = (code, title = "Ten off") => ({ code, title, scope: "order", priority: 30, discount: { kind: "percent", value: 10 } });
  const snap = (cfg, at = "2026-10-01T00:00:00.000Z", type = "COUPON", label = "Coupon") => JSON.stringify({ type, label, starts_at: null, ends_at: null, config: JSON.stringify(cfg), replaced_at: at });
  const of = await build(FILES.offers);
  for (const [id, type, cfg, prev] of [
    ["o-prev", "COUPON", coupon("NEW15"), snap(coupon("OLD10"))],
    ["o-fresh", "COUPON", coupon("FRESH"), null],
    ["o-bundle", "BUNDLE", { title: "Duo", scope: "line", priority: 30 }, snap({ title: "Duo old" }, undefined, "BUNDLE")],
    ["o-badprev", "COUPON", coupon("GOOD"), snap({ ...coupon("BAD"), title: "" })],
  ]) {
    await of.execute({ sql: "INSERT INTO offers (id, type, label, enabled, config, previous_config, created_at, updated_at) VALUES (?, ?, 'Coupon', 1, ?, ?, 'x', 'x')", args: [id, type, JSON.stringify(cfg), prev] });
  }
  const no = await build(FILES.nooffers);
  await no.execute({ sql: "INSERT INTO offers (id, type, label, enabled, config, previous_config, created_at, updated_at) VALUES ('o-prev', 'COUPON', 'Coupon', 1, ?, ?, 'x', 'x')", args: [JSON.stringify(coupon("NEW15")), snap(coupon("OLD10"))] });
  await breakReads(no, "offers");
}

const TENANTS = {
  ok: `file:${FILES.ok}`,
  readonly: `file:${FILES.readonly}`,
  bare: `file:${FILES.bare}`,
  old: `file:${FILES.old}`,
  broken: `file:${FILES.broken}`,
  links: `file:${FILES.links}`,
  race: `file:${FILES.race}`,
  norel: `file:${FILES.norel}`,
  nopages: `file:${FILES.nopages}`,
  noappr: `file:${FILES.noappr}`,
  notnull: `file:${FILES.notnull}`,
  words: `file:${FILES.words}`,
  badtitles: `file:${FILES.badtitles}`,
  badrevs: `file:${FILES.badrevs}`,
  oldpages: `file:${FILES.oldpages}`,
  noredir: `file:${FILES.noredir}`,
  nocol: `file:${FILES.nocol}`,
  nofamily: `file:${FILES.nofamily}`,
  nopagestable: `file:${FILES.nopagestable}`,
  relview: `file:${FILES.relview}`,
  redirview: `file:${FILES.redirview}`,
  apprview: `file:${FILES.apprview}`,
  offers: `file:${FILES.offers}`,
  nooffers: `file:${FILES.nooffers}`,
  // nothing answers here (undici refuses port 9 at once, then lib/db.js retries)
  down: "http://127.0.0.1:9",
};
const T = {};
const owner = await Id.createUser({ email: "owner@fm.test", password: "owner-pass-doc04" });
const staff = await Id.createUser({ email: "staff@fm.test", password: "staff-pass-doc04" });
const support = await Id.createUser({ email: "support@fm.test", password: "support-pass-doc04" });
for (const [name, dbUrl] of Object.entries(TENANTS)) {
  const id = `fm${name}`;
  await C.upsertTenant({ id, name: `Failure ${name}`, domains: [`${id}.test`], dbUrl, config: {}, secrets: {} });
  T[name] = await C.getTenant(id);
  await Id.addMembership(owner.id, id, "owner");
  await Id.addMembership(staff.id, id, "staff");
  await Id.addMembership(support.id, id, "support");
}
const tok = async (u) => (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(owner);
const STAFF = await tok(staff);
const SUPPORT = await tok(support);

const request = (tenant, { admin = OWNER, preview = null, body = {} } = {}) => ({
  cookies: { get: (n) => (n === "_admin" && admin ? { value: admin } : n === "_preview" && preview ? { value: preview } : undefined) },
  headers: { get: (k) => ({ host: `${tenant.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const storefront = (name, body, opts = {}) => withTenant(T[name], () => handleStorefrontPut(request(T[name], { ...opts, body })));
const storefrontGet = (name, opts = {}) => withTenant(T[name], () => handleStorefrontGet(request(T[name], opts)));
const releases = (name, body, opts = {}) => withTenant(T[name], () => handleReleasesPost(request(T[name], { ...opts, body })));
const releasesGet = (name, opts = {}) => withTenant(T[name], () => handleReleasesGet(request(T[name], opts)));
const previewTok = (name) => withTenant(T[name], () => previewToken());

// --- what "founder-readable" means here -----------------------------------------
// Words a founder can act on: no database, driver or code text, no table names,
// nothing a stack trace would say, not a whole HTML page.
const RAW = /SQLITE|libsql|hrana|no such (table|column|function)|fetch failed|ECONN|TypeError|ReferenceError|SyntaxError|\bundefined\b|\bnull\b|\[object|\bat \S+\.js|\bcms_[a-z_]+|constraint|<html|<!doctype|stack|\bboom\b/i;
const readable = (msg, label) => {
  ok(typeof msg === "string" && msg.trim().length >= 8, `${label} has a message, got ${JSON.stringify(msg)}:`);
  ok(msg.length <= 400, `${label} is short enough (${msg.length}):`);
  ok(!RAW.test(msg), `${label} plain words, got "${msg}":`);
};
const POSITION = /\b(section|question|accordion|item)\s+\d/i;
const KEYS = ["documentId", "sectionId", "blockId", "field", "code", "severity", "message", "autoFix"];

// What an infrastructure message must say happened to the founder's work, by
// what they were doing. "saved" is the one case where the write went through
// and only the refresh after it failed.
const OUTCOME_WORDS = {
  save: /nothing was saved\. Your changes are still here/,
  preview: /the preview didn't update\. Your changes are still here/,
  publish: /nothing was published\. Your live store hasn't changed/,
  load: /this couldn't load/,
  saved: /^Your changes were saved, but this page couldn't refresh\. Reload it/,
};

// One row of the matrix. `cls` is the status class the founder's screen keys
// on: "validation" (422 with issues), "refusal" (another 4xx, no issues) or
// "infrastructure" (5xx with a code, no issues). `doing` says which outcome
// an infrastructure message must name (the row's area unless set).
function check(res, { status, code, cls, label, doing }) {
  eq(res.status, status, `${label} status:`);
  const body = res.body || {};
  readable(body.error, `${label} error`);
  if (code) eq(body.code, code, `${label} code:`);
  if (cls === "validation") {
    eq(res.status, 422, `${label} validation is 422:`);
    ok(Array.isArray(body.issues) && body.issues.length > 0, `${label} carries the issue list:`);
    for (const i of body.issues) {
      eq(Object.keys(i), KEYS, `${label} issue shape:`);
      readable(i.message, `${label} issue message`);
      ok(!POSITION.test(i.message), `${label} issue has no position, got "${i.message}":`);
      readable(issuesModule.issueText(i), `${label} issue as the editor words it`);
    }
  } else {
    ok(!("issues" in body), `${label} a ${cls} failure never carries an issue list:`);
    ok(!("errors" in body), `${label} a ${cls} failure never carries a validation errors list:`);
    if (cls === "infrastructure") {
      ok(res.status >= 500 && res.status <= 599, `${label} infrastructure is 5xx:`);
      ok(typeof body.code === "string" && /^[A-Z_]+$/.test(body.code), `${label} has a code:`);
      // the message names what really happened to the work, not just any plain words
      ok(OUTCOME_WORDS[doing]?.test(body.error), `${label} says what happened (${doing}), got "${body.error}":`);
    } else ok(res.status >= 400 && res.status < 500 && res.status !== 422, `${label} a refusal is a 4xx other than 422:`);
  }
}

const MATRIX = [];
const row = (area, name, run, expect, extra) => MATRIX.push({ area, name, run, expect, extra });

// --- save ------------------------------------------------------------------------
row("save", "hero with no title", () => storefront("ok", { block: "hero", value: { title: "" }, revision: null }), { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, (r) => {
  eq(r.body.issues.map((i) => [i.documentId, i.sectionId, i.field, i.code]), [["doc_home", "hero", "title", "REQUIRED"]], "hero issue:");
});
row(
  "save",
  "two homepage sections wrong at once",
  () => storefront("ok", { block: "home_sections", value: [{ id: "sec_aa11", kind: "banner", title: "", text: "", href: "nope" }, { id: "sec_bb22", kind: "product_rail", collection: "" }], revision: null }),
  { status: 422, code: "VALIDATION_FAILED", cls: "validation" },
  (r) =>
    eq(
      r.body.issues.map((i) => [i.sectionId, i.field, i.code]),
      [
        ["sec_aa11", "href", "LINK_INVALID"],
        ["sec_aa11", "title", "REQUIRED"],
        ["sec_bb22", "collection", "REQUIRED"],
      ],
      "every issue, each with its section id:",
    ),
);
row("save", "page with an empty section and no title", () => storefront("ok", { page: { slug: "fm-page", title: "", sections: [{ id: "sec_cc33", kind: "text", heading: "", body: [] }] }, revision: null }), { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, (r) => {
  eq(r.body.issues.map((i) => [i.sectionId, i.field, i.code]), [[null, "title", "REQUIRED"], ["sec_cc33", "body", "SECTION_EMPTY"]], "both:");
});
row("save", "template with no name", () => storefront("ok", { saveTemplate: { name: "", family: "page", sections: [{ kind: "text", heading: "H", body: ["x"] }] } }), { status: 422, code: "VALIDATION_FAILED", cls: "validation" });
row("save", "a bad redirect is refused before anything is written", () => storefront("ok", { page: { slug: "fm-redirect", title: "Post", family: "journal", sections: [{ kind: "text", heading: "H", body: ["x"] }], redirect_from: "Not A Slug!" }, revision: null }), { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, async (r) => {
  eq(r.body.issues[0].field, "redirect_from", "field:");
  const page = await withTenant(T.ok, async () => (await import("../lib/db.js")).db.selectFrom("cms_pages").selectAll().where("slug", "=", "fm-redirect").executeTakeFirst());
  eq(page, undefined, "the page row was NOT written:");
});
row("save", "someone else saved first (stale revision)", async () => {
  await withTenant(T.ok, () => setBlock("announcement", { enabled: true, text: "Theirs", href: "/" }));
  return storefront("ok", { block: "announcement", value: { enabled: true, text: "Mine", href: "/" }, revision: null });
}, { status: 409, code: "CMS_CONFLICT", cls: "refusal" }, (r) => eq(r.body.current?.value?.text, "Theirs", "their version rides along:"));
row("save", "two first saves race (block)", () => storefront("race", { block: "hero", value: { title: "Mine" }, revision: null }), { status: 409, code: "CMS_CONFLICT", cls: "refusal" });
row("save", "two first saves race (page)", () => storefront("race", { page: { slug: "raced", title: "Mine", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: null }), { status: 409, code: "CMS_CONFLICT", cls: "refusal" });
row("save", "no revision sent", () => storefront("ok", { block: "hero", value: { title: "x" } }), { status: 428, code: "REVISION_REQUIRED", cls: "refusal" });
row("save", "two operations in one request", () => storefront("ok", { block: "hero", value: { title: "x" }, getPage: "about" }), { status: 400, code: "AMBIGUOUS_OPERATION", cls: "refusal" });
row("save", "a page that isn't an object", () => storefront("ok", { page: null, revision: null }), { status: 400, code: "MALFORMED", cls: "refusal" });
row("save", "signed out", () => storefront("ok", { block: "hero", value: { title: "x" }, revision: null }, { admin: null }), { status: 401, cls: "refusal" });
row("save", "read-only role (support)", () => storefront("ok", { block: "hero", value: { title: "x" }, revision: null }, { admin: SUPPORT }), { status: 403, cls: "refusal" });
row("save", "template that no longer exists", () => storefront("ok", { useTemplate: "tpl_gone" }), { status: 404, code: "NOT_FOUND", cls: "refusal" });
row("save", "database doesn't answer (block)", () => storefront("down", { block: "hero", value: { title: "Typed" }, revision: 1 }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("save", "database doesn't answer (page)", () => storefront("down", { page: { slug: "p", title: "P", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: 1 }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("save", "database went read-only (block)", () => storefront("readonly", { block: "hero", value: { title: "Typed" }, revision: 1 }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("save", "database went read-only (reset to default)", () => storefront("readonly", { block: "hero", reset: true, revision: 1 }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("save", "database went read-only (page)", () => storefront("readonly", { page: { slug: "p", title: "P", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: null }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("save", "database never migrated (block)", () => storefront("bare", { block: "hero", value: { title: "Typed" }, revision: null }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
row("save", "database never migrated (page)", () => storefront("bare", { page: { slug: "p", title: "P", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: null }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
row("save", "templates table missing (save as template)", () => storefront("old", { saveTemplate: { name: "T", family: "page", sections: [{ kind: "text", heading: "H", body: ["x"] }] } }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
row("save", "templates table missing (start from a template)", () => storefront("old", { useTemplate: "tpl_any" }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure", doing: "load" });
// before DOC-04 this read failure came back as 409 "edited by someone else"
row("save", "reading the current version fails (block)", () => storefront("broken", { block: "hero", value: { title: "Typed" }, revision: 1 }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("save", "reading the current version fails (reset to default)", () => storefront("broken", { block: "hero", reset: true, revision: 3 }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("save", "reading the current version fails (page)", () => storefront("broken", { page: { slug: "p", title: "P", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: 1 }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("save", "a bug on our side", () => storefront("ok", { page: { get slug() { throw new TypeError("boom: a bug of ours"); }, title: "x" }, revision: null }), { status: 500, code: "INTERNAL_ERROR", cls: "infrastructure" });
// fix round 1: a NOT NULL or CHECK failure used to come back as 409 "edited by someone else"
row("save", "a broken rule that isn't a race (NOT NULL) is ours, not someone else's edit", () => storefront("notnull", { block: "hero", value: { title: "Typed" }, revision: null }), { status: 500, code: "INTERNAL_ERROR", cls: "infrastructure" });
// fix round 1: the hero IS stored, so "nothing was saved" would be false
row("save", "saved, then the editor's refresh fails", () => storefront("nopages", { block: "hero", value: { title: "Stored for real" }, revision: null }), { status: 503, code: "SAVED_RELOAD_FAILED", cls: "infrastructure", doing: "saved" }, async (r) => {
  eq(r.body.saved, true, "says it was saved:");
  ok(!/nothing was saved/.test(r.body.error), "never says nothing was saved:");
  const row = await withTenant(T.nopages, async () => (await import("../lib/db.js")).db.selectFrom("cms_blocks").select(["value", "revision"]).where("key", "=", "hero").executeTakeFirst());
  eq([JSON.parse(row?.value || "{}").title, row?.revision], ["Stored for real", 1], "the hero really is stored:");
});
row("load", "editor load when the database doesn't answer", () => storefrontGet("down"), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("load", "editor load when reads fail", () => storefrontGet("broken"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
// fix round 1: only the block reads were strict; with the pages unreadable the
// load answered 200 with pages: [] and pageRevisions: {} while a page existed
row("load", "editor load when only the page reads fail", () => storefrontGet("nopages"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("load", "editor load when only the page list can't be read", () => storefrontGet("badtitles"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("load", "editor load when only the page versions can't be read (the editor would save against none)", () => storefrontGet("badrevs"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("load", "editor load on a store from before page families, when the page list can't be read", () => storefrontGet("oldpages"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
// P1-FIX-C (P1-DRILLS finding 5): "no such column" read as a store from before
// a migration, so this load answered 200 with no pages while a page existed,
// and a Designer save answered 200 with no notice
row("save", "saved, then the editor's refresh fails on a column nobody expected to be missing (not an old store)", () => storefront("nocol", { block: "hero", value: { title: "Stored while pages break" }, revision: null }), { status: 503, code: "SAVED_RELOAD_FAILED", cls: "infrastructure", doing: "saved" }, async (r) => {
  eq(r.body.saved, true, "says it was saved:");
  const row = await withTenant(T.nocol, async () => (await import("../lib/db.js")).db.selectFrom("cms_blocks").select(["value"]).where("key", "=", "hero").executeTakeFirst());
  eq(JSON.parse(row?.value || "{}").title, "Stored while pages break", "the hero really is stored:");
});
row("load", "editor load when the page reads name a column that isn't there (a broken schema, not an old store)", () => storefrontGet("nocol"), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
// ...and the stores from before a migration still read as they always did
row("load", "a store from before page families still loads, with its page", () => storefrontGet("nofamily"), { status: 200 }, (r) => {
  eq(r.body.pages.map((p) => [p.slug, p.family]), [["kept", "page"]], "pages:");
  eq(r.body.pageRevisions, { kept: 1 }, "page versions:");
});
row("load", "a store from before content pages still loads, with none", () => storefrontGet("nopagestable"), { status: 200 }, (r) => {
  eq([r.body.pages, r.body.pageRevisions], [[], {}], "pages and versions:");
});
// A view that names a missing column breaks every read of it, so the page
// list and the page versions above fail together and each hides the other.
// Here only ONE statement fails, with the driver's own error shape, on a
// healthy store with a page: the read that names the column is the only one hit.
const failingSql = async (name, pattern, message, fn) => {
  const inst = await withTenant(T[name], async () => (await import("../lib/db.js")).currentDatabase());
  const send = inst.libsql.execute;
  inst.libsql.execute = (stmt, ...rest) =>
    pattern.test(typeof stmt === "string" ? stmt : stmt?.sql || "") ? Promise.reject(Object.assign(new Error(`SQLITE_ERROR: ${message}`), { name: "LibsqlError", code: "SQLITE_ERROR" })) : send(stmt, ...rest);
  try {
    return await fn();
  } finally {
    delete inst.libsql.execute;
  }
};
const PAGE_LIST_SQL = /select "slug", "title", "enabled", "updated_at"(, "family")? from "cms_pages"/;
const PAGE_REVS_SQL = /select "slug", "revision" from "cms_pages"/;
row("load", "only the page list's read fails \"no such column\" on a column it never expected missing", () => failingSql("words", PAGE_LIST_SQL, "no such column: nosuch_col", () => storefrontGet("words")), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
row("load", "only the page versions' read fails \"no such column\" on a column it never expected missing", () => failingSql("words", PAGE_REVS_SQL, "no such column: nosuch_col", () => storefrontGet("words")), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
// ...while the expected old shapes of those two reads still load
row("load", "the page versions' read on a store from before revisions (0006) loads, with no versions", () => failingSql("words", PAGE_REVS_SQL, "no such column: revision", () => storefrontGet("words")), { status: 200 }, (r) => {
  eq(r.body.pageRevisions, {}, "versions:");
  ok(r.body.pages.some((p) => p.slug === "partner-network"), "the page is still listed");
});
row("load", "Publishing's load when the approvals table is a view over a table that's gone: 503, not \"no approval\"", () => releasesGet("apprview"), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });

// --- preview -----------------------------------------------------------------------
row("preview", "unsaved hero and sections both wrong", async () => storefront("ok", { previewCandidate: { hero: { title: "" }, home_sections: [{ id: "sec_dd44", kind: "rich_text", html: "" }] } }, { preview: await previewTok("ok") }), { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, (r) => {
  eq(r.body.issues.map((i) => [i.documentId, i.sectionId, i.field]), [["doc_home", "hero", "title"], ["doc_home", "sec_dd44", "html"]], "issues from BOTH blocks, not only the first:");
});
row("preview", "no preview open", () => storefront("ok", { previewCandidate: { hero: { title: "x" } } }), { status: 409, code: "NO_PREVIEW", cls: "refusal" });
row("preview", "a block the preview can't show", async () => storefront("ok", { previewCandidate: { pdp_extras: [] } }, { preview: await previewTok("ok") }), { status: 400, code: "UNKNOWN_BLOCK", cls: "refusal" });
// S59's packet saw "no such table: cms_preview_candidates" reach the editor as a 422
row("preview", "preview table missing (tenant before migration 0016)", async () => storefront("old", { previewCandidate: { hero: { title: "Live" } } }, { preview: await previewTok("old") }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
row("preview", "database went read-only", async () => storefront("readonly", { previewCandidate: { hero: { title: "Live" } } }, { preview: await previewTok("readonly") }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("preview", "database doesn't answer", async () => storefront("down", { previewCandidate: { hero: { title: "Live" } } }, { preview: await previewTok("down") }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("preview", "opening a preview needs no database", () => releases("down", { action: "preview", to: "/" }, { admin: STAFF }), { status: 200 });

// --- publish -----------------------------------------------------------------------
row("publish", "hero has no title", async () => {
  await withTenant(T.ok, () => setBlock("hero", { title: "  " }));
  return releases("ok", { action: "publish" });
}, { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, (r) => {
  ok(r.body.issues.some((i) => i.sectionId === "hero" && i.field === "title"), `hero title issue: ${JSON.stringify(r.body.issues)}`);
  ok(Array.isArray(r.body.sections), "carries the sections being published, to word issues from ids:");
});
row("publish", "banner links to a collection that isn't in the catalog", async () => {
  await withTenant(T.ok, async () => {
    await setBlock("hero", { title: "Fine" });
    await setBlock("home_sections", [{ id: "sec_ee55", kind: "banner", title: "Sale", text: "", label: "Go", href: "/collections/not-here", enabled: true }]);
  });
  return releases("ok", { action: "publish" });
}, { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, (r) => {
  const it = r.body.issues.find((i) => i.code === "LINK_MISSING_TARGET");
  eq([it?.documentId, it?.sectionId, it?.field], ["doc_home", "sec_ee55", "href"], "names the banner by id:");
  eq(r.body.sections, [{ id: "sec_ee55", kind: "banner" }], "sections:");
  eq(issuesModule.issueText(it, { sections: r.body.sections }), 'Section 1 (Banner / CTA): "/collections/not-here" points at a collection that doesn\'t exist in the catalog', "as the Publish panel words it:");
});
row("publish", "drafts changed since review", () => releases("ok", { action: "publish", expectedDraftHash: "f".repeat(64) }), { status: 409, code: "DRAFTS_CHANGED", cls: "refusal" });
row("publish", "schedule time in the past", () => releases("ok", { action: "schedule", at: "2020-01-01T00:00:00.000Z" }), { status: 422, code: "VALIDATION_FAILED", cls: "validation" }, (r) => eq(r.body.issues[0].field, "at", "field:"));
row("publish", "staff can't publish", () => releases("ok", { action: "publish" }, { admin: STAFF }), { status: 403, cls: "refusal" });
row("publish", "undo to a version that doesn't exist", () => releases("ok", { action: "rollback", id: "rel_gone" }), { status: 404, code: "NOT_FOUND", cls: "refusal" });
row("publish", "cancel a release that isn't scheduled", () => releases("ok", { action: "cancel", id: "rel_gone" }), { status: 404, cls: "refusal" });
row("publish", "database doesn't answer", () => releases("down", { action: "publish" }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("publish", "database went read-only", () => releases("readonly", { action: "publish" }), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
// before DOC-04: 422 "release snapshot failed reading pages: SQLITE_ERROR: …"
row("publish", "reading the drafts fails", () => releases("broken", { action: "publish" }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
// The snapshot wraps these two reads in its own error; the answer depends on
// the wrapper keeping the driver's error as its cause (fix round 1: the
// classifier reads the driver's error, never the wrapper's words).
row("publish", "reading the pages fails (blocks read fine)", () => releases("nopages", { action: "publish" }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("publish", "reading the slug redirects fails", () => releases("noredir", { action: "publish" }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
// P1-FIX-C: "no such table" anywhere used to read as "no redirects yet", so
// this publish went live with every slug redirect dropped
row("publish", "the slug redirects read names a table that's gone (not an old store): nothing ships, no redirect is dropped", () => releases("redirview", { action: "publish" }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" }, async () => {
  const live = await withTenant(T.redirview, async () => (await import("../lib/db.js")).db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst());
  eq(live?.live_release_id ?? null, null, "nothing went live:");
});
// before DOC-04: 422 with the raw SQLite text of the catalog lookup
row("publish", "the catalog lookup behind link checks fails", () => releases("links", { action: "publish" }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("publish", "release table missing", () => releases("norel", { action: "publish" }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
// before DOC-04: an unhandled exception, so Next's HTML 500 page
row("publish", "Publishing page load when the database doesn't answer", () => releasesGet("down"), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure", doing: "load" });
// fix round 1: the live pointer HAS moved, so "nothing was published" would be false
row("publish", "published, then the panel's refresh fails", () => releases("noappr", { action: "publish" }), { status: 200 }, async (r) => {
  eq([r.body.ok, r.body.code], [true, "RELOAD_NEEDED"], "a success that says the page is out of date:");
  readable(r.body.notice, "notice");
  ok(/^Published\. Your live store has the new version/.test(r.body.notice) && /Reload it/.test(r.body.notice), `says it went live, then to reload: "${r.body.notice}"`);
  ok(!/nothing was published/.test(JSON.stringify(r.body)), "never says nothing was published:");
  const live = await withTenant(T.noappr, async () => (await import("../lib/db.js")).db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst());
  eq(live?.live_release_id, r.body.published?.id, "the release really is live:");
});

// --- run the matrix ------------------------------------------------------------------
for (const area of ["save", "load", "preview", "publish"]) {
  console.log(`— ${area}`);
  for (const r of MATRIX.filter((m) => m.area === area)) {
    await t(`${area}: ${r.name} → ${r.expect.status}${r.expect.code ? ` ${r.expect.code}` : ""}`, async () => {
      const res = await r.run();
      // FM_SHOW=1 prints what each row answered (used for the review packet's before/after)
      if (process.env.FM_SHOW) console.log(`   → ${res.status} ${JSON.stringify(res.body).slice(0, 260)}`);
      if (r.expect.status === 200) {
        eq(res.status, 200, "status:");
        if (r.extra) await r.extra(res);
        return;
      }
      check(res, { doing: r.area, ...r.expect, label: r.name });
      if (r.extra) await r.extra(res);
    });
  }
}

// --- the console client: failures that never reach our server -----------------------
console.log("— the console client (components/admin/cms/api.js)");
const realFetch = globalThis.fetch;
const withFetch = async (impl, fn) => {
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};
await t("client: no connection → a plain message, not a validation list", async () => {
  const r = await withFetch(async () => {
    throw new TypeError("Failed to fetch");
  }, () => api.saveBlock("hero", { title: "x" }, 1));
  eq([r.ok, r.code], [false, "NETWORK"], "result:");
  readable(r.error, "network");
  ok(/nothing was saved/.test(r.error) && /still here/.test(r.error) && !/network error|failed to fetch/i.test(r.error), `says what happened to the edits, in plain words: "${r.error}"`);
  ok(!r.errors && !r.issues, "no validation list:");
});
await t("client: a gateway's HTML error page → a plain message with the status", async () => {
  const r = await withFetch(async () => ({ ok: false, status: 502, json: async () => JSON.parse("<html>Bad gateway</html>") }), () => api.savePage({ slug: "x" }, 1));
  eq([r.ok, r.code, r.status], [false, "UNREADABLE_RESPONSE", 502], "result:");
  readable(r.error, "gateway");
  ok(r.error.includes("502"), "says the status:");
});
await t("client: a 5xx from our server keeps its plain message and code, and is never a validation list", async () => {
  const served = await storefront("down", { block: "hero", value: { title: "x" }, revision: 1 });
  const r = await withFetch(async () => ({ ok: false, status: served.status, json: async () => served.body }), () => api.saveBlock("hero", { title: "x" }, 1));
  eq([r.ok, r.code, r.error], [false, "DATABASE_UNAVAILABLE", served.body.error], "result:");
  ok(!r.errors && !r.issues && !r.conflict, "no validation list or conflict:");
});
await t("client: saved, then the server's refresh failed → it reads the view once more, and the editor carries on with the new revision", async () => {
  const saved = { error: "Your changes were saved, but this page couldn't refresh. Reload it before you make more changes.", code: "SAVED_RELOAD_FAILED", saved: true, retryable: false };
  const view = (await storefrontGet("ok")).body;
  const calls = [];
  const r = await withFetch(async (url, options) => {
    calls.push(`${options?.method || "GET"} ${url}`);
    return options?.method === "PUT" ? { ok: false, status: 503, json: async () => saved } : { ok: true, status: 200, json: async () => view };
  }, () => api.saveBlock("hero", { title: "x" }, 1));
  eq(calls, ["PUT /api/admin/storefront", "GET /api/admin/storefront"], "one save, one re-read:");
  eq([r.ok, r.revisions], [true, view.revisions], "the fresh view, with the revisions the next save needs:");
});
await t("client: saved, and the re-read fails too → the answer still says it was saved, never a conflict or a validation list", async () => {
  const r = await withFetch(async (url, options) => {
    const res = options?.method === "PUT" ? await storefront("nopages", JSON.parse(options.body)) : await storefrontGet("nopages");
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  }, () => api.saveBlock("hero", { title: "Saved twice" }, 1));
  eq([r.ok, r.code], [false, "SAVED_RELOAD_FAILED"], "result:");
  ok(/^Your changes were saved, but this page couldn't refresh/.test(r.error), `says it was saved: "${r.error}"`);
  ok(!r.errors && !r.issues && !r.conflict, "no validation list or conflict:");
});
await t("client: a 422 keeps the structured issues and words each one", async () => {
  const served = await storefront("ok", { block: "nav_header", value: [{ label: "", href: "/x" }], revision: null });
  const r = await withFetch(async () => ({ ok: false, status: served.status, json: async () => served.body }), () => api.saveBlock("nav_header", [], null));
  eq(r.issues, served.body.issues, "issues:");
  eq(r.errors, ["Header menu, item 1: needs a label and a path/URL"], "worded on the client, from the field path:");
});

// --- the rest of the console API ----------------------------------------------------
console.log("— the other /api/admin routes");
await t("a real /api/admin route (upsells) answers a database failure 503 with a plain message, not its 422 catch-all", async () => {
  const route = await import("../app/api/admin/upsells/route.js");
  const res = await route.POST({
    cookies: { get: (n) => (n === "_admin" ? { value: OWNER } : undefined) },
    headers: { get: (k) => ({ host: `${T.down.id}.test` })[k.toLowerCase()] ?? null },
    json: async () => ({ kind: "cart_upsell", targetHandles: ["tee"], title: "Pairs well" }),
  });
  const body = await res.json();
  if (process.env.FM_SHOW) console.log(`   → ${res.status} ${JSON.stringify(body).slice(0, 260)}`);
  check({ status: res.status, body }, { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure", label: "upsells", doing: "save" });
});
// A route handler called the way Next calls it, for one tenant.
const adminRoute = async (path, method, name, body) => {
  const route = await import(`../app/api/admin/${path}/route.js`);
  const res = await withTenant(T[name], () =>
    route[method]({
      cookies: { get: (n) => (n === "_admin" ? { value: OWNER } : undefined) },
      headers: { get: (k) => ({ host: `${T[name].id}.test` })[k.toLowerCase()] ?? null },
      json: async () => body,
    }),
  );
  const json = await res.json();
  if (process.env.FM_SHOW) console.log(`   → ${res.status} ${JSON.stringify(json).slice(0, 260)}`);
  return { status: res.status, body: json };
};
const NOT_INFRA = (body, label) => ok(!/^DATABASE_|^SAVE_CONFLICT$|^INTERNAL_ERROR$/.test(String(body.code || "")) && !/couldn't reach your store's data/.test(String(body.error)), `${label} is not mistaken for a database failure: ${JSON.stringify(body)}`);

// fix round 1, reproduced first: on a33e0a3..0b98649 both answered 503
// DATABASE_UNAVAILABLE, because the classifier searched the refusal's text
// for "network". bdbe1a7 answered 422 and 409, as these rows require.
await t("a bundle refusal that quotes a product called \"Network Switch 8-port\" keeps its 422 and its reasons", async () => {
  const r = await adminRoute("bundles", "POST", "words", {
    bundle: { slug: "net-kit", title: "Net kit", items: [{ variantId: "gid://shopify/ProductVariant/1" }, { variantId: "gid://shopify/ProductVariant/2" }], bundle_price: 400, enable: true },
  });
  eq(r.status, 422, "status:");
  eq(r.body.problems, ["component 1 (Network Switch 8-port): sold out"], "the reason:");
  eq(r.body.error, "can't enable: component 1 (Network Switch 8-port): sold out", "error:");
  NOT_INFRA(r.body, "bundles");
});
await t("deleting an image used on the page \"partner-network\" keeps its 409 \"still used\" guard (the only way to force-delete)", async () => {
  const r = await adminRoute("media", "DELETE", "words", { id: "med_net1" });
  eq(r.status, 409, "status:");
  eq([r.body.code, r.body.usage], ["MEDIA_IN_USE", [{ where: "page:partner-network" }]], "the guard:");
  NOT_INFRA(r.body, "media");
});
await t("the AI service not answering is named as the AI service, not as the store's data", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.anthropic.com/")) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    return real(url, options);
  };
  try {
    const r = await adminRoute("insights", "POST", "words", { generate: true });
    eq([r.status, r.body.code], [503, "AI_UNAVAILABLE"], "answer:");
    readable(r.body.error, "AI");
    ok(/AI service/.test(r.body.error) && /nothing was stored/.test(r.body.error), `names the AI service: "${r.body.error}"`);
    NOT_INFRA(r.body, "insights");
  } finally {
    globalThis.fetch = real;
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

// --- P1-FIX-C: the offer go-back route (c513d27) -------------------------------------
// Before c513d27 an unknown error was re-thrown (Next's HTML 500 page) and a
// database failure fell through the same way. The order scan below checks the
// shape of the catch; these check what it answers.
console.log("— the offer go-back route (/api/admin/offers/[id]/revert)");
const revertRoute = async (name, id, body = {}) => {
  const route = await import("../app/api/admin/offers/[id]/revert/route.js");
  const res = await route.POST(
    {
      url: `http://${T[name].id}.test/api/admin/offers/${id}/revert`,
      cookies: { get: (n) => (n === "_admin" ? { value: OWNER } : undefined) },
      headers: { get: (k) => ({ host: `${T[name].id}.test` })[k.toLowerCase()] ?? null },
      json: async () => body,
    },
    { params: Promise.resolve({ id }) },
  );
  const json = await res.json();
  if (process.env.FM_SHOW) console.log(`   → ${res.status} ${JSON.stringify(json).slice(0, 260)}`);
  return { status: res.status, body: json };
};
const offerRow = (name, id) => withTenant(T[name], async () => (await import("../lib/db.js")).db.selectFrom("offers").select(["config", "previous_config"]).where("id", "=", id).executeTakeFirst());
await t("go back: a database that doesn't answer → 503 with the plain message, never a 4xx", async () => {
  check(await revertRoute("down", "o-prev"), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure", label: "go back, database down", doing: "save" });
});
await t("go back: reading the offer fails → 503 with the plain message", async () => {
  check(await revertRoute("nooffers", "o-prev"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure", label: "go back, reads fail", doing: "save" });
});
await t("go back: each of the store's refusals keeps its status and its exact body, and changes nothing", async () => {
  const before = await offerRow("offers", "o-prev");
  const cases = [
    ["o-none", {}, 404, { error: "This offer no longer exists.", code: "NOT_FOUND" }],
    ["o-bundle", {}, 409, { error: "This offer belongs to a bundle. Change it where you edit the bundle.", code: "NOT_HERE" }],
    ["o-fresh", {}, 409, { error: "There are no earlier settings for this offer.", code: "NO_PREVIOUS" }],
    ["o-prev", { expect: "2020-01-01T00:00:00.000Z" }, 409, { error: "This offer changed while you were looking at it. Close it and open it again to see its settings now.", code: "CHANGED" }],
    ["o-badprev", {}, 422, { error: "The earlier settings can't be used any more.", code: "OFFER_INVALID" }],
  ];
  for (const [id, body, status, want] of cases) eq(await revertRoute("offers", id, body), { status, body: want }, `${id}:`);
  eq(await offerRow("offers", "o-prev"), before, "the offer is unchanged:");
});
await t("go back: an error that is neither the store's nor the database's → JSON 500 INTERNAL_ERROR, the raw text kept out", async () => {
  const inst = await withTenant(T.offers, async () => (await import("../lib/db.js")).currentDatabase());
  const send = inst.libsql.execute;
  inst.libsql.execute = (stmt, ...rest) => (/from "offers"/i.test(typeof stmt === "string" ? stmt : stmt?.sql || "") ? Promise.reject(new TypeError("boom: a bug of ours")) : send(stmt, ...rest));
  try {
    const r = await revertRoute("offers", "o-prev");
    eq([r.status, r.body.code], [500, "INTERNAL_ERROR"], "answer:");
    readable(r.body.error, "internal");
    ok(/Something went wrong on our side/.test(r.body.error), `plain words: "${r.body.error}"`);
    ok(!/boom/.test(JSON.stringify(r.body)), "the raw text stays in the log");
  } finally {
    delete inst.libsql.execute;
  }
});

// --- P1-FIX-C: only the expected old shape counts as "not there yet" ----------------
console.log("— schema errors that aren't a store from before a migration");
await t("the live pointer read failing on some other table is an error, never \"no release yet\" (which serves drafts to shoppers)", async () => {
  const { getLiveReleaseState } = await import("../lib/releases.js");
  const s = await withTenant(T.relview, () => getLiveReleaseState());
  eq(s.state, "error", `state: ${JSON.stringify(s)}`);
  eq((await withTenant(T.bare, () => getLiveReleaseState())).state, "none", "a store with no release tables yet:");
});
// The page save clears any redirect FROM its slug. That clean-up swallowed every
// error ("pre-migration tenants lack the table"), so a save answered 200 while
// an old redirect kept sending visitors away from the page. The page row and
// the redirects are still two writes (DOC-04's known limit: the answer then
// says nothing was saved, though the row is); DOC-02's single write ends that.
await t("a page save whose redirect clean-up fails is never answered as a success", async () => {
  const r = await storefront("redirview", { page: { slug: "fm-redirclean", title: "Clean", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: null });
  ok(r.status >= 500, `answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  ok(!("issues" in r.body) && /^[A-Z_]+$/.test(String(r.body.code)), `a coded infrastructure answer: ${JSON.stringify(r.body)}`);
  readable(r.body.error, "redirect clean-up");
});
{
  // The page editor's server load (a server component), compiled with Next's
  // SWC and run against the real tenant databases; the editor itself is a stub
  // that keeps its props. DOC-04's known limit: this load had no test.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const file = join(root, "app/(console)/admin/(authed)/storefront/pages/[slug]/page.js");
  const { code } = await swc.transform(await readFile(file, "utf8"), {
    filename: file,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const PageEditor = () => null;
  const stubs = { "next/headers": await import(FM_HEADERS), "@/components/admin/cms/PageEditor": { PageEditor } };
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(
    (id) => (id in stubs ? stubs[id] : id.startsWith("@/") ? require(join(root, id.endsWith(".js") ? id.slice(2) : `${id.slice(2)}.js`)) : require(id)),
    mod,
    mod.exports,
  );
  const EditorPage = mod.exports.default;
  const openEditor = async (name, slug) => {
    globalThis.__fmRequest = { host: `${T[name].id}.test`, cookies: { _admin: OWNER } };
    try {
      return { el: await EditorPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }) };
    } catch (error) {
      return { error };
    } finally {
      globalThis.__fmRequest = null;
    }
  };
  const isNotFound = (e) => /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String(e?.digest || e?.message || ""));
  await t("page editor load: a page whose reads fail \"no such column\" goes to the console's error screen, not a 404", async () => {
    const r = await openEditor("nocol", "kept");
    ok(r.error, `it opened the editor: ${JSON.stringify(r.el?.props?.page)}`);
    ok(!isNotFound(r.error), `it answered 404: ${r.error.message}`);
    eq(issuesModule.infraKind(r.error), "schema", "the database's own error reaches the error boundary:");
  });
  await t("page editor load: only the page's own read fails \"no such column\" (its versions read fine): the error screen, not a 404", async () => {
    const r = await failingSql("words", /from "cms_pages" where "slug" = \?/, "no such column: nosuch_col", () => openEditor("words", "partner-network"));
    ok(r.error && !isNotFound(r.error), `answered: ${r.error?.message ?? JSON.stringify(r.el?.props?.page)}`);
    eq(issuesModule.infraKind(r.error), "schema", "the database's own error reaches the error boundary:");
    const fine = await openEditor("words", "partner-network");
    eq(fine.el?.props?.page?.slug, "partner-network", "without the failure, the page opens:");
  });
  await t("page editor load: on a store from before page families, the page opens in the editor", async () => {
    const r = await openEditor("nofamily", "kept");
    ok(!r.error, `failed: ${r.error?.message}`);
    eq([r.el.type, r.el.props.mode, r.el.props.page.slug, r.el.props.page.family, r.el.props.revision], [PageEditor, "edit", "kept", "page", 1], "editor:");
  });
  await t("page editor load: on a store from before content pages, a page that isn't there is a 404, as before", async () => {
    const r = await openEditor("nopagestable", "kept");
    ok(r.error && isNotFound(r.error), `answered: ${r.error?.message ?? "the editor"}`);
  });
}

// Every catch in an /api/admin route: the route's own known answers first
// (`if (e?.code === …) return …`, `if (e?.problems) return …`), then the
// database check, then the catch-all. The known answers come first so a
// founder-facing refusal can never be overtaken (fix round 1).
await t("every catch-all in an /api/admin route answers its own refusals, then checks for a database failure, then falls back", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory()) await walk(`${dir}/${e.name}`);
      else if (e.name === "route.js") files.push(`${dir}/${e.name}`);
    }
  };
  await walk("app/api/admin");
  ok(files.length >= 30, `found the routes (${files.length}):`);
  const KNOWN_ANSWER = /^\s*if \(e\?\.[a-z]+(?: === "[A-Z_]+"(?: \|\| e\?\.code === "[A-Z_]+")?)?\) return NextResponse\.json\(/i;
  const wrong = [];
  let catches = 0;
  let known = 0;
  for (const f of files) {
    const lines = (await readFile(join(root, f), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (!/\} catch \(e\) \{\s*$/.test(line)) return;
      catches++;
      const indent = line.match(/^\s*/)[0];
      const end = lines.findIndex((l, j) => j > i && l.startsWith(`${indent}}`));
      const block = lines.slice(i + 1, end);
      const infraAt = block.findIndex((l) => /infraResponse\(e\b/.test(l));
      if (infraAt < 0) {
        // a catch that already answers every error 5xx can't mislabel one as a 4xx
        if (block.some((l) => /status: 5\d\d \}/.test(l)) && !block.some((l) => /status: 4\d\d/.test(l))) return;
        wrong.push(`${f}:${i + 1} has no database check`);
        return;
      }
      for (const l of block.slice(0, infraAt)) {
        if (/^\s*\/\//.test(l)) continue;
        if (KNOWN_ANSWER.test(l)) {
          known++;
          continue;
        }
        wrong.push(`${f}:${i + 1} runs something other than a known answer before the database check: ${l.trim().slice(0, 80)}`);
      }
      // P1-FIX-C (DOC-04 review): a known answer AFTER the check is caught by
      // what it is, not only through the count below
      for (const l of block.slice(infraAt + 1)) {
        if (KNOWN_ANSWER.test(l) || /^\s*if \(e\?\.[a-z]+\b/i.test(l)) wrong.push(`${f}:${i + 1} answers one of its own refusals after the database check: ${l.trim().slice(0, 80)}`);
      }
      if (!block.slice(infraAt + 1).some((l) => /return NextResponse\.json\(/.test(l))) wrong.push(`${f}:${i + 1} has no catch-all after the database check`);
    });
  }
  ok(catches >= 20, `found the catch-alls (${catches}):`);
  ok(known >= 11, `found the known answers ahead of the check (${known}):`);
  eq(wrong, [], "catch-alls out of order:");
});

// --- the negative: no position text leaves the server ------------------------------
await t("no save, preview or publish validator builds position text any more (\"Section 2 (banner): …\", \"section 1: …\")", async () => {
  const files = ["lib/cms/validate.js", "lib/cms/store.js", "lib/cms/templates-store.js", "lib/releases.js", "lib/admin/cms-api.js", "lib/admin/releases-api.js"];
  const POSITION_TEXT = /[`"'](?:[Ss]ection|[Hh]ome section|Nav item|Accordion|question)\s+(?:\$\{|\d)|,\s*question \$\{/;
  const found = [];
  for (const f of files) {
    (await readFile(join(root, f), "utf8")).split("\n").forEach((line, i) => {
      if (!/^\s*\/\//.test(line) && POSITION_TEXT.test(line)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  eq(found, [], "position text in a server message:");
});

// --- unit: the wording an editor gets ---------------------------------------------------
await t("worded for a screen that already names the block, a hero issue doesn't repeat \"Hero\"; elsewhere it does", () => {
  const hero = issuesModule.issue({ documentId: "doc_home", sectionId: "hero", field: "title", code: "REQUIRED", message: "Hero title is required" });
  eq(issuesModule.issueText(hero, { documentLabels: false }), "Hero title is required", "in the Designer's hero banner:");
  eq(issuesModule.issueText(hero), "Hero: Hero title is required", "in a list of everything:");
  const nav = issuesModule.issue({ documentId: "doc_footer", field: "items.1.children.0", code: "REQUIRED", message: "needs a label and a path/URL" });
  eq(issuesModule.issueText(nav), "Footer menu, item 2, sub-item 1: needs a label and a path/URL", "a menu sub-item:");
  const wrapped = new Error("release snapshot failed", { cause: Object.assign(new Error("disk"), { name: "LibsqlError", code: "SQLITE_IOERR" }) });
  eq(issuesModule.infraKind(wrapped), "unavailable", "a wrapped driver error is seen through its cause:");
  eq(issuesModule.infraKind(new Error("window end must be after window start")), null, "an ordinary error is not infrastructure:");
});

// --- unit: the classifier reads only what the driver and the network made ------------
await t("our own errors are never infrastructure, whatever words they quote (product titles, page slugs, experiment names)", () => {
  const ours = [
    "can't enable: component 1 (Network Switch 8-port): sold out",
    "still referenced by page:partner-network",
    '"network-timeout-test" already runs on hero — complete it first',
    '"checkout-timed-out" is running — the plan froze at start and can\'t be edited',
    "fetch failed",
    "SQLITE_BUSY: the founder named their product this",
    "no such table: a page title that says so",
    "connection reset by the founder's own words",
    "UNIQUE constraint failed: quoted in a refusal",
  ];
  for (const m of ours) {
    eq(issuesModule.infraKind(new Error(m)), null, `"${m}":`);
    const coded = Object.assign(new Error(m), { code: "OFFER_INVALID" });
    eq(issuesModule.infraKind(coded), null, `"${m}" with a code of ours:`);
  }
});
await t("driver and network errors are classified by their names and codes", () => {
  const libsql = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { name: "LibsqlError", code });
  const sqlite = (code, message) => Object.assign(new Error(message), { name: "SqliteError", code });
  const k = issuesModule.infraKind;
  eq(k(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) })), "unavailable", "undici's fetch failure:");
  eq(k(new TypeError("fetch failed", { cause: new Error("bad port") })), "unavailable", "undici's fetch failure, any cause:");
  eq(k(new TypeError("Cannot read properties of undefined")), null, "any other TypeError is a bug, not the network:");
  eq(k(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), "unavailable", "a socket error:");
  eq(k(Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" })), "unavailable", "an undici timeout:");
  eq(k(libsql("SERVER_ERROR", "Server returned HTTP status 502")), "unavailable", "hosted database's server failed:");
  eq(k(libsql("HRANA_WEBSOCKET_ERROR", "WebSocket closed")), "unavailable", "hosted database's connection failed:");
  eq(k(libsql("SQLITE_BUSY", "SQLITE_BUSY: database is locked")), "unavailable", "locked:");
  eq(k(libsql("SQLITE_READONLY", "SQLITE_READONLY: attempt to write a readonly database")), "unavailable", "read-only:");
  eq(k(libsql("SQLITE_ERROR", "SQLITE_ERROR: no such table: cms_blocks")), "schema", "missing table:");
  eq(k(libsql("SQLITE_ERROR", "SQLITE_ERROR: no such function: nosuch_fn")), "database", "any other driver error:");
  eq(k(libsql("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT: UNIQUE constraint failed: cms_blocks.key", sqlite("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: cms_blocks.key"))), "conflict", "a uniqueness race:");
  eq(k(libsql("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT: NOT NULL constraint failed: cms_blocks.value", sqlite("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed: cms_blocks.value"))), "internal", "NOT NULL is a bug of ours, not a race:");
  eq(k(libsql("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT: CHECK constraint failed: revision > 0")), "internal", "CHECK is a bug of ours, not a race:");
});
await t("failure() keeps a deliberate refusal's status and words (e.expose), and maps a NOT NULL failure to 500", () => {
  const refusal = Object.assign(new Error("publish job is already leased — too late to cancel"), { status: 409, expose: true });
  const f = issuesModule.failure(refusal, { doing: "publish" });
  eq([f.status, f.kind, f.body.error], [409, "refusal", "publish job is already leased — too late to cancel"], "kept:");
  const nn = Object.assign(new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed: x"), { name: "LibsqlError", code: "SQLITE_CONSTRAINT" });
  eq([issuesModule.failure(nn).status, issuesModule.failure(nn).body.code], [500, "INTERNAL_ERROR"], "NOT NULL:");
});

// --- unit: ids are stamped before checking --------------------------------------------
await t("two sections sent with the same id: each issue names the id its own section is saved under", async () => {
  const { validateBlock } = await import("../lib/cms/validate.js");
  const r = validateBlock("home_sections", [
    { id: "sec_dup1", kind: "banner", title: "", text: "", href: "/" },
    { id: "sec_dup1", kind: "banner", title: "", text: "", href: "/" },
  ]);
  const named = r.issues.map((i) => i.sectionId);
  eq(named[0], "sec_dup1", "first keeps its id:");
  ok(named[1] !== "sec_dup1" && /^sec_/.test(named[1]), `second is minted its own: ${named}`);
  eq(named, r.value.map((s) => s.id), "the ids the sections are saved under:");
});

// --- unit: where each publish warning is filed, and how it reads -----------------------
// The "words" tenant gets a home page whose links point at routes this
// platform doesn't serve, in every place a link can live.
const publishWords = async () => {
  await withTenant(T.words, async () => {
    await setBlock("hero", { title: "Fine", primary: { label: "Shop", href: "/x-odd" } });
    await setBlock("announcement", { enabled: true, text: "Sale", href: "/another-odd" });
    await setBlock("nav_header", [{ label: "Shop", href: "/odd-nav" }]);
    await setBlock("home_sections", [
      { id: "sec_txt1", kind: "rich_text", html: "<p>Hello</p>", enabled: true },
      { id: "sec_ban1", kind: "banner", title: "Sale", text: "", label: "Go", href: "/odd-route", enabled: true },
    ]);
  });
};
const WORDED_WARNINGS = [
  "Hero: the primary button links to \"/x-odd\", which isn't a storefront route this platform serves — double-check it",
  "Announcement bar: \"/another-odd\" isn't a storefront route this platform serves — double-check it",
  "Header menu, item 1: “Shop” links to \"/odd-nav\", which isn't a storefront route this platform serves — double-check it",
  "Section 2 (Banner / CTA): \"/odd-route\" isn't a storefront route this platform serves — double-check it",
];
await t("each publish warning is filed under its own document and section (announcement, hero, menu, banner), and reads with one colon", async () => {
  await publishWords();
  const snap = await withTenant(T.words, () => import("../lib/releases.js").then((R) => R.snapshotContent()));
  const v = await withTenant(T.words, () => import("../lib/releases.js").then((R) => R.validateRelease(snap.content)));
  const links = v.issues.filter((i) => i.code === "LINK_UNKNOWN_ROUTE");
  eq(
    links.map((i) => [i.documentId, i.sectionId, i.field]),
    [
      ["doc_home", "hero", "primary.href"],
      ["doc_announcement", null, "href"],
      ["doc_header", null, "items.0.href"],
      ["doc_home", "sec_ban1", "href"],
    ],
    "filed under:",
  );
  const worded = links.map((i) => issuesModule.issueText(i, { sections: v.sections }));
  eq(worded, WORDED_WARNINGS, "as the Publishing panel words them:");
  for (const line of worded) eq(line.split(": ").length, 2, `one colon, after the place: "${line}"`);
});
await t("a product-page accordion issue names its accordion from the field path", async () => {
  const { validateBlock } = await import("../lib/cms/validate.js");
  const r = validateBlock("pdp_extras", [{ title: "Care", html: "<p>Wash cold</p>" }, { title: "", html: "<p>Ships in 2 days</p>" }]);
  eq(r.issues.map((i) => [i.documentId, i.field, i.code]), [["doc_product_layout", "items.1.title", "REQUIRED"]], "issue:");
  eq(issuesModule.issueText(r.issues[0]), "Product page accordions, accordion 2: needs a title", "worded:");
});

// --- the Publishing panel, run for real on stand-in hooks ---------------------------
// ReleasesAdmin compiled with Next's SWC (as test:page-editor does for the
// page editor): useState is a slot list, JSX builds plain objects, console
// components are stubs, and its fetch reaches the REAL releases handler.
// Fix round 1: after Publish now and Schedule the warnings banner showed the
// bare messages, with no place in them.
console.log("— the Publishing panel (components/admin/ReleasesAdmin.js), on stand-in hooks");
{
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const { code } = await swc.transform(await readFile(join(root, "components/admin/ReleasesAdmin.js"), "utf8"), {
    filename: "components/admin/ReleasesAdmin.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  let hooks = null;
  const stubs = new Map();
  const stubModule = () =>
    new Proxy({ __esModule: true }, {
      get: (target, k) => {
        if (k in target) return target[k];
        if (!stubs.has(k)) stubs.set(k, Object.assign(() => null, { displayName: String(k) }));
        return stubs.get(k);
      },
    });
  const toasts = [];
  const modules = {
    react: { useState: (init) => hooks.useState(init) },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" },
    "@/lib/admin/schedule": await import("../lib/admin/schedule.js"),
    "@/components/admin/cms/labels": await import("../components/admin/cms/labels.js"),
    "@/components/admin/cms/api": api,
    "@/lib/cms/issues": issuesModule,
    "@/components/console/Toast": { useToast: () => ({ success: (m) => toasts.push(m), error: (m) => toasts.push(m), info() {} }) },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((id) => modules[id] ?? stubModule(), mod, mod.exports);
  const ReleasesAdmin = mod.exports.default;

  const mount = (initial) => {
    const slots = [];
    let cursor = 0;
    const instance = {
      useState(init) {
        const at = cursor++;
        if (!(at in slots)) slots[at] = typeof init === "function" ? init() : init;
        return [slots[at], (next) => (slots[at] = typeof next === "function" ? next(slots[at]) : next)];
      },
    };
    return () => {
      hooks = instance;
      cursor = 0;
      return ReleasesAdmin({ initial, canPublish: true });
    };
  };
  const find = (node, test, out = []) => {
    if (Array.isArray(node)) node.forEach((n) => find(n, test, out));
    else if (node?.props) {
      if (test(node)) out.push(node);
      Object.values(node.props).forEach((v) => find(v, test, out));
    }
    return out;
  };
  const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join("") : node?.props ? textOf(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "");
  // the result banner: the Banner at the top with no className (the
  // pre-publish warning banners sit inside the card, with "mb-3")
  const resultLines = (tree) => {
    const banner = find(tree, (n) => n.props.tone === "warning" && !n.props.className && n.type?.displayName === "Banner")[0];
    return banner ? [].concat(banner.props.children).map(textOf) : [];
  };
  const withPanelFetch = async (name, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url !== "/api/admin/releases") return real(url, options);
      const res = await releases(name, JSON.parse(options.body));
      return { ok: res.status < 400, status: res.status, json: async () => res.body };
    };
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };

  await t("Publish now: the warnings banner says where each warning is, as the card does before publishing", async () => {
    await publishWords();
    const initial = (await releasesGet("words")).body;
    const render = mount(initial);
    const dialog = find(render(), (n) => n.props.title === "Publish to live?")[0];
    ok(dialog && typeof dialog.props.onConfirm === "function", "found the publish dialog:");
    await withPanelFetch("words", () => dialog.props.onConfirm());
    ok(toasts.includes("Published — live now."), `published: ${toasts}`);
    const lines = resultLines(render());
    for (const w of WORDED_WARNINGS) ok(lines.includes(w), `the banner shows "${w}", got ${JSON.stringify(lines)}`);
  });

  await t("Schedule: the same warnings, worded the same way", async () => {
    await withTenant(T.words, () => setBlock("announcement", { enabled: true, text: "Sale!", href: "/another-odd" })); // a change to schedule
    const initial = (await releasesGet("words")).body;
    const render = mount(initial);
    const input = find(render(), (n) => n.props.id === "release-at")[0];
    input.props.onChange({ target: { value: "2031-06-01T10:00" } });
    const button = find(render(), (n) => n.type?.displayName === "Button" && textOf(n.props.children) === "Schedule")[0];
    ok(button, "found the Schedule button:");
    await withPanelFetch("words", () => button.props.onClick());
    const refused = find(render(), (n) => n.props.tone === "danger" && n.type?.displayName === "Banner" && !n.props.className).map((n) => textOf(n.props.children));
    ok(toasts.some((m) => /^Scheduled for /.test(m)), `scheduled: ${toasts} ${JSON.stringify(refused)}`);
    const lines = resultLines(render());
    for (const w of WORDED_WARNINGS) ok(lines.includes(w), `the banner shows "${w}", got ${JSON.stringify(lines)}`);
  });

  await t("Publish now when the panel can't refresh: the banner says it went live and to reload, never that it failed", async () => {
    const before = (await releasesGet("ok")).body; // a healthy view to start from
    const render = mount({ ...before, draftHash: null });
    const dialog = find(render(), (n) => n.props.title === "Publish to live?")[0];
    await withPanelFetch("noappr", () => dialog.props.onConfirm());
    const lines = resultLines(render());
    ok(/^Published\. Your live store has the new version/.test(lines[0] || ""), `first line: ${JSON.stringify(lines)}`);
    const errors = find(render(), (n) => n.props.tone === "danger" && n.type?.displayName === "Banner" && !n.props.className);
    eq(errors.length, 0, "no error banner:");
  });
}

// --- coverage of the matrix itself -----------------------------------------------------
console.log("— the matrix covers what the code can answer");
await t("every infrastructure code the module can produce appears in the matrix", () => {
  const codes = new Set(MATRIX.map((m) => m.expect.code).filter(Boolean));
  for (const [kind, { code }] of Object.entries(issuesModule.INFRA_CODES || {})) {
    if (kind === "conflict") continue; // a raced CMS write is a CMS_CONFLICT before it can reach the generic mapping
    ok(codes.has(code), `${code} (${kind}) has a row:`);
  }
  for (const area of ["save", "preview", "publish"]) {
    for (const cls of ["validation", "refusal", "infrastructure"]) ok(MATRIX.some((m) => m.area === area && m.expect.cls === cls), `${area} has a ${cls} row:`);
  }
});
await t("each infrastructure message says what happened to the founder's work, in plain words", () => {
  for (const kind of ["schema", "unavailable", "database", "conflict", "internal"]) {
    for (const doing of ["save", "preview", "publish", "load"]) {
      const m = issuesModule.infraMessage(kind, doing);
      readable(m, `${kind}/${doing}`);
      if (doing === "save") ok(/nothing was saved/.test(m) && /still here/.test(m), `${kind}: the founder learns nothing was saved and the edits are kept:`);
      if (doing === "publish") ok(/nothing was published/.test(m) && /hasn't changed/.test(m), `${kind}: the founder learns the live store is untouched:`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
await cleanup();
process.exit(fail ? 1 : 0);
