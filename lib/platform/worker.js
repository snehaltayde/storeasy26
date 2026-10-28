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
// Node-only (handlers import node-only modules).
import { runAsTenant } from "./ops.js";
import { getInbox, markInbox, leaseJobs, leaseJobById, completeJob, failJob } from "./jobs.js";
import { applyWebhook } from "./shopify-webhooks.js";
import { slog } from "../log.js";

async function applyRazorpayCapture(payload) {
  const { markOrderPaid, findOrderByRazorpayOrderId } = await import("../orders.js");
  const { clearCart } = await import("../cart.js");
  const { enqueueShopifyPush } = await import("../shopify-push.js");
  const { enqueuePurchaseAndForward } = await import("../events.js");
  const payment = payload?.payload?.payment?.entity || {};
  const { id: paymentId, order_id: razorpayOrderId, amount } = payment;
  if (!paymentId || !razorpayOrderId) return { ignored: "malformed" };
  const order = await findOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) return { ignored: "unknown_order" };
  const { toMinor } = await import("../money.js");
  if (Number(amount) !== toMinor(order.total, order.currency || "INR")) return { flagged: "amount_mismatch", orderId: order.id };
  const paid = await markOrderPaid(order.id, { razorpayPaymentId: paymentId, source: "webhook_replay" });
  if (!paid.already) {
    if (order.cart_id) await clearCart(order.cart_id).catch(() => {});
    await enqueueShopifyPush(order.id);
    await enqueuePurchaseAndForward(order.id);
  }
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
  // S36: scheduled publish — the release row was created (and validated) at
  // schedule time; this just flips the live pointer at the scheduled instant.
  publish_release: async ({ releaseId }) => {
    const { publishReleaseById } = await import("../releases.js");
    return publishReleaseById(releaseId);
  },
};

async function executeLeased(job, handlers) {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`no handler for job type "${job.type}"`);
    const result = await runAsTenant(job.tenant_id || null, () => handler(job.payload));
    await completeJob(job.id);
    slog("job_done", { job: job.id, type: job.type, tenant: job.tenant_id, attempt: job.attempts });
    return { id: job.id, type: job.type, ok: true, result };
  } catch (e) {
    const { dead } = await failJob(job, e);
    if (dead && job.type === "webhook_apply" && job.payload?.inboxId) {
      await markInbox(job.payload.inboxId, "dead", { error: String(e?.message || e).slice(0, 300) }).catch(() => {});
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
export async function runDueJobs({ limit = 25, handlers = HANDLERS } = {}) {
  const leased = await leaseJobs({ limit });
  const results = [];
  for (const job of leased) results.push(await executeLeased(job, handlers));
  return results;
}

// after() fast path: run one just-enqueued job NOW — the atomic single-job
// lease means the tick and the fast path can never double-run it.
export async function runJobById(id, { handlers = HANDLERS } = {}) {
  const job = await leaseJobById(id);
  if (!job) return null;
  return executeLeased(job, handlers);
}
