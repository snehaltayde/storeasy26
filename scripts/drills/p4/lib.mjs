// Shared helpers for the phase 5 and 6 browser drills (scripts/drills/p5,
// scripts/drills/p6), on the design harness in desktop Chrome. Everything the
// phase 3 helpers do (scripts/drills/p3/lib.mjs, re-exported) plus:
//   assertLocal(url)          throws unless the address is on this machine
//                             (localhost, *.localhost, 127.0.0.1, ::1, or a
//                             file: path with no host); refuses 3017 too
//   selfCheck()               assertLocal refuses non-local addresses and
//                             p3Ports still refuses 3017 (`node lib.mjs --check`)
//   sleep, waitFor, rowsOf, sqlAt(url, stmts)
//   consoleUrl(base, path), harnessContext()  this run's ports, database
//                             addresses and harness env (all local)
//   saveStatus, waitSaved, publishHere(page)  the editor's own controls
// Not a test:* suite: drills need a harness and Chrome. Run them with
// pnpm drill:p5 / pnpm drill:p6 (scripts/drills/run-isolated.mjs).
//
//   node scripts/drills/p4/lib.mjs --check     the helpers' own checks (no harness)
import { fileURLToPath } from "node:url";
import { ROOT } from "../../design-harness.js";
import { DrillError, OWNER_PORT, p3Ports } from "../p3/lib.mjs";

export * from "../p3/lib.mjs";

// ---------- refusing anything but this machine ----------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertLocal(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    throw new DrillError(`"${String(url).slice(0, 80)}" is not a full address. Drills only use addresses on this machine, like http://localhost:6160.`);
  }
  if (u.protocol === "file:") {
    if (u.host) throw new DrillError(`Refusing ${String(url).slice(0, 80)}: a file on another machine. Only files on this machine are allowed.`);
    return String(url);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new DrillError(`Refusing ${u.protocol}// addresses: drills only open http or https pages on this machine.`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) {
    throw new DrillError(`Refusing ${u.origin}: drills only talk to this machine (localhost, 127.0.0.1 or ::1), never a hosted or real store.`);
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

// ---------- small helpers ----------

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
  return {
    ports,
    urls,
    env,
    base: `http://localhost:${ports.next}`,
    store: STORE_ID,
  };
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--check")) {
  const res = selfCheck();
  for (const c of res) console.log(`${c.ok ? "✓" : "✗"} ${c.label}`);
  process.exit(res.every((c) => c.ok) ? 0 : 1);
}
