// The provision_store job (Phase 1 line 2, docs/plans/phase-1.md §1 items 3–7,
// §3). Node-only.
//
//   provision_store {signupId, siteUrl}   key provision_store:<signupId>, maxAttempts 3
//     load the signup: done -> {already}; not provisioning -> {skipped};
//     lapsed -> failed 'lapsed'; run (or resume) the signup's provision run, then
//     the user and the owner membership, then done + done_at. A retryable
//     failure with retries left counts one, sets next_attempt_at and returns
//     {requeue, runAfter} (its own delays, not the queue's 60 s backoff); after
//     the fifth retry -> failed 'retry_exhausted'; anything else -> failed
//     'needs_operator' with an alert naming the signup, step and HTTP status
//     (once per signup per kind: signups.alerted_kinds). The job's lease is
//     renewed before each step; a runner that lost it stops writing and every
//     signup write is conditional on status 'provisioning' under this job.
//     No token is ever in the job, the signup row or a log line.
//   claimSignupProvision(row, { siteUrl }) -> { jobId } | { already: status }
//     verified or failed -> provisioning with a fresh try count, the job made
//     due (the same job, so the same provision run: never a second database).
//   resumeSignupRun(runId) -> the operator's resume of a signup's run.
//   signupsForRuns(runIds) -> { runId: { id, status, failureKind } } for /platform.
import { platformDb } from "./control.js";
import { findUserByEmail, createUser, addMembership } from "./identity.js";
import { enqueueJob, makeJobDue, renewJobLease } from "./jobs.js";
import { audit } from "./audit.js";
import { scrubSecrets, RETRY_AFTER_CAP_MS } from "./turso-api.js";
import { sendAlert } from "../alerts.js";
import { slog } from "../log.js";

export const JOB_TYPE = "provision_store";
export const jobKey = (signupId) => `${JOB_TYPE}:${signupId}`;
export const JOB_MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000, 120_000, 300_000]);
export const MAX_RETRIES = RETRY_DELAYS_MS.length;
// A seam for the suite (the retry delays on a fake clock); real time otherwise.
export const signupClock = { now: () => Date.now() };

export const EXHAUSTED_WORDS = "We couldn't finish setting up your store. Nothing you entered is lost: press Try again.";
export const NEEDS_US_WORDS = "Something on our side needs fixing. We've been told. Press Try again in a while.";
// the same words as lib/platform/signup.js SIGNUP_LAPSED (kept here to avoid an import cycle)
export const LAPSED_WORDS = "This signup has lapsed. Start again.";
export const LAPSE_AFTER_MS = 24 * 60 * 60 * 1000;
export const FAILURE_WORDS = Object.freeze({ retry_exhausted: EXHAUSTED_WORDS, needs_operator: NEEDS_US_WORDS, lapsed: LAPSED_WORDS });

const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const signupLapsed = (row) => row.expires_at <= iso(Date.now() - LAPSE_AFTER_MS) || (!row.user_id && !row.password_hash);

async function loadSignup(id) {
  const r = await platformDb().execute({ sql: "SELECT * FROM signups WHERE id = ?", args: [id] });
  return r.rows[0] ? { ...r.rows[0] } : null;
}
async function setRow(id, patch) {
  const keys = Object.keys(patch);
  await platformDb().execute({ sql: `UPDATE signups SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, args: [...keys.map((k) => patch[k]), iso(), id] });
}

// The job's own writes to its signup: only while the signup is still
// provisioning under this job (a runner that lost the race changes nothing).
// -> true when the row was written.
async function setIfProvisioning(id, jobId, patch) {
  const keys = Object.keys(patch);
  const r = await platformDb().execute({
    sql: `UPDATE signups SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND status = 'provisioning' AND (? IS NULL OR job_id IS NULL OR job_id = ?) RETURNING id`,
    args: [...keys.map((k) => patch[k]), iso(), id, jobId, jobId],
  });
  return Boolean(r.rows[0]);
}
// -> true the first time this signup fails with this kind (an alert is due)
async function firstAlertFor(id, kind) {
  const entry = `,${kind},`;
  const r = await platformDb().execute({
    sql: "UPDATE signups SET alerted_kinds = COALESCE(alerted_kinds, '') || ? WHERE id = ? AND instr(COALESCE(alerted_kinds, ''), ?) = 0 RETURNING id",
    args: [entry, id, entry],
  });
  return Boolean(r.rows[0]);
}

async function failSignup(row, kind, { step = null, status = null, run = null, jobId = null } = {}) {
  if (!(await setIfProvisioning(row.id, jobId, { status: "failed", failure_kind: kind, error: FAILURE_WORDS[kind], next_attempt_at: null }))) return { lostLease: true };
  slog("signup_provision_failed", { signup: row.id, kind, step, ...(status != null ? { status } : {}) });
  // once per signup per kind: Try again after a needs-us failure does not alert again
  if (kind === "needs_operator" && (await firstAlertFor(row.id, kind))) {
    await sendAlert(`Self-serve signup needs an operator: ${row.id}`, { signup: row.id, store: row.slug, step, status, run }, { severity: "warn", runbook: "/platform provisions: fix the cause, then resume the run" });
  }
  return { failed: kind, step };
}

// Unexpected throws go to the queue's backoff; their text is scrubbed first,
// since it lands in jobs.last_error.
export const withScrubbedErrors = (fn) => async (payload, ctx) => {
  try {
    return await fn(payload, ctx);
  } catch (e) {
    throw new Error(scrubSecrets(e?.message || e).slice(0, 300));
  }
};

async function provisionStore({ signupId, siteUrl = null } = {}, ctx = {}) {
  const row = signupId ? await loadSignup(signupId) : null;
  if (!row) return { missing: true };
  if (row.status === "done") return { already: true };
  if (row.status !== "provisioning") return { skipped: row.status };
  // the lease is renewed before each step; a runner that lost it stops there
  const jobId = ctx.job?.id ?? null;
  const holdLease = () => (ctx.job ? renewJobLease(ctx.job) : true);
  const fail = (kind, opts = {}) => failSignup(row, kind, { ...opts, jobId });
  if (signupLapsed(row)) return fail("lapsed");

  const db = platformDb();
  const { runProvision } = await import("./provision.js");
  const { signupDbDriver } = await import("./provisioner.js");
  const { storeHostFor } = await import("./signup.js");
  let runId = row.provision_run_id;
  if (!runId) {
    // a run started before a crash, before its id was saved on the signup
    // (never one an operator superseded by freeing the address, line 8)
    const earlier = await db.execute({ sql: "SELECT id, params FROM provision_runs WHERE tenant_id = ? AND status != 'superseded' ORDER BY created_at DESC LIMIT 1", args: [row.slug] });
    let p = null;
    try {
      p = earlier.rows[0] ? JSON.parse(earlier.rows[0].params || "{}") : null;
    } catch {
      p = null;
    }
    if (p?.source === "signup" && p?.supportEmail === row.email) runId = earlier.rows[0].id;
  }
  let r;
  if (runId) r = await runProvision({}, { resumeRunId: runId, holdLease });
  else {
    const driver = signupDbDriver();
    if (!driver) return fail("needs_operator", { step: "create_db" });
    r = await runProvision({
      id: row.slug,
      name: row.store_name,
      domains: [storeHostFor(row.slug)],
      siteName: row.store_name,
      supportEmail: row.email,
      contentMode: "documents",
      dbDriver: driver,
      source: "signup",
      siteUrl: siteUrl || `https://${storeHostFor(row.slug)}`,
    }, { holdLease });
  }
  if (r.lostLease || !(await holdLease())) return { lostLease: true };
  runId = r.run.id;
  if (!(await setIfProvisioning(row.id, jobId, { provision_run_id: runId, tenant_id: row.slug }))) return { lostLease: true };
  if (r.failedStep) {
    const tries = Number(row.provision_attempts || 0);
    if (r.failedKind === "retry" && tries < MAX_RETRIES) {
      const delay = Math.max(RETRY_DELAYS_MS[tries], Math.min(r.retryAfterMs || 0, RETRY_AFTER_CAP_MS));
      const runAfter = iso(signupClock.now() + delay);
      if (!(await setIfProvisioning(row.id, jobId, { provision_attempts: tries + 1, next_attempt_at: runAfter, error: null }))) return { lostLease: true };
      slog("signup_provision_retry", { signup: row.id, attempt: tries + 1, status: r.failedStatus ?? "network", step: r.failedStep, delayMs: delay });
      return { requeue: true, runAfter, attempt: tries + 1 };
    }
    return fail(r.failedKind === "retry" ? "retry_exhausted" : "needs_operator", { step: r.failedStep, status: r.failedStatus, run: runId });
  }
  if (!r.resumedNoop) await audit({ actor: { kind: "system", id: "signup" }, action: "tenant.provisioned", tenantId: row.slug, diff: { source: "signup", run: runId } });

  let userId = row.user_id;
  try {
    if (!userId) {
      // the email was proved; an account made for it since is the same person's
      let user = await findUserByEmail(row.email);
      if (!user && !row.password_hash) return fail("lapsed", { step: "create_account" });
      user ||= await createUser({ email: row.email, name: row.name, passwordHash: row.password_hash, emailVerifiedAt: row.verified_at || iso() });
      userId = user.id;
      await setRow(row.id, { user_id: userId });
    }
    await addMembership(userId, row.slug, "owner");
  } catch (e) {
    slog("signup_user_error", { signup: row.id, error: scrubSecrets(e?.message || e).slice(0, 200) });
    return fail("needs_operator", { step: "create_account", run: runId });
  }
  if (!(await holdLease())) return { lostLease: true };
  const at = iso();
  if (!(await setIfProvisioning(row.id, jobId, { status: "done", done_at: at, password_hash: null, code_hash: null, next_attempt_at: null, failure_kind: null, error: null }))) return { lostLease: true };
  await audit({ actor: { kind: "merchant", id: userId, role: "owner" }, action: "signup.verified", tenantId: row.slug, resource: row.id });
  slog("signup_done", { signup: row.id, tenant: row.slug, run: runId });
  return { done: true, tenant: row.slug };
}

export const runSignupProvisionJob = withScrubbedErrors(provisionStore);

// The queue gave up on the job (unexpected throws): the founder sees "needs us".
export async function markSignupJobDead(signupId, jobId = null) {
  const row = signupId ? await loadSignup(signupId) : null;
  if (row?.status === "provisioning") await failSignup(row, "needs_operator", { step: "job", jobId });
}

export async function claimSignupProvision(row, { siteUrl = null } = {}) {
  const claimed = await platformDb().execute({
    sql: `UPDATE signups SET status = 'provisioning', error = NULL, failure_kind = NULL, provision_attempts = 0, next_attempt_at = NULL, updated_at = ?
          WHERE id = ? AND status IN ('verified', 'failed') RETURNING id`,
    args: [iso(), row.id],
  });
  if (!claimed.rows[0]) return { already: row.status, jobId: row.job_id || null };
  const { id: jobId, existed } = await enqueueJob({ type: JOB_TYPE, payload: { signupId: row.id, siteUrl }, idempotencyKey: jobKey(row.id), maxAttempts: JOB_MAX_ATTEMPTS });
  if (existed) await makeJobDue(jobId);
  await setRow(row.id, { job_id: jobId });
  slog("signup_job_queued", { signup: row.id, job: jobId, ...(existed ? { again: true } : {}) });
  return { jobId };
}

export async function resumeSignupRun(runId) {
  const r = await platformDb().execute({ sql: "SELECT * FROM signups WHERE provision_run_id = ? ORDER BY created_at DESC LIMIT 1", args: [String(runId || "")] });
  const row = r.rows[0] ? { ...r.rows[0] } : null;
  if (!row) return null;
  if (row.status === "done") return { already: "done", signupId: row.id };
  if (signupLapsed(row)) return { lapsed: true, signupId: row.id };
  const q = await claimSignupProvision(row);
  if (q.already === "provisioning" && row.job_id) await makeJobDue(row.job_id);
  return { signupId: row.id, jobId: q.jobId || row.job_id || null };
}

export async function signupsForRuns(runIds) {
  const ids = [...new Set((runIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const r = await platformDb().execute({ sql: `SELECT id, status, failure_kind, provision_run_id FROM signups WHERE provision_run_id IN (${ids.map(() => "?").join(",")})`, args: ids });
  return Object.fromEntries(r.rows.map((s) => [s.provision_run_id, { id: s.id, status: s.status, failureKind: s.failure_kind || null }]));
}
