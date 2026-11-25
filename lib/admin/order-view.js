// Pure order view helpers (S31 / BE10+MC16) — NO imports, safe for client
// components and plain-node tests alike.


// Role-limited customer fields: the SUPPORT role can look at orders (status,
// money, sync state) but never sees contact PII or the address snapshot.
// Every admin order read goes through redactOrderForRole, for every role.
// customer_id (Phase 0 line 2) links the order to the shopper's account. The
// payment ids and coupon code stay: support needs them to answer a shopper.
const PII_FIELDS = ["email", "phone", "name", "address_line1", "address_line2", "city", "state", "pincode", "country", "customer_id"];

// The roles that never see a shopper's details (today: support, which an
// operator under a support grant also is).
export const redactsPii = (role) => role === "support";

// Phase 0 line 2 (S5): cart_id is the shopper's cart_session cookie and
// idempotency_key the checkout's retry key, so no admin read hands them to any
// role; nothing in the console shows them.
const SERVER_ONLY_FIELDS = ["cart_id", "idempotency_key"];

export function redactOrderForRole(order, role) {
  if (!order) return order;
  const out = { ...order };
  for (const f of SERVER_ONLY_FIELDS) delete out[f];
  if (!redactsPii(role)) return out;
  for (const f of PII_FIELDS) if (f in out) out[f] = null;
  if (out.snapshot) out.snapshot = null; // snapshot carries contact + address
  out.pii_redacted = true;
  return out;
}

// OVL-06: what a founder needs to find this line in Shopify admin, when the title
// the shopper saw is not Shopify's own: "Shopify title: X, SKU: Y". Both are
// frozen at order time, on the line (migration 0018) and in the snapshot's items.
// The snapshot covers an order placed before its tenant was migrated. Old orders
// (no Shopify title) and lines whose titles match get null, so they show as
// they always have.
// P4-SEARCH (OVL-06): the line's text colour is the console's muted text
// (--c-fg-muted #52525b, 7.7:1 on the white card), not the subtle one
// (#a1a1aa, 2.56:1): the founder reads it to find the line in Shopify.
export const SHOPIFY_LINE_CLASS = "text-xs text-fg-muted";

export function shopifyMatchLine(item, snapshotItems) {
  if (!item) return null;
  const snap =
    !item.is_gift && Array.isArray(snapshotItems)
      ? snapshotItems.find((s) => s && s.variantId && s.variantId === item.variant_id)
      : null;
  const catalogTitle = item.catalog_title ?? snap?.catalog_title ?? null;
  const sku = item.sku ?? snap?.sku ?? null;
  if (!catalogTitle || catalogTitle === item.title) return null;
  return sku ? `Shopify title: ${catalogTitle}, SKU: ${sku}` : `Shopify title: ${catalogTitle}`;
}

// Honest copy for the console's push button (fixes the "Push failed: 200"
// quirk): push REFUSALS come back HTTP 200 with their reason keys — say what
// actually happened instead of parroting the status code.
export function pushResultMessage(data = {}, httpStatus = 200) {
  if (httpStatus >= 400) return `Push failed: ${data.error || `HTTP ${httpStatus}`}`;
  if (data.ok) return data.already ? "Already synced to Shopify" : "Pushed to Shopify ✓";
  if (data.inFlight) return "A push is already in flight — refresh in a moment";
  if (data.skipped) return `Not pushable from status "${data.skipped}"`;
  if (data.mismatch) return "Refused: Shopify's total didn't match the captured amount (needs review)";
  if (data.failed) return `${data.dead ? "Dead-lettered: " : "Attempt failed: "}${String(data.failed).slice(0, 120)}`;
  if (data.dead) return `Dead-lettered after ${data.attempts ?? "max"} attempts — review before retrying`;
  return "Push did not complete — check the order timeline";
}

// Phase 2 line 2: the new order page's words for each answer, as
// { ok, text }: ok true is a success toast, false an info/error one. No codes
// on screen (docs/UI.md "Words"); every refusal says what to do next.
const STATUS_PLAIN = {
  pending_payment: "still waiting for payment",
  cod_pending: "a cash-on-delivery order",
  paid: "paid",
  syncing_shopify: "being sent to Shopify",
  synced: "already in Shopify",
  sync_failed: "a failed push",
  cancelled: "cancelled",
};

// A Razorpay refund id as the cancel route and the cancel dialog accept it.
export const REFUND_ID_RE = /^rfnd_[A-Za-z0-9]{8,}$/;
export const REFUND_ID_WORDS = "That isn't a Razorpay refund id. Copy it from the refund in Razorpay: it starts with rfnd_ followed by letters and numbers.";

const DENIED = { ok: false, text: "Your role can't do this. Ask the store owner or an admin." };

export function pushAnswer(data = {}, httpStatus = 200) {
  if (httpStatus === 401 || httpStatus === 403) return DENIED;
  if (httpStatus === 404) return { ok: false, text: "We couldn't find that order. It may have been removed; go back to Orders and search again." };
  if (httpStatus >= 400) return { ok: false, text: data.error || "The push didn't go through. Try again in a minute." };
  if (data.ok) return { ok: true, text: data.already ? "This order is already in Shopify. Nothing new was sent." : "Sent to Shopify. The order now shows there." };
  if (data.inFlight) return { ok: false, text: "A push for this order is already running. Wait a moment, then refresh the page." };
  if (data.skipped) return { ok: false, text: `This order can't be sent to Shopify now: it is ${STATUS_PLAIN[data.skipped] || "not in a state that can be sent"}.` };
  if (data.mismatch) return { ok: false, text: "Shopify's total didn't match the amount paid, so the push stopped. Check the order in Shopify before trying again." };
  if (data.dead) return { ok: false, text: `This order has failed to reach Shopify ${data.attempts ?? "too many"} times, so automatic retries stopped. Check the error on this page, fix it in Shopify, then try again.` };
  if (data.failed) return { ok: false, text: "The push didn't go through. The reason is on this page; try again once it's fixed." };
  return { ok: false, text: "The push didn't finish. Refresh the page to see where the order is." };
}

export function reconcileAnswer(data = {}, httpStatus = 200) {
  if (httpStatus === 401 || httpStatus === 403) return DENIED;
  if (httpStatus === 404) return { ok: false, text: "We couldn't find that order. Go back to Orders and search again." };
  if (data.ok && data.skipped === "not_pushed") return { ok: false, text: "This order isn't in Shopify yet, so there is nothing to refresh." };
  if (data.ok) return { ok: true, text: "Refunds and shipments are up to date with Shopify." };
  if (data.skipped === "shopify_order_missing") return { ok: false, text: "Shopify no longer has this order. Check it in Shopify; nothing changed here." };
  return { ok: false, text: data.error || "We couldn't refresh from Shopify. Try again in a minute." };
}

export function cancelAnswer(data = {}, httpStatus = 200) {
  if (httpStatus === 401 || httpStatus === 403) return DENIED;
  if (httpStatus === 404) return { ok: false, text: "We couldn't find that order. Go back to Orders and search again." };
  if (data.ok) return { ok: true, text: data.already ? "This order was already cancelled." : data.shopifyCancelled ? "Order cancelled here and in Shopify. Items were restocked; no refund was issued." : "Order cancelled." };
  if (data.code === "REFUND_ID_INVALID") return { ok: false, text: REFUND_ID_WORDS };
  if (data.code === "REFUND_REQUIRED") return { ok: false, text: "This payment was captured. Refund it in Razorpay first, then enter the refund id (it starts rfnd_) and cancel again." };
  if (data.code === "INVALID_TRANSITION") return { ok: false, text: "This order can't be cancelled right now. Wait for the Shopify push to finish, then try again." };
  if (data.code === "SHOPIFY_CANCEL_FAILED") return { ok: false, text: "Shopify didn't cancel the order, so nothing changed here. Check the order in Shopify, then try again." };
  return { ok: false, text: data.error || "The order wasn't cancelled. Try again in a minute." };
}

// Phase 2 line 2: the orders list's address keeps its state (?status=,
// ?payment=, ?q=, ?view=returns; the contract the dashboard links to).
export const ORDER_TABS = Object.freeze([
  ["all", "All"],
  ["pending_payment", "Pending payment"],
  ["cod_pending", "COD pending"],
  ["paid", "Paid"],
  ["syncing_shopify", "Pushing"],
  ["synced", "Pushed"],
  ["sync_failed", "Push failed"],
  ["cancelled", "Cancelled"],
]);
export const PAYMENT_TABS = Object.freeze([
  ["", "Any payment"],
  ["cod", "Cash on delivery"],
  ["online", "Online"],
]);

// The list's filters from the address: unknown values drop to "all"/none.
export function orderFilters(sp = {}) {
  const one = (v) => (Array.isArray(v) ? v[0] : v) ?? "";
  const status = ORDER_TABS.some(([k]) => k === one(sp.status)) ? one(sp.status) : "all";
  const payment = PAYMENT_TABS.some(([k]) => k && k === one(sp.payment)) ? one(sp.payment) : "";
  const q = String(one(sp.q)).trim().slice(0, 100);
  const view = one(sp.view) === "returns" ? "returns" : "orders";
  return { status, payment, q, view };
}

export function ordersHref({ status = "all", payment = "", q = "", view = "orders" } = {}) {
  const p = new URLSearchParams();
  if (view === "returns") p.set("view", "returns");
  else {
    if (status && status !== "all") p.set("status", status);
    if (payment) p.set("payment", payment);
    if (q) p.set("q", q);
  }
  const s = p.toString();
  return s ? `/admin/orders?${s}` : "/admin/orders";
}

export const paymentWords = (method) => (method === "cod" ? "Cash on delivery" : method ? "Online" : "—");

// The list's push column, as one string (the table truncates it with a tooltip).
export function pushState(o) {
  if (o.shopify_order_id) return `In Shopify · ${String(o.shopify_order_id).split("/").pop()}`;
  if (o.status === "sync_failed") return o.sync_error ? `Failed: ${o.sync_error}` : "Failed";
  if (o.status === "syncing_shopify") return "Sending";
  if (o.status === "cancelled" || o.status === "pending_payment") return "—";
  return "Not sent yet";
}

// A time in the store's timezone (lib/reporting.js merchantTz, passed in by
// the page), so the server's render and the browser's agree.
export const orderTime = (s, timeZone = "Asia/Kolkata") =>
  s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }) : "—";
