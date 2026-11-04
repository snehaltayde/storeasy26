// P4-REVERSE (MIG-04): putting a store that moved to the new editor back on
// the old one. The owner's command; builders run it only on file databases and
// the harness's local sqld. The runbook's reversal section is in
// docs/cms-reviews/P4-CUTOVER-RUNBOOK.md. Replaces P4-SCAFFOLD's stub.
//
// Load the environment yourself (the package script carries no --env-file):
//   node --env-file=.env.local scripts/reverse-documents.js --tenant <id> …
// (`pnpm reverse:documents -- …` works too once the environment is loaded.)
//
//   --tenant <id> --dry-run [--json]
//       READS ONLY: what going back does, and the edits made in the new editor
//       that won't show any more, by product name; prints its digest.
//   --tenant <id> --dry-run-digest <digest> [--hosted --confirm <id> --backup-ref <iso time>]
//       THE REVERSAL. Every precondition is checked by the command itself; see
//       lib/migrate/reverse.js. A database not on this machine needs
//       --hosted --confirm <the same id> --backup-ref <the time recorded just
//       before> (the move's rule). Builders never pass --hosted.
//   --tenant <id> --status      where a reversal is, in plain words (read only)
//   --tenant <id> --resume      carry on a paused reversal; after a finished one
//                               whose search or look step failed, do those again
//   --tenant <id> --abort       stop a paused reversal: stay on the new editor
//                               (refused once the store is back on the old one)
//
// With no database address set the command refuses: it never falls back to a
// local file it would create. No token or secret is ever printed.
// Exit: 0 done (or a dry-run report), 1 a refusal, a stop or a usage mistake.
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

function isLocalDbUrl(url) {
  const s = typeof url === "string" ? url.trim() : "";
  if (/^file:/i.test(s)) return !/^file:\/\/[^/]/i.test(s);
  const m = /^(?:libsql|https?|wss?):\/\/([^/?#]+)/i.exec(s);
  if (!m) return false;
  const host = m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const USAGE = [
  "Use one of (load the environment first, e.g. node --env-file=.env.local scripts/reverse-documents.js …):",
  "  --tenant <id> --dry-run [--json]",
  "  --tenant <id> --dry-run-digest <digest> [--hosted --confirm <id> --backup-ref <time>]",
  "  --tenant <id> --status | --resume | --abort",
].join("\n");

const tenantArg = value("tenant");
if (!tenantArg) fail(USAGE);
const modes = ["dry-run", "status", "resume", "abort"].filter(has);
if (modes.length > 1) fail(`Use one of --${modes.join(", --")} at a time.`);
const mode = modes[0] || "reverse";
const hosted = has("hosted");
const confirm = value("confirm");
const hostedConfirmed = hosted && confirm === tenantArg;

if (mode === "reverse" && !value("dry-run-digest"))
  fail("Run the reversal's dry run first (--dry-run), read it with the founder, then give its digest: --dry-run-digest <digest>. To see where a reversal stands, use --status.");

if (tenantArg === "_default") {
  if (!(process.env.TURSO_DB_URL || process.env.DATABASE_URL)) fail("No database is set for the env store (TURSO_DB_URL or DATABASE_URL). Load the environment first, for example: node --env-file=.env.local scripts/reverse-documents.js …");
} else if (!process.env.PLATFORM_DB_URL) {
  fail("No control plane is set (PLATFORM_DB_URL), so the store can't be found. Load the environment first, for example: node --env-file=.env.local scripts/reverse-documents.js …");
}

let needsHosted = false;
const platformUrl = process.env.PLATFORM_DB_URL || null;
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
if (!isLocalDbUrl(url)) {
  if (!hostedConfirmed) fail(`refusing: "${tenantArg}" is not a local database. Only the owner works on a hosted store, with --hosted --confirm ${tenantArg}.`);
  needsHosted = true;
}
if (hosted && !needsHosted) fail("--hosted is only for a hosted database; this store's database and the control plane are local. Run it without --hosted.");

const platform = tenantArg === "_default" ? (platformUrl ? platformDb() : null) : platformDb();
const Rep = await import("../lib/migrate/report.js");
const Rev = await import("../lib/migrate/reverse.js");
const inStore = (fn) => (tenant ? withTenant(tenant, fn) : fn());
const again = (flag) => `node --env-file=.env.local scripts/reverse-documents.js --tenant ${tenantArg}${needsHosted ? ` --hosted --confirm ${tenantArg}` : ""} ${flag}`;

try {
  if (mode === "dry-run") {
    const out = await inStore(() => Rev.reverseDryRun());
    if (has("json")) console.log(JSON.stringify({ ...out.plan, refused: out.refused, digest: out.digest }, null, 2));
    else console.log(Rep.renderReversePlanText({ ...out.plan, refused: out.refused }, out.refused ? null : out.digest));
    process.exit(out.refused ? 1 : 0);
  }
  if (mode === "status") {
    const s = await inStore(() => Rev.reverseStatus());
    if (has("json")) console.log(JSON.stringify({ mode: s.mode, run: s.run, report: s.report, last: s.last }, null, 2));
    else console.log(Rep.renderReverseStatusText(s, { tenant: tenantArg, command: again }));
    process.exit(0);
  }
  if (mode === "abort") {
    const r = await inStore(() => Rev.abortReversal());
    if (!r.ok) fail(r.refused.message);
    console.log(r.words);
    process.exit(0);
  }
  const hostedInfo = { needed: needsHosted, hosted, confirm, backupRef: value("backup-ref") };
  const res = await inStore(() => Rev.reverseDocuments({ dryRunDigest: value("dry-run-digest"), hosted: hostedInfo, platform, resume: mode === "resume" }));
  if (res.refused) {
    console.error(Rep.renderReverseRefusal(res.refused));
    process.exit(1);
  }
  if (res.report) console.log(Rep.renderReverseText(res.report));
  if (res.stopped) {
    console.error(`\n✗ ${res.stopped.words}`);
    if (!res.stopped.unlocked) console.error(`  ${again("--status")}`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  fail(`${tenantArg}: stopped: ${String(e?.message || e).slice(0, 300)}\nCheck where the store stands with --status before anything else.`);
}
