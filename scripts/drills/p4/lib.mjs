// P4-HARNESS: shared helpers for the phase 4 drills (MIG-02, MIG-03, MIG-04),
// on the design harness in desktop Chrome. Everything the phase 3 helpers do
// (scripts/drills/p3/lib.mjs, imported, never edited) plus what phase 4 needs.
// Not a test:* suite: drills need a harness and Chrome.
//
//   DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 node scripts/drills/p4/run.mjs [seed,smoke]
//   node scripts/drills/p4/lib.mjs --check     the helpers' own checks (no harness)
//
// From the phase 3 helpers (re-exported as they are):
//   runDrill(spec, fn)        Chrome up, fn(drill), results written, the harness
//                             it started stopped
//   p3Ports()                 the harness ports; refuses 3017 (the owner's harness)
//   storeSql(store, stmts)    read the running harness's local databases
//   startOwned(), stopOwned(), runNode(), storeUrl(), docsApi(), bodyText(),
//   noThanks(), readSeed(), DrillError, settle
// Added here:
//   login(drill, role, opts)  drill.login(role, opts): 'owner' | 'staff' through
//                             the real form. After --p4 the logins come from
//                             .design-data/p3-seed.json, which --p4 writes too.
//   reseedP4(drill, {start})  stops the harness this run started, seeds the
//                             phase 4 store fresh (seed-design-documents.js --p4:
//                             a LEGACY store live on a v3 release) and starts
//                             the harness again. Returns { seed, out }.
//   readP4Seed()              .design-data/p4-seed.json (ids, paths, the seed list)
//   p4SeedState()             check --p4, read only: the seed list's counts,
//                             what the live release froze, where the
//                             module-only photo is used
//   captureShopperRoutes(baseUrl, routes, outDir, { unit })
//                             each route fetched as a shopper: no session, no
//                             preview, no console cookie. One cookie only: a
//                             fixed experiment unit (_unit=p4-capture), because
//                             a request with NO unit cookie is NOT deterministic
//                             (app/(storefront)/page.js gives it a random unit,
//                             so a running hero experiment serves a random
//                             variant). With the fixed unit every capture of
//                             one store serves the same variant. { unit: null }
//                             sends no cookie at all. Redirects are recorded,
//                             not followed. Writes <outDir>/<name>.html and
//                             <outDir>/index.json; returns the index.
//   assertLocal(url)          throws unless the address is on this machine
//                             (localhost, *.localhost, 127.0.0.1, ::1, or a
//                             file: path with no host); refuses 3017 too
//   selfCheck()               assertLocal refuses non-local addresses and
//                             p3Ports still refuses 3017 (run by the smoke
//                             stage, and by `node lib.mjs --check`)
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT } from "../../design-harness.js";
import { DrillError, OWNER_PORT, p3Ports, runNode, startOwned, stopOwned } from "../p3/lib.mjs";

export * from "../p3/lib.mjs";

export const P4_SEED_PATH = join(ROOT, DATA_DIR_NAME, "p4-seed.json");
export const CAPTURE_DIR = join(ROOT, DATA_DIR_NAME, "p4-captures");
// the experiment unit every capture sends (see captureShopperRoutes)
export const CAPTURE_UNIT = "p4-capture";

// ---------- refusing anything but this machine ----------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertLocal(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    throw new DrillError(`"${String(url).slice(0, 80)}" is not a full address. Phase 4 drills only use addresses on this machine, like http://localhost:6160.`);
  }
  if (u.protocol === "file:") {
    if (u.host) throw new DrillError(`Refusing ${String(url).slice(0, 80)}: a file on another machine. Only files on this machine are allowed.`);
    return String(url);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new DrillError(`Refusing ${u.protocol}// addresses: phase 4 drills only open http or https pages on this machine.`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) {
    throw new DrillError(`Refusing ${u.origin}: phase 4 drills only talk to this machine (localhost, 127.0.0.1 or ::1), never a hosted or real store.`);
  }
  if (Number(u.port) === OWNER_PORT) throw new DrillError(`Refusing ${u.origin}: port ${OWNER_PORT} is the owner's harness and a drill never uses it.`);
  return String(url);
}

// The helpers' own checks. Returns [{ ok, label, detail }]; never throws.
export function selfCheck() {
  const refused = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof DrillError ? e.message : `not a DrillError: ${e?.message}`;
    }
  };
  const out = [];
  const remote = ["https://shop.example.com/", "http://storeasy.in/products/x", "https://staging.example.com/", "http://10.0.0.5:6160/", "http://localhost.example.com/", "libsql://shop-x.turso.io", "file://other-host/x.db", "http://localhost:3017/", "not a url"];
  const r = remote.map((u) => [u, refused(() => assertLocal(u))]);
  out.push({ ok: r.every(([, m]) => m), label: "assertLocal refuses addresses that are not on this machine (and the owner's port 3017)", detail: Object.fromEntries(r) });
  const local = ["http://localhost:6160/", "http://127.0.0.1:7160", "http://[::1]:6160/", "http://closed.localhost:6160/", "file:/tmp/x.db", "file:.test-x.db"];
  const l = local.map((u) => [u, refused(() => assertLocal(u))]);
  out.push({ ok: l.every(([, m]) => m === null), label: "assertLocal lets addresses on this machine through", detail: Object.fromEntries(l) });
  const p = [
    ["DESIGN_PORT 3017", refused(() => p3Ports({ DESIGN_PORT: String(OWNER_PORT), DESIGN_SQLD_PORT: "7160" }))],
    ["DESIGN_PORT unset (means 3017)", refused(() => p3Ports({ DESIGN_SQLD_PORT: "7160" }))],
  ];
  const fine = refused(() => p3Ports({ DESIGN_PORT: "6160", DESIGN_SQLD_PORT: "7160" }));
  out.push({ ok: p.every(([, m]) => m && m.includes(String(OWNER_PORT))) && fine === null, label: "p3Ports still refuses 3017 (set or by default) and takes this run's own ports", detail: { ...Object.fromEntries(p), "DESIGN_PORT 6160": fine } });
  return out;
}

// ---------- the phase 4 seed ----------

export const login = (drill, role, opts) => drill.login(role, opts);

export function readP4Seed() {
  try {
    return JSON.parse(readFileSync(P4_SEED_PATH, "utf8"));
  } catch {
    throw new DrillError(`There is no phase 4 seed config (${DATA_DIR_NAME}/p4-seed.json). Reseed: node scripts/seed-design-documents.js --p4 (with the harness stopped).`);
  }
}

export async function p4SeedState() {
  const r = await runNode([join(ROOT, "scripts", "seed-design-documents.js"), "check", "--p4"]);
  const line = r.out.trim().split("\n").filter((l) => l.startsWith('{"mode"')).pop();
  if (r.code !== 0 || !line) throw new DrillError(`check --p4 failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`);
  return JSON.parse(line);
}

// Seed the phase 4 store fresh and (start: true) start the harness again.
export async function reseedP4(drill, { start = true } = {}) {
  await stopOwned();
  const r = await runNode([join(ROOT, "scripts", "seed-design-documents.js"), "--p4"]);
  const line = r.out.split("\n").filter((l) => /^[✓✗]/.test(l)).pop() || r.out.trim().split("\n").pop();
  if (r.code !== 0) throw new DrillError(`seeding the phase 4 store failed: ${line}`);
  if (start) await startOwned();
  drill?.note(`re-seeded fresh (--p4): ${String(line).replace(/^✓ /, "")}`);
  return { seed: readP4Seed(), out: r.out };
}

// ---------- what a shopper gets ----------

const safeName = (path) =>
  String(path)
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80) || "home";

// routes: ["/path", …] or [{ path, name }, …]. Only the fixed unit cookie is
// sent (none with { unit: null }); nothing is kept between requests, and
// redirects are recorded, not followed.
export async function captureShopperRoutes(baseUrl, routes, outDir = CAPTURE_DIR, { unit = CAPTURE_UNIT } = {}) {
  assertLocal(baseUrl);
  mkdirSync(outDir, { recursive: true });
  const index = [];
  for (const r of routes) {
    const { path, name } = typeof r === "string" ? { path: r, name: safeName(r) } : { path: r.path, name: r.name || safeName(r.path) };
    const url = new URL(path, baseUrl);
    assertLocal(url.href);
    if (url.origin !== new URL(baseUrl).origin) throw new DrillError(`Refusing ${path}: a capture stays on ${new URL(baseUrl).origin}.`);
    const headers = { accept: "text/html" };
    if (unit != null) headers.cookie = `_unit=${encodeURIComponent(unit)}`;
    const res = await fetch(url, { redirect: "manual", headers });
    const body = await res.text();
    const file = `${name}.html`;
    writeFileSync(join(outDir, file), body);
    index.push({
      path,
      name,
      unit: unit ?? null,
      status: res.status,
      location: res.headers.get("location"),
      contentType: res.headers.get("content-type"),
      setsCookie: res.headers.has("set-cookie"),
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      file,
    });
  }
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify({ baseUrl, capturedAt: new Date().toISOString(), routes: index }, null, 2)}\n`);
  return index;
}

// ---------- P4-DRILLS: the move, the copy, the editor (shared by the stages) ----------
//
//   sleep(ms), waitFor(fn, ms, step), rowsOf(result)
//   sqlAt(url, stmts)           statements on one local database (assertLocal first)
//   copyDatabase(from, to)      every table and row of one local database into
//                               another (what was there is dropped first)
//   harnessContext()            the running harness's ports, database addresses,
//                               env (harnessEnv, PLATFORM_CACHE_MS 1000), the
//                               shopper address and the operator commands:
//                               migrate(args), reverse(args), render(args)
//   drillScratch(name)          a folder for this run's copies and reports:
//                               P4_DRILL_SCRATCH/<name> (default: a new folder
//                               in the system's temporary folder)
//   copyServer(scratch)         a second local sqld (COPY_SQLD_PORT, default
//                               DESIGN_SQLD_PORT + 3) for restore-drill copies
//   revokeAgency(ctx)           the demo seed's agency access removed (the
//                               move refuses a store with agency access)
//   makeRoutes(drill, ctx, dir) migrate-render --make-routes for the store
//   moveStore(drill, ctx, opts) the move as the owner runs it: a copy in the
//                               copy server, the store's row pointed at it, the
//                               rehearsal, the row pointed back, the dry run,
//                               then the move with the digest and the report
//   publishHere(page), waitSaved(page), searchFor(page, base, q),
//   pickInto(page, group, query)  the editor's own controls, as the founder
//                               uses them (P4-EDITOR's drill helpers)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 30_000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(step);
  }
  return false;
}
export const rowsOf = (r) => r.rows.map((x) => ({ ...x }));

export async function sqlAt(url, statements) {
  assertLocal(url);
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url });
  try {
    const out = [];
    for (const s of statements) out.push(await c.execute(typeof s === "string" ? { sql: s, args: [] } : s));
    return out;
  } finally {
    c.close();
  }
}

export async function copyDatabase(fromUrl, toUrl) {
  assertLocal(fromUrl);
  assertLocal(toUrl);
  const { createClient } = await import("@libsql/client");
  const src = createClient({ url: fromUrl });
  const dst = createClient({ url: toUrl });
  const skip = "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'";
  try {
    const old = await dst.execute(`SELECT name, type FROM sqlite_master WHERE ${skip} AND type IN ('table', 'view', 'trigger')`);
    for (const r of old.rows) await dst.execute(`DROP ${String(r.type).toUpperCase()} IF EXISTS "${r.name}"`);
    const master = await src.execute(`SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND ${skip} ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`);
    const tables = [];
    for (const row of master.rows) {
      await dst.execute(String(row.sql));
      if (row.type === "table") tables.push(String(row.name));
    }
    let rows = 0;
    for (const t of tables) {
      const data = await src.execute(`SELECT * FROM "${t}"`);
      const cols = data.columns;
      const stmts = data.rows.map((r) => ({ sql: `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => r[c]) }));
      for (let i = 0; i < stmts.length; i += 200) await dst.batch(stmts.slice(i, i + 200), "write");
      rows += stmts.length;
    }
    return { tables: tables.length, rows };
  } finally {
    src.close();
    dst.close();
  }
}

export const STORE_ID = "design";
// a console page of the harness store (this machine only)
export const consoleUrl = (base, path) => assertLocal(new URL(path, base).href);

export async function harnessContext() {
  const H = await import("../../design-harness.js");
  const ports = p3Ports();
  const urls = H.harnessUrls(ports);
  for (const u of Object.values(urls)) assertLocal(u);
  const env = { ...H.harnessEnv(process.env, H.readCredentials(ROOT), ports), PLATFORM_CACHE_MS: process.env.PLATFORM_CACHE_MS || "1000" };
  // the operator commands never see a hosted address: the harness env blanks
  // Turso, Typesense and Shopify, and points both databases at this run's sqld
  for (const k of ["PLATFORM_DB_URL", "DATABASE_URL"]) assertLocal(env[k]);
  const node = (file) => (args, opts = {}) => runNode([join(ROOT, file), ...args], { env: { ...env, ...(opts.env || {}) }, timeoutMs: opts.timeoutMs });
  return {
    ports,
    urls,
    env,
    base: `http://localhost:${ports.next}`,
    store: STORE_ID,
    migrate: node("scripts/migrate-documents.js"),
    reverse: node("scripts/reverse-documents.js"),
    render: node("scripts/migrate-render.mjs"),
  };
}

export function drillScratch(name) {
  const root = process.env.P4_DRILL_SCRATCH;
  if (!root) return mkdtempSync(join(tmpdir(), `p4-drills-${name}-`));
  const dir = join(root, `${name}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function copyServer(scratch) {
  const H = await import("../../design-harness.js");
  const first = Number(String(process.env.DESIGN_SQLD_PORT || "").trim());
  const port = Number(process.env.COPY_SQLD_PORT || (first ? first + 3 : 0));
  if (!port) throw new DrillError("Set COPY_SQLD_PORT (or DESIGN_SQLD_PORT) to this run's own spare database port.");
  if (port === OWNER_PORT) throw new DrillError(`Port ${OWNER_PORT} is the owner's harness.`);
  const dataDir = join(scratch, "copy-sqld");
  mkdirSync(dataDir, { recursive: true });
  const sq = H.startSqld({ bin: H.findSqld().bin, key: "p4-drill-copy", port, dataDir });
  await H.waitForHealth(sq.url, sq.child, { logFile: sq.logFile, label: "the restore-drill copy" });
  return { url: sq.url, port, stop: async () => H.stopChild(sq.child) };
}

export async function revokeAgency(drill, ctx) {
  const r = await sqlAt(ctx.urls.platform, [{ sql: "UPDATE agency_grants SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND status = 'accepted'", args: [new Date().toISOString(), ctx.store] }]);
  drill?.note(`the demo agency's access to the store removed first (${r[0].rowsAffected} grant), as the dry run asks (Settings > Team)`);
  return r[0].rowsAffected;
}

export async function makeRoutes(drill, ctx, dir) {
  const file = join(dir, "routes.json");
  const mk = await ctx.render(["--make-routes", file, "--tenant", ctx.store]);
  drill?.check(mk.code === 0, "the route list for the page comparison (migrate-render --make-routes)", mk.out.trim().split("\n").pop());
  return file;
}

// The store's control-plane row pointed at another local database (the copy),
// then back. The harness reads the row through its cache (PLATFORM_CACHE_MS).
export async function pointStoreAt(ctx, url) {
  assertLocal(url);
  await sqlAt(ctx.urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [url, ctx.store] }]);
  await sleep(Number(ctx.env.PLATFORM_CACHE_MS || 1000) + 1500);
}

// P4-DRILLS finding F2: the comparison finds the hero test's ping by a
// pattern over the raw page, and Next can split its streamed data inside that
// ping; the hero then counts as a difference and the rehearsal fails although
// only the randomly chosen hero differs. True when that is the only failure.
export const heroOnlyFailure = (rep) => Boolean(rep) && rep.passed !== true && rep.dataCheck?.differences === 0 && Array.isArray(rep.render?.list) && rep.render.list.length > 0 && rep.render.list.every((d) => d.route === "/" && /section\[data-sec="hero"\]/.test(d.selector || ""));

// The rehearsal on a fresh copy, as runbook steps 3 and 5 do it; once more
// on a fresh copy when only the home page's hero differed (F2), with a note.
export async function rehearse(drill, ctx, opts) {
  const r = await rehearseOnce(drill, ctx, opts);
  if (!heroOnlyFailure(r.rep)) return r;
  drill?.note(`${opts.label || "move"}: the rehearsal failed on the home page's hero only (${r.rep.render.list.length} differences: the running hero test's random pick, its ping split in one capture's streamed data: finding F2); rehearsing again on a fresh copy`);
  if (drill) drill.f2Retries = (drill.f2Retries || 0) + 1;
  return rehearseOnce(drill, ctx, { ...opts, out: `${opts.out}-again`, label: `${opts.label || "move"} (again)` });
}

async function rehearseOnce(drill, ctx, { copy, routesFile, out, label = "move", extra = [] }) {
  const copied = await copyDatabase(ctx.urls.tenant, copy.url);
  drill?.note(`${label}: the store copied into ${copy.url} (${copied.tables} tables, ${copied.rows} rows)`);
  const before = await storeSnapshot(ctx.urls.tenant);
  await pointStoreAt(ctx, copy.url);
  let reh;
  try {
    reh = await ctx.migrate(["--tenant", ctx.store, "--rehearsal-run", "--db", copy.url, "--base", ctx.base, "--routes", routesFile, "--out", out, ...extra]);
  } finally {
    await pointStoreAt(ctx, ctx.urls.tenant);
  }
  let rep = null;
  try {
    rep = JSON.parse(readFileSync(join(out, "rehearsal.json"), "utf8"));
  } catch {
    rep = null;
  }
  const after = await storeSnapshot(ctx.urls.tenant);
  return { reh, rep, report: join(out, "rehearsal.json"), untouched: JSON.stringify(before) === JSON.stringify(after), before, after };
}

export async function storeSnapshot(url) {
  const r = await sqlAt(url, ["SELECT mode FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT count(*) AS n FROM documents"]);
  return { mode: r[0].rows[0]?.mode ?? null, live: r[1].rows[0]?.id ?? null, documents: Number(r[2].rows[0]?.n ?? 0) };
}

export const digestOf = (out) => /Dry-run digest: ([0-9a-f]{64})/.exec(out)?.[1] ?? null;

// The whole move, as the owner runs it (runbook steps 3 to 6). Returns
// { dry, digest, mv, rehearsal }. Every step is a drill check with `label`.
export async function moveStore(drill, ctx, { label = "the move", copy, routesFile, scratch }) {
  const out = join(scratch, `rehearsal-${label.replace(/[^a-z0-9]+/gi, "-")}`);
  const r = await rehearse(drill, ctx, { copy, routesFile, out, label });
  drill.check(r.reh.code === 0 && r.rep?.passed === true, `${label}: the rehearsal on a copy passes (the move on the copy, then the page comparison)`, { exit: r.reh.code, compared: r.rep?.render?.compared, same: r.rep?.render?.same, canariesOk: r.rep?.render?.canariesOk, list: r.rep?.render?.list?.slice(0, 5), dataCheck: r.rep?.dataCheck, tail: r.reh.out.trim().split("\n").slice(-3) });
  drill.check(r.untouched, `${label}: the store's own database is untouched by its rehearsal`, { before: r.before, after: r.after });
  const dry = await ctx.migrate(["--tenant", ctx.store, "--dry-run"]);
  const digest = digestOf(dry.out);
  drill.check(dry.code === 0 && /^Ready to move/m.test(dry.out) && Boolean(digest), `${label}: the dry run says Ready to move and prints its digest`, dry.out.split("\n").slice(0, 3).join(" | "));
  const mv = await ctx.migrate(["--tenant", ctx.store, "--dry-run-digest", String(digest), "--rehearsal", r.report]);
  drill.check(mv.code === 0 && /Your store now uses the new editor\./.test(mv.out), `${label}: the move (digest and rehearsal report as proofs) finishes`, mv.out.split("\nDetails")[0].slice(-1200));
  await sleep(1500);
  return { dry, digest, mv, rehearsal: r };
}

// A --p4 store, moved to the new editor, the harness running. The stages that
// work on a moved store (product, collection, routes, search-rename) start here.
// beforeMove({ seed, ctx, scratch }): what a stage looks at, or sets up through
// the old editors, on the legacy store before it moves; its answer is returned
// as `before`.
export async function movedP4Store(drill, name, { beforeMove = null } = {}) {
  const { seed } = await reseedP4(drill, { start: true });
  const ctx = await harnessContext();
  const scratch = drillScratch(name);
  const before = beforeMove ? await beforeMove({ seed, ctx, scratch }) : null;
  await revokeAgency(drill, ctx);
  const routesFile = await makeRoutes(drill, ctx, scratch);
  const copy = await copyServer(scratch);
  try {
    await moveStore(drill, ctx, { label: "the move", copy, routesFile, scratch });
  } finally {
    await copy.stop();
  }
  const st = await storeSnapshot(ctx.urls.tenant);
  if (st.mode !== "documents") throw new DrillError(`the move didn't finish: the store is in ${st.mode} mode`);
  return { seed, ctx, scratch, routesFile, before };
}

// ---- the editor, as the founder uses it ----

export const saveStatus = (page) => page.locator("[data-save-status]").first().getAttribute("data-save-status").catch(() => null);
export const waitSaved = (page, ms = 30_000) => waitFor(async () => (await saveStatus(page)) === "saved", ms);

// Publish in the editor's own panel: Publish, review, Publish. Returns the
// panel's final phase ("done" when it went live).
export async function publishHere(page) {
  await page.locator("[data-publish] button", { hasText: "Publish" }).first().click();
  await page.waitForSelector('[data-publish][data-phase="review"]', { timeout: 30_000 });
  await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 30_000);
  await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  await waitFor(async () => (await page.locator('[data-publish][data-phase="done"], [data-publish][data-phase="blocked"], [data-publish][data-phase="refused"], [data-publish][data-phase="error"]').count()) > 0, 45_000);
  return page.locator("[data-publish][data-phase]").getAttribute("data-phase").catch(() => null);
}

// Storefront search, the page a shopper uses (it streams: wait for its count).
export async function searchFor(page, base, q) {
  await page.goto(`${base}/search?q=${encodeURIComponent(q)}`, { waitUntil: "load", timeout: 120_000 });
  await page.locator("main h1", { hasText: "Results for" }).waitFor({ timeout: 60_000 });
  await page.locator("main p", { hasText: /^\d+ products?$/ }).first().waitFor({ timeout: 60_000 });
  return page.locator("main").innerText();
}

// The product picker of a pairs or pinned-products control: choose `query`.
export async function pickInto(page, groupSelector, query) {
  const group = page.locator(groupSelector).first();
  await group.getByRole("button", { name: /Choose products|Change the products/ }).click();
  const dlg = page.locator("dialog[open]").last();
  await dlg.getByRole("searchbox").fill(query);
  const row = dlg.locator('ul[aria-label="Synced products"] li').filter({ hasText: query }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.locator("button, input[type=checkbox], label").first().click();
  await dlg.getByRole("button", { name: /^Confirm/ }).click();
  await group.locator("[data-pick-title]").filter({ hasText: query }).first().waitFor({ timeout: 30_000 });
  return group;
}

// A page as a shopper sees it: a fresh context (no console cookie), a fixed
// experiment unit, the cookie banner answered "No thanks".
export async function shopperContext(drill, base, unit = "p4-drills") {
  const ctx = await drill.context({ width: 1440 });
  await ctx.addCookies([{ name: "_unit", value: unit, url: base }]);
  return ctx;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--check")) {
  const res = selfCheck();
  for (const c of res) console.log(`${c.ok ? "✓" : "✗"} ${c.label}`);
  process.exit(res.every((c) => c.ok) ? 0 : 1);
}
