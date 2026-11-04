// P4-CUTOVER (MIG-01, MIG-02, MIG-03, MED-03, ED-05, OVL-17): moving one store
// from the old editor (legacy) to the new one (documents). Command-line only
// (scripts/migrate-documents.js); edge-safe all the same (no node: imports).
// Everything runs inside the store's own context (withTenant).
//
//   runCutover(opts)    the move, or its resume
//   abortCutover(opts)  --abort: back to the old editor, before the flip only
//   cutoverStatus()     --status (read only)
//   runRehearsal(opts)  --rehearsal-run: the move on a local copy, with the
//                       rendered before/after comparison, and its report.json
//   __cutoverTestHooks  test seams (never set outside tests)
//
// The steps, each recorded in the run row (lib/migrate/runs.js), so a run can
// be resumed from any of them:
//   preconditions  checked by the tool before anything is written
//                  (lib/migrate/preconditions.js): the store is on the old
//                  editor (or this tool's own run is open: resume), the ledger
//                  holds 0021 to 0025, no catalog sync runs, the dry run's
//                  refusals (pending schedule, live read in error, approvals
//                  or agency, a slug collision, a type with content and no
//                  editor, "no release" without --store-open/--not-launched)
//                  and its verdict, the dry-run digest (the very dry run the
//                  command prints, lib/migrate/report.js dryRun), a passing
//                  rehearsal of this store whose source hash is the store's
//                  current one, and for a hosted database --hosted --confirm
//                  <id> --backup-ref <iso>.
//   a. lock       ONE batch: [legacyGuardStatement, the pointer is still the
//                 one read, mode 'migrating', the run row]. The live release
//                 id read at the lock goes in the run's report (0024 is
//                 pinned). From here old writers refuse in their own batch and
//                 a catalog sync parks (P4-GUARD).
//   b. recheck    the pending schedule and the live read, AFTER the lock. A
//                 failure puts the store back on the old editor and refuses.
//                 Then pending publish_release jobs of this store are cancelled
//                 (their release can't publish any more; the queue would only
//                 dead-letter them).
//   c. backfill   lib/migrate/backfill.js, in chunks, verified after each one
//   d. check      MIG-02, the hard gate: lib/migrate/check.js dataCheck with
//                 entities "live" (the backfilled live rows), every resolved*
//                 getter, legacy against the candidate, while catalog sync is
//                 parked. Any difference puts the store back on the old
//                 editor and stops.
//   e. flip       lib/migrate/flip.js, ONE batch
//   f. theme_pin  the doc_design version through lib/documents/after-commit.js
//                 themePin (imported, not edited), then RE-READ from the
//                 control plane, one retry; a failure is reported and redone
//                 on resume. Skipped on a rehearsal copy.
//   (search)      kickSearchReindex (P4-SEARCH), best effort, after the flip
//                 and again on resume. Skipped on a rehearsal copy.
//   g. finish     the run row gets its report and outcome 'done'.
//
// Plain words for every refusal and stop; codes are for tests and Details.
import { libsql } from "../db.js";
import { currentTenant, tenantId } from "../tenant-context.js";
import { legacyGuardStatement, migratingGuardStatement, classifyAbort, isGuardAbort } from "../cms-mode.js";
import { stableStringify } from "../registry/index.js";
import { readLegacySource, mapLegacy } from "./map.js";
import { classifyState, readTenantState } from "./state.js";
import { dataCheck } from "./check.js";
import { dryRun, dryRunRoutes, buildReport, namesFor } from "./report.js";
import { sha256Hex } from "./ids.js";
import { KIND, newRunId, openRun, anyOpenRun, readMode, storeStatus, parseReport, stepStatement, finishStatement, isBeforeFlip, stepIndex } from "./runs.js";
import { modeRefusal, missingMigrations, syncRunning, readinessRefusal, archivedRefusal, digestRefusal, rehearsalRefusal, hostedRefusal, refusal, WORDS, REHEARSAL_TOOL, REHEARSAL_KIND } from "./preconditions.js";
import { runBackfill, BackfillMismatch } from "./backfill.js";
import { flipStatements, flipLanded } from "./flip.js";

export const TOOL = REHEARSAL_TOOL;
const nowIso = () => new Date().toISOString();

// Test seams. Each is async (step) => void, or null.
export const __cutoverTestHooks = { afterLock: null, afterStep: null, afterChunk: null, beforeCheck: null, beforeFlip: null };
export function resetCutoverTestHooks() {
  for (const k of Object.keys(__cutoverTestHooks)) __cutoverTestHooks[k] = null;
}

export const STOP_WORDS = Object.freeze({
  RECHECK: "After the store was paused, it turned out it can't move yet, so it went back to the old editor. Nothing else changed.",
  CHECK: "The copy in the new editor didn't match what shoppers see today, so nothing was switched and the store went back to the old editor. Nothing shoppers see changed.",
  CHECK_NOT_RUN: "The comparison with the live store couldn't run, so nothing was switched and the store went back to the old editor.",
  MISMATCH: "Part of the copy didn't come out as planned, so the move stopped before anything was switched. The store is still paused; shoppers see it as before.",
  PLAN_MOVED: "The store's content changed while it was being copied, so the move stopped before anything was switched. The store is still paused; shoppers see it as before.",
  POINTER_MOVED: "The live store changed after the update started, so nothing was switched. Shoppers still see the store as before. The store is still paused.",
  LOST_RUN: "This run no longer holds the store (it was stopped or finished elsewhere), so nothing was switched.",
  UNKNOWN: "We couldn't tell whether the switch went through.",
  PIN: "The store's look couldn't be recorded for Storeasy's own screens. Shoppers aren't affected.",
});

// (no command line here: lib/ text is scanned for developer words; the
// command adds its own invocation, scripts/migrate-documents.js)
const NEXT_PAUSED = () => "Next: check where the store stands with --status, then carry on with --resume or go back to the old editor with --abort.";

class Stop extends Error {
  constructor(code, words, { detail = null, unlock = false } = {}) {
    super(words);
    this.code = code;
    this.words = words;
    this.detail = detail;
    this.unlock = unlock;
  }
}

// ---- mapping inside a run ------------------------------------------------------------

// The mapping of the CURRENT legacy source while the store is paused. The
// store reads as migrating, which classifyState refuses; this run holds the
// pause, so the mapping is made as for the legacy store it still is.
export async function mapForRun({ storeOpen, platform = null } = {}) {
  const source = await readLegacySource({ platform });
  source.state = { ...source.state, mode: "legacy" };
  return { source, ...(await mapLegacy(source, { storeOpen })) };
}

// What the backfill writes and the flip puts live, as one hash: a resume only
// skips a step when the mapping is still exactly this.
export async function planHash(mapped) {
  return sha256Hex(
    stableStringify({
      releaseId: mapped.releaseId ?? null,
      documents: mapped.documents.map((d) => [d.id, d.draftHash, d.published?.versionId ?? null]),
      versions: [...mapped.bodies.keys()].sort(),
      live: { product: mapped.liveRows?.product ?? [], collection: mapped.liveRows?.collection ?? [] },
    }),
  );
}

// ---- small pieces -----------------------------------------------------------------------

async function step(runId, name, report) {
  await libsql.batch([migratingGuardStatement(runId), stepStatement(runId, name, report)], "write");
  if (__cutoverTestHooks.afterStep) await __cutoverTestHooks.afterStep(name);
}

// Back to the old editor: the run finishes with `outcome`. A batch whose
// answer was lost and whose resend met its own unlock is found by re-reading.
async function unlock(runId, report, { outcome, step: at, at: when }) {
  try {
    await libsql.batch(
      [
        migratingGuardStatement(runId),
        { sql: "UPDATE cms_state SET mode = 'legacy', updated_at = ? WHERE id = 1 AND mode = 'migrating'", args: [when] },
        finishStatement(runId, { step: at, outcome, report, at: when }),
      ],
      "write",
    );
  } catch (e) {
    const r = await libsql.execute({ sql: "SELECT (SELECT mode FROM cms_state WHERE id = 1) AS mode, (SELECT outcome FROM cms_migration_runs WHERE id = ? AND finished_at = ?) AS outcome", args: [runId, when] });
    const row = r.rows[0] || {};
    if (!(row.mode === "legacy" && row.outcome === outcome)) throw e;
  }
}

async function livePointer() {
  const r = await libsql.execute("SELECT live_release_id FROM release_state WHERE id = 1");
  return r.rows[0]?.live_release_id == null ? null : String(r.rows[0].live_release_id);
}

const kept = (prev, add) => {
  const by = new Map((prev || []).map((k) => [k.id, k]));
  for (const k of add || []) by.set(k.id, k);
  return [...by.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

const keptName = (k) => {
  if (k.type === "home") return "The home page";
  if (k.type === "product_content") return "A product's extras";
  if (k.type === "collection_content") return "A collection's pinned products";
  if (k.slug) return `The page /${k.slug}`;
  return k.label || "A part of your store";
};

// pending publish_release jobs of this store (control plane), cancelled at the lock
async function cancelPublishJobs(platform) {
  if (!platform) return 0;
  const t = tenantId();
  try {
    const r = await platform.execute({ sql: "DELETE FROM jobs WHERE type = 'publish_release' AND status = 'pending' AND tenant_id IS ?", args: [t === "_default" ? null : t] });
    return Number(r.rowsAffected || 0);
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return 0;
    throw e;
  }
}

// ---- theme_pin ----------------------------------------------------------------------------

async function readPin(platform, id) {
  const r = await platform.execute({ sql: "SELECT json_type(config, '$.theme_pin') AS t, json_extract(config, '$.theme_pin') AS pin FROM tenants WHERE id = ?", args: [id] });
  const row = r.rows[0];
  if (!row || row.t == null) return { present: false, pin: undefined };
  if (row.t === "null") return { present: true, pin: null };
  try {
    return { present: true, pin: JSON.parse(String(row.pin)) };
  } catch {
    return { present: true, pin: undefined };
  }
}

const pinSame = (a, b) =>
  a === null || b === null ? a === b : a != null && b != null && a.kit === b.kit && (a.version ?? null) === (b.version ?? null) && (a.release ?? null) === (b.release ?? null) && (a.published_at ?? null) === (b.published_at ?? null);

export async function pinStep({ designBody, releaseId }, report, { platform }) {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") return { status: "env" };
  const body = designBody ?? null;
  if (!body) return { status: "nothing" };
  const AC = await import("../documents/after-commit.js");
  const build = { versions: [{ document_id: "doc_design", body }], releaseId: releaseId ?? null, now: report.flippedAt };
  const expected = AC.themePinOf(build);
  if (expected === undefined) return { status: "nothing" };
  const client = platform || (await import("../platform/control.js")).platformDb();
  let error = null;
  let read = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await AC.themePin({ build });
      error = null;
    } catch (e) {
      error = String(e?.message || e).slice(0, 300);
    }
    try {
      read = await readPin(client, tenant.id);
    } catch (e) {
      error = error || String(e?.message || e).slice(0, 300);
      read = null;
    }
    if (read?.present && pinSame(read.pin, expected)) return { status: "written", pin: expected, tries: attempt };
  }
  return { status: "failed", expected, read: read?.present ? read.pin : null, error: error || "the pin read back is not the one written" };
}

// ---- search ------------------------------------------------------------------------------

async function searchStep({ searchClient = null } = {}) {
  const { kickSearchReindex } = await import("../catalog/search-reindex.js");
  const r = await kickSearchReindex({ client: searchClient });
  if (r.error) return { status: "failed", error: r.error, queued: !!r.queued };
  if (!r.queued && !r.drained && !r.timedOut) return { status: "nothing" };
  if (r.drained) return { status: "drained", queued: !!r.queued, drained: { read: r.drained.read, upserted: r.drained.upserted, done: r.drained.done, skipped: r.drained.skipped ?? null } };
  return { status: "queued", queued: !!r.queued, timedOut: !!r.timedOut };
}

// ---- the steps -----------------------------------------------------------------------------

function summarizeCheck(check) {
  return {
    ran: !!check?.ran,
    reason: check?.reason ?? null,
    compared: check?.compared ?? 0,
    entityRoutes: check?.entityRoutes ?? 0,
    differences: check?.differences?.length ?? 0,
    list: (check?.differences ?? []).slice(0, 50).map((d) => ({ fn: d.fn, args: d.args })),
  };
}

async function backfillStep(ctx, mapped) {
  const { runId, report } = ctx;
  const res = await runBackfill(mapped, { runId, at: report.startedAt, report, hooks: { afterChunk: __cutoverTestHooks.afterChunk } });
  // a repeated backfill (a resume) finds what the first one wrote as "same":
  // the counts of new and changed documents add up across the passes
  const prev = report.counts || {};
  const documentsNew = (prev.documentsNew || 0) + res.counts.documentsNew;
  const documentsChanged = (prev.documentsChanged || 0) + res.counts.documentsChanged;
  report.backfills = (report.backfills || 0) + 1;
  report.counts = { ...prev, ...res.counts, documentsNew, documentsChanged, documentsSame: Math.max(0, res.counts.documents - documentsNew - documentsChanged), kept: kept(report.keptList, res.kept).length };
  report.keptList = kept(report.keptList, res.kept);
  report.kept = report.keptList.map((k) => ({ id: k.id, name: keptName(k) }));
  report.strayProducts = [...new Set([...(report.strayProducts || []), ...res.stray.product.map((s) => s.id)])].sort();
  report.plan = await planHash(mapped);
  report.releaseId = mapped.releaseId ?? null;
  await step(runId, "backfilled", report);
}

async function checkStep(ctx, mapped) {
  const { runId, report } = ctx;
  if (__cutoverTestHooks.beforeCheck) await __cutoverTestHooks.beforeCheck();
  const routes = await dryRunRoutes(mapped);
  const check = await dataCheck(mapped, { routes, entities: "live" });
  report.dataCheck = summarizeCheck(check);
  if (mapped.list && !check.ran) throw new Stop("CHECK_NOT_RUN", STOP_WORDS.CHECK_NOT_RUN, { unlock: true, detail: { reason: check.reason } });
  if (check.differences.length) {
    const names = await namesFor(mapped, routes);
    const changes = buildReport(mapped, check, { routes, names }).shopperChanges.map((c) => c.text);
    throw new Stop("CHECK", STOP_WORDS.CHECK, { unlock: true, detail: { changes, differences: report.dataCheck.list } });
  }
  await step(runId, "checked", report);
}

async function flipStep(ctx, mapped) {
  const { runId, report } = ctx;
  if (__cutoverTestHooks.beforeFlip) await __cutoverTestHooks.beforeFlip();
  const at = ctx.now();
  const outboxProducts = [...(mapped.liveRows?.product ?? []).map((r) => r.product_id), ...(report.strayProducts || [])];
  const next = { ...report, flippedAt: at };
  const built = await flipStatements({ runId, mapped, liveAtLock: report.liveAtLock ?? null, at, report: next, outboxProducts });
  next.counts = { ...(next.counts || {}), log: built.counts.log, outbox: built.counts.outbox };
  // the statements carry `next` as the run's report; rebuild them with the counts in
  const final = await flipStatements({ runId, mapped, liveAtLock: report.liveAtLock ?? null, at, report: next, outboxProducts });
  try {
    await libsql.batch(final.statements, "write");
  } catch (e) {
    let seen = null;
    try {
      seen = await flipLanded(libsql, { runId, mapped });
    } catch {
      throw new Stop("UNKNOWN", `${STOP_WORDS.UNKNOWN} Check with --status before anything else.`, { detail: { error: String(e?.message || e).slice(0, 300) } });
    }
    if (!seen.landed) {
      if (!isGuardAbort(e)) throw new Stop("FLIP_FAILED", `The switch failed, so nothing was switched. The store is still paused; shoppers see it as before.`, { detail: { error: String(e?.message || e).slice(0, 300) } });
      const c = await classifyAbort(libsql, e, "migrating");
      const open = await openRun(KIND);
      if (c?.kind === "mode" || !open || open.id !== runId) throw new Stop("LOST_RUN", STOP_WORDS.LOST_RUN, { detail: { mode: seen.mode } });
      throw new Stop("POINTER_MOVED", STOP_WORDS.POINTER_MOVED, { detail: { expected: report.liveAtLock ?? null, live: seen.live } });
    }
  }
  Object.assign(report, next);
  if (__cutoverTestHooks.afterStep) await __cutoverTestHooks.afterStep("flipped");
}

// After the flip the store is in documents mode: the run row is updated with a
// plain UPDATE of an open run (the migrating guard no longer applies).
async function afterFlipStep(runId, name, report) {
  await libsql.execute(stepStatement(runId, name, report));
  if (__cutoverTestHooks.afterStep) await __cutoverTestHooks.afterStep(name);
}

async function finishSteps(ctx) {
  const { runId, report } = ctx;
  if (stepIndex(ctx.at) < stepIndex("pinned")) {
    report.themePin = ctx.rehearsal ? { status: "skipped" } : await pinStep(await liveDesign(report), report, { platform: ctx.platform });
    if (report.themePin.status === "failed") {
      // the run stays open at 'flipped': --resume writes the pin again
      report.search = ctx.rehearsal ? { status: "skipped" } : await searchStep(ctx);
      report.stopped = { code: "PIN", words: `${STOP_WORDS.PIN} Run the same command with --resume to try again.` };
      await libsql.execute(stepStatement(runId, "flipped", report));
      return { finished: false };
    }
    delete report.stopped;
    await afterFlipStep(runId, "pinned", report);
    ctx.at = "pinned";
  }
  if (stepIndex(ctx.at) < stepIndex("searched")) {
    report.search = ctx.rehearsal ? { status: "skipped" } : await searchStep(ctx);
    await afterFlipStep(runId, "searched", report);
    ctx.at = "searched";
  }
  report.finishedAt = ctx.now();
  report.outcome = "done";
  await libsql.execute(finishStatement(runId, { step: "searched", outcome: "done", report, at: report.finishedAt }));
  return { finished: true };
}

// The run from its recorded step on.
async function continueRun(ctx) {
  const { runId, report } = ctx;
  try {
    if (ctx.at === "locked") {
      const state = await readTenantState();
      const cls = classifyState({ ...state, mode: "legacy", storeOpen: report.storeOpen ?? undefined });
      const r = cls.refusals.find((x) => x.code === "PENDING_SCHEDULE" || x.code === "LIVE_READ_ERROR") || cls.refusals[0];
      if (r) throw new Stop(`RECHECK_${r.code}`, `${STOP_WORDS.RECHECK} ${r.code === "PENDING_SCHEDULE" ? "A release is scheduled to go live later: publish it now or cancel it, then start the move again." : r.code === "LIVE_READ_ERROR" ? "The live store content can't be read right now; Storeasy support will look at it with you." : ""}`.trim(), { unlock: true, detail: r });
      const live = await livePointer();
      if (live !== (report.liveAtLock ?? null)) throw new Stop("RECHECK_LIVE_MOVED", `${STOP_WORDS.RECHECK} Someone published just before the pause; start the move again.`, { unlock: true });
      report.counts = { ...(report.counts || {}), jobsCancelled: ctx.rehearsal ? 0 : await cancelPublishJobs(ctx.platform) };
      await step(runId, "rechecked", report);
      ctx.at = "rechecked";
    }
    if (isBeforeFlip(ctx.at)) {
      let mapped = await mapForRun({ storeOpen: report.storeOpen ?? undefined, platform: ctx.platform });
      if (mapped.report.refusals.length) throw new Stop("RECHECK_MAP", `${STOP_WORDS.RECHECK} The dry run's refusals came back after the pause; run the dry run again.`, { unlock: true, detail: mapped.report.refusals.map((r) => r.code) });
      const sameAsBackfilled = report.plan && report.plan === (await planHash(mapped));
      if (!sameAsBackfilled || stepIndex(ctx.at) < stepIndex("backfilled")) {
        await backfillStep(ctx, mapped);
        ctx.at = "backfilled";
        // what the check and the flip use is a fresh read of the source
        mapped = await mapForRun({ storeOpen: report.storeOpen ?? undefined, platform: ctx.platform });
        if ((await planHash(mapped)) !== report.plan) throw new Stop("PLAN_MOVED", STOP_WORDS.PLAN_MOVED);
      }
      if (stepIndex(ctx.at) < stepIndex("checked")) {
        await checkStep(ctx, mapped);
        ctx.at = "checked";
      }
      await flipStep(ctx, mapped);
      ctx.at = "flipped";
    }
    return await finishSteps(ctx);
  } catch (e) {
    if (e instanceof BackfillMismatch) {
      report.stopped = { code: e.code, words: STOP_WORDS.MISMATCH, detail: { chunk: e.chunk, problems: e.problems } };
      await saveReport(runId, report);
      return { stopped: true, code: e.code, words: `${STOP_WORDS.MISMATCH} ${NEXT_PAUSED(ctx.tenant)}` };
    }
    if (!(e instanceof Stop)) throw e;
    report.stopped = { code: e.code, words: e.words, detail: e.detail };
    if (e.unlock) {
      const when = ctx.now();
      report.finishedAt = when;
      report.outcome = "stopped";
      await unlock(runId, report, { outcome: "stopped", step: ctx.at, at: when });
      return { stopped: true, unlocked: true, code: e.code, words: e.words };
    }
    await saveReport(runId, report);
    return { stopped: true, code: e.code, words: `${e.words} ${NEXT_PAUSED(ctx.tenant)}` };
  }
}

async function saveReport(runId, report) {
  try {
    await libsql.execute({ sql: "UPDATE cms_migration_runs SET report = ? WHERE id = ? AND finished_at IS NULL", args: [JSON.stringify(report), runId] });
  } catch {
    /* the stop words still reach the owner */
  }
}

// The design that went live at the flip (pinStep needs only that): read back
// from the documents, so a resume after the flip needs no mapping.
async function liveDesign(report) {
  const r = await libsql.execute(
    "SELECT v.body AS body FROM documents d JOIN document_versions v ON v.id = d.published_version_id WHERE d.id = 'doc_design'",
  );
  let body = null;
  try {
    body = r.rows[0]?.body != null ? JSON.parse(String(r.rows[0].body)) : null;
  } catch {
    body = null;
  }
  return { designBody: body, releaseId: report.releaseId ?? null };
}

// ---- the entry points ----------------------------------------------------------------------

/**
 * The move. opts:
 *   storeOpen        true | false | undefined (--store-open / --not-launched)
 *   dryRunDigest     the digest the owner checked (not needed for a rehearsal)
 *   rehearsalReport  the parsed rehearsal.json (not needed for a rehearsal)
 *   hosted           { needed, hosted, confirm, backupRef } (the command works
 *                    out `needed` from the database and control-plane URLs)
 *   platform         the control plane's client, or null (_default)
 *   rehearsal        true on a local copy: no control-plane write, no search
 *   resume           carry on an open run (or start a new one when none is open)
 *   now              () => ISO time (tests)
 *   searchClient     a Typesense client (tests: a spy)
 *   beforeLock       async () => void, called after every precondition passed
 *                    and right before the lock (the rehearsal's "before" capture)
 * -> { ok, refused?, stopped?, report, words }
 */
export async function runCutover(opts = {}) {
  const now = opts.now || nowIso;
  const tenant = tenantId();
  const ctx = { tenant, now, platform: opts.platform ?? null, rehearsal: !!opts.rehearsal, searchClient: opts.searchClient ?? null };
  const mode = await readMode();
  const open = await openRun(KIND);
  if (open) {
    if (!opts.resume) return { ok: false, refused: modeRefusal(mode, { run: open }) };
    const report = parseReport(open);
    if (!!report.rehearsal !== ctx.rehearsal) return { ok: false, refused: refusal("OTHER_RUN", ctx.rehearsal ? "The open move on this database is a real one, not a rehearsal." : "The open move on this database is a rehearsal. Finish it with --rehearsal-run.") };
    Object.assign(ctx, { runId: open.id, report, at: open.step });
    const r = await continueRun(ctx);
    return finished(ctx, r);
  }
  const busy = await anyOpenRun();
  const mr = modeRefusal(mode, { run: busy });
  if (mr) return { ok: false, refused: mr };

  // ---- preconditions (nothing written yet) ----
  const hr = hostedRefusal({ ...(opts.hosted || {}), tenantId: tenant, now: Date.parse(now()) });
  if (hr) return { ok: false, refused: hr };
  const missing = await missingMigrations();
  if (missing.length) return { ok: false, refused: refusal("NOT_MIGRATED", WORDS.NOT_MIGRATED, { missing }) };
  if (await syncRunning()) return { ok: false, refused: refusal("SYNC_RUNNING", WORDS.SYNC_RUNNING) };
  const dry = await dryRun({ storeOpen: opts.storeOpen, platform: ctx.platform });
  const rr = readinessRefusal(dry) || archivedRefusal(dry);
  if (rr) return { ok: false, refused: rr, dry };
  if (!ctx.rehearsal) {
    const dr = digestRefusal(opts.dryRunDigest, dry.digest);
    if (dr) return { ok: false, refused: dr, dry };
    const rh = rehearsalRefusal(opts.rehearsalReport ?? null, { tenantId: tenant, sourceHash: dry.mapped.sourceHash });
    if (rh) return { ok: false, refused: rh, dry };
  }
  if (opts.beforeLock) await opts.beforeLock({ dry });

  // ---- a. lock ----
  const liveAtLock = await livePointer();
  const runId = newRunId();
  const at = now();
  const report = {
    tool: TOOL,
    kind: KIND,
    tenant,
    runId,
    rehearsal: ctx.rehearsal,
    storeOpen: opts.storeOpen ?? null,
    state: dry.mapped.state.name,
    liveAtLock,
    sourceHash: dry.mapped.sourceHash,
    digest: dry.digest,
    backupRef: opts.hosted?.backupRef ?? null,
    hosted: !!opts.hosted?.needed,
    startedAt: at,
    unresolvedRedirects: dry.mapped.report.unresolvedRedirects.map((r) => ({ from_slug: r.from_slug, to_slug: r.to_slug, side: r.side })),
    cmsTemplates: dry.mapped.report.templates.count,
    dropped: dry.mapped.entities?.holds?.dropped ?? [],
  };
  try {
    await libsql.batch(
      [
        legacyGuardStatement(),
        { sql: "INSERT INTO release_state (id) SELECT 2 WHERE (SELECT live_release_id FROM release_state WHERE id = 1) IS NOT ?", args: [liveAtLock] },
        {
          sql: "INSERT INTO cms_state (id, mode, cutover_release_id, updated_at) VALUES (1, 'migrating', NULL, ?) ON CONFLICT(id) DO UPDATE SET mode = 'migrating', updated_at = excluded.updated_at WHERE cms_state.mode = 'legacy'",
          args: [at],
        },
        {
          sql: "INSERT INTO cms_migration_runs (id, kind, step, source_hash, dry_run_digest, backup_ref, report, started_at, finished_at, outcome) VALUES (?, ?, 'locked', ?, ?, ?, ?, ?, NULL, NULL)",
          args: [runId, KIND, report.sourceHash, dry.digest, report.backupRef, JSON.stringify(report), at],
        },
      ],
      "write",
    );
  } catch (e) {
    // committed, and the answer was lost (lib/db.js resent it, and the resend
    // met its own lock): this run's row is there, so the store is paused by it
    const mine = await openRun(KIND).catch(() => null);
    if (!(mine && mine.id === runId)) {
      const c = await classifyAbort(libsql, e, "legacy");
      if (c?.kind === "mode") return { ok: false, refused: modeRefusal(c.mode, { run: await anyOpenRun() }) || refusal("BUSY", WORDS.BUSY) };
      if (c?.kind === "lost") return { ok: false, refused: refusal("LIVE_MOVED", WORDS.LIVE_MOVED) };
      throw e;
    }
  }
  if (__cutoverTestHooks.afterLock) await __cutoverTestHooks.afterLock();
  if (__cutoverTestHooks.afterStep) await __cutoverTestHooks.afterStep("locked");
  Object.assign(ctx, { runId, report, at: "locked" });
  const r = await continueRun(ctx);
  return finished(ctx, r);
}

function finished(ctx, r) {
  if (r.stopped) return { ok: false, stopped: { code: r.code, words: r.words, unlocked: !!r.unlocked }, report: ctx.report, runId: ctx.runId };
  if (!r.finished) return { ok: false, unfinished: true, report: ctx.report, runId: ctx.runId, words: ctx.report.stopped?.words ?? null };
  return { ok: true, report: ctx.report, runId: ctx.runId };
}

/** --status: read only. */
export async function cutoverStatus() {
  return storeStatus();
}

export const ABORT_WORDS = Object.freeze({
  NOTHING: "There is no move under way, so there is nothing to stop.",
  AFTER_FLIP:
    "The store has already switched to the new editor, so the move can't be stopped any more. To go back to the old editor, use the reversal tool (the reverse:documents command; see the runbook's reversal section).",
  DONE: "The move was stopped and the store is back on the old editor. The old editors save again and the catalog copy from Shopify carries on. What was already copied stays in the new editor's tables, unseen by shoppers; the next move takes the old editor's content again.",
  NOT_PAUSED: "The store isn't paused for this move any more, so nothing was changed. Check it with --status.",
});

/** --abort: before the flip only. */
export async function abortCutover({ now = nowIso } = {}) {
  const open = await openRun(KIND);
  if (!open) return { ok: false, refused: refusal("NOTHING", ABORT_WORDS.NOTHING) };
  if (!isBeforeFlip(open.step)) return { ok: false, refused: refusal("AFTER_FLIP", ABORT_WORDS.AFTER_FLIP) };
  const report = { ...parseReport(open), outcome: "aborted" };
  const at = now();
  report.finishedAt = at;
  try {
    await unlock(open.id, report, { outcome: "aborted", step: open.step, at });
  } catch (e) {
    if (isGuardAbort(e)) return { ok: false, refused: refusal("NOT_PAUSED", ABORT_WORDS.NOT_PAUSED) };
    throw e;
  }
  return { ok: true, words: ABORT_WORDS.DONE, runId: open.id };
}

// ---- the rehearsal ----------------------------------------------------------------------------

/**
 * --rehearsal-run, on a local copy of the store (the caller has already set the
 * tenant context to the copy). capture(label) -> { pages, index } where pages
 * is render-compare's page list ({ route, status, contentType, location,
 * origin, body }) and index the capture's route list (with `kind`); compare
 * (before, after) -> render-compare's result. Both are injected: the command
 * passes scripts/migrate-render.mjs's, the suite renders in-process.
 * -> { report (the rehearsal.json object), cutover (runCutover's answer) }
 */
export async function runRehearsal({ capture, compare, now = nowIso, ...opts } = {}) {
  if (typeof capture !== "function" || typeof compare !== "function") throw new Error("runRehearsal: capture and compare are required");
  let before = null;
  const cut = await runCutover({
    ...opts,
    now,
    rehearsal: true,
    beforeLock: async () => {
      before = await capture("before");
    },
  });
  const rep = {
    tool: TOOL,
    kind: REHEARSAL_KIND,
    version: 1,
    tenant: tenantId(),
    sourceHash: cut.report?.sourceHash ?? cut.dry?.mapped?.sourceHash ?? null,
    digest: cut.report?.digest ?? cut.dry?.digest ?? null,
    runId: cut.runId ?? null,
    at: now(),
    cutover: cut.ok ? "done" : cut.refused ? `refused: ${cut.refused.code}` : cut.stopped ? `stopped: ${cut.stopped.code}` : "unfinished",
    dataCheck: cut.report?.dataCheck ? { ran: cut.report.dataCheck.ran, compared: cut.report.dataCheck.compared, differences: cut.report.dataCheck.differences } : { ran: false, compared: 0, differences: null },
    render: null,
    passed: false,
  };
  if (!cut.ok || !before) {
    rep.words = cut.refused?.message || cut.stopped?.words || "The rehearsal didn't finish.";
    return { report: rep, cutover: cut };
  }
  const after = await capture("after");
  const notLaunched = cut.report?.state === "no_release_not_launched";
  rep.notLaunched = notLaunched;
  const res = compare(before.pages, after.pages);
  const canaries = (before.index || []).filter((r) => r.kind === "canary" || !(before.index || []).some((x) => x.kind === "canary"));
  const badCanaries = canaries.filter((r) => !(Number(r.status) >= 200 && Number(r.status) < 400)).map((r) => ({ path: r.path, status: r.status }));
  rep.render = {
    same: !!res.same,
    compared: Number(res.compared || 0),
    canaries: canaries.length,
    canariesOk: canaries.length > 0 && badCanaries.length === 0,
    badCanaries,
    differences: (res.differences || []).length,
    list: (res.differences || []).slice(0, 40).map((d) => ({ route: d.route, selector: d.selector, before: d.before ?? null, after: d.after ?? null })),
    allowed: [...new Set((res.allowedApplied || []).map((a) => a.id))],
  };
  // A store that isn't open yet closes at the move (spec 8.11: closed until
  // its first publish): its pages are expected to change, to "Opening soon".
  if (notLaunched) {
    const html = (after.pages || []).filter((p) => /html/i.test(p.contentType || "") || (!p.contentType && typeof p.body === "string" && p.body.includes("<")));
    rep.render.closedAfter = html.length > 0 && html.every((p) => /Opening soon/.test(p.body));
  }
  // a comparison of nothing, or of broken pages, is never "the same"
  if (!rep.render.compared) rep.render.words = "No page was compared.";
  else if (!rep.render.canariesOk) rep.render.words = "Some pages didn't load before the move, so 'the same' can't be trusted.";
  else if (notLaunched && !rep.render.closedAfter) rep.render.words = "The store should show 'Opening soon' after the move, and it doesn't.";
  else if (!notLaunched && !rep.render.same) rep.render.words = `${rep.render.differences} difference(s) on the pages.`;
  const dataClean = notLaunched ? rep.dataCheck.ran === false && cut.report?.dataCheck?.reason === "NOTHING_PUBLISHED" : rep.dataCheck.ran === true && rep.dataCheck.differences === 0;
  if (notLaunched) rep.dataCheck.reason = cut.report?.dataCheck?.reason ?? null;
  const renderClean = rep.render.compared > 0 && rep.render.canariesOk && (notLaunched ? rep.render.closedAfter === true : rep.render.same);
  rep.passed = dataClean && renderClean;
  return { report: rep, cutover: cut };
}
