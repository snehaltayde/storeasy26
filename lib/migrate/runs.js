// P4-CUTOVER (MIG-03): the cutover's run rows (cms_migration_runs, migration
// 0024), its steps, and the read-only status a stuck store needs. Edge-safe:
// no node: imports (the cutover itself only runs from the command line).
//
//   STEPS                         the steps of a cutover run, in order. The run
//                                 row's `step` is the last step that FINISHED:
//                                   locked      the store is migrating, the run is open
//                                   rechecked   the refusals were checked again after the lock
//                                   backfilled  documents, versions, refs and live rows are in
//                                   checked     the data check (MIG-02) found nothing
//                                   flipped     the store is on the new editor
//                                   pinned      theme_pin written and read back (or reported)
//                                   searched    the search reindex was asked for
//                                 A finished run has finished_at and an outcome:
//                                   done | aborted | stopped (a refusal after the
//                                   lock put the store back on the old editor)
//   newRunId()                    mrun_<16 hex>
//   openRun(kind)                 the open run of that kind (finished_at IS NULL), or null
//   latestRun(kind)               the newest run of that kind, open or not
//   readMode()                    cms_state.mode ('legacy' when the table or row is missing)
//   storeStatus()                 { mode, run, report } for --status (SELECTs only)
//   parseReport(row)              the run's report JSON (never throws)
//   stepStatement(runId, step, report)
//                                 the UPDATE that records a step; it only acts
//                                 on an open run
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";

export const KIND = "cutover";
export const STEPS = Object.freeze(["locked", "rechecked", "backfilled", "checked", "flipped", "pinned", "searched"]);
export const OUTCOMES = Object.freeze(["done", "aborted", "stopped"]);
export const BEFORE_FLIP = Object.freeze(["locked", "rechecked", "backfilled", "checked"]);

export const stepIndex = (step) => {
  if (typeof step === "string" && step.startsWith("backfill:")) return STEPS.indexOf("rechecked") + 0.5;
  return STEPS.indexOf(step);
};
export const isBeforeFlip = (step) => stepIndex(step) < STEPS.indexOf("flipped");

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const newRunId = () => `mrun_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;

const plainRow = (row, cols) => (row ? Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]])) : null);

export function parseReport(row) {
  if (!row?.report) return {};
  try {
    const r = JSON.parse(String(row.report));
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  } catch {
    return {};
  }
}

async function one(sql, args = []) {
  try {
    const r = await libsql.execute({ sql, args });
    return plainRow(r.rows[0], r.columns);
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_migration_runs" })) return null;
    throw e;
  }
}

export const openRun = (kind = KIND) =>
  one("SELECT * FROM cms_migration_runs WHERE kind = ? AND finished_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1", [kind]);

export const latestRun = (kind = KIND) => one("SELECT * FROM cms_migration_runs WHERE kind = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", [kind]);

export const getRun = (id) => one("SELECT * FROM cms_migration_runs WHERE id = ?", [id]);

// Any open run, of any kind (a reversal holds the store too).
export const anyOpenRun = () => one("SELECT * FROM cms_migration_runs WHERE finished_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1");

export async function readMode() {
  let r;
  try {
    r = await libsql.execute("SELECT mode FROM cms_state WHERE id = 1");
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_state" })) return "legacy";
    throw e;
  }
  return r.rows[0]?.mode == null ? "legacy" : String(r.rows[0].mode);
}

// --status: what the store is doing, read only.
export async function storeStatus() {
  const mode = await readMode();
  const run = (await openRun(KIND)) || (await anyOpenRun());
  const last = run ? null : await latestRun(KIND);
  return { mode, run, report: run ? parseReport(run) : null, last, lastReport: last ? parseReport(last) : null };
}

export function stepStatement(runId, step, report) {
  return {
    sql: "UPDATE cms_migration_runs SET step = ?, report = ? WHERE id = ? AND finished_at IS NULL",
    args: [step, JSON.stringify(report ?? {}), runId],
  };
}

export function finishStatement(runId, { step, outcome, report, at }) {
  return {
    sql: "UPDATE cms_migration_runs SET step = ?, outcome = ?, report = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL",
    args: [step, outcome, JSON.stringify(report ?? {}), at, runId],
  };
}
