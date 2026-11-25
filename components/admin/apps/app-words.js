// The Apps screens' plain words, in one place (Phase 4 line 1).
export const NO_MANAGE = "Only an owner or admin can install apps or change them.";
export const SEES_NOTHING = "It can't see your orders or customers.";
export const KILLED = "Turned off by Storeasy";
export const KILLED_BODY = "Storeasy has turned this app off for your store for now. Its settings are kept. You can turn it on again once Storeasy allows it.";

// An install's state as a badge: [label, tone] (components/ui/badge variants).
export function installState(install) {
  if (install?.killed) return [KILLED, "warning"];
  if (install?.status === "enabled") return ["On", "success"];
  if (install?.status === "disabled") return ["Off", "muted"];
  return ["Unknown", "muted"];
}

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
export const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE.format(d);
};

export const ACTION_WORDS = Object.freeze({
  "apps.install": "Installed",
  "apps.enable": "Turned on",
  "apps.disable": "Turned off",
  "apps.uninstall": "Uninstalled",
  "apps.settings": "Changed settings",
  // Phase 4 line 3: webhooks
  "apps.create_custom": "Created the custom app",
  "apps.endpoint_saved": "Changed the webhook address",
  "apps.endpoint_allowlist_changed": "Moved webhooks to a new host",
  "apps.secret_rotated": "Changed the signing secret",
  "apps.endpoint_paused": "Paused webhooks",
  "apps.endpoint_resumed": "Resumed webhooks",
  "apps.endpoint_auto_paused": "Webhooks paused by Storeasy",
  "apps.test_event_sent": "Sent a test event",
  "apps.delivery_resent": "Sent a delivery again",
});

// One POST to an apps route → { ok, ...body } | { ok: false, error, errors? }
export async function postApp(path, body) {
  try {
    const res = await fetch(`/api/admin/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) return json;
    return { ok: false, error: json.error || "That didn't work. Nothing was changed. Try again.", errors: json.errors || null, code: json.code || null };
  } catch {
    return { ok: false, error: "We couldn't reach Storeasy. Check your connection and try again." };
  }
}

// a delivery's state as a badge: [label, tone]
export const DELIVERY_STATES = Object.freeze({
  delivered: ["Delivered", "success"],
  retrying: ["Retrying", "warning"],
  pending: ["Waiting", "info"],
  failed: ["Failed", "danger"],
  skipped: ["Skipped", "muted"],
});
// "about 5 min" / "about 2 h": retries run on the job tick, so times are approximate
export function aboutIn(iso, nowMs = Date.now()) {
  const ms = Date.parse(iso || "") - nowMs;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 60_000) return "about a minute";
  if (ms < 3600_000) return `in about ${Math.round(ms / 60_000)} min`;
  return `in about ${Math.round(ms / 3600_000)} h`;
}
