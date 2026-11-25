"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// An offer's start and end in the STORE's time (Settings > timezone, the
// merchant timezone reporting uses), not the browser's: a founder abroad
// still schedules a sale for 9am at the store. The pure helpers convert a
// "YYYY-MM-DDTHH:MM" wall time in `tz` to and from a UTC ISO instant.

const parts = (ms, tz) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, Number(x.value)]),
  );
  return p;
};
// how far `tz` is ahead of UTC at the instant `ms`, in ms
const offsetAt = (ms, tz) => {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

export function isoToZoned(iso, tz) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const p = parts(ms, tz);
  const z = (n) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

// A wall time that happens twice (the hour clocks go back) is the earlier
// instant; one that never happens (the hour clocks skip) moves forward by the
// skipped length (02:30 in a 02:00 -> 03:00 jump is 03:30). Both as
// Temporal's "compatible" disambiguation.
const DAY = 86_400_000;
export function zonedToIso(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // the offsets a day either side cover any one transition near this time
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  const fits = [...new Set([before, after])].map((o) => wall - o).filter((ms) => offsetAt(ms, tz) === wall - ms);
  // in a gap nothing fits: the offset from before the jump lands past it
  const ms = fits.length ? Math.min(...fits) : wall - before;
  return new Date(ms).toISOString();
}

// "25 Nov, 09:00" in the store's time
export const whenIn = (iso, tz) =>
  iso ? new Date(iso).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;

export function scheduleText(startsAt, endsAt, tz) {
  if (!startsAt && !endsAt) return "Runs whenever it's on.";
  if (startsAt && endsAt) return `Runs from ${whenIn(startsAt, tz)} to ${whenIn(endsAt, tz)}.`;
  return startsAt ? `Starts ${whenIn(startsAt, tz)}.` : `Ends ${whenIn(endsAt, tz)}.`;
}

export function ScheduleField({ startsAt, endsAt, onChange, tz, disabled = false }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="offer-starts">Starts (optional)</Label>
          <Input id="offer-starts" type="datetime-local" value={startsAt} disabled={disabled} onChange={(e) => onChange({ startsAt: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offer-ends">Ends (optional)</Label>
          <Input id="offer-ends" type="datetime-local" value={endsAt} disabled={disabled} onChange={(e) => onChange({ endsAt: e.target.value })} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {scheduleText(zonedToIso(startsAt, tz), zonedToIso(endsAt, tz), tz)} Times are your store&rsquo;s ({tz}).
      </p>
    </div>
  );
}
