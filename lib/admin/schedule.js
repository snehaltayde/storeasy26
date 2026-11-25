// Offer-schedule helpers (Session 32 / BE07+MC14) — PURE, no imports: safe for
// client components and plain-node tests.
//
// The quirk this kills: the old form did `new Date(iso).toISOString().slice(0,16)`
// into a <input type="datetime-local">, so UTC digits were re-read as LOCAL time
// on save — every edit shifted the schedule by the UTC offset (IST: −5h30m).
// datetime-local speaks the browser's local wall time; these convert properly,
// so an edit round-trip preserves the intended INSTANT exactly.

// UTC ISO instant → "YYYY-MM-DDTHH:MM" in the environment's local time
export function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "YYYY-MM-DDTHH:MM" (local wall time) → UTC ISO instant
export function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v); // no timezone suffix ⇒ parsed as LOCAL, as typed
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Lifecycle chip for the offers console: where is this offer in its life?
//   draft     — disabled, never scheduled
//   paused    — disabled but has (or had) a schedule/was live
//   scheduled — enabled, window hasn't opened
//   active    — enabled, inside (or without) a window
//   expired   — window closed (whether or not still enabled)
export function offerScheduleStatus({ enabled, starts_at = null, ends_at = null }, at = new Date()) {
  const t = at instanceof Date ? at.toISOString() : String(at);
  if (ends_at && ends_at <= t) return "expired";
  if (!enabled) return starts_at || ends_at ? "paused" : "draft";
  if (starts_at && starts_at > t) return "scheduled";
  return "active";
}

// Is `tz` a time zone this runtime's Intl knows ("Asia/Kolkata" yes;
// "Asia/Kolkatta", "", "GMT+5:30" no)? A bad saved zone would make every
// Intl call with it throw, so readers check once and fall back.
export function isTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
