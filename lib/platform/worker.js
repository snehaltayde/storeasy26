// Job executor (Session 29 / BE14). Each job runs inside its tenant's context
// (runAsTenant) and every handler is IDEMPOTENT — the queue is at-least-once:
//   shopify_push   {orderId}  → pushOrderToShopify (state-machine guarded; the
//                               orders table stays the money-truth; this job
//                               guarantees the ATTEMPT happens)
//   forward_event  {eventId}  → forwardEventById (store-then-forward, deduped)
//   webhook_apply  {inboxId}  → re-apply a persisted webhook receipt (catalog
//                               hints via applyWebhook; razorpay payment
//                               captures via the same markOrderPaid path the
//                               live route uses)
//   catalog_sync   {runId}    → GEN-02: one time-boxed slice of a catalog sync
//                               (lib/sync.js runSyncSlice). Pages commit with
//                               their position, so a re-run continues; a slice
//                               with more to do requeues itself.
//   search_reindex {upTo}    → P4-SEARCH (OVL-17): drain the tenant's search
//                               outbox (lib/catalog/search-reindex.js
//                               drainAll) into its own Typesense collection;
//                               a failure throws into the job backoff and
//                               leaves the rows pending (the next full sync
//                               is the backstop). upTo is informational: the
//                               drain takes every pending row.
// Node-only (handlers import node-only modules).
import { runAsTenant } from "./ops.js";
import { getInbox, markInbox, leaseJobs, leaseJobById, completeJob, failJob, requeueJob, releaseJob } from "./jobs.js";
import { applyWebhook } from "./shopify-webhooks.js";
import { slog } from "../log.js";

// GEN-02: the clock time budgets are measured on. A seam for the suite, which
// simulates slow Shopify pages; everything else uses real time.
export const workerClock = { now: () => Date.now() };

// P4-SEARCH (P4-GUARD review): how long a catalog sync slice parked by a
// store being updated (paused) waits before the queue looks again, instead of
// being leased again on every tick.
export const PAUSED_SYNC_RETRY_MS = 60_000;

// The tick route's budget inside its 60s limit (10s left for leasing,
// bookkeeping and stats).
export const TICK_BUDGET_MS = 50_000;

// Job types that can run for most of a route's time. Only callers that pass
// a budget lease them, so a shopper route's after() never picks one up.
export const LONG_JOB_TYPES = ["catalog_sync"];

async function applyRazorpayCapture(payload) {
  const { markOrderPaid, findOrderByRazorpayOrderId } = await import("../orders.js");
  const { runOrderEffects } = await import("../payment-settle.js");
  const payment = payload?.payload?.payment?.entity || {};
  const { id: paymentId, order_id: razorpayOrderId, amount } = payment;
  if (!paymentId || !razorpayOrderId) return { ignored: "malformed" };
  const order = await findOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) return { ignored: "unknown_order" };
  const { toMinor } = await import("../money.js");
  if (Number(amount) !== toMinor(order.total, order.currency || "INR")) return { flagged: "amount_mismatch", orderId: order.id };
  const paid = await markOrderPaid(order.id, { razorpayPaymentId: paymentId, source: "webhook_replay" });
  await runOrderEffects(order.id);
  return { orderId: order.id, already: !!paid.already };
}

async function applyInboxRow(inboxId) {
  const row = await getInbox(inboxId);
  if (!row) throw new Error(`inbox row ${inboxId} not found`);
  if (row.status === "done") return { already: true };
  let payload;
  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    await markInbox(inboxId, "dead", { error: "unparseable payload" });
    return { dead: "unparseable" };
  }
  try {
    const result =
      row.source === "razorpay" ? await applyRazorpayCapture(payload) : await applyWebhook(row.topic, payload);
    await markInbox(inboxId, "done");
    return result;
  } catch (e) {
    await markInbox(inboxId, "pending", { error: String(e?.message || e).slice(0, 300) });
    throw e; // job backoff governs the retry cadence
  }
}

const HANDLERS = {
  shopify_push: async ({ orderId }) => {
    const { pushOrderToShopify } = await import("../shopify-push.js");
    return pushOrderToShopify(orderId);
  },
  forward_event: async ({ eventId }) => {
    // Store-if-missing first (a crash between the durable enqueue and the
    // fast-path store would otherwise leave nothing to forward), then forward.
    // A no-consent order stores nothing BY DESIGN — that completes the job.
    const { enqueuePurchaseEvent, forwardEventById } = await import("../events.js");
    const stored = await enqueuePurchaseEvent(eventId);
    if (stored?.skipped === "no_consent") return stored;
    return forwardEventById(eventId);
  },
  webhook_apply: async ({ inboxId }) => applyInboxRow(inboxId),
  // A verified browser callback that couldn't be recorded during a database blip.
  payment_confirm: async (payload) => {
    const { confirmVerifiedPayment } = await import("../payment-settle.js");
    return confirmVerifiedPayment(payload);
  },
  // Legacy scheduled-release jobs are retired alongside the Legacy CMS.
  publish_release: async ({ releaseId }) => ({ id: releaseId, skipped: "legacy_cms_retired" }),
  // S39 (BE23): deliver a durable notification intent (idempotent — a sent
  // row completes without re-sending; failures throw into the job backoff).
  send_notification: async ({ notificationId }) => {
    const { deliverNotification } = await import("../notifications.js");
    return deliverNotification(notificationId);
  },
  // S40 (BE11): apply a persisted billing webhook (idempotent — the ledger
  // dedupes by provider event id, status writes are watermark-guarded).
  billing_apply: async ({ inboxId }) => {
    const row = await getInbox(inboxId);
    if (!row) throw new Error(`inbox row ${inboxId} not found`);
    if (row.status === "done") return { already: true };
    const { applyBillingEvent, parseBillingWebhook } = await import("./billing.js");
    try {
      const result = await applyBillingEvent(parseBillingWebhook(JSON.parse(row.payload || "{}")));
      await markInbox(inboxId, "done");
      return result;
    } catch (e) {
      await markInbox(inboxId, "pending", { error: String(e?.message || e).slice(0, 300) });
      throw e;
    }
  },
  // GEN-02: one slice of a catalog sync, inside the caller's time budget
  // (never more than SLICE_MS). Throws on a retryable failure (job backoff);
  // a run that completed or failed for good completes the job.
  catalog_sync: async ({ runId }, ctx = {}) => {
    const { runSyncSlice, SYNC_TIMING } = await import("../sync.js");
    const now = ctx.now || workerClock.now;
    const cap = now() + SYNC_TIMING.SLICE_MS;
    const deadline = ctx.deadline != null ? Math.min(ctx.deadline, cap) : cap;
    let res;
    try {
      res = await runSyncSlice(runId, { deadline, now, mode: "queued" });
    } catch (e) {
      // Pages went in before the failure: try again after the base backoff
      // with a fresh attempt budget, so a flaky store still finishes. A slice
      // that got nothing in counts toward giving up.
      if (e?.syncCommitted > 0) return { runId, requeue: true, runAfter: new Date(Date.now() + 60_000).toISOString() };
      throw e;
    }
    const run = res.run;
    const summary = { runId, phase: run?.phase ?? null, products: Number(run?.products_fetched || 0), collections: Number(run?.collections_fetched || 0) };
    if (res.done) {
      const status = res.status || (res.missing ? "missing" : null);
      // P6-GEN (GEN-01): a completed sync makes the first store, best effort
      return status === "complete" ? { ...summary, status, firstRun: await firstRunAfterSync(runId, deadline, now) } : { ...summary, status };
    }
    // P4-SEARCH (P4-GUARD review): parked while the store is being updated:
    // look again after a short wait, not on every tick
    if (res.paused) return { ...summary, paused: true, requeue: true, runAfter: new Date(Date.now() + PAUSED_SYNC_RETRY_MS).toISOString() };
    // more to do: back in the queue — after the other runner's lease if one holds it
    return { ...summary, requeue: true, runAfter: res.busy ? run?.lease_until || null : null };
  },
  // P4-SEARCH (OVL-17): the retry of the publish fast path's reindex
  search_reindex: async () => {
    const { drainAll } = await import("../catalog/search-reindex.js");
    return drainAll();
  },
};

// P6-GEN (GEN-01): after a catalog sync slice that finished the run, the
// first store is made (lib/first-run/generate.js), when the store is eligible.
// Best effort, inside the slice's own time box: with less than
// FIRST_RUN_MIN_LEFT_MS of the deadline left it is skipped (logged
// first_run_deferred) and the store generates when the founder opens the
// start page or the editor. A failure is only logged: it never fails or
// requeues the sync job. -> a small summary for the job result, or null
// Not hooked here (they generate on the founder's next visit instead): the
// console's inline slices, the CLI's runCatalogSync and the connect callback.
export const FIRST_RUN_MIN_LEFT_MS = 5_000;
export const workerFirstRun = {
  // a seam for the suite; production loads the generator only when needed
  generate: async (opts) => (await import("../first-run/generate.js")).generateFirstStore(opts),
};
async function firstRunAfterSync(runId, deadline, now) {
  const left = deadline - now();
  if (!(left >= FIRST_RUN_MIN_LEFT_MS)) {
    slog("first_run_deferred", { run: runId, leftMs: Math.max(0, Math.round(left)) });
    return { deferred: true };
  }
  try {
    const r = await workerFirstRun.generate({ trigger: "sync" });
    return r.ran ? { ran: true, written: Boolean(r.written), created: r.created, refilled: r.refilled } : { ran: false, reason: r.reason };
  } catch (e) {
    slog("first_run_failed", { run: runId, error: String(e?.message || e).slice(0, 200) });
    return { ran: false, error: true };
  }
}

async function executeLeased(job, handlers, ctx = {}) {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`no handler for job type "${job.type}"`);
    const result = await runAsTenant(job.tenant_id || null, () => handler(job.payload, ctx));
    if (result?.requeue) {
      await requeueJob(job.id, { runAfter: result.runAfter || null });
      slog("job_requeued", { job: job.id, type: job.type, tenant: job.tenant_id });
      return { id: job.id, type: job.type, ok: true, requeued: true, result };
    }
    await completeJob(job.id);
    slog("job_done", { job: job.id, type: job.type, tenant: job.tenant_id, attempt: job.attempts });
    return { id: job.id, type: job.type, ok: true, result };
  } catch (e) {
    const { dead } = await failJob(job, e);
    if (dead && job.type === "webhook_apply" && job.payload?.inboxId) {
      await markInbox(job.payload.inboxId, "dead", { error: String(e?.message || e).slice(0, 300) }).catch(() => {});
    }
    // GEN-02: the queue gave up on a sync slice → the run fails, so the
    // founder sees a plain message and a retry instead of "running" forever.
    if (dead && job.type === "catalog_sync" && job.payload?.runId) {
      await runAsTenant(job.tenant_id || null, async () => {
        const { failSyncRun } = await import("../sync.js");
        await failSyncRun(job.payload.runId, String(e?.message || e));
      }).catch(() => {});
    }
    slog("job_failed", {
      job: job.id,
      type: job.type,
      tenant: job.tenant_id,
      attempt: job.attempts,
      dead,
      error: String(e?.message || e).slice(0, 200),
    });
    return { id: job.id, type: job.type, ok: false, dead };
  }
}

// Drain up to `limit` due jobs. The tick endpoint calls this; the daily crons
// piggyback it as insurance when no external scheduler is configured.
// GEN-02: `budgetMs` is how long this caller may spend. With one, long jobs
// (LONG_JOB_TYPES) are leased too and run LAST, each handler sees the
// deadline, and a job leased but not reached in time is handed back unrun.
// Without one, long jobs are left for a caller that has a budget.
export async function runDueJobs({ limit = 25, handlers = HANDLERS, budgetMs = null, now = workerClock.now } = {}) {
  const deadline = budgetMs != null ? now() + budgetMs : null;
  const leased = await leaseJobs({ limit, excludeTypes: deadline == null ? LONG_JOB_TYPES : [] });
  const isLong = (j) => LONG_JOB_TYPES.includes(j.type);
  const ordered = [...leased.filter((j) => !isLong(j)), ...leased.filter(isLong)];
  const results = [];
  for (const job of ordered) {
    if (deadline != null && now() >= deadline) {
      await releaseJob(job.id).catch(() => {});
      continue;
    }
    results.push(await executeLeased(job, handlers, { deadline, now }));
  }
  return results;
}

// after() fast path: run one just-enqueued job NOW — the atomic single-job
// lease means the tick and the fast path can never double-run it.
export async function runJobById(id, { handlers = HANDLERS, budgetMs = null, now = workerClock.now } = {}) {
  const job = await leaseJobById(id);
  if (!job) return null;
  return executeLeased(job, handlers, { deadline: budgetMs != null ? now() + budgetMs : null, now });
}
