// P3-SESSION suite (PV-01, PUB-11, ED-02; drills finding 1): console logout
// ends the person's previews, and the console's client for the documents APIs.
//   1. Logout revokes every unrevoked preview session this actor opened on
//      this store (merchant and bootstrap); another person's rows stay.
//   2. The logout answers clear _preview and _admin (legacy and documents
//      stores); platform logout clears _preview.
//   3. After logout, the old _preview cookie on a documents store gets live
//      content only.
//   4. A revoke failure (no table, a database error, a host with no store)
//      still signs the person out, and logs preview_logout_revoke_failed.
//   5. Logout then a new login: the preview mint works again (legacy
//      Designer and documents editor).
//   6. documentsApi.call maps every example in documents-api-shapes.js;
//      sendKeepalive's limit; startDocumentsPreview and setShowDesign.
//   pnpm test:logout-preview
// request-cache must load before any app module that imports react.
import "./support/request-cache.js";
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();

// next/headers answers for one simulated request at a time (as in
// test-preview-overlay); outside one, headers() and cookies() throw.
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
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-lop-default.db";
process.env.PLATFORM_DB_URL = "file:.test-lop-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const TENANTS = ["ld", "ll", "lb", "lf", "lg"];
const dbs = [".test-lop-default.db", ".test-lop-platform.db", ...TENANTS.map((t) => `.test-lop-${t}.db`)];
const cleanup = async () => {
  for (const f of dbs) for (const s of ["", "-wal", "-shm", "-journal"]) await rm(join(ROOT, f + s), { force: true });
};
await cleanup();

const C = await import("../lib/platform/control.js");
const SS = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const R = await import("../lib/releases.js");
const Res = await import("../lib/content/resolve.js");
const L = await import("../lib/documents/release-list.js");
const ids = await import("../lib/documents/ids.js");
const Svc = await import("../lib/documents/service.js");
const { commitPublishBatch } = await import("../lib/documents/commit.js");
const Reg = await import("../lib/registry/index.js");
const PS = await import("../lib/preview-sessions.js");
const { adminSessionToken } = await import("../lib/admin-auth.js");
const { handlePreviewSessionPost } = await import("../lib/admin/preview-session-api.js");
const { handleReleasesPost } = await import("../lib/admin/releases-api.js");
const { runRequest } = await import("./support/request-cache.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const Shapes = await import("../lib/admin/documents-api-shapes.js");
const Api = await import("../components/admin/editor/documentsApi.js");
const AdminLogout = await import("../app/api/admin/logout/route.js");
const PlatformLogout = await import("../app/api/platform/logout/route.js");
const AdminLogin = await import("../app/api/admin/login/route.js");
const PreviewRoute = await import("../app/api/preview/route.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
const MIGRATIONS = await loadMigrations("tenant");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ") || e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m || "expected truthy");
};
const eq = (got, want, m = "") => {
  if (got !== want) throw new Error(`${m} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const canon = (v) => R.stableStringify(v === undefined ? null : JSON.parse(JSON.stringify(v)));
const same = (got, want, m = "") => {
  if (canon(got) !== canon(want)) throw new Error(`${m}\n      expected ${canon(want).slice(0, 600)}\n      got      ${canon(got).slice(0, 600)}`);
};

// slog lines (JSON on console.log), captured while fn runs.
async function logsDuring(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => {
    const s = a.map(String).join(" ");
    if (s.startsWith("{")) lines.push(JSON.parse(s));
    else orig(...a);
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

// ---- stores and people ----------------------------------------------------------------

const NOW = "2026-11-04T10:00:00.000Z";
async function tenant(id, { mode = "documents", secrets = {} } = {}) {
  await C.upsertTenant({
    id,
    name: `LO ${id}`,
    domains: [`${id}.test`],
    dbUrl: `file:.test-lop-${id}.db`,
    config: { site: { name: `LO ${id} Store` }, site_url: `https://${id}.test` },
    secrets: { order_link_secret: `${id}-secret`, ...secrets },
  });
  const T = await C.getTenant(id);
  await withTenant(T, async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, MIGRATIONS);
    await libsql.execute({ sql: "UPDATE cms_state SET mode = ? WHERE id = 1", args: [mode] });
  });
  return T;
}
const LD = await tenant("ld"); // documents, with a live release and a draft
const LL = await tenant("ll", { mode: "legacy" }); // legacy: the Designer's releases preview
const LB = await tenant("lb", { secrets: { admin_password: "lb-boot-pass-1" } }); // documents, no members yet: bootstrap
const LF = await tenant("lf"); // documents, broken on purpose (failure rows)
const LG = await tenant("lg", { mode: "legacy", secrets: { admin_password: "lg-boot-pass-1" } }); // legacy, bootstrap
const HOST = (T) => (typeof T === "string" ? T : `${T.id}.test`);
const inT = (T, fn) => withTenant(T, fn);

const PASS = { asha: "owner-pass-lo", ravi: "other-pass-lo" };
const asha = await I.createUser({ email: "asha@lo.test", name: "Asha Rao", password: PASS.asha });
const ravi = await I.createUser({ email: "ravi@lo.test", name: "Ravi", password: PASS.ravi });
for (const T of [LD, LL, LF]) {
  await I.addMembership(asha.id, T.id, "owner");
  await I.addMembership(ravi.id, T.id, "owner");
}
const sessionToken = async (u) => (await SS.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const bootToken = (T) => inT(T, () => adminSessionToken());

// A route request: host, optional Origin, cookies, JSON body or query.
function req(T, { cookies = {}, body, path = "/api/admin/logout", origin = null, headers = {} } = {}) {
  const url = new URL(path, `http://${HOST(T)}`);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    url: url.href,
    nextUrl: url,
    cookies: { get: (n) => (Object.hasOwn(cookies, n) && cookies[n] != null ? { name: n, value: cookies[n] } : undefined) },
    headers: { get: (k) => ({ ...lower, host: HOST(T), ...(origin ? { origin } : {}) })[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}
const logout = (T, admin, { preview = null, origin = null } = {}) => AdminLogout.POST(req(T, { cookies: { _admin: admin, _preview: preview }, origin }));

// Set-Cookie of a response, by cookie name: { value, attrs (lower-case keys) }.
function setCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const i = pair.indexOf("=");
    const attrs = {};
    for (const a of rest) {
      const j = a.indexOf("=");
      attrs[(j < 0 ? a : a.slice(0, j)).toLowerCase()] = j < 0 ? true : a.slice(j + 1);
    }
    out[pair.slice(0, i)] = { value: pair.slice(i + 1), attrs };
  }
  return out;
}
// A cleared cookie with the attributes /api/preview sets (not Secure outside production).
function cleared(c, name) {
  ok(c, `${name} is not in the Set-Cookie headers`);
  eq(c.value, "", `${name} value:`);
  eq(c.attrs["max-age"], "0", `${name} Max-Age:`);
  eq(c.attrs.path, "/", `${name} Path:`);
  eq(c.attrs.httponly, true, `${name} HttpOnly:`);
  eq(String(c.attrs.samesite).toLowerCase(), "lax", `${name} SameSite:`);
  eq(c.attrs.secure, undefined, `${name} Secure (not production):`);
}

// The preview-session console route, as it is called.
const previewAdmin = (T, admin, body) => inT(T, () => handlePreviewSessionPost(req(T, { cookies: { _admin: admin }, body, path: "/api/admin/preview-session" })));
async function mint(T, admin) {
  const r = await previewAdmin(T, admin, { create: true });
  if (r.status !== 200) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const rowsOf = (T) =>
  inT(T, async () => (await libsql.execute("SELECT id, created_by, revoked_at FROM preview_sessions ORDER BY id")).rows.map((r) => ({ id: String(r.id), by: String(r.created_by), revoked: r.revoked_at != null })));

// One simulated storefront request on T's host with these cookies.
async function asRequest(T, fn, cookies = {}) {
  globalThis.__readRequest = { host: HOST(T), cookies };
  try {
    return await runRequest(() => inT(T, fn));
  } finally {
    globalThis.__readRequest = null;
  }
}

// ---- LD's live release: a home page, then a saved draft over it ------------------------

const sec = (kind, id, settings = {}) => {
  const s = Reg.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings } };
};
const homeBody = (title) => {
  const b = Reg.emptyBody("home");
  b.sections = [sec("hero", "sec_hero", { title, subtitle: `${title} words` })];
  return b;
};
await inT(LD, async () => {
  const b = homeBody("Live hero");
  const hash = await Reg.documentHash(b);
  await libsql.execute({
    sql: "INSERT INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES ('doc_home', 'home', NULL, 'Home page', ?, ?, 1, 1, ?, ?)",
    args: [JSON.stringify(b), hash, NOW, NOW],
  });
  const canonical = R.stableStringify(b);
  const v = { id: ids.verId(), document_id: "doc_home", kind: "published", body: canonical, body_hash: await R.sha256Hex(canonical), schema_version: 1, created_at: NOW };
  const build = {
    releaseId: ids.relId(),
    setId: ids.setId(),
    pointer: null,
    versions: [v],
    documents: [{ id: "doc_home", revision: 1, published_version_id: v.id, published_hash: hash }],
    log: [{ id: ids.logId(), document_id: "doc_home", action: "publish", to_version_id: v.id }],
    actor: "test",
    now: NOW,
  };
  build.list = L.setEntries(L.emptyList(1, Reg.singletonTypes()), [{ document: "doc_home", entry: { version: v.id, hash: v.body_hash }, pages: [], redirects: [] }]);
  const r = await commitPublishBatch(build);
  if (r.outcome !== "ok") throw new Error(`publish: ${JSON.stringify(r).slice(0, 300)}`);
  await Svc.saveDraft({ id: "doc_home", revision: 1, body: homeBody("Draft hero"), actor: { kind: "merchant", id: asha.id } });
});
const heroOf = (T, preview) =>
  asRequest(T, async () => ({ hero: (await Res.resolvedHero())?.title ?? null, preview: (await Res.contentSource()).preview }), preview ? { _preview: preview } : {});

// =====================================================================================
console.log("— 1. logout revokes this actor's previews on this store, and no one else's");
// =====================================================================================
await t("merchant: every unrevoked session Asha opened here (two devices) is revoked; Ravi's stay; Asha's on another store stay", async () => {
  const A1 = await sessionToken(asha);
  const A2 = await sessionToken(asha); // a second device
  const RV = await sessionToken(ravi);
  const a1 = await mint(LD, A1);
  const a2 = await mint(LD, A2);
  const r1 = await mint(LD, RV);
  const elsewhere = await mint(LF, A1); // Asha, another store
  // a row of another store in the same database (stores that share one file)
  await inT(LD, () =>
    libsql.execute({
      sql: "INSERT INTO preview_sessions (id, tenant_id, created_by, created_at, expires_at, revoked_at, show_design) VALUES ('ps_aaaaaaaaaaaaaaaa', 'other_store', ?, ?, ?, NULL, 0)",
      args: [`merchant:${asha.id}`, NOW, "2099-01-01T00:00:00.000Z"],
    }),
  );
  const before = await rowsOf(LD);
  eq(before.filter((r) => r.by === `merchant:${asha.id}` && !r.revoked && r.id !== "ps_aaaaaaaaaaaaaaaa").length, 2, "Asha's live rows before:");
  const { result: res, lines } = await logsDuring(() => logout(LD, A1));
  eq(res.status, 200, "logout status:");
  same(await res.json(), { ok: true }, "logout body:");
  const after = await rowsOf(LD);
  for (const sid of [a1.sid, a2.sid]) ok(after.find((r) => r.id === sid).revoked, `${sid} should be revoked`);
  ok(!after.find((r) => r.id === r1.sid).revoked, "Ravi's session must stay");
  ok(!(await rowsOf(LF)).find((r) => r.id === elsewhere.sid).revoked, "Asha's session on another store must stay");
  ok(!after.find((r) => r.id === "ps_aaaaaaaaaaaaaaaa").revoked, "another store's row in the same database must stay");
  for (const sid of [a1.sid, a2.sid]) eq((await inT(LD, () => PS.readPreviewSession(sid))).reason, "revoked", "storefront read:");
  eq((await inT(LD, () => PS.readPreviewSession(r1.sid))).ok, true, "Ravi's still counts:");
  ok(lines.some((l) => l.evt === "preview_logout_revoked" && l.count === 2), "logs the count");
  ok(!lines.some((l) => l.evt === "preview_logout_revoke_failed"), "no failure line");
  eq(await SS.verifySession(A1, "merchant"), null, "the console session is revoked too:");
  ok(await SS.verifySession(A2, "merchant"), "the other device's console session is not (only its previews end)");
});

await t("an already-revoked row keeps its first revoked_at (only unrevoked rows are written)", async () => {
  const A = await sessionToken(asha);
  const s = await mint(LD, A);
  await inT(LD, () => PS.revokePreviewSession({ sid: s.sid }));
  const at = (await inT(LD, () => libsql.execute({ sql: "SELECT revoked_at FROM preview_sessions WHERE id = ?", args: [s.sid] }))).rows[0].revoked_at;
  await new Promise((r) => setTimeout(r, 5));
  await logout(LD, A);
  eq((await inT(LD, () => libsql.execute({ sql: "SELECT revoked_at FROM preview_sessions WHERE id = ?", args: [s.sid] }))).rows[0].revoked_at, at, "revoked_at:");
});

await t("bootstrap: the shared-password cookie's sessions are revoked; a merchant row on the same store stays", async () => {
  const B = await bootToken(LB);
  const b1 = await mint(LB, B);
  const b2 = await mint(LB, B);
  eq((await rowsOf(LB)).find((r) => r.id === b1.sid).by, "bootstrap:bootstrap", "created_by of a bootstrap mint:");
  // a row someone else wrote (a member added later, say)
  const other = await inT(LB, () => PS.createPreviewSession({ actor: { kind: "merchant", id: "usr_someone" } }));
  const res = await logout(LB, B);
  eq(res.status, 200, "status:");
  const after = await rowsOf(LB);
  ok(after.find((r) => r.id === b1.sid).revoked && after.find((r) => r.id === b2.sid).revoked, "bootstrap rows revoked");
  ok(!after.find((r) => r.id === other.sid).revoked, "the merchant row stays");
});

await t("no actor (no cookie, or a cookie that names no one): nothing is revoked, logout still answers and clears", async () => {
  const RV = await sessionToken(ravi);
  const s = await mint(LD, RV);
  for (const admin of [null, "not-a-token"]) {
    const { result: res, lines } = await logsDuring(() => logout(LD, admin));
    eq(res.status, 200, "status:");
    const c = setCookies(res);
    cleared(c._admin, "_admin");
    cleared(c._preview, "_preview");
    ok(!lines.some((l) => String(l.evt).startsWith("preview_logout")), "no log line for no actor");
  }
  ok(!(await rowsOf(LD)).find((r) => r.id === s.sid).revoked, "Ravi's session stays");
});

await t("unit: revokePreviewSessionsFor never sweeps rows with no known author", async () => {
  // P3-FIX1: a row written with no known author (created_by 'unknown') is
  // there to be swept, so the guard is really exercised
  const sid = "ps_00000000000a0b0c";
  const exp = new Date(Date.now() + 3600_000).toISOString();
  await inT(LD, () => libsql.execute({ sql: "INSERT INTO preview_sessions (id, tenant_id, created_by, created_at, expires_at, revoked_at, show_design) VALUES (?, ?, 'unknown', ?, ?, NULL, 0)", args: [sid, LD.id, NOW, exp] }));
  const n = await inT(LD, () => PS.revokePreviewSessionsFor({ actor: null }));
  eq(n, 0, "rows:");
  eq(await inT(LD, () => PS.revokePreviewSessionsFor({ actor: { kind: "merchant" } })), 0, "rows for an actor with no id:");
  eq(await inT(LD, () => PS.revokePreviewSessionsFor({ actor: {} })), 0, "rows for an empty actor:");
  // a real person's logout leaves it too
  await inT(LD, () => PS.revokePreviewSessionsFor({ actor: { kind: "merchant", id: asha.id } }));
  const row = (await rowsOf(LD)).find((r) => r.id === sid);
  ok(row && row.by === "unknown", "the 'unknown' row is there");
  eq(row.revoked, false, "the 'unknown' row is never revoked:");
  await inT(LD, () => libsql.execute({ sql: "DELETE FROM preview_sessions WHERE id = ?", args: [sid] }));
});

await t("a cross-origin logout is refused before anything is revoked", async () => {
  const A = await sessionToken(asha);
  const s = await mint(LD, A);
  const res = await logout(LD, A, { origin: "https://evil.example" });
  eq(res.status, 403, "status:");
  ok(!(await rowsOf(LD)).find((r) => r.id === s.sid).revoked, "nothing revoked");
  ok(await SS.verifySession(A, "merchant"), "session kept");
});

// =====================================================================================
console.log("— 2. the cookies logout clears");
// =====================================================================================
await t("documents store: Set-Cookie clears _preview and _admin (Max-Age=0, Path=/, HttpOnly, SameSite=Lax)", async () => {
  const A = await sessionToken(asha);
  const s = await mint(LD, A);
  const c = setCookies(await logout(LD, A, { preview: s.token }));
  cleared(c._admin, "_admin");
  cleared(c._preview, "_preview");
});
await t("legacy store (merchant and bootstrap): the same two cookies are cleared", async () => {
  const c1 = setCookies(await logout(LL, await sessionToken(asha), { preview: "p.1.x" }));
  cleared(c1._admin, "_admin");
  cleared(c1._preview, "_preview");
  const c2 = setCookies(await logout(LG, await bootToken(LG)));
  cleared(c2._admin, "_admin");
  cleared(c2._preview, "_preview");
});
await t("platform logout clears _preview too (and the operator cookie as before)", async () => {
  const res = await PlatformLogout.POST(req("ops.test", { cookies: { _platform: "whatever" }, path: "/api/platform/logout" }));
  eq(res.status, 200, "status:");
  const c = setCookies(res);
  cleared(c._preview, "_preview");
  ok(c._platform && c._platform.attrs["max-age"] === "0", "the operator cookie is still cleared");
});
await t("the cleared cookies are Secure in production (the attribute /api/preview sets)", async () => {
  // the attributes are read once at module load, so check the source line
  for (const f of ["app/api/admin/logout/route.js", "app/api/platform/logout/route.js"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(/secure: process\.env\.NODE_ENV === "production"/.test(src), `${f} sets secure in production`);
  }
});

// =====================================================================================
console.log("— 3. the old preview cookie after logout");
// =====================================================================================
await t("documents store: before logout the cookie shows the draft; after, the same cookie serves live content only", async () => {
  const A = await sessionToken(asha);
  const s = await mint(LD, A);
  same(await heroOf(LD, s.token), { hero: "Draft hero", preview: true }, "before logout:");
  await logout(LD, A, { preview: s.token });
  same(await heroOf(LD, s.token), { hero: "Live hero", preview: false }, "the old cookie after logout:");
  same(await heroOf(LD, null), { hero: "Live hero", preview: false }, "no cookie:");
});

// =====================================================================================
console.log("— 4. a revoke failure never blocks logout");
// =====================================================================================
async function failingLogout(T, admin, reason) {
  const { result: res, lines } = await logsDuring(() => logout(T, admin));
  eq(res.status, 200, `${reason}: status:`);
  same(await res.json(), { ok: true }, `${reason}: body:`);
  const c = setCookies(res);
  cleared(c._admin, "_admin");
  cleared(c._preview, "_preview");
  const line = lines.find((l) => l.evt === "preview_logout_revoke_failed");
  ok(line, `${reason}: logs preview_logout_revoke_failed (got ${JSON.stringify(lines.map((l) => l.evt))})`);
  eq(line.reason, reason, "reason:");
  return line;
}
await t("no table (a store before 0022): normal logout, cookies cleared, logged as no_table, console session revoked", async () => {
  const A = await sessionToken(asha);
  await inT(LF, () => libsql.executeMultiple("ALTER TABLE preview_sessions RENAME TO preview_sessions_kept;"));
  try {
    await failingLogout(LF, A, "no_table");
    eq(await SS.verifySession(A, "merchant"), null, "the console session is still revoked:");
  } finally {
    await inT(LF, () => libsql.executeMultiple("ALTER TABLE preview_sessions_kept RENAME TO preview_sessions;"));
  }
});
await t("a database error on the revoke: normal logout, cookies cleared, logged as error", async () => {
  const A = await sessionToken(asha);
  const s = await mint(LF, A);
  await inT(LF, () => libsql.execute("CREATE TRIGGER lop_refuse_u BEFORE UPDATE ON preview_sessions BEGIN SELECT RAISE(ABORT, 'disk said no'); END"));
  try {
    const line = await failingLogout(LF, A, "error");
    ok(/disk said no/.test(line.error), "the driver's message is logged");
    eq(await SS.verifySession(A, "merchant"), null, "the console session is still revoked:");
  } finally {
    await inT(LF, () => libsql.execute("DROP TRIGGER lop_refuse_u"));
  }
  ok(!(await rowsOf(LF)).find((r) => r.id === s.sid).revoked, "(the row could not be written, as the failure says)");
});
await t("a thrown error from the database client itself: still a normal logout", async () => {
  const A = await sessionToken(asha);
  await mint(LF, A);
  const db = await import("../lib/db.js");
  const inst = await inT(LF, () => db.currentDatabase());
  const orig = inst.libsql.execute;
  inst.libsql.execute = async (q) => {
    if (/UPDATE preview_sessions/.test(typeof q === "string" ? q : q.sql)) throw new Error("socket hang up");
    return orig.call(inst.libsql, q);
  };
  try {
    await failingLogout(LF, A, "error");
  } finally {
    inst.libsql.execute = orig;
  }
});
await t("unit: endPreviewsAtLogout never throws, even when naming the actor throws (logged as error)", async () => {
  const { result, lines } = await logsDuring(() =>
    inT(LF, () =>
      PS.endPreviewsAtLogout({
        resolveActor: async () => {
          throw new Error("control plane down");
        },
      }),
    ),
  );
  eq(result, 0, "ended:");
  const line = lines.find((l) => l.evt === "preview_logout_revoke_failed");
  ok(line && line.reason === "error" && /control plane down/.test(line.error), "logged");
});
await t("a host with no store (unresolved tenant): normal logout, cookies cleared, logged as no_tenant", async () => {
  const A = await sessionToken(asha);
  await failingLogout("nobody.test", A, "no_tenant");
  eq(await SS.verifySession(A, "merchant"), null, "the console session is still revoked:");
});

// =====================================================================================
console.log("— 5. logout, then a new login: the preview mint works again");
// =====================================================================================
async function login(T, body) {
  const res = await AdminLogin.POST({ ...req(T, { path: "/api/admin/login" }), json: async () => body });
  if (res.status !== 200) throw new Error(`login: ${res.status} ${JSON.stringify(await res.json())}`);
  return setCookies(res)._admin.value;
}
// The legacy Designer's preview: POST /api/admin/releases {action:"preview"}, then
// GET the token URL, which sets _preview.
async function designerPreview(T, admin) {
  const r = await inT(T, () => handleReleasesPost(req(T, { cookies: { _admin: admin }, body: { action: "preview", to: "/" }, path: "/api/admin/releases" })));
  if (r.status !== 200) return { status: r.status, body: r.body };
  const res = await PreviewRoute.GET(req(T, { path: r.body.url }));
  return { status: r.status, redirect: res.status, cookie: setCookies(res)._preview };
}
await t("legacy store, merchant: preview, logout, new login, and the Designer's preview mint succeeds and its cookie previews", async () => {
  const first = await login(LL, { email: "asha@lo.test", password: PASS.asha });
  const p1 = await designerPreview(LL, first);
  eq(p1.status, 200, "first mint:");
  await logout(LL, first, { preview: p1.cookie.value });
  eq((await designerPreview(LL, first)).status, 401, "the old console cookie can't mint:");
  const second = await login(LL, { email: "asha@lo.test", password: PASS.asha });
  const p2 = await designerPreview(LL, second);
  eq(p2.status, 200, "mint after a new login:");
  eq(p2.redirect, 302, "the token URL redirects:");
  ok(p2.cookie && p2.cookie.value.startsWith("p.") && Number(p2.cookie.attrs["max-age"]) > 0, "and sets a fresh _preview cookie");
  const src = await asRequest(LL, () => Res.contentSource(), { _preview: p2.cookie.value });
  eq(src.preview, true, "the new cookie previews the drafts:");
  eq(src.mode, "draft", "legacy draft preview:");
});
await t("legacy store, bootstrap: logout, the shared password again, and the mint succeeds", async () => {
  const first = await login(LG, { password: "lg-boot-pass-1" });
  eq((await designerPreview(LG, first)).status, 200, "first mint:");
  await logout(LG, first);
  const second = await login(LG, { password: "lg-boot-pass-1" });
  eq((await designerPreview(LG, second)).status, 200, "mint after logging in again:");
});
await t("documents store: logout, new login, a new preview session is made and counts (the revoke left nothing stale)", async () => {
  const first = await login(LD, { email: "ravi@lo.test", password: PASS.ravi });
  const s1 = await mint(LD, first);
  await logout(LD, first, { preview: s1.token });
  const second = await login(LD, { email: "ravi@lo.test", password: PASS.ravi });
  const s2 = await mint(LD, second);
  eq((await inT(LD, () => PS.readPreviewSession(s2.sid))).ok, true, "the new session counts:");
  same(await heroOf(LD, s2.token), { hero: "Draft hero", preview: true }, "and shows the draft:");
  eq((await inT(LD, () => PS.readPreviewSession(s1.sid))).reason, "revoked", "the old one stays ended:");
});

// =====================================================================================
console.log("— 6. documentsApi: the console's client");
// =====================================================================================
// A fetch stub: answers with (status, body) and records each request.
function stubFetch(answer) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const a = typeof answer === "function" ? await answer(url, init, calls.length) : answer;
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => (a.raw !== undefined ? JSON.parse(a.raw) : a.body) };
  };
  f.calls = calls;
  return f;
}
const outcomesOf = (op) => {
  const s = Shapes.SHAPES[op];
  return s.outcomes || Shapes.SHAPES[s.sameOutcomesAs].outcomes;
};
const ALLOWED = {
  ok: ["ok", "data"],
  conflict: ["conflict", "code", "current", "message", "conflicts"],
  refused: ["refused", "code", "message", "other", "offer", "current"],
  issues: ["issues", "code", "message", "offer", "documents"],
  needsRevision: ["needsRevision", "code", "message"],
  notBuilt: ["notBuilt", "code", "message"],
  error: ["error", "code", "message"],
};
const TECH = ["Unauthorized", "Cross-origin request rejected"];
// What the brief says each outcome maps to, worked out from the example alone.
function expected(o) {
  const b = o.body;
  if (o.status >= 200 && o.status < 300) return { kind: "ok", data: b };
  if (o.status === 409 && ["DOCUMENT_CHANGED", "PUBLISHED_ELSEWHERE"].includes(b.code)) return { kind: "conflict", code: b.code, current: b.current ?? null, message: b.error };
  if (o.status === 409) return { kind: "refused", code: b.code, message: b.error, other: b.other, offer: b.offer };
  if (o.status === 422) return { kind: "issues", code: b.code, issues: b.issues, message: b.error, offer: b.offer };
  if (o.status === 428) return { kind: "needsRevision", code: b.code };
  if (o.status === 501) return { kind: "notBuilt", code: b.code };
  return { kind: "error", code: b.code, message: TECH.includes(b.error) ? null : b.error };
}

const ALL_OPS = Object.keys(Shapes.SHAPES);
let mapped = 0;
await t(`call() maps every example outcome of every operation (${ALL_OPS.length} operations, their own and the common outcomes)`, async () => {
  for (const op of ALL_OPS) {
    const { [op]: value, ...extra } = Shapes.SHAPES[op].request;
    const outcomes = { ...Shapes.COMMON.outcomes, ...outcomesOf(op) };
    for (const [name, o] of Object.entries(outcomes)) {
      const f = stubFetch({ status: o.status, body: o.body });
      const api = Api.createDocumentsApi({ fetch: f });
      const r = await api.call(op, value, extra);
      const where = `${op}.${name}:`;
      // the request: one PUT of exactly the contract's example request
      eq(f.calls.length, 1, `${where} requests`);
      eq(f.calls[0].url, "/api/admin/documents", `${where} url`);
      eq(f.calls[0].init.method, "PUT", `${where} method`);
      same(JSON.parse(f.calls[0].init.body), Shapes.SHAPES[op].request, `${where} request body`);
      const want = expected(o);
      const kind = Object.keys(ALLOWED).find((k) => r[k] !== undefined && (k !== "issues" || Array.isArray(r.issues)) && (k !== "error" || r.error === true));
      eq(kind, want.kind, `${where} kind`);
      // P3-FIX1: a key is the result's own, or a field of the body kept as sent
      for (const k of Object.keys(r)) ok(ALLOWED[kind].includes(k) || (kind !== "ok" && k !== "error" && Object.hasOwn(o.body, k)), `${where} unexpected key ${k}`);
      if (kind !== "ok") {
        for (const k of Object.keys(o.body)) {
          if (k === "error") continue;
          ok(Object.hasOwn(r, k), `${where} the body's ${k} was dropped`);
          same(r[k], o.body[k], `${where} ${k}`);
        }
      }
      if (kind === "ok") {
        same(r.data, want.data, `${where} data`);
        eq(r.ok, true, `${where} ok`);
      } else {
        eq(r.code, want.code ?? r.code, `${where} code`);
        ok(typeof r.code === "string" && r.code, `${where} has a code`);
        ok(typeof r.message === "string" && r.message.length > 10, `${where} has words`);
        ok(!/[a-z]+_[A-Z0-9]{8,}|\bver_|\blog_|\bh_draft/.test(r.message), `${where} words carry no ids`);
      }
      if (want.message) eq(r.message, want.message, `${where} message`);
      if (kind === "conflict") {
        same(r.current, want.current, `${where} current`);
        if (r.current) eq(r.current.updatedByName, "Asha", `${where} updatedByName`);
      }
      if (kind === "refused" || kind === "issues") {
        // offer null (FIRST_PUBLISH_NEEDS_HOME, no home page yet) is kept as sent
        if (want.offer !== undefined) same(r.offer, want.offer, `${where} offer`);
        else eq(r.offer, undefined, `${where} no offer`);
      }
      if (kind === "refused") {
        if (want.other !== undefined) same(r.other, want.other, `${where} other`);
        else eq(r.other, undefined, `${where} no other`);
      }
      if (kind === "issues") same(r.issues, want.issues, `${where} issues`);
      mapped++;
    }
  }
  // Every example outcome in the contract, counted from the contract itself, so a later
  // item that adds examples (P3-COMMIT added 17) is still checked in full. The floor is
  // the count when this suite was written: the contract never drops an example.
  const total = ALL_OPS.reduce((n, op) => n + Object.keys({ ...Shapes.COMMON.outcomes, ...outcomesOf(op) }).length, 0);
  eq(mapped, total, "outcomes mapped:");
  ok(total >= 360, `the contract lost examples: ${total} < 360`);
});
await t("the conflict carries updatedByName for every 409 DOCUMENT_CHANGED or PUBLISHED_ELSEWHERE example that has current", async () => {
  let n = 0;
  for (const op of ALL_OPS)
    for (const o of Object.values(outcomesOf(op))) {
      if (o.status !== 409 || !["DOCUMENT_CHANGED", "PUBLISHED_ELSEWHERE"].includes(o.body.code)) continue;
      const r = await Api.createDocumentsApi({ fetch: stubFetch(o) }).call(op, {});
      eq(r.conflict, true, `${op}:`);
      eq(r.current.updatedByName, "Asha", `${op} updatedByName:`);
      n++;
    }
  ok(n >= 9, `conflict examples: ${n}`);
});
await t("a set conflict without a top-level current gives current null and the per-document conflicts", async () => {
  const { current, ...body } = Shapes.SHAPES.publish.outcomes.changed.body;
  const r = await Api.createDocumentsApi({ fetch: stubFetch({ status: 409, body }) }).call("publishSet", []);
  eq(r.conflict, true, "conflict:");
  eq(r.current, null, "current:");
  eq(r.conflicts.length, 1, "conflicts:");
});
await t("a rejected fetch gives NETWORK_ERROR in plain words; so does a fetch that throws at once", async () => {
  for (const f of [async () => Promise.reject(new TypeError("Failed to fetch")), () => { throw new TypeError("boom"); }]) {
    const r = await Api.createDocumentsApi({ fetch: f }).call("getDocument", "doc_home");
    same(Object.keys(r).sort(), ["code", "error", "message"], "keys:");
    eq(r.error, true, "error:");
    eq(r.code, "NETWORK_ERROR", "code:");
    ok(/couldn't reach/.test(r.message) && /still here/.test(r.message), "plain words");
  }
});
await t("nothing throws: unreadable bodies, an unknown operation, a body JSON can't hold, odd responses", async () => {
  const api = (answer) => Api.createDocumentsApi({ fetch: stubFetch(answer) });
  const r1 = await api({ status: 200, raw: "<html>" }).call("getDocument", "doc_home");
  same(r1, { error: true, code: "UNREADABLE_RESPONSE", message: Shapes.COMMON.outcomes.internalError.body.error }, "unreadable 200:");
  const r2 = await api({ status: 502, raw: "Bad gateway" }).call("getDocument", "doc_home");
  eq(r2.error, true, "502:");
  eq(r2.code, "INTERNAL_ERROR", "502 code:");
  const r3 = await api({ status: 503, raw: "" }).call("saveDraft", {}, { revision: 1 });
  eq(r3.message, Shapes.COMMON.outcomes.databaseUnavailable.body.error, "503 with no body uses the contract's words:");
  const f = stubFetch({ status: 200, body: {} });
  const r4 = await Api.createDocumentsApi({ fetch: f }).call("dropTable", {});
  eq(r4.code, "UNKNOWN_OPERATION", "unknown op:");
  eq(f.calls.length, 0, "an unknown op is not sent");
  const cyc = {};
  cyc.self = cyc;
  eq((await api({ status: 200, body: {} }).call("saveDraft", cyc)).code, "MALFORMED", "cyclic args:");
  eq((await api({ status: 200, body: {} }).call("saveDraft", {}, { n: 1n })).code, "MALFORMED", "BigInt:");
  const r5 = await Api.createDocumentsApi({ fetch: async () => undefined }).call("getDocument", "doc_home");
  eq(r5.error, true, "no response object:");
  const r6 = await Api.createDocumentsApi({ fetch: async () => ({ status: 200, get json() { throw new Error("getter"); } }) }).call("getDocument", "doc_home");
  eq(r6.code, "UNREADABLE_RESPONSE", "a json getter that throws:");
  const r7 = await api({ status: 401, body: { error: "Unauthorized" } }).call("getDocument", "doc_home");
  same(r7, { error: true, code: "UNAUTHORIZED", message: r7.message }, "401:");
  ok(/signed out/.test(r7.message), "401 in plain words, not 'Unauthorized'");
  const r8 = await api({ status: 403, body: { error: "Cross-origin request rejected" } }).call("getDocument", "doc_home");
  ok(!/Cross-origin/.test(r8.message) && r8.code === "FORBIDDEN", "403 cross-origin in plain words");
  const r9 = await api({ status: 418, body: null }).call("getDocument", "doc_home");
  eq(r9.error, true, "an unexpected 4xx is an error:");
});
await t("call() sends the operation with its top-level keys (revision) and same-origin credentials", async () => {
  const f = stubFetch({ status: 200, body: { ok: true } });
  await Api.createDocumentsApi({ fetch: f }).call("saveDraft", { id: "doc_home", body: {} }, { revision: 7 });
  same(JSON.parse(f.calls[0].init.body), { saveDraft: { id: "doc_home", body: {} }, revision: 7 }, "body:");
  eq(f.calls[0].init.credentials, "same-origin", "credentials:");
  eq(f.calls[0].init.headers["Content-Type"], "application/json", "content type:");
});
await t("the module imports the shapes file (no restated shapes) and stays plain JS", async () => {
  const src = await readFile(join(ROOT, "components/admin/editor/documentsApi.js"), "utf8");
  ok(/from "\.\.\/\.\.\/\.\.\/lib\/admin\/documents-api-shapes\.js"/.test(src), "imports documents-api-shapes.js");
  const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  same(imports, ["../../../lib/admin/documents-api-shapes.js"], "its only import:");
  ok(!/from "react"|node:|process\.env|document\.|window\./.test(src), "no React, node, env or DOM");
  same(Api.OPERATIONS, Object.keys(Shapes.SHAPES), "operations come from SHAPES:");
});

await t("P3-FIX1: error and refusal bodies keep retryable, release, reason, missing, slug and document (and today's code, message, other, offer, current)", async () => {
  const C0 = Shapes.COMMON.outcomes;
  const P0 = Shapes.SHAPES.publish.outcomes;
  const cases = [
    ["503 DATABASE_UNAVAILABLE", C0.databaseUnavailable, "error", { retryable: true }],
    ["503 DATABASE_NOT_READY", C0.databaseNotReady, "error", { retryable: false }],
    ["409 SAVE_CONFLICT", C0.saveConflict, "refused", { retryable: true }],
    ["500 INTERNAL_ERROR", C0.internalError, "error", { retryable: true }],
    ["503 PUBLISH_UNKNOWN", { status: 503, body: { error: "Your publish may have gone live. Reload to check.", code: "PUBLISH_UNKNOWN", release: { id: "rel_1" } } }, "error", { release: { id: "rel_1" } }],
    ["500 PUBLISH_FAILED", { status: 500, body: { error: "Something went wrong on our side, so nothing was published.", code: "PUBLISH_FAILED", reason: "THREW" } }, "error", { reason: "THREW" }],
    ["404 DOCUMENT_DELETED", { status: 404, body: { error: "This page was deleted while you were publishing. Reload to see the current pages.", code: "DOCUMENT_DELETED", missing: ["doc_home"] } }, "error", { missing: ["doc_home"] }],
    ["409 SLUG_TAKEN", { status: 409, body: { error: "Another page already uses this web address.", code: "SLUG_TAKEN", slug: "about-us", other: { id: "doc_x", label: "About" } } }, "refused", { slug: "about-us", other: { id: "doc_x", label: "About" } }],
    ["409 NOT_PUBLISHABLE", { status: 409, body: { error: "The menu is published with the pages that use it.", code: "NOT_PUBLISHABLE", document: "doc_header" } }, "refused", { document: "doc_header" }],
  ];
  // the contract's own examples carry these fields too
  ok(Object.values(P0).some((o) => o.body?.release) || JSON.stringify(Shapes.SHAPES).includes('"release"'), "the contract has a release example");
  for (const [name, o, kind, fields] of cases) {
    const r = await Api.createDocumentsApi({ fetch: stubFetch(o) }).call("publish", {});
    eq(r[kind], true, `${name} kind:`);
    eq(r.code, o.body.code, `${name} code:`);
    eq(r.message, o.body.error, `${name} message:`);
    for (const [k, v] of Object.entries(fields)) same(r[k], v, `${name} ${k}:`);
    eq(r.error === true ? kind : r.error, kind === "error" ? "error" : undefined, `${name} the body's words are never copied over the error flag:`);
  }
  // a body field never overwrites the result's own keys
  const r = await Api.createDocumentsApi({ fetch: stubFetch({ status: 503, body: { error: "Try again.", code: "DATABASE_ERROR", ok: true, refused: true, message: "x" } }) }).call("publish", {});
  same([r.error, r.ok, r.refused, r.message], [true, undefined, undefined, "Try again."], "reserved keys:");
});

console.log("— 6b. sendKeepalive");
await t("sendKeepalive: sent with keepalive at 60,000 bytes; false above it (bytes, not characters) and nothing sent", async () => {
  const f = stubFetch({ status: 200, body: { ok: true } });
  const api = Api.createDocumentsApi({ fetch: f });
  const shell = JSON.stringify({ revision: 3, saveDraft: { id: "doc_home", body: { t: "" } } });
  const fill = (n) => ({ id: "doc_home", body: { t: "a".repeat(n) } });
  const atLimit = fill(Api.KEEPALIVE_MAX_BYTES - Api.byteLength(shell));
  eq(Api.byteLength(JSON.stringify({ revision: 3, saveDraft: atLimit })), 60_000, "fixture size:");
  eq(api.sendKeepalive("saveDraft", atLimit, { revision: 3 }), true, "exactly 60,000 bytes:");
  eq(f.calls.length, 1, "sent:");
  eq(f.calls[0].init.keepalive, true, "keepalive:");
  eq(f.calls[0].init.method, "PUT", "method:");
  eq(f.calls[0].url, "/api/admin/documents", "url:");
  eq(api.sendKeepalive("saveDraft", fill(Api.KEEPALIVE_MAX_BYTES - Api.byteLength(shell) + 1), { revision: 3 }), false, "60,001 bytes:");
  // 25,000 rupee signs: 25,000 characters, 75,000 bytes
  eq(api.sendKeepalive("saveDraft", { id: "doc_home", body: { t: "₹".repeat(25_000) } }, { revision: 3 }), false, "multi-byte text over the limit:");
  eq(f.calls.length, 1, "nothing more was sent");
});
await t("sendKeepalive never throws: a rejecting fetch, a throwing fetch, an unknown op", async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on("unhandledRejection", onRej);
  try {
    eq(Api.createDocumentsApi({ fetch: () => Promise.reject(new Error("gone")) }).sendKeepalive("saveDraft", {}, { revision: 1 }), true, "handed over:");
    eq(Api.createDocumentsApi({ fetch: () => { throw new Error("no"); } }).sendKeepalive("saveDraft", {}, { revision: 1 }), false, "throwing fetch:");
    eq(Api.createDocumentsApi({ fetch: stubFetch({ status: 200, body: {} }) }).sendKeepalive("nope", {}), false, "unknown op:");
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onRej);
  }
  eq(rejections.length, 0, "no unhandled rejection:");
});

console.log("— 6c. startDocumentsPreview and setShowDesign, against the real routes");
// A fetch that runs the real console route and the real /api/preview route
// for one store and one console cookie, keeping the browser's _preview cookie.
function browser(T, admin) {
  const jar = {};
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/api/admin/preview-session") {
      const r = await previewAdmin(T, admin, JSON.parse(init.body));
      return { status: r.status, json: async () => r.body };
    }
    if (url.startsWith("/api/preview?")) {
      const res = await PreviewRoute.GET(req(T, { path: url, headers: init.headers || {} }));
      const c = setCookies(res)._preview;
      if (c) jar._preview = c.value;
      // as a browser does: redirect "manual" gives an opaque redirect (status 0)
      if (res.status >= 300 && res.status < 400 && init.redirect === "manual") return { type: "opaqueredirect", status: 0, json: async () => Promise.reject(new SyntaxError("opaque")) };
      const text = await res.text();
      return { type: "basic", status: res.status, json: async () => JSON.parse(text) };
    }
    throw new TypeError(`unexpected fetch ${url}`);
  };
  return { f, jar, calls };
}
await t("documents store: {sid, expiresAt}; the cookie it set previews the draft; the session is this person's", async () => {
  const A = await sessionToken(asha);
  const b = browser(LD, A);
  const r = await Api.createDocumentsApi({ fetch: b.f }).startDocumentsPreview();
  eq(r.ok, true, `start: ${JSON.stringify(r)}`);
  ok(/^ps_[0-9a-f]{16}$/.test(r.sid), "sid:");
  ok(!Number.isNaN(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt) > Date.now(), "expiresAt in the future");
  eq(r.showDesign, false, "showDesign:");
  same(b.calls.map((c) => [c.url.split("?")[0], c.init.method]), [["/api/admin/preview-session", "POST"], ["/api/preview", "GET"]], "requests:");
  same(JSON.parse(b.calls[0].init.body), { create: true }, "posts {create:true}:");
  eq(b.calls[1].init.credentials, "same-origin", "same-origin:");
  eq(b.calls[1].init.redirect, "manual", "P3-FIX1: the cookie fetch never follows the redirect to the home page:");
  eq(b.calls[1].init.headers?.[Api.PREVIEW_CONFIRM_HEADER], "1", "P3-FIX1: it asks /api/preview to confirm:");
  ok(b.jar._preview && b.jar._preview.includes(r.sid), "the httpOnly cookie holds this session");
  same(await heroOf(LD, b.jar._preview), { hero: "Draft hero", preview: true }, "preview:");
  eq((await rowsOf(LD)).find((x) => x.id === r.sid).by, `merchant:${asha.id}`, "created_by:");
});
await t("showDesign: true sets it before the cookie is fetched; setShowDesign(sid, false) turns it off", async () => {
  const A = await sessionToken(asha);
  const b = browser(LD, A);
  const api = Api.createDocumentsApi({ fetch: b.f });
  const r = await api.startDocumentsPreview({ showDesign: true });
  eq(r.ok, true, "start:");
  eq(r.showDesign, true, "showDesign:");
  same(JSON.parse(b.calls[1].init.body), { showDesign: { sid: r.sid, on: true } }, "second request:");
  eq(b.calls[2].url.split("?")[0], "/api/preview", "then the cookie:");
  eq((await inT(LD, () => PS.readPreviewSession(r.sid))).session.showDesign, true, "row:");
  const off = await api.setShowDesign(r.sid, false);
  eq(off.ok, true, "off:");
  eq(off.data.showDesign, false, "answer:");
  eq((await inT(LD, () => PS.readPreviewSession(r.sid))).session.showDesign, false, "row after:");
  const gone = await api.setShowDesign("ps_0000000000000000", true);
  same([gone.error, gone.code], [true, "PREVIEW_SESSION_NOT_FOUND"], "unknown session:");
  ok(/preview has ended/.test(gone.message), "in plain words");
});
await t("legacy store: 409 STORE_USES_LEGACY comes back as a refusal in plain words, and no cookie is fetched", async () => {
  const b = browser(LL, await sessionToken(asha));
  const r = await Api.createDocumentsApi({ fetch: b.f }).startDocumentsPreview({ showDesign: true });
  eq(r.refused, true, `refused: ${JSON.stringify(r)}`);
  eq(r.code, "STORE_USES_LEGACY", "code:");
  eq(r.message, "This store still uses the current Storefront editor, so it previews from there. Use Preview in Storefront instead.", "words:");
  eq(b.calls.length, 1, "only the create was sent");
  eq(b.jar._preview, undefined, "no cookie");
});
await t("startDocumentsPreview: signed out, offline, and a previewUrl that isn't this origin's /api/preview", async () => {
  const signedOut = await Api.createDocumentsApi({ fetch: browser(LD, null).f }).startDocumentsPreview();
  same([signedOut.error, signedOut.code], [true, "UNAUTHORIZED"], "signed out:");
  const offline = await Api.createDocumentsApi({ fetch: async () => Promise.reject(new TypeError("Failed to fetch")) }).startDocumentsPreview();
  eq(offline.code, "NETWORK_ERROR", "offline:");
  for (const previewUrl of ["https://evil.example/api/preview?token=x", "//evil.example/api/preview?x", "/api/preview\\@evil?x", "/elsewhere"]) {
    const f = stubFetch({ status: 200, body: { ok: true, sid: "ps_0123456789abcdef", token: "p.1.x", expiresAt: NOW, showDesign: false, previewUrl } });
    const r = await Api.createDocumentsApi({ fetch: f }).startDocumentsPreview();
    eq(r.error, true, `${previewUrl}:`);
    eq(f.calls.length, 1, `${previewUrl} is never fetched`);
  }
  // the cookie fetch fails after the session was made
  const f2 = stubFetch((url) => (url.startsWith("/api/preview") ? Promise.reject(new TypeError("Failed")) : { status: 200, body: { ok: true, sid: "ps_0123456789abcdef", expiresAt: NOW, previewUrl: "/api/preview?token=t&to=/" } }));
  const r2 = await Api.createDocumentsApi({ fetch: f2 }).startDocumentsPreview();
  eq(r2.code, "NETWORK_ERROR", "cookie fetch failed:");
  ok(/preview/.test(r2.message), "says the preview didn't open");
});

await t("P3-FIX1: a showDesign step that answers 404 or 5xx makes startDocumentsPreview return that error, and no cookie is fetched", async () => {
  const made = { status: 200, body: { ok: true, sid: "ps_0123456789abcdef", token: "p.1.x", expiresAt: NOW, showDesign: false, previewUrl: "/api/preview?token=t&to=/" } };
  for (const answer of [
    { status: 404, body: { error: "This preview has ended. Open the preview again.", code: "PREVIEW_SESSION_NOT_FOUND" } },
    { status: 503, body: Shapes.COMMON.outcomes.databaseUnavailable.body },
    { status: 500, body: Shapes.COMMON.outcomes.internalError.body },
    { status: 502, raw: "Bad gateway" },
  ]) {
    const f = stubFetch((url, init) => (url === "/api/admin/preview-session" && JSON.parse(init.body).create ? made : answer));
    const r = await Api.createDocumentsApi({ fetch: f }).startDocumentsPreview({ showDesign: true });
    eq(r.error, true, `${answer.status}: ${JSON.stringify(r)}`);
    eq(r.ok, undefined, `${answer.status} is not ok:`);
    eq(r.showDesign, undefined, `${answer.status} never claims the design is shown:`);
    eq(r.code, answer.body?.code ?? "INTERNAL_ERROR", `${answer.status} code:`);
    ok(!f.calls.some((c) => c.url.startsWith("/api/preview?")), `${answer.status}: no cookie fetched`);
  }
});

await t("P3-FIX1: a refused preview token is an error, not {ok:true}; so is an answer that only redirects, or a 5xx", async () => {
  // the real routes, with the token in previewUrl spoilt on the way
  const A = await sessionToken(asha);
  const b = browser(LD, A);
  const spoil = async (url, init) => {
    const res = await b.f(url, init);
    if (url !== "/api/admin/preview-session") return res;
    const data = await res.json();
    if (data?.previewUrl) data.previewUrl = data.previewUrl.replace(/token=([^&]+)/, (m, t) => `token=${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`);
    return { status: res.status, json: async () => data };
  };
  const refused = await Api.createDocumentsApi({ fetch: spoil }).startDocumentsPreview();
  eq(refused.error, true, `refused: ${JSON.stringify(refused)}`);
  eq(refused.code, "PREVIEW_TOKEN_REFUSED", "code:");
  ok(/didn't open/.test(refused.message), "plain words");
  eq(b.jar._preview, undefined, "no cookie was set");
  // a server that answers the cookie fetch with a redirect has not confirmed it
  const made = { status: 200, body: { ok: true, sid: "ps_0123456789abcdef", expiresAt: NOW, previewUrl: "/api/preview?token=t&to=/" } };
  for (const [label, cookieAnswer, code] of [
    ["opaque redirect", { type: "opaqueredirect", status: 0 }, "PREVIEW_NOT_CONFIRMED"],
    ["302", { status: 302 }, "PREVIEW_NOT_CONFIRMED"],
    ["200 that is not a confirmation", { status: 200, body: { hello: 1 } }, "PREVIEW_NOT_CONFIRMED"],
    // P3-FIX2: a 2xx whose body can't be read didn't confirm the preview either
    ["200 with no readable body", { status: 200, raw: "not json" }, "PREVIEW_NOT_CONFIRMED"],
    ["204 with no body", { status: 204, body: null }, "PREVIEW_NOT_CONFIRMED"],
    ["503 suspended store", { status: 503, body: { error: "This store is temporarily unavailable", code: "TENANT_SUSPENDED" } }, "TENANT_SUSPENDED"],
    ["500", { status: 500, raw: "oops" }, "INTERNAL_ERROR"],
  ]) {
    const f = async (url) => (url === "/api/admin/preview-session" ? { status: 200, json: async () => made.body } : { type: cookieAnswer.type || "basic", status: cookieAnswer.status, json: async () => (cookieAnswer.raw !== undefined ? JSON.parse(cookieAnswer.raw) : cookieAnswer.body) });
    const r = await Api.createDocumentsApi({ fetch: f }).startDocumentsPreview();
    eq(r.error, true, `${label}: ${JSON.stringify(r)}`);
    eq(r.code, code, `${label} code:`);
    // P3-FIX2: the preview's own words, never a save's ("nothing was saved")
    if (code === "PREVIEW_NOT_CONFIRMED") ok(/couldn't open the preview/.test(r.message) && !/saved/.test(r.message), `${label} words: ${r.message}`);
  }
});

await t("P3-FIX1: /api/preview without the confirm header answers as before (302 with the cookie, or 302 with none for a bad token)", async () => {
  const A = await sessionToken(asha);
  const made = await previewAdmin(LD, A, { create: true });
  const url = made.body.previewUrl;
  const good = await PreviewRoute.GET(req(LD, { path: url }));
  eq(good.status, 302, "a good token:");
  ok(setCookies(good)._preview?.value, "sets the cookie");
  const bad = await PreviewRoute.GET(req(LD, { path: url.replace(/token=([^&]+)/, "token=p.1.bad") }));
  eq(bad.status, 302, "a bad token:");
  eq(setCookies(bad)._preview, undefined, "no cookie");
  const confirmed = await PreviewRoute.GET(req(LD, { path: url, headers: { [Api.PREVIEW_CONFIRM_HEADER]: "1" } }));
  eq(confirmed.status, 200, "with the header:");
  same(await confirmed.json(), { ok: true }, "the confirmation:");
  ok(setCookies(confirmed)._preview?.value, "and the same cookie");
});

// ---- done ------------------------------------------------------------------------------
await cleanup();
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed (${secs}s)`);
process.exit(fail ? 1 : 0);
