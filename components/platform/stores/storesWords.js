// The operator's Stores screens in plain words (Phase 3 line 1). Codes come
// from lib/platform/stores-list.js; every word the list and store page show
// for them is here, so the unit suite checks one table.

// [label, Badge tone]
export const STORE_STATUS = Object.freeze({
  active: ["Active", "success"],
  maintenance: ["Maintenance", "warning"],
  suspended: ["Suspended", "danger"],
  offboarded: ["Offboarded", "muted"],
});

export const STATUS_FILTERS = Object.freeze([
  { value: "", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "maintenance", label: "Maintenance" },
]);

export const SORT_LABELS = Object.freeze({ name: "Name", created: "Created", updated: "Last updated" });

// subscriptions.status
export const SUBSCRIPTION = Object.freeze({
  created: ["Not paid yet", "muted"],
  authenticated: ["Authorised", "info"],
  active: ["Active", "success"],
  paused: ["Paused", "warning"],
  halted: ["Payment failed", "danger"],
  cancelled: ["Cancelled", "danger"],
  completed: ["Ended", "muted"],
  expired: ["Expired", "danger"],
});

// what the list's "needs attention" filter found in the control plane
export const ATTENTION_WORDS = Object.freeze({
  shopify_uninstalled: "Shopify app uninstalled",
  onboarding_problem: "Onboarding has a problem",
  incident_open: "Open incident",
  billing_lapsed: "Billing lapsed",
});

// the live health check's reasons
export const HEALTH_WORDS = Object.freeze({
  sync_failed: "sync failed",
  shopify_uninstalled: "Shopify uninstalled",
  pushes_failing: "pushes to Shopify failing",
  migrations_behind: "migrations behind",
});

// -> { label, tone } for a health answer (undefined while loading)
export function healthWords(h) {
  if (!h) return { label: "Checking…", tone: "muted" };
  if (h.state === "healthy") return { label: "Healthy", tone: "success" };
  if (h.state === "attention") return { label: `Needs attention: ${h.reasons.map((r) => HEALTH_WORDS[r] || r).join(", ")}`, tone: "warning" };
  if (h.state === "missing") return { label: "No such store", tone: "danger" };
  // unreachable, a failed request, or anything unknown: never healthy
  return { label: "Can't reach the store's database", tone: "danger" };
}

export const word = (table, code) => {
  const [label, tone] = table[code] || [code ? "Unknown" : "None", "muted"];
  return { label, tone };
};

export const STEP_LABELS = Object.freeze({ connect: "Connect Shopify", import: "Bring in products", brand: "Brand", open: "Open the store" });
export const STEP_STATE = Object.freeze({
  done: ["Done", "success"],
  in_progress: ["In progress", "info"],
  ready: ["Ready", "muted"],
  blocked: ["Blocked", "warning"],
});

export const RUN_STATUS = Object.freeze({
  running: ["Running", "info"],
  done: ["Done", "success"],
  failed: ["Failed", "danger"],
  compensated: ["Rolled back", "muted"],
});

// "3 / 4", "Open", or a dash
export function onboardingWords(ob) {
  if (!ob) return "—";
  if (ob.open) return "Open";
  if (!ob.supported) return "—";
  return `${ob.done} / ${ob.total}`;
}

export function when(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export const onboardingSheetHref = (id) => `/platform/onboarding?view=all&s=${encodeURIComponent(`tenant:${id}`)}`;
export const billingHref = (id) => `/platform/billing?store=${encodeURIComponent(id)}`;
