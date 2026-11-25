// GEN-02: catalog syncs through the durable queue. Node-only (control plane).
//
// A run (tenant DB, sync_runs) is the source of truth for progress; ONE job
// per run (control plane, idempotency key catalog_sync:<tenant>:<run>) is how
// it gets CPU time. Each time the job runs it does one time-boxed slice and
// requeues itself until the run completes. Three things give it time:
//   • the after() kick from whoever started or retried it (connect, console,
//     operator, scheduled route) — the first ~45 seconds at once;
//   • the tick (/api/jobs/tick, external scheduler) — the durable path;
//   • the console's status poll while the founder watches (nudge below).
// Legacy mode (no control plane, the _default store) has no queue: the kick
// and the nudge run a slice in-process instead, under the run's own lease.
import { platformConfigured } from "./control.js";
import { enqueueJob, getJobByKey, makeJobDue } from "./jobs.js";
import { runJobById, workerClock } from "./worker.js";
import { requestCatalogSync, runSyncSlice, catalogSyncStatus } from "../sync.js";
import { syncView } from "../admin/sync-view.js";
import { tenantId } from "../tenant-context.js";

export const SYNC_JOB_TYPE = "catalog_sync";
// What a kick may spend after its response, inside a 60s route.
export const KICK_BUDGET_MS = 45_000;

const queueTenant = () => {
  const t = tenantId();
  return t === "_default" ? null : t;
};
export const syncJobKey = (runId) => `${SYNC_JOB_TYPE}:${queueTenant() || "_default"}:${runId}`;

export const syncJobFor = (runId) => getJobByKey(syncJobKey(runId));

// A job whose runner was killed (the platform ended its function mid-slice)
// stays 'leased' until its lease runs out; after that it is free to run again.
const leaseLapsed = (job) => job?.status === "leased" && (!job.lease_until || Date.parse(job.lease_until) < Date.now());

// The run's job, created if missing (a lost enqueue, a pruned row) and made
// due when it had finished or died, or `runNow` (the founder's Try again) asks
// to skip its backoff, to take over from a runner that was killed, or to bring
// back a job an operator discarded (Phase 3 line 6; a poll never does).
export async function ensureSyncJob(run, { runNow = false } = {}) {
  const key = syncJobKey(run.id);
  let job = await getJobByKey(key);
  if (!job) {
    await enqueueJob({ type: SYNC_JOB_TYPE, tenantId: queueTenant(), payload: { runId: run.id }, idempotencyKey: key, maxAttempts: 5 });
    job = await getJobByKey(key);
  }
  if (job && (job.status === "done" || job.status === "dead" || (runNow && job.status === "discarded") || (runNow && ((job.status === "pending" && job.run_after) || leaseLapsed(job))))) {
    await makeJobDue(job.id, { revive: runNow });
    job = await getJobByKey(key);
  }
  return job;
}

// Runnable now: pending and due, or leased by a runner whose lease ran out
// (runJobById → leaseJobById takes those over). Review fix (GEN-02 round 1):
// without the second case a killed slice could only be picked up by the tick,
// so with no tick neither the console poll nor Try again moved the sync.
export const isDue = (job) =>
  (job?.status === "pending" && (!job.run_after || Date.parse(job.run_after) <= Date.now())) || leaseLapsed(job);

// Give a running sync CPU time after the response: the job's next slice
// (platform) or an in-process slice (legacy). Safe to over-call: the job lease
// and the run lease each allow one runner. → the job, when there is a queue.
export async function kickSync(run, { defer = null, budgetMs = KICK_BUDGET_MS, runNow = false } = {}) {
  if (!run || run.status !== "running") return null;
  if (platformConfigured()) {
    const job = await ensureSyncJob(run, { runNow });
    if (defer && isDue(job)) defer(() => runJobById(job.id, { budgetMs }).catch(() => {}));
    return job;
  }
  if (defer) {
    defer(() =>
      runSyncSlice(run.id, { deadline: workerClock.now() + budgetMs, now: workerClock.now, mode: "inline" }).catch(() => {}),
    );
  }
  return null;
}

// Start (or join, or resume on retry) the store's sync and kick it.
//   → { run, action, job }
export async function startCatalogSync({ startedBy = "manual", retry = false, defer = null, budgetMs = KICK_BUDGET_MS } = {}) {
  const res = await requestCatalogSync({ startedBy, retry });
  const job = await kickSync(res.run, { defer, budgetMs, runNow: retry });
  return { ...res, job };
}

// The console's view of the sync, read from sync_runs. With `nudge`, a
// running sync whose job is due also gets a slice after the response (so a
// first sync keeps moving while the founder watches, tick or no tick).
export async function catalogSyncProgress({ nudge = false, defer = null, budgetMs = KICK_BUDGET_MS } = {}) {
  const status = await catalogSyncStatus();
  const run = status.run;
  if (!run || run.status !== "running") return status;
  let retryAt = null;
  if (platformConfigured()) {
    const job = nudge ? await ensureSyncJob(run).catch(() => null) : await syncJobFor(run.id).catch(() => null);
    if (job?.status === "pending" && job.run_after && Date.parse(job.run_after) > Date.now()) retryAt = job.run_after;
    if (nudge && defer && isDue(job)) defer(() => runJobById(job.id, { budgetMs }).catch(() => {}));
  } else if (nudge) {
    await kickSync(run, { defer, budgetMs });
  }
  return retryAt ? { ...status, view: syncView(run, { hasComplete: !status.view.firstSync, retryAt, linked: status.linked }) } : status;
}
