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
import { readFile, rm, chmod, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

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
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
const build = async (file) => {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(schema);
  await runMigrations(c, migrations);
  return c;
};
// a table whose every read fails with a plain SQLite error (not "missing")
const breakReads = (c, table) => c.executeMultiple(`ALTER TABLE ${table} RENAME TO ${table}_data; CREATE VIEW ${table} AS SELECT *, nosuch_fn(1) AS boom FROM ${table}_data;`);

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

// One row of the matrix. `cls` is the status class the founder's screen keys
// on: "validation" (422 with issues), "refusal" (another 4xx, no issues) or
// "infrastructure" (5xx with a code, no issues).
function check(res, { status, code, cls, label }) {
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
row("save", "templates table missing (start from a template)", () => storefront("old", { useTemplate: "tpl_any" }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
// before DOC-04 this read failure came back as 409 "edited by someone else"
row("save", "reading the current version fails (block)", () => storefront("broken", { block: "hero", value: { title: "Typed" }, revision: 1 }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("save", "reading the current version fails (page)", () => storefront("broken", { page: { slug: "p", title: "P", sections: [{ kind: "text", heading: "H", body: ["x"] }] }, revision: 1 }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("save", "a bug on our side", () => storefront("ok", { page: { get slug() { throw new TypeError("boom: a bug of ours"); }, title: "x" }, revision: null }), { status: 500, code: "INTERNAL_ERROR", cls: "infrastructure" });
row("load", "editor load when the database doesn't answer", () => storefrontGet("down"), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });
row("load", "editor load when reads fail", () => storefrontGet("broken"), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });

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
// before DOC-04: 422 with the raw SQLite text of the catalog lookup
row("publish", "the catalog lookup behind link checks fails", () => releases("links", { action: "publish" }), { status: 503, code: "DATABASE_ERROR", cls: "infrastructure" });
row("publish", "release table missing", () => releases("norel", { action: "publish" }), { status: 503, code: "DATABASE_NOT_READY", cls: "infrastructure" });
// before DOC-04: an unhandled exception, so Next's HTML 500 page
row("publish", "Publishing page load when the database doesn't answer", () => releasesGet("down"), { status: 503, code: "DATABASE_UNAVAILABLE", cls: "infrastructure" });

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
        return;
      }
      check(res, { ...r.expect, label: r.name });
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
await t("client: a 422 keeps the structured issues and words each one", async () => {
  const served = await storefront("ok", { block: "nav_header", value: [{ label: "", href: "/x" }], revision: null });
  const r = await withFetch(async () => ({ ok: false, status: served.status, json: async () => served.body }), () => api.saveBlock("nav_header", [], null));
  eq(r.issues, served.body.issues, "issues:");
  eq(r.errors, ["Header menu, item 1: needs a label and a path/URL"], "worded on the client, from the field path:");
});

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
