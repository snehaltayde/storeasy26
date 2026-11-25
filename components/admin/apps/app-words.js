// The Apps screens' plain words, in one place (Phase 4 line 1).
export const NO_MANAGE = "Only an owner or admin can install apps or change them.";
export const SEES_NOTHING = "It can't see your orders or customers.";
export const KILLED = "Turned off by Storeasy";
export const KILLED_BODY = "Storeasy has turned this app off for every store for now. Its settings are kept. You can turn it on again once Storeasy allows it.";

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
