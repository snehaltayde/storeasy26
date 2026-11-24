// Phase 1 line 8: the operator's cache of each store's onboarding steps
// (onboarding_progress, migration 0014). Node only. The founder's own page
// always reads live; this is what /platform/onboarding lists and sorts by.
//
//   snapshotTenant(tenant, { now })  reads the steps inside the store's own
//       database (withTenant + onboardingFor as the read-only support role,
//       capped at 5 s), stores the compact steps and returns the live model.
//       step_since: when the current step or its state last changed. The first
//       snapshot of a store on step 1 uses the store's created_at (exact);
//       otherwise the check time, shown as "at least". A failed read keeps
//       the last good steps and records check_error. -> { ok, model?, error? }
//   sweepOnboarding({ limit, deadline, now })  never-checked stores first,
//       then closed ones not checked for 30 minutes, then open ones not
//       checked for a day. -> { checked, failed }
//   queueOnboardingSweep(now)  one onboarding_sweep job per 10-minute window
//       (the idempotency key dedupes repeated ticks).
import { platformDb, getTenant } from "../platform/control.js";
import { enqueueJob } from "../platform/jobs.js";
import { withTenant } from "../tenant-context.js";
import { slog } from "../log.js";

export const SWEEP_JOB = "onboarding_sweep";
export const SWEEP_WINDOW_MS = 10 * 60 * 1000;
export const SNAPSHOT_CAP_MS = 5_000;
export const CLOSED_RECHECK_MS = 30 * 60 * 1000;
export const OPEN_RECHECK_MS = 24 * 60 * 60 * 1000;
export const snapshotClock = { now: () => Date.now() };
// The live read, as a seam the suite can make fail.
export const snapshotReader = {
  read: async (tenant) => {
    const { onboardingFor } = await import("./service.js");
    return withTenant(tenant, () => onboardingFor({ role: "support" }));
  },
};

const iso = (ms) => new Date(ms).toISOString();

function withCap(promise, ms) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the store did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

const compact = (steps) =>
  (steps || []).map((s) => ({ id: s.id, state: s.state, ...(s.problem ? { problem: String(s.problem).slice(0, 300) } : {}), ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}) }));

const markOf = (current, steps) => (current ? `${current}:${steps.find((s) => s.id === current)?.state || ""}` : "");

export async function snapshotTenant(tenant, { now = snapshotClock.now() } = {}) {
  const db = platformDb();
  const checkedAt = iso(now);
  let model;
  try {
    model = await withCap(snapshotReader.read(tenant), SNAPSHOT_CAP_MS);
  } catch (e) {
    const error = String(e?.message || e).slice(0, 200);
    await db.execute({
      sql: `INSERT INTO onboarding_progress (tenant_id, checked_at, check_error) VALUES (?, ?, ?)
            ON CONFLICT(tenant_id) DO UPDATE SET checked_at = excluded.checked_at, check_error = excluded.check_error`,
      args: [tenant.id, checkedAt, error],
    });
    slog("onboarding_snapshot_failed", { tenant: tenant.id });
    return { ok: false, error };
  }
  const steps = compact(model.steps);
  const current = model.supported && !model.open ? model.current : null;
  const prev = (await db.execute({ sql: "SELECT current_step, steps, step_since, step_since_exact FROM onboarding_progress WHERE tenant_id = ?", args: [tenant.id] })).rows[0];
  let since = checkedAt;
  let exact = 0;
  if (prev && prev.step_since && markOf(prev.current_step, JSON.parse(prev.steps || "[]")) === markOf(current, steps)) {
    since = prev.step_since;
    exact = Number(prev.step_since_exact) || 0;
  } else if (prev && prev.step_since) {
    exact = 1; // seen to change since the last check
  } else if (current === "connect") {
    const created = (await db.execute({ sql: "SELECT created_at FROM tenants WHERE id = ?", args: [tenant.id] })).rows[0]?.created_at;
    if (created) {
      since = created;
      exact = 1;
    }
  }
  await db.execute({
    sql: `INSERT INTO onboarding_progress (tenant_id, supported, open, current_step, done_count, steps, step_since, step_since_exact, checked_at, check_error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(tenant_id) DO UPDATE SET supported = excluded.supported, open = excluded.open, current_step = excluded.current_step,
            done_count = excluded.done_count, steps = excluded.steps, step_since = excluded.step_since,
            step_since_exact = excluded.step_since_exact, checked_at = excluded.checked_at, check_error = NULL`,
    args: [tenant.id, model.supported ? 1 : 0, model.openKnown ? (model.open ? 1 : 0) : null, current, Number(model.doneCount) || 0, JSON.stringify(steps), since, exact, checkedAt],
  });
  return { ok: true, model };
}

export async function sweepOnboarding({ limit = 10, deadline = null, now = snapshotClock.now } = {}) {
  const t = now();
  const r = await platformDb().execute({
    sql: `SELECT t.id FROM tenants t LEFT JOIN onboarding_progress p ON p.tenant_id = t.id
          WHERE t.status = 'active' AND (p.tenant_id IS NULL
            OR (COALESCE(p.open, 0) != 1 AND p.checked_at < ?)
            OR (p.open = 1 AND p.checked_at < ?))
          ORDER BY CASE WHEN p.tenant_id IS NULL THEN 0 WHEN COALESCE(p.open, 0) != 1 THEN 1 ELSE 2 END, p.checked_at ASC, t.created_at ASC
          LIMIT ?`,
    args: [iso(t - CLOSED_RECHECK_MS), iso(t - OPEN_RECHECK_MS), Math.max(1, Math.min(Number(limit) || 10, 50))],
  });
  let checked = 0;
  let failed = 0;
  for (const row of r.rows) {
    // each store may take up to the cap: stop while a whole one still fits
    if (deadline != null && now() + SNAPSHOT_CAP_MS > deadline) break;
    const tenant = await getTenant(row.id, { fresh: true }).catch(() => null);
    const res = tenant ? await snapshotTenant(tenant, { now: now() }) : { ok: false };
    checked++;
    if (!res.ok) failed++;
  }
  slog("onboarding_sweep", { checked, failed });
  return { checked, failed };
}

export async function queueOnboardingSweep(now = snapshotClock.now()) {
  const windowStart = Math.floor(now / SWEEP_WINDOW_MS);
  return enqueueJob({ type: SWEEP_JOB, idempotencyKey: `${SWEEP_JOB}:${windowStart}`, maxAttempts: 1 });
}
