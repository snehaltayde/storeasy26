// Feature-flag words for the operator's /platform/flags screen (Phase 3 line 4).
// Pure, so the unit suite reads the same words the screen shows.

// The flag key rule the server enforces (lib/platform/flags.js FLAG_KEY_RE),
// checked in the form before sending.
export const FLAG_KEY_PATTERN = /^ff_[a-z0-9][a-z0-9-]{0,40}$/;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A flag's state in plain words, with a status tone for its badge.
//   flag: { default_on, expired, tenants: { storeId: 0|1 } }
export function flagState(flag) {
  if (!flag) return { label: "Unknown", tone: "muted" };
  if (flag.expired) return { label: "Expired", tone: "muted" };
  const values = Object.values(flag.tenants || {}).map((v) => Boolean(Number(v)));
  const on = values.filter(Boolean).length;
  const off = values.length - on;
  if (flag.default_on) return off ? { label: `On except ${plural(off, "store", "stores")}`, tone: "success" } : { label: "On for everyone", tone: "success" };
  return on ? { label: `On for ${plural(on, "store", "stores")}`, tone: "info" } : { label: "Off", tone: "muted" };
}

// What the code does once the flag is gone (its flagEnabled fallback).
export const fallbackWords = (fallback) =>
  fallback === false ? "Code that reads this flag will treat it as off for every store." : "Code that reads this flag will treat it as on for every store.";

// When an emergency disable takes effect.
export const disableWords = (critical) =>
  critical
    ? "This is a critical flag. It is read fresh on every request, so it is off from the next request on every server."
    : "It is off within 30 seconds, as each server refreshes its cached flags.";

// A history row's action in words.
export const FLAG_ACTION_WORDS = Object.freeze({
  "flags.set": "Saved",
  "flags.override": "Store override",
  "flags.emergency_disable": "Emergency disable",
  "flags.delete": "Deleted",
});

export const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC" : "—";
