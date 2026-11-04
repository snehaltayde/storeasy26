// P4-MAPPER (MIG-01, MIG-02) and P4-CUTOVER (MIG-01, MIG-02, MIG-03): moving a
// store from the old editor to the new one. The owner's command; builders run
// it only on file databases and the harness's local sqld. The runbook is
// docs/cms-reviews/P4-CUTOVER-RUNBOOK.md.
//
// Load the environment yourself (the package script carries no --env-file):
//   node --env-file=.env.local scripts/migrate-documents.js --tenant <id> …
// (`pnpm migrate:documents -- …` works too once the environment is loaded.)
//
//   --tenant <id> --dry-run [--json] [--store-open | --not-launched]
//       READS ONLY: maps the store's content to documents in memory, runs the
//       in-process data check, prints the plain report and its digest.
//   --tenant <id> --rehearsal-run --db <copy> --base <url> --routes <routes.json> --out <dir>
//                 [--store-open | --not-launched] [--report <file>]
//       the whole move on a LOCAL copy of the store (<copy>: a file: database
//       or one on this machine, such as a sqld serving a restore-drill copy),
//       with the rendered before/after comparison against the local harness
//       serving that copy (<url>, on this machine). Captures go to
//       <dir>/before and <dir>/after; the report to <dir>/rehearsal.json (or
//       --report). Nothing is written to the control plane or to search.
//   --tenant <id> --dry-run-digest <digest> --rehearsal <rehearsal.json>
//                 [--store-open | --not-launched]
//                 [--hosted --confirm <id> --backup-ref <iso time>]
//       THE MOVE. Every precondition is checked by the command itself; see
//       lib/migrate/cutover.js. A database not on this machine needs
//       --hosted --confirm <the same id> --backup-ref <the time recorded just
//       before>. Builders never pass --hosted.
//   --tenant <id> --status      where a move is, in plain words (read only)
//   --tenant <id> --resume      carry on an open move from its recorded step
//                               (with the same proofs as the move; with no
//                               open move it starts a new one)
//   --tenant <id> --abort       stop a move before the switch: back to the old
//                               editor (after the switch: the reversal tool)
//
//   --tenant <id>    the store, from the control plane (PLATFORM_DB_URL).
//                    "_default" is the env store (TURSO_DB_URL or
//                    DATABASE_URL), whose brand and theme come from the env.
//   --store-open     a store that never published, whose drafts shoppers see
//                    today: its published versions come from the drafts
//   --not-launched   a store that never published and isn't open: nothing is
//                    published, and it stays closed until its first publish
//
// With no database address set the command refuses: it never falls back to a
// local file it would create. No token or secret is ever printed.
// Exit: 0 done (or a dry-run report, ready or not), 1 a refusal, a stop or a
// usage mistake.
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

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

const args = process.argv.slice(2).filter((a) => a !== "--");
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

const USAGE = [
  "Use one of (load the environment first, e.g. node --env-file=.env.local scripts/migrate-documents.js …):",
  "  --tenant <id> --dry-run [--json] [--store-open | --not-launched]",
  "  --tenant <id> --rehearsal-run --db <local copy> --base http://localhost:<port> --routes <routes.json> --out <dir>",
  "  --tenant <id> --dry-run-digest <digest> --rehearsal <rehearsal.json> [--hosted --confirm <id> --backup-ref <time>]",
  "  --tenant <id> --status | --resume | --abort",
].join("\n");

const tenantArg = value("tenant");
if (!tenantArg) fail(USAGE);
const modes = ["dry-run", "rehearsal-run", "status", "resume", "abort"].filter(has);
if (modes.length > 1) fail(`Use one of --${modes.join(", --")} at a time.`);
const mode = modes[0] || "move";
if (has("store-open") && has("not-launched")) fail("Use --store-open or --not-launched, not both.");
const storeOpen = has("store-open") ? true : has("not-launched") ? false : undefined;
const hosted = has("hosted");
const confirm = value("confirm");
const hostedConfirmed = hosted && confirm === tenantArg;

// The proofs of the move, asked for before anything is read.
if (mode === "move" || mode === "resume") {
  if (mode === "move" && !value("dry-run-digest"))
    fail("Run the dry run first (--dry-run), check its report with the founder, then give its digest: --dry-run-digest <digest>. To see where a move stands, use --status.");
  if (mode === "move" && !value("rehearsal")) fail("Give the report of a passing rehearsal on a copy of this store: --rehearsal <rehearsal.json> (made with --rehearsal-run).");
}

// No database address: refuse, never fall back to a file this would create.
if (tenantArg === "_default") {
  if (!(process.env.TURSO_DB_URL || process.env.DATABASE_URL)) fail("No database is set for the env store (TURSO_DB_URL or DATABASE_URL). Load the environment first, for example: node --env-file=.env.local scripts/migrate-documents.js …");
} else if (!process.env.PLATFORM_DB_URL) {
  fail("No control plane is set (PLATFORM_DB_URL), so the store can't be found. Load the environment first, for example: node --env-file=.env.local scripts/migrate-documents.js …");
}

let needsHosted = false;
const platformUrl = process.env.PLATFORM_DB_URL || null;
// The control plane gets the same check as the store's database, before
// anything is read from it (P4-FIX1). The URL is never printed.
if (platformUrl && !isLocalDbUrl(platformUrl)) {
  if (!hostedConfirmed) fail(`refusing: the control plane (PLATFORM_DB_URL) is not a local database. Only the owner works on hosted data, with --hosted --confirm ${tenantArg}.`);
  needsHosted = true;
}

const { getTenant, platformDb } = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");

let tenant = null;
let url;
if (tenantArg === "_default") {
  url = process.env.TURSO_DB_URL || process.env.DATABASE_URL;
} else {
  try {
    tenant = await getTenant(tenantArg, { fresh: true });
  } catch (e) {
    fail(`couldn't read the control plane: ${String(e?.message || e).slice(0, 200)}`);
  }
  if (!tenant) fail(`no store "${tenantArg}" in the control plane`);
  url = tenant.dbUrl;
}

// A rehearsal runs on a copy: --db names it, and it must be on this machine.
if (mode === "rehearsal-run") {
  const db = value("db");
  if (!db) fail("Give the copy to rehearse on: --db <file:copy.db, or a database on this machine serving the copy>.");
  // only ever a database on this machine: a hosted store is never local, so
  // a rehearsal can't write to one (the control-plane row may point at the
  // copy too, as when the local harness serves it)
  if (!isLocalDbUrl(db)) fail("refusing: a rehearsal only ever runs on a copy on this machine (a file: database, or localhost).");
  url = db;
}
// the context the store runs in: its control-plane row (with --db, pointed at
// the copy), or none for the env store (lib/db.js reads TURSO_DB_URL /
// DATABASE_URL), or the env store's copy
const storeContext = mode === "rehearsal-run" ? (tenant ? { ...tenant, dbUrl: url, dbToken: undefined } : { id: "_default", dbUrl: url, config: null, secrets: {} }) : tenant;

if (!isLocalDbUrl(url)) {
  if (!hostedConfirmed) fail(`refusing: "${tenantArg}" is not a local database. Only the owner works on a hosted store, with --hosted --confirm ${tenantArg}.`);
  needsHosted = true;
}
if (hosted && !needsHosted) fail("--hosted is only for a hosted database; this store's database and the control plane are local. Run it without --hosted.");

const platform = tenantArg === "_default" ? (platformUrl ? platformDb() : null) : platformDb();
const Rep = await import("../lib/migrate/report.js");
const Cut = await import("../lib/migrate/cutover.js");

const inStore = (fn) => (storeContext ? withTenant(storeContext, fn) : fn());
// this command again, with a flag (the status and stop words name it)
const again = (flag) => `node --env-file=.env.local scripts/migrate-documents.js --tenant ${tenantArg}${needsHosted ? ` --hosted --confirm ${tenantArg}` : ""} ${flag}`;

function printCutover(res) {
  if (res.refused) {
    console.error(Rep.renderRefusal(res.refused));
    return 1;
  }
  if (res.report) console.log(Rep.renderCutoverText(res.report));
  if (res.stopped) {
    console.error(`\n✗ ${res.stopped.words}`);
    if (!res.stopped.unlocked) console.error(`  ${again("--status")}`);
    return 1;
  }
  if (res.unfinished) {
    console.error(`\n✗ ${res.words || "The last steps didn't finish."}`);
    return 1;
  }
  return 0;
}

const readJson = (file, what) => {
  try {
    return JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (e) {
    fail(`couldn't read ${what} ${file}: ${String(e?.message || e).slice(0, 160)}`);
  }
};

try {
  if (mode === "dry-run") {
    const out = await inStore(() => Rep.dryRun({ storeOpen, platform: tenant ? platformDb() : null }));
    if (has("json")) console.log(JSON.stringify({ ...out.report, digest: out.digest }, null, 2));
    else console.log(Rep.renderText(out.report, out.digest));
    process.exit(0);
  }
  if (mode === "status") {
    const s = await inStore(() => Cut.cutoverStatus());
    if (has("json")) console.log(JSON.stringify({ mode: s.mode, run: s.run, report: s.report, last: s.last }, null, 2));
    else console.log(Rep.renderStatusText(s, { tenant: tenantArg, command: again }));
    process.exit(0);
  }
  if (mode === "abort") {
    const r = await inStore(() => Cut.abortCutover());
    if (!r.ok) {
      console.error(`✗ ${r.refused.message}`);
      process.exit(1);
    }
    console.log(r.words);
    process.exit(0);
  }
  const hostedInfo = { needed: needsHosted, hosted, confirm, backupRef: value("backup-ref") };
  if (mode === "rehearsal-run") {
    const base = value("base");
    const routesFile = value("routes");
    const out = value("out");
    if (!base || !routesFile || !out) fail(USAGE);
    const MR = await import("./migrate-render.mjs");
    const { compare } = await import("../lib/migrate/render-compare.js");
    const { ALLOWED_DIFFERENCES } = await import("../lib/migrate/allowed-differences.js");
    MR.assertLocalBase(base);
    const routes = MR.readRoutes(routesFile);
    const capture = async (label) => {
      const dir = join(resolve(out), label);
      console.log(`Capturing ${routes.length} pages ${label} the move…`);
      const index = await MR.captureRoutes(base, routes, dir, { log: () => {} });
      return { pages: MR.loadCapture(dir), index: index.routes };
    };
    const { report, cutover } = await inStore(() =>
      Cut.runRehearsal({ storeOpen, platform, hosted: { ...hostedInfo, needed: false }, capture, compare: (a, b) => compare(a, b, { allowed: ALLOWED_DIFFERENCES }) }),
    );
    const file = value("report") ? resolve(value("report")) : join(resolve(out), "rehearsal.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    if (cutover.refused) {
      console.error(Rep.renderRefusal(cutover.refused));
      console.error(`\nThe rehearsal report was written to ${file} (not passed).`);
      process.exit(1);
    }
    if (cutover.report) console.log(Rep.renderCutoverText({ ...cutover.report, passed: report.passed, render: report.render }));
    console.log(`\nRehearsal report: ${file}`);
    console.log(report.passed ? "Result: passed. Give this file to the real move with --rehearsal." : `Result: NOT passed. ${report.words || report.render?.words || cutover.stopped?.words || ""}`.trim());
    process.exit(report.passed ? 0 : 1);
  }
  // the move, or its resume
  const rehearsalFile = value("rehearsal");
  const rehearsalReport = rehearsalFile ? readJson(rehearsalFile, "the rehearsal report") : null;
  const res = await inStore(() =>
    Cut.runCutover({ storeOpen, dryRunDigest: value("dry-run-digest"), rehearsalReport, hosted: hostedInfo, platform, resume: mode === "resume" }),
  );
  process.exit(printCutover(res));
} catch (e) {
  fail(`${tenantArg}: stopped: ${String(e?.message || e).slice(0, 300)}\nCheck where the store stands with --status before anything else.`);
}
