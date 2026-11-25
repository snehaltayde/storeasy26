// Durable job queue + webhook inbox (Session 29 / BE14). Control-plane-backed:
// enqueue is idempotent (UNIQUE idempotency_key), leasing is one atomic UPDATE
// (a crashed worker's lease simply expires and the job re-leases), retries back
// off with jitter, and exhausted jobs dead-letter LOUDLY (alert + inspector).
// Handlers must be idempotent — the queue guarantees at-LEAST-once execution;
// the money paths already are (markOrderPaid/push/forward all no-op on replay).
//
// after() remains the fast path (immediate attempt via runJobById); the tick
// endpoint (/api/jobs/tick, external scheduler) is the durability backstop.
import { platformDb, platformConfigured, getTenant } from "./control.js";
import { newId, sha256Hex } from "./sessions.js";
import { tenantId } from "../tenant-context.js";
import { sendAlert } from "../alerts.js";
import { audit } from "./audit.js";
import { slog } from "../log.js";
import { clampLimit } from "./paging.js";
import { scrubSecrets } from "./turso-api.js";

export const LEASE_MS = 120_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

const nowIso = () => new Date().toISOString();

// attempts → next run_after with ±25% jitter (deterministic-ish is fine here)
export function backoffMs(attempts) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

// --- enqueue -------------------------------------------------------------------

// Idempotent enqueue. Returns { id, existed }. Throws only on real DB errors —
// use enqueueDurable() from request paths that must never fail on queue trouble.
export async function enqueueJob({ type, tenantId: tid = null, payload = {}, idempotencyKey = null, maxAttempts = 5, runAfter = null }) {
  const id = newId("job");
  const res = await platformDb().execute({
    sql: `INSERT INTO jobs (id, type, tenant_id, payload, idempotency_key, status, attempts, max_attempts, run_after, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
          ON CONFLICT(idempotency_key) DO NOTHING`,
    args: [id, type, tid, JSON.stringify(payload), idempotencyKey, maxAttempts, runAfter, nowIso(), nowIso()],
  });
  if (Number(res.rowsAffected) === 0 && idempotencyKey) {
    const existing = await platformDb().execute({
      sql: "SELECT id FROM jobs WHERE idempotency_key = ?",
      args: [idempotencyKey],
    });
    return { id: existing.rows[0]?.id ?? null, existed: true };
  }
  return { id, existed: false };
}

// S52: cancel a scheduled job that hasn't run yet (e.g. a scheduled release
// publish). Only 'pending' rows are deletable — a leased/done/dead job stays,
// and the caller decides what that means for its own record.
export async function cancelPendingJob(idempotencyKey) {
  if (!idempotencyKey) return { found: false, cancelled: false };
  const r = await platformDb().execute({ sql: "SELECT id, status FROM jobs WHERE idempotency_key = ?", args: [idempotencyKey] });
  const row = r.rows[0];
  if (!row) return { found: false, cancelled: false };
  if (row.status !== "pending") return { found: true, cancelled: false, status: row.status };
  const del = await platformDb().execute({ sql: "DELETE FROM jobs WHERE id = ? AND status = 'pending'", args: [row.id] });
  return { found: true, cancelled: Number(del.rowsAffected) > 0, status: "pending" };
}

// Fire-and-forget enqueue for checkout/webhook paths: platform mode only
// (legacy mode keeps its sweep-based retries), and NEVER throws — a queue
// hiccup must not break the flow it is backing up.
export async function enqueueDurable(type, payload, idempotencyKey) {
  if (!platformConfigured()) return null;
  try {
    const tid = tenantId();
    return await enqueueJob({
      type,
      tenantId: tid === "_default" ? null : tid,
      payload,
      idempotencyKey,
    });
  } catch (e) {
    slog("job_enqueue_failed", { type, error: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

// --- leasing / completion --------------------------------------------------------

// Atomically lease up to `limit` due jobs (pending-and-due, or leased with an
// EXPIRED lease — that is the crash recovery: ack'd work whose worker died
// comes back here). attempts increments at lease time.
// GEN-02: `excludeTypes` keeps long-running job types (a catalog sync slice)
// away from callers that don't know their own time budget.
export async function leaseJobs({ limit = 10, excludeTypes = [] } = {}) {
  const now = nowIso();
  const skip = excludeTypes.length ? `AND type NOT IN (${excludeTypes.map(() => "?").join(", ")})` : "";
  const res = await platformDb().execute({
    sql: `UPDATE jobs SET status = 'leased', lease_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id IN (
            SELECT id FROM jobs
            WHERE ((status = 'pending' AND (run_after IS NULL OR run_after <= ?))
               OR (status = 'leased' AND lease_until < ?)) ${skip}
            ORDER BY created_at
            LIMIT ?
          )
          RETURNING *`,
    args: [new Date(Date.now() + LEASE_MS).toISOString(), now, now, now, ...excludeTypes, limit],
  });
  return res.rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

// Lease ONE specific job if (and only if) it is leasable — the after() fast
// path uses this so it can never double-run a job the tick already took.
export async function leaseJobById(id) {
  const now = nowIso();
  const res = await platformDb().execute({
    sql: `UPDATE jobs SET status = 'leased', lease_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND (
            (status = 'pending' AND (run_after IS NULL OR run_after <= ?))
            OR (status = 'leased' AND lease_until < ?)
          )
          RETURNING *`,
    args: [new Date(Date.now() + LEASE_MS).toISOString(), now, id, now, now],
  });
  const row = res.rows[0];
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

// Phase 1 line 2 review fix: a long handler keeps its lease alive between
// steps. The lease is ours only while lease_until is still the value we hold
// (a runner that took the job after our lease ran out set a new one).
// -> true when renewed (job.lease_until moves on), false when the lease is lost.
export async function renewJobLease(job) {
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  const res = await platformDb().execute({
    sql: "UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'leased' AND lease_until = ? RETURNING id",
    args: [until, nowIso(), job.id, job.lease_until],
  });
  if (!res.rows[0]) return false;
  job.lease_until = until;
  return true;
}

const safeParse = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

export async function completeJob(id) {
  await platformDb().execute({
    sql: "UPDATE jobs SET status = 'done', done_at = ?, updated_at = ?, last_error = NULL WHERE id = ?",
    args: [nowIso(), nowIso(), id],
  });
}

// GEN-02: a job that did its share and has more to do goes back in the queue
// as fresh work: pending, due now (or at runAfter), a new attempt budget, and
// to the back of the line (created_at), so one long sync can't starve another
// store's. Only from 'leased': a job someone else re-leased is left alone.
export async function requeueJob(id, { runAfter = null } = {}) {
  const now = nowIso();
  await platformDb().execute({
    sql: `UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, lease_until = NULL, last_error = NULL, created_at = ?, updated_at = ?
          WHERE id = ? AND status = 'leased'`,
    args: [runAfter, now, now, id],
  });
}

// Phase 3 line 2: a suspended store's job waits. It goes back to pending with
// the attempt the lease took handed back, its place in line (created_at) kept,
// and a last_error that says since when it has been waiting. After
// SUSPENDED_MAX_MS of waiting it dead-letters with a plain reason (an operator
// replays it once the store is resumed). Only from 'leased'.
export const SUSPENDED_WAIT_PREFIX = "Waiting: the store is suspended (since ";
export const SUSPENDED_MAX_MS = 7 * 24 * 60 * 60_000;
export const SUSPENDED_DEAD_REASON = "The store stayed suspended for 7 days, so this job was stopped. Replay it after the store is resumed.";
const waitingSince = (lastError) => {
  const s = String(lastError || "");
  return s.startsWith(SUSPENDED_WAIT_PREFIX) ? Date.parse(s.slice(SUSPENDED_WAIT_PREFIX.length).replace(/\)$/, "")) : NaN;
};

// -> { dead: boolean }
export async function holdForSuspendedStore(job, { now = Date.now(), retryMs }) {
  const known = waitingSince(job.last_error);
  const since = Number.isFinite(known) ? known : now;
  if (now - since >= SUSPENDED_MAX_MS) {
    await platformDb().execute({
      sql: "UPDATE jobs SET status = 'dead', lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'leased'",
      args: [SUSPENDED_DEAD_REASON, nowIso(), job.id],
    });
    await sendAlert(`Job dead-lettered: ${job.type} (store suspended 7 days)`, { job: job.id, tenant: job.tenant_id, error: SUSPENDED_DEAD_REASON }, { severity: "warning" });
    return { dead: true };
  }
  await platformDb().execute({
    sql: `UPDATE jobs SET status = 'pending', lease_until = NULL, attempts = MAX(attempts - 1, 0), run_after = ?, last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'leased'`,
    args: [new Date(now + retryMs).toISOString(), `${SUSPENDED_WAIT_PREFIX}${new Date(since).toISOString()})`, nowIso(), job.id],
  });
  return { dead: false };
}

// On resume: the store's waiting jobs are due now. -> how many
export async function releaseSuspendedJobs(tenantId) {
  const r = await platformDb().execute({
    sql: "UPDATE jobs SET run_after = NULL, last_error = NULL, updated_at = ? WHERE tenant_id = ? AND status = 'pending' AND substr(last_error, 1, ?) = ?",
    args: [nowIso(), tenantId, SUSPENDED_WAIT_PREFIX.length, SUSPENDED_WAIT_PREFIX],
  });
  return Number(r.rowsAffected || 0);
}

// GEN-02: hand back a job leased but never started (the tick ran out of
// time), with the attempt it didn't use.
export async function releaseJob(id) {
  await platformDb().execute({
    sql: `UPDATE jobs SET status = 'pending', lease_until = NULL, attempts = MAX(attempts - 1, 0), updated_at = ?
          WHERE id = ? AND status = 'leased'`,
    args: [nowIso(), id],
  });
}

export async function getJobByKey(idempotencyKey) {
  const res = await platformDb().execute({ sql: "SELECT * FROM jobs WHERE idempotency_key = ?", args: [idempotencyKey] });
  const row = res.rows[0];
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

// GEN-02: make a job runnable now: a finished or dead job back to pending
// with a fresh budget, a backed-off one due at once, and one whose runner was
// killed (lease ran out) back to pending with a fresh budget. A job leased by
// a live runner is left alone. Phase 3 line 6: a job an operator discarded
// comes back only with `revive` (an explicit Resume or claim is consent; an
// automatic status poll never is).
export async function makeJobDue(id, { revive = false } = {}) {
  const now = nowIso();
  await platformDb().execute({
    sql: `UPDATE jobs SET attempts = CASE WHEN status = 'pending' THEN attempts ELSE 0 END, status = 'pending',
            run_after = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND (status IN ('pending', 'done', 'dead'${revive ? ", 'discarded'" : ""}) OR (status = 'leased' AND (lease_until IS NULL OR lease_until < ?)))`,
    args: [now, id, now],
  });
}

// → { dead: boolean }. Retries back off with jitter until max_attempts, then
// the job dead-letters with an alert (a dead job is an operator task, not a
// silent loss — OP05 lists and replays them).
export async function failJob(job, error) {
  const msg = String(error?.message || error).slice(0, 300);
  if (job.attempts >= job.max_attempts) {
    await platformDb().execute({
      sql: "UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?",
      args: [msg, nowIso(), job.id],
    });
    await sendAlert(
      `Job dead-lettered: ${job.type} (${job.attempts} attempts)`,
      { job: job.id, tenant: job.tenant_id, error: msg, runbook: "replay via /platform queues or pnpm (OP05)" },
      { severity: "critical" },
    );
    return { dead: true };
  }
  await platformDb().execute({
    sql: "UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?",
    args: [new Date(Date.now() + backoffMs(job.attempts)).toISOString(), msg, nowIso(), job.id],
  });
  return { dead: false };
}

// Operator replay: dead → pending with a fresh attempt budget. Audited.
export async function replayJob(id, { actor = { kind: "operator", id: "operator" } } = {}) {
  const res = await platformDb().execute({
    sql: `UPDATE jobs SET status = 'pending', attempts = 0, run_after = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND status IN ('dead', 'done', 'discarded') RETURNING id, type, tenant_id`,
    args: [nowIso(), id],
  });
  const row = res.rows[0];
  if (!row) return false;
  await audit({ actor, action: "queue.replay", tenantId: row.tenant_id ?? null, resource: `job:${id}`, diff: { type: row.type } });
  return true;
}

// --- webhook inbox ---------------------------------------------------------------

// Persist the receipt BEFORE acknowledging the delivery (BE14). Callers that
// cannot persist must NOT ack — let the provider redeliver.
export async function recordWebhook({ source, topic = null, shopDomain = null, tenantId: tid = null, rawBody, headers = {}, hmacOk, status = "pending" }) {
  const id = newId("wh");
  await platformDb().execute({
    sql: `INSERT INTO webhook_inbox (id, source, topic, shop_domain, tenant_id, body_hash, payload, headers, hmac_ok, status, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      source,
      topic,
      shopDomain,
      tid,
      await sha256Hex(String(rawBody ?? "")),
      String(rawBody ?? ""),
      JSON.stringify(headers),
      hmacOk ? 1 : 0,
      status,
      nowIso(),
    ],
  });
  return id;
}

export async function getInbox(id) {
  const res = await platformDb().execute({ sql: "SELECT * FROM webhook_inbox WHERE id = ?", args: [id] });
  return res.rows[0] ? { ...res.rows[0] } : null;
}

export async function markInbox(id, status, { error = null } = {}) {
  await platformDb().execute({
    sql: `UPDATE webhook_inbox SET status = ?, last_error = ?, attempts = attempts + 1, processed_at = ? WHERE id = ?`,
    args: [status, error, status === "done" ? nowIso() : null, id],
  });
}

// Replay a dead/ignored inbox row: back to pending + ensure its apply job is
// pending too (recreated if the original never existed or was pruned). Audited.
export async function replayInbox(id, { actor = { kind: "operator", id: "operator" } } = {}) {
  const row = await getInbox(id);
  if (!row) return false;
  await platformDb().execute({
    sql: "UPDATE webhook_inbox SET status = 'pending', last_error = NULL WHERE id = ?",
    args: [id],
  });
  const key = `wh:${id}`;
  const { existed } = await enqueueJob({
    type: "webhook_apply",
    tenantId: row.tenant_id,
    payload: { inboxId: id },
    idempotencyKey: key,
  });
  if (existed) {
    await platformDb().execute({
      sql: `UPDATE jobs SET status = 'pending', attempts = 0, run_after = NULL, lease_until = NULL, updated_at = ?
            WHERE idempotency_key = ? AND status IN ('dead', 'done', 'discarded')`,
      args: [nowIso(), key],
    });
  }
  await audit({ actor, action: "queue.replay", tenantId: row.tenant_id ?? null, resource: `inbox:${id}`, diff: { source: row.source, topic: row.topic } });
  return true;
}

// Phase 3 line 6: discard a dead letter. Only a dead row is discarded: a job
// becomes 'discarded' (never run again unless an operator replays it), an
// inbox row 'ignored' (the status the webhook path already uses). Audited.
export async function discardJob(id, { actor = { kind: "operator", id: "operator" } } = {}) {
  const res = await platformDb().execute({
    sql: `UPDATE jobs SET status = 'discarded', lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'dead' RETURNING id, type, tenant_id`,
    args: [nowIso(), id],
  });
  const row = res.rows[0];
  if (!row) return false;
  await audit({ actor, action: "queue.discard", tenantId: row.tenant_id ?? null, resource: `job:${id}`, diff: { type: row.type } });
  return true;
}

export async function discardInbox(id, { actor = { kind: "operator", id: "operator" } } = {}) {
  const res = await platformDb().execute({
    sql: "UPDATE webhook_inbox SET status = 'ignored' WHERE id = ? AND status = 'dead' RETURNING id, source, topic, tenant_id",
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return false;
  await audit({ actor, action: "queue.discard", tenantId: row.tenant_id ?? null, resource: `inbox:${id}`, diff: { source: row.source, topic: row.topic } });
  return true;
}

// --- inspection / health -----------------------------------------------------------

// Inspector lists NEVER include payloads (raw webhook bodies can carry PII).
export async function listJobs({ status = null, tenant = null, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (tenant) {
    where.push("tenant_id = ?");
    args.push(tenant);
  }
  const res = await platformDb().execute({
    sql: `SELECT id, type, tenant_id, idempotency_key, status, attempts, max_attempts, run_after, lease_until, last_error, created_at, updated_at, done_at
          FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ${clampLimit(limit)}`,
    args,
  });
  return scrubLastErrors(res.rows.map((r) => ({ ...r })));
}

export async function listInbox({ status = null, limit = 50 } = {}) {
  const res = await platformDb().execute({
    sql: `SELECT id, source, topic, shop_domain, tenant_id, body_hash, hmac_ok, status, attempts, last_error, received_at, processed_at
          FROM webhook_inbox ${status ? "WHERE status = ?" : ""} ORDER BY received_at DESC LIMIT ${clampLimit(limit)}`,
    args: status ? [status] : [],
  });
  return scrubLastErrors(res.rows.map((r) => ({ ...r })));
}

// P3-G: a row's last_error can be a driver error naming its store's database;
// it is scrubbed with that store's address and token (and the generic patterns).
async function scrubLastErrors(rows) {
  const tenants = new Map();
  for (const r of rows) {
    if (!r.last_error) continue;
    const id = r.tenant_id ? String(r.tenant_id) : null;
    if (id && !tenants.has(id)) tenants.set(id, await getTenant(id).catch(() => null));
    const t = id ? tenants.get(id) : null;
    r.last_error = scrubSecrets(r.last_error, [t?.dbUrl, t?.dbToken]);
  }
  return rows;
}

export async function queueStats() {
  const jobs = await platformDb().execute(
    "SELECT status, COUNT(*) AS n, MIN(created_at) AS oldest FROM jobs WHERE status IN ('pending','leased','dead') GROUP BY status",
  );
  const inbox = await platformDb().execute(
    "SELECT status, COUNT(*) AS n FROM webhook_inbox WHERE status IN ('pending','dead') GROUP BY status",
  );
  const j = Object.fromEntries(jobs.rows.map((r) => [r.status, { n: Number(r.n), oldest: r.oldest }]));
  const i = Object.fromEntries(inbox.rows.map((r) => [r.status, Number(r.n)]));
  const oldestPending = j.pending?.oldest ? Math.max(0, Math.round((Date.now() - new Date(j.pending.oldest).getTime()) / 60000)) : 0;
  return {
    jobs: {
      pending: j.pending?.n || 0,
      leased: j.leased?.n || 0,
      dead: j.dead?.n || 0,
      oldest_pending_min: oldestPending,
    },
    inbox: { pending: i.pending || 0, dead: i.dead || 0 },
  };
}

// Opportunistic retention: completed work ages out, dead letters stick around
// long enough for an operator to act.
export async function pruneQueues({ doneDays = 7, inboxDays = 14, deadDays = 60 } = {}) {
  const cut = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  await platformDb().execute({ sql: "DELETE FROM jobs WHERE status = 'done' AND updated_at < ?", args: [cut(doneDays)] });
  // a discarded dead letter ages out on the dead-letter schedule (it holds its idempotency key until then)
  await platformDb().execute({ sql: "DELETE FROM jobs WHERE status IN ('dead', 'discarded') AND updated_at < ?", args: [cut(deadDays)] });
  await platformDb().execute({
    sql: "DELETE FROM webhook_inbox WHERE status IN ('done','ignored') AND received_at < ?",
    args: [cut(inboxDays)],
  });
  await platformDb().execute({ sql: "DELETE FROM webhook_inbox WHERE status = 'dead' AND received_at < ?", args: [cut(deadDays)] });
}
