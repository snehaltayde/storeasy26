// The operator Billing screen's words and its one API helper (Phase 3 line 3).
// Plain data and fetch: no JSX, so the unit suite reads the same words.

export const TABS = Object.freeze([
  ["overview", "Overview"],
  ["subscriptions", "Subscriptions"],
  ["plans", "Plans"],
  ["events", "Billing events"],
  ["overrides", "Overrides"],
  ["costs", "Costs"],
]);
export const TAB_IDS = TABS.map(([id]) => id);

// subscription status -> [plain words, badge tone]
export const SUB_STATUS = Object.freeze({
  created: ["Waiting for payment", "warning"],
  authenticated: ["Authorised", "info"],
  active: ["Active", "success"],
  paused: ["Paused", "warning"],
  halted: ["Payment failing", "danger"],
  cancelled: ["Cancelled", "muted"],
  completed: ["Completed", "muted"],
  expired: ["Expired", "muted"],
});
export const subStatus = (s) => SUB_STATUS[s] || ["Unknown", "muted"];

export const EXCEPTION_WORDS = Object.freeze({
  payment_trouble: "Payment trouble",
  past_grace: "Past grace: checkout paused",
  orphan_event: "Event with no store",
});

export const EVENT_WORDS = Object.freeze({
  "subscription.authenticated": "Authorised",
  "subscription.activated": "Activated",
  "subscription.charged": "Charged",
  "subscription.paused": "Paused",
  "subscription.resumed": "Resumed",
  "subscription.pending": "Charge retrying",
  "subscription.halted": "Halted",
  "subscription.cancelled": "Cancelled",
  "subscription.completed": "Completed",
  "subscription.expired": "Expired",
  "refund.processed": "Refund",
});

export const UNCONFIGURED_WORDS = "Razorpay isn't set up for platform billing (PLATFORM_RAZORPAY_KEY_ID and PLATFORM_RAZORPAY_KEY_SECRET), so paid plans can't start and Razorpay subscriptions can't be cancelled from here.";

export const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const monthWords = (ym) => {
  if (!/^\d{4}-\d{2}$/.test(ym || "")) return ym || "—";
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
};

// GET or POST an operator API; a 401 sends the operator to the sign-in.
// -> the JSON body; throws an Error with the API's plain-words message.
export async function platformApi(path, body = undefined) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) {
    window.location.assign("/platform");
    throw new Error("Signed out");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || `That didn't work (${res.status}). Try again.`);
  return json;
}

// An exception's detail line from the server ("status halted, grace until
// 2026-11-27T09:46:39.275Z") in plain words: dates as dates, statuses as the
// table's words. Display only; the server's text is unchanged.
export const detailWords = (detail) =>
  String(detail || "")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, (iso) => shortDate(iso))
    .replace(/\bstatus (\w+)/g, (_, s) => subStatus(s)[0])
    .replace(/\b(?:subscription|refund)\.\w+\b/g, (t) => EVENT_WORDS[t] || t)
    .replace(/ — /g, ": ")
    .replace(/^./, (c) => c.toUpperCase());
