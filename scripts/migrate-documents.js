// P4-MAPPER (MIG-01, MIG-02): `pnpm migrate:documents`, the dry run of the
// move to the new editor. It READS ONLY: it maps the store's legacy content to
// documents in memory, runs the in-process data check, prints the report, and
// writes nothing anywhere. P4-CUTOVER adds the real move to this file.
//
//   pnpm migrate:documents -- --tenant <id> --dry-run [--json] [--store-open | --not-launched]
//   pnpm migrate:documents -- --tenant <id> --dry-run --hosted --confirm <id>   (owner only)
//
//   --tenant <id>    the store, from the control plane (PLATFORM_DB_URL).
//                    "_default" is the env store (TURSO_DB_URL, DATABASE_URL,
//                    else file:local.db), whose brand and theme come from the
//                    env config
//   --dry-run        required: the move itself isn't built yet (P4-CUTOVER)
//   --json           print the full report as JSON instead of the plain one
//   --store-open     a store that never published, whose drafts shoppers see
//                    today: its published versions come from the drafts
//   --not-launched   a store that never published and isn't open: nothing is
//                    published, and it stays closed until its first publish
//                    (only a store with no release needs one of the two; the
//                    dry run never guesses, it says "Not ready" instead)
//
// The output ends with the dry-run digest, a hash of the full JSON report,
// the same with or without --json. P4-CUTOVER requires it.
//
// Which database: a local file (file:) or a database on this machine
// (localhost, 127.0.0.1, [::1], such as the harness's sqld). The same holds
// for the control plane (PLATFORM_DB_URL), checked before it is read. Anything
// else is refused unless --hosted --confirm <the same store id> is given: a real dry
// run reads real data, so that is the owner's step, never a builder's. No
// token or secret is ever printed.
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The storefront's getters import next/headers and "@/…" paths: resolve them
// outside Next, as the fixture recorders do.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// file: (not file://host), or a database on this machine
function isLocalDbUrl(url) {
  const s = typeof url === "string" ? url.trim() : "";
  if (/^file:/i.test(s)) return !/^file:\/\/[^/]/i.test(s);
  const m = /^(?:libsql|https?|wss?):\/\/([^/?#]+)/i.exec(s);
  if (!m) return false;
  const host = m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const USAGE = "Usage: pnpm migrate:documents -- --tenant <id> --dry-run [--json] [--store-open | --not-launched]";
const tenantArg = value("tenant");
if (!tenantArg) fail(USAGE);
if (!has("dry-run")) fail("Only the dry run is built so far. Add --dry-run: it reads your store and changes nothing. The move itself comes later.");
if (has("store-open") && has("not-launched")) fail("Use --store-open or --not-launched, not both.");
const storeOpen = has("store-open") ? true : has("not-launched") ? false : undefined;
const hosted = has("hosted");
const confirm = value("confirm");
const hostedConfirmed = hosted && confirm === tenantArg;
let needsHosted = false;

// The control plane (store list, agency access) gets the same check as the
// store's database, before anything is read from it (P4-FIX1). The URL is
// never printed.
const platformUrl = process.env.PLATFORM_DB_URL || "file:platform.db";
if (!isLocalDbUrl(platformUrl)) {
  if (!hostedConfirmed) fail(`refusing: the control plane (PLATFORM_DB_URL) is not a local database. Only the owner runs a dry run against hosted data, with --hosted --confirm ${tenantArg}.`);
  needsHosted = true;
}

const { getTenant, platformDb } = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");

let tenant = null;
let url;
if (tenantArg === "_default") {
  url = process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db";
} else {
  try {
    tenant = await getTenant(tenantArg, { fresh: true });
  } catch (e) {
    fail(`couldn't read the control plane: ${String(e?.message || e).slice(0, 200)}`);
  }
  if (!tenant) fail(`no store "${tenantArg}" in the control plane`);
  url = tenant.dbUrl;
}
if (!isLocalDbUrl(url)) {
  if (!hostedConfirmed) fail(`refusing: "${tenantArg}" is not a local database. Only the owner runs a dry run on a hosted store, with --hosted --confirm ${tenantArg}.`);
  needsHosted = true;
}
if (hosted && !needsHosted) fail("--hosted is only for a hosted database; this store's database and the control plane are local. Run it without --hosted.");

const { mapTenant } = await import("../lib/migrate/map.js");
const { dataCheck, entityRoutesFor, routesFor } = await import("../lib/migrate/check.js");
const { buildReport, renderText, reportDigest } = await import("../lib/migrate/report.js");

try {
  const out = await withTenant(tenant, async () => {
    const mapped = await mapTenant({ storeOpen, platform: tenant ? platformDb() : null });
    // routesFor's routes plus the entity routes dataCheck always adds
    // (P4-OVL07), once each, so the listed routes are the ones compared
    const seen = new Set();
    const routes = [...routesFor(mapped.source), ...(await entityRoutesFor(mapped))].filter((r) => {
      const k = JSON.stringify(r);
      return seen.has(k) ? false : (seen.add(k), true);
    });
    const check = await dataCheck(mapped, { routes });
    // the report's Details list the routes this comparison covered
    const report = buildReport(mapped, check, { routes });
    return { report, digest: await reportDigest(report) };
  });
  if (has("json")) console.log(JSON.stringify({ ...out.report, digest: out.digest }, null, 2));
  else console.log(renderText(out.report, out.digest));
  process.exit(0);
} catch (e) {
  fail(`${tenantArg}: the dry run stopped: ${String(e?.message || e).slice(0, 300)}`);
}
