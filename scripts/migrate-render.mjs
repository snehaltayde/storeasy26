// P4-EQUIV (MIG-02): the rendered before/after comparison of a store's shopper
// pages. P4-CUTOVER's rehearsal runs it against the local harness serving a
// restore-drill copy: capture before the move, capture after, compare. It only
// ever talks to this machine.
//
//   node scripts/migrate-render.mjs --make-routes <routes.json> --tenant <id>
//       the route list for a store: the canaries (home, a page, a journal
//       post, the journal list, a campaign, an old address that moved, the
//       product with the most kinds of content, the collection with the most
//       pinned products, the collections list, the cart, the cart offer,
//       search) plus every product and collection with old content. Reads the
//       store (SELECTs only); the store's database and the control plane
//       (PLATFORM_DB_URL) must be on this machine.
//   node scripts/migrate-render.mjs --base <url> --routes <routes.json> --out <dir> [--timeout <s>]
//       captures each route as a shopper with NO cookie at all (no cart, no
//       experiment unit, no session, no preview). Redirects are recorded, not
//       followed. Writes <dir>/<name>.html (or .json) and <dir>/index.json.
//       The base must be on this machine (http://localhost:<port>, 127.0.0.1,
//       [::1] or *.localhost); anything else is refused before any request.
//       <dir> must be new, empty, or an earlier capture of this tool; files
//       are only ever added or overwritten by name, never deleted.
//   node scripts/migrate-render.mjs --compare <beforeDir> <afterDir> [--json <file>]
//       normalizes both captures and compares them page by page, setting
//       aside only lib/migrate/allowed-differences.js. Exit 0: the same.
//       Exit 1: a difference (each named by page and where on the page).
//       Refused (exit 2) when no page was compared, when the before capture
//       marks no canary page, or when any canary in the before capture did
//       not answer 2xx or 3xx: a store broken before the move proves nothing.
//
// Exit 2: a refusal or a usage mistake; nothing was captured or compared.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLocal } from "./drills/p4/lib.mjs";
import { compare } from "../lib/migrate/render-compare.js";
import { ALLOWED_DIFFERENCES } from "../lib/migrate/allowed-differences.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TOOL = "migrate-render";
const USAGE = [
  "Use one of:",
  "  node scripts/migrate-render.mjs --make-routes <routes.json> --tenant <id>",
  "  node scripts/migrate-render.mjs --base http://localhost:<port> --routes <routes.json> --out <dir>",
  "  node scripts/migrate-render.mjs --compare <beforeDir> <afterDir> [--json <file>]",
].join("\n");

export class Refusal extends Error {}

// ---------- only this machine ----------

/** The base address, refused unless it is an http(s) address on this machine. */
export function assertLocalBase(base) {
  let u;
  try {
    u = new URL(String(base ?? ""));
  } catch {
    throw new Refusal(`"${String(base ?? "").slice(0, 80)}" is not a full address. Give the local harness, like http://localhost:6140.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Refusal(`Refusing ${String(base).slice(0, 80)}: only http or https pages on this machine are captured.`);
  try {
    assertLocal(u.href);
  } catch (e) {
    throw new Refusal(e.message);
  }
  return u;
}

// A route is a path on the base, never another host.
function routeUrl(base, path) {
  const p = String(path ?? "");
  if (!p.startsWith("/") || p.startsWith("//")) throw new Refusal(`"${p.slice(0, 80)}" is not a path on this store (it must start with one /).`);
  const u = new URL(p, base);
  if (u.origin !== base.origin) throw new Refusal(`"${p.slice(0, 80)}" leaves the store.`);
  return u;
}

// ---------- the route list ----------

function readRouteFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Refusal(`couldn't read the route list ${file}: ${String(e?.message || e).slice(0, 160)}`);
  }
}

// The running hero test's slug, as --make-routes read it from the store
// (empty for a plain list): kept in each capture so the comparison sets the
// hero aside only for that test.
export function readHeroExperiments(file) {
  const data = readRouteFile(file);
  const list = Array.isArray(data?.heroExperiments) ? data.heroExperiments : [];
  return list.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(x));
}

export function readRoutes(file) {
  const data = readRouteFile(file);
  const list = Array.isArray(data) ? data : Array.isArray(data?.routes) ? data.routes : null;
  if (!list || !list.length) throw new Refusal(`the route list ${file} holds no routes.`);
  const names = new Set();
  return list.map((r, i) => {
    const path = typeof r === "string" ? r : r?.path;
    if (typeof path !== "string") throw new Refusal(`route ${i + 1} in ${file} has no path.`);
    let name = typeof r === "object" && typeof r.name === "string" && /^[A-Za-z0-9._-]+$/.test(r.name) ? r.name : path.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "home";
    while (names.has(name)) name += "_";
    names.add(name);
    return { name, path, kind: r?.kind ?? null, why: r?.why ?? null };
  });
}

// ---------- the output folder ----------

function prepareOut(dir) {
  const out = resolve(dir);
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return out;
  }
  if (!statSync(out).isDirectory()) throw new Refusal(`${out} is a file, not a folder. Pick a new or empty folder with --out.`);
  const entries = readdirSync(out);
  if (!entries.length) return out;
  let index = null;
  try {
    index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
  } catch {
    /* not ours */
  }
  if (index?.tool !== TOOL) throw new Refusal(`Refused to capture into ${out}: it holds files this tool did not write. Nothing was changed. Pick a new or empty folder with --out.`);
  return out;
}

// ---------- capturing ----------

/**
 * Capture every route from `base` into `outDir`. No cookie header is ever
 * sent; redirects are recorded, not followed. Returns the index.
 */
export async function captureRoutes(baseUrl, routes, outDir, { fetchImpl = fetch, timeoutMs = 180_000, log = () => {}, heroExperiments = [] } = {}) {
  const base = assertLocalBase(baseUrl);
  const urls = routes.map((r) => routeUrl(base, r.path));
  const out = prepareOut(outDir);
  const index = { tool: TOOL, version: 1, base: base.origin, origin: base.origin, capturedAt: new Date().toISOString(), heroExperiments: [...heroExperiments], routes: [] };
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      // headers are set here and nowhere else: no cookie, ever
      res = await fetchImpl(urls[i].href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: ctrl.signal,
        headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.1", "user-agent": "storeasy-migrate-render/1" },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Refusal(`couldn't load ${r.path} from ${base.origin}: ${String(e?.cause?.code || e?.message || e).slice(0, 160)}. Is the harness running?`);
    }
    const body = await res.text();
    clearTimeout(timer);
    const contentType = res.headers.get("content-type") || "";
    let location = res.headers.get("location");
    if (location) {
      try {
        const l = new URL(location, base);
        location = l.origin === base.origin ? `${l.pathname}${l.search}` : l.href;
      } catch {
        /* keep as sent */
      }
    }
    const file = `${r.name}${/json/i.test(contentType) ? ".json" : ".html"}`;
    writeFileSync(join(out, file), body);
    index.routes.push({ name: r.name, path: r.path, kind: r.kind, why: r.why, file, status: res.status, contentType, location: location || null, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") });
    log(`  ${res.status} ${r.path}${location ? ` -> ${location}` : ""}`);
  }
  writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

// ---------- comparing ----------

export function loadCapture(dir) {
  const d = resolve(dir);
  let index;
  try {
    index = JSON.parse(readFileSync(join(d, "index.json"), "utf8"));
  } catch {
    throw new Refusal(`${d} is not a capture of this tool (no index.json). Capture with --base … --routes … --out first.`);
  }
  if (index?.tool !== TOOL || !Array.isArray(index.routes)) throw new Refusal(`${d} is not a capture of this tool.`);
  const heroExperiments = Array.isArray(index.heroExperiments) ? index.heroExperiments.map(String) : [];
  return index.routes.map((r) => ({ route: r.path, kind: r.kind ?? null, status: r.status, contentType: r.contentType, location: r.location ?? null, origin: index.origin ?? null, heroExperiments, body: readFileSync(join(d, r.file), "utf8") }));
}

const answered = (status) => {
  const n = Number(status);
  return Number.isInteger(n) && n >= 200 && n < 400;
};

/**
 * P4-FIX4: refuse a comparison that proves nothing. A rehearsal passes only
 * when pages were compared and the store worked before the move: every canary
 * (home, a page, a product, the cart, …) of the before capture answered 2xx
 * or 3xx. Two captures of the same broken store compare "the same".
 */
export function assertComparable(beforeList, result) {
  if (!result || !Number(result.compared)) throw new Refusal("Refused: no page was compared, so this proves nothing. Capture the route list from --make-routes before and after the move, then compare those two folders.");
  const canaries = beforeList.filter((c) => c.kind === "canary");
  if (!canaries.length) throw new Refusal("Refused: the before capture marks no canary page (home, a page, a product, the cart …), so it can't show the store worked before the move. Capture with a route list from --make-routes.");
  const broken = canaries.filter((c) => !answered(c.status));
  if (broken.length) {
    const names = broken.slice(0, 10).map((c) => `${c.route} (${c.status})`).join(", ");
    throw new Refusal(`Refused: ${broken.length} canary page${broken.length === 1 ? "" : "s"} didn't load before the move: ${names}${broken.length > 10 ? ", …" : ""}. A store that is broken before the move proves nothing. Fix the harness and capture again.`);
  }
}

export function compareDirs(beforeDir, afterDir, { allowed = ALLOWED_DIFFERENCES, gate = true } = {}) {
  const before = loadCapture(beforeDir);
  const result = compare(before, loadCapture(afterDir), { allowed });
  if (gate) assertComparable(before, result);
  return result;
}

export function renderResult(result) {
  const lines = [];
  const byRoute = new Map();
  for (const d of result.differences) byRoute.set(d.route, [...(byRoute.get(d.route) ?? []), d]);
  const differ = byRoute.size;
  lines.push(`Compared ${result.compared} page${result.compared === 1 ? "" : "s"}: ${differ ? `${differ} look${differ === 1 ? "s" : ""} different to a shopper.` : "every one looks the same to a shopper."}`);
  for (const [route, list] of byRoute) {
    lines.push("", `Different: ${route}`);
    for (const d of list) {
      lines.push(`  where:  ${d.selector}`);
      lines.push(`  before: ${d.before ?? "(nothing there)"}`);
      lines.push(`  after:  ${d.after ?? "(nothing there)"}`);
    }
  }
  if (result.allowedApplied.length) {
    const reasons = new Map(ALLOWED_DIFFERENCES.map((a) => [a.id, a.reason]));
    const pages = new Map();
    for (const a of result.allowedApplied) pages.set(a.id, [...(pages.get(a.id) ?? []), a.route]);
    lines.push("", "Set aside as allowed (not counted):");
    for (const [id, routes] of pages) lines.push(`  ${id} on ${routes.join(", ")}`, `    why: ${reasons.get(id) ?? "(not in the list)"}`);
  }
  lines.push("", result.same ? "Result: the same. Nothing a shopper sees changed." : "Result: NOT the same. The move must not go ahead until each difference above is explained and fixed.");
  return lines.join("\n");
}

// ---------- the route list from a store ----------

function isLocalDbUrl(url) {
  const s = typeof url === "string" ? url.trim() : "";
  if (/^file:/i.test(s)) return !/^file:\/\/[^/]/i.test(s);
  const m = /^(?:libsql|https?|wss?):\/\/([^/?#]+)/i.exec(s);
  if (!m) return false;
  const host = m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export async function makeRoutes({ tenantId, storeOpen }) {
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
      if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
      return next(spec, ctx);
    },
  });
  const platformUrl = process.env.PLATFORM_DB_URL;
  if (!platformUrl) throw new Refusal("no control plane is set (PLATFORM_DB_URL). Point it at a database on this machine.");
  if (!isLocalDbUrl(platformUrl)) throw new Refusal("refusing: the control plane (PLATFORM_DB_URL) is not on this machine. This tool only reads local copies.");
  const { getTenant, platformDb } = await import("../lib/platform/control.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  const tenant = await getTenant(tenantId, { fresh: true });
  if (!tenant) throw new Refusal(`no store "${tenantId}" in the control plane.`);
  if (!isLocalDbUrl(tenant.dbUrl)) throw new Refusal(`refusing: "${tenantId}" is not a database on this machine. Make a restore-drill copy and point a local store at it.`);
  const { mapTenant } = await import("../lib/migrate/map.js");
  const { renderRoutesFor } = await import("../lib/migrate/render-compare.js");
  return withTenant(tenant, async () => renderRoutesFor(await mapTenant({ storeOpen, platform: platformDb() })));
}

// ---------- the command ----------

export async function main(argv, { log = console.log, error = console.error } = {}) {
  const has = (n) => argv.includes(`--${n}`);
  const value = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  try {
    if (has("hosted")) throw new Refusal("--hosted is not accepted: this tool only ever talks to this machine.");
    if (has("compare")) {
      const i = argv.indexOf("--compare");
      const a = argv[i + 1];
      const b = argv[i + 2];
      if (!a || !b || a.startsWith("--") || b.startsWith("--")) throw new Refusal(USAGE);
      const result = compareDirs(a, b);
      const json = value("json");
      if (json) writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
      log(renderResult(result));
      return result.same ? 0 : 1;
    }
    if (has("make-routes")) {
      const file = value("make-routes");
      const tenantId = value("tenant");
      if (!file || !tenantId) throw new Refusal(USAGE);
      const storeOpen = has("store-open") ? true : has("not-launched") ? false : undefined;
      const list = await makeRoutes({ tenantId, storeOpen });
      writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
      const count = (k) => list.routes.filter((r) => r.kind === k).length;
      log(`Wrote ${list.routes.length} routes to ${file}: ${count("canary")} canaries, ${count("product")} more products and ${count("collection")} more collections with old content.${list.heroExperiments?.length ? ` A hero test is running (${list.heroExperiments.join(", ")}): its hero is set aside when both captures show it.` : ""}`);
      return 0;
    }
    const base = value("base");
    const routesFile = value("routes");
    const out = value("out");
    if (!base || !routesFile || !out) throw new Refusal(USAGE);
    assertLocalBase(base);
    const routes = readRoutes(routesFile);
    const t = Number(value("timeout"));
    log(`Capturing ${routes.length} pages from ${new URL(base).origin} as a shopper with no cookies…`);
    const heroExperiments = readHeroExperiments(routesFile);
    const index = await captureRoutes(base, routes, out, { timeoutMs: Number.isFinite(t) && t > 0 ? t * 1000 : undefined, log, heroExperiments });
    log(`Captured ${index.routes.length} pages into ${resolve(out)}.`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      error(`✗ ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2)));
}
