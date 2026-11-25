// Phase 8 line 1 (decision 9): delivery estimates in calendar days, from the
// store's own settings only. Pure and Edge-safe (no node:*, no data/): the
// shipping engine, the checkout, the product page and the order pages share it.
//
//   estimateDays(config, zone)  → { minDays, maxDays } | null
//     dispatchDays (0 when unset) + the zone's deliveryDays, else the store's.
//     No deliveryDays anywhere → null: the store set no estimate, so none shows.
//   deliveryWindow(estimate, { from, timeZone }) → { from, to } as YYYY-MM-DD | null
//     counted from `from`'s calendar day in the store's time zone.
//   deliveryLine(...) → "Delivery by Tue 1 Dec – Thu 3 Dec" | null
//   expectedLine(...) → "Expected by Thu 3 Dec" | null
//   expectedPassed(estimate, { from, timeZone, now }) → true once the last
//     expected day is behind `now`'s day in the store's zone

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export function estimateDays(config, zone = null) {
  const d = zone?.deliveryDays ?? config?.deliveryDays;
  if (!d || !Number.isInteger(d.min) || !Number.isInteger(d.max)) return null;
  const dispatch = Number.isInteger(config?.dispatchDays) ? config.dispatchDays : 0;
  return { minDays: dispatch + d.min, maxDays: dispatch + d.max };
}

// The calendar day `at` falls on in `timeZone`, as YYYY-MM-DD.
export function localDay(at, timeZone = DEFAULT_TIME_ZONE) {
  let tz = timeZone || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    tz = DEFAULT_TIME_ZONE;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

const addDays = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export function deliveryWindow(estimate, { from = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!estimate || !Number.isInteger(estimate.minDays) || !Number.isInteger(estimate.maxDays)) return null;
  const today = localDay(from, timeZone);
  return { from: addDays(today, estimate.minDays), to: addDays(today, estimate.maxDays) };
}

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
// "2026-12-01" → "Tue 1 Dec"
export function dayLabel(day) {
  const parts = Object.fromEntries(DAY_LABEL.formatToParts(new Date(`${day}T00:00:00Z`)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

export function deliveryLine(estimate, opts) {
  const w = deliveryWindow(estimate, opts);
  if (!w) return null;
  return w.from === w.to ? `Delivery by ${dayLabel(w.to)}` : `Delivery by ${dayLabel(w.from)} – ${dayLabel(w.to)}`;
}

export function expectedPassed(estimate, { now = new Date(), ...opts } = {}) {
  const w = deliveryWindow(estimate, opts);
  return Boolean(w) && w.to < localDay(now, opts.timeZone);
}

export function expectedLine(estimate, opts) {
  const w = deliveryWindow(estimate, opts);
  return w ? `Expected by ${dayLabel(w.to)}` : null;
}
