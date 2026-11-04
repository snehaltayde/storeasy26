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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--check")) {
  const res = selfCheck();
  for (const c of res) console.log(`${c.ok ? "✓" : "✗"} ${c.label}`);
  process.exit(res.every((c) => c.ok) ? 0 : 1);
}
