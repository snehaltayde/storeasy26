// P4-CUTOVER (MIG-03, MIG-02): what must hold before a store is moved to the
// new editor. The command checks every one itself (never trusted to the
// runbook), each a plain refusal. Read-only: SELECTs only. Edge-safe (no
// node: imports); the cutover itself only runs from the command line.
//
//   REQUIRED_MIGRATIONS            0021 to 0025 must be in the store's ledger
//   missingMigrations()            the ones that aren't
//   syncRunning()                  true when a catalog sync run is in progress
//   refusal(code, message, extra)  { refused: true, code, message, ... }
//   modeRefusal(mode, run)         a store already on the new editor, or one
//                                  that another run holds
//   readinessRefusal(dry)          the dry run's own refusals and its verdict:
//                                  approvals or an agency, a slug collision, a
//                                  type with content and no editor, the
//                                  "no release" flag, a pending schedule, a
//                                  live read in error, shopper changes,
//                                  unmatched addresses
//   archivedRefusal(dry)           a page legacy holds whose document was
//                                  archived (archive is terminal: never undone)
//   digestRefusal(given, actual)   the dry-run digest the owner passed
//   rehearsalRefusal(rep, { tenantId, sourceHash })
//                                  the rehearsal report: a passing rehearsal
//                                  (data check and rendered comparison both
//                                  clean) of THIS store whose source hash is
//                                  the store's current one
//   hostedRefusal({ needed, hosted, confirm, tenantId, backupRef, now })
//                                  a database not on this machine needs
//                                  --hosted --confirm <tenantId> --backup-ref <iso>
//   backupRefProblem(ref, now)     null, or why the backup time isn't usable
//
// Codes are for tests and Details; the founder and the owner read `message`.
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";

export const REQUIRED_MIGRATIONS = Object.freeze(["0021", "0022", "0023", "0024", "0025"]);
export const REHEARSAL_TOOL = "migrate-documents";
export const REHEARSAL_KIND = "rehearsal";
// a backup time older than this is refused (the owner records it just before)
export const BACKUP_REF_MAX_AGE_MS = 24 * 3600 * 1000;

export function refusal(code, message, extra = {}) {
  return { refused: true, code, message, ...extra };
}

export async function missingMigrations() {
  let ids = [];
  try {
    ids = (await libsql.execute("SELECT id FROM schema_migrations")).rows.map((r) => String(r.id));
  } catch (e) {
    if (!notMigratedYet(e, { table: "schema_migrations" })) throw e;
  }
  return REQUIRED_MIGRATIONS.filter((n) => !ids.some((id) => id === n || id.startsWith(`${n}_`)));
}

export async function syncRunning() {
  try {
    const r = await libsql.execute("SELECT status FROM sync_runs ORDER BY started_at DESC, rowid DESC LIMIT 1");
    return String(r.rows[0]?.status ?? "") === "running";
  } catch (e) {
    if (notMigratedYet(e, { table: "sync_runs" })) return false;
    throw e;
  }
}

export const WORDS = Object.freeze({
  ALREADY_DOCUMENTS: "This store already uses the new editor, so there is nothing to move. New stores start on the new editor; only stores made before it need this move.",
  BUSY: "This store is being updated by another run right now. Check it with --status first.",
  OPEN_RUN: "A move of this store is already under way. Check it with --status, then carry on with --resume or stop it with --abort.",
  NOT_MIGRATED: "This store's database is missing the updates the move needs. Apply them first (the runbook's first step: pnpm tenant:migrate -- --all).",
  SYNC_RUNNING: "The catalog is being copied from Shopify right now. Wait for that copy to finish (the console's sync card shows it), then run the move again.",
  NOT_READY: "The dry run says the store isn't ready to move.",
  NO_DIGEST: "Give the digest from the dry run you checked with the founder: --dry-run-digest <the digest the dry run printed>.",
  STALE_DIGEST: "The store changed since the dry run you gave (the digests don't match). Run the dry run again, check it, and pass its new digest.",
  NO_REHEARSAL: "Give the report of a passing rehearsal on a copy of this store: --rehearsal <rehearsal.json>.",
  BAD_REHEARSAL: "The rehearsal report can't be used.",
  FAILED_REHEARSAL: "The rehearsal you gave did not pass, so the store can't move. Fix what it found, then rehearse again.",
  OTHER_STORE_REHEARSAL: "The rehearsal you gave is for another store.",
  STALE_REHEARSAL: "The store changed since that rehearsal (its content isn't the same as the copy you rehearsed on). Make a fresh copy, rehearse again, and pass the new report.",
  HOSTED: "This store's database is not on this machine. Only the owner moves a hosted store, with --hosted --confirm <the store id> --backup-ref <the time you recorded just before>.",
  NOT_HOSTED: "--hosted is only for a database that is not on this machine; this one is. Run it without --hosted.",
  BACKUP_REF: "The backup time isn't usable.",
  LIVE_MOVED: "Someone published on the old editor just now, so the move didn't start. Run it again.",
});

export function modeRefusal(mode, { run = null } = {}) {
  if (mode === "documents" && !run) return refusal("ALREADY_DOCUMENTS", WORDS.ALREADY_DOCUMENTS);
  if (run && run.kind === "cutover") return refusal("OPEN_RUN", WORDS.OPEN_RUN, { run: run.id });
  if (run || mode === "migrating") return refusal("BUSY", WORDS.BUSY, { run: run?.id ?? null });
  if (mode !== "legacy" && mode !== "documents") return refusal("UNKNOWN_MODE", "This store is in a state the move doesn't expect. Ask Storeasy support to look at it.", { mode: String(mode).slice(0, 40) });
  return null;
}

// The dry run's refusals (map.js buildFacts, state.js classifyState) under
// their own codes, so a test can name which one refused; the words are the
// dry run's own plain fixes.
const MAPPED_CODES = ["PENDING_SCHEDULE", "LIVE_READ_ERROR", "UNKNOWN_MODE", "LIVE_V4_ON_LEGACY", "APPROVALS_IN_USE", "AGENCY_ACCESS", "AGENCY_UNCHECKED", "NO_EDITOR", "ENTITY_CONTENT_NOT_MOVABLE", "SLUG_COLLISION", "NEEDS_FLAG"];

export function readinessRefusal(dry) {
  const report = dry?.report;
  if (!report) return refusal("NOT_READY", WORDS.NOT_READY);
  const fixes = report.verdict?.fixes ?? [];
  const first = fixes.find((f) => f.kind === "refusal" && MAPPED_CODES.includes(f.code));
  if (first) return refusal(first.code, `${first.what} ${first.where}`, { fixes });
  if (report.verdict?.ready !== true) return refusal("NOT_READY", `${WORDS.NOT_READY} ${report.verdict?.line ?? ""}.`.replace(/\.\.$/, "."), { fixes });
  return null;
}

// A page the old editor still holds whose document was archived (deleted in
// the new editor, for example before a reversal). Archive is terminal, so the
// move can't bring it back.
export function archivedRefusal(dry) {
  const rows = (dry?.mapped?.report?.reconcile?.byId ?? []).filter((r) => r.archived);
  if (!rows.length) return null;
  const names = rows.map((r) => (r.label ? `“${r.label}”` : "a page")).join(", ");
  return refusal(
    "ARCHIVED_DOCUMENT",
    `The old editor still holds ${rows.length === 1 ? "a page" : "pages"} (${names}) that ${rows.length === 1 ? "was" : "were"} deleted in the new editor before. Delete ${rows.length === 1 ? "it" : "them"} in the old editor too (Storefront > Pages), or ask Storeasy support, then run the dry run again.`,
    { documents: rows.map((r) => r.id) },
  );
}

export function digestRefusal(given, actual) {
  if (typeof given !== "string" || !given.trim()) return refusal("NO_DIGEST", WORDS.NO_DIGEST);
  if (given.trim().toLowerCase() !== String(actual).toLowerCase()) return refusal("STALE_DIGEST", WORDS.STALE_DIGEST, { given: given.trim().slice(0, 80), actual });
  return null;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function rehearsalRefusal(rep, { tenantId, sourceHash } = {}) {
  if (rep == null) return refusal("NO_REHEARSAL", WORDS.NO_REHEARSAL);
  if (!isObj(rep) || rep.tool !== REHEARSAL_TOOL || rep.kind !== REHEARSAL_KIND) return refusal("BAD_REHEARSAL", `${WORDS.BAD_REHEARSAL} It isn't a rehearsal report of this tool.`);
  if (rep.tenant !== tenantId) return refusal("OTHER_STORE_REHEARSAL", WORDS.OTHER_STORE_REHEARSAL, { rehearsed: String(rep.tenant ?? "").slice(0, 80) });
  const data = rep.dataCheck;
  const render = rep.render;
  // a store that isn't open yet has nothing published to compare, and closes
  // at the move: its rehearsal shows the data check as not needed and every
  // page as "Opening soon" after
  const closed = rep.notLaunched === true;
  const dataClean = isObj(data) && (closed ? data.ran === false && data.reason === "NOTHING_PUBLISHED" : data.ran === true && Number(data.differences) === 0);
  const renderClean = isObj(render) && Number(render.compared) > 0 && render.canariesOk === true && (closed ? render.closedAfter === true : render.same === true);
  if (rep.passed !== true || !dataClean || !renderClean) {
    const why = [!dataClean ? "the data comparison wasn't clean" : null, !renderClean ? "the page comparison wasn't clean" : null, rep.passed !== true ? "the rehearsal itself didn't finish" : null].filter(Boolean);
    return refusal("FAILED_REHEARSAL", `${WORDS.FAILED_REHEARSAL} (${why.join("; ") || "not passed"})`);
  }
  if (typeof rep.sourceHash !== "string" || rep.sourceHash !== sourceHash) return refusal("STALE_REHEARSAL", WORDS.STALE_REHEARSAL);
  return null;
}

export function backupRefProblem(ref, now = Date.now()) {
  const s = typeof ref === "string" ? ref.trim() : "";
  if (!s) return "Give the time you recorded just before this command, as --backup-ref <time>, for example 2026-11-04T10:15:00Z.";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return `"${s.slice(0, 40)}" isn't a full time with its time zone, like 2026-11-04T10:15:00Z.`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return `"${s.slice(0, 40)}" isn't a real time.`;
  if (t > now + 5 * 60 * 1000) return "That backup time is in the future. Record the time just before you run the move.";
  if (now - t > BACKUP_REF_MAX_AGE_MS) return "That backup time is more than a day old. Record the time again just before you run the move.";
  return null;
}

export function hostedRefusal({ needed, hosted, confirm, tenantId, backupRef, now = Date.now() } = {}) {
  if (!needed) return hosted ? refusal("NOT_HOSTED", WORDS.NOT_HOSTED) : null;
  if (!hosted || confirm !== tenantId) return refusal("HOSTED", WORDS.HOSTED.replace("<the store id>", tenantId));
  const problem = backupRefProblem(backupRef, now);
  if (problem) return refusal("BACKUP_REF", `${WORDS.BACKUP_REF} ${problem}`);
  return null;
}
