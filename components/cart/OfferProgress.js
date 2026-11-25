"use client";

// Phase 7 line 3: the drawer's offer progress, under its header (sticky by
// layout: the line list scrolls below it). It shows only what the server sent
// in the cart's `progress` (lib/offers/progress.js): every nudge there was
// proved against the offer engine, and its words carry no target value. The
// tier nudge's "Add 1 more" button sits on the line it was checked on (the
// drawer renders it there), and goes through the normal setQty pipeline.
export default function OfferProgress({ progress }) {
  const nudges = progress?.nudges || [];
  const unlocked = progress?.unlocked || [];
  const empty = nudges.length === 0 && unlocked.length === 0;
  return (
    <div data-offer-progress aria-live="polite" className={empty ? "" : "border-b border-sf-border-soft bg-sf-surface px-5 py-3"}>
      {nudges.map((n) =>
        n.kind === "spend" ? (
          <div key={`spend-${n.id}`} data-nudge="spend" className="mb-2 last:mb-0">
            <p className="text-sm font-medium text-sf-text">{n.text}</p>
            <div
              role="progressbar"
              aria-label={n.text}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={n.percent}
              className="relative mt-2 h-2 rounded-full bg-sf-surface-sunken"
            >
              <div data-progress-fill className="h-full rounded-full bg-sf-accent transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${n.percent}%` }} />
              {n.milestones.map((m) => (
                <span
                  key={m.id}
                  title={m.label}
                  aria-hidden="true"
                  className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sf-text-subtle"
                  style={{ left: `${m.position}%` }}
                />
              ))}
            </div>
            {n.milestones.length > 1 && (
              <p className="mt-1 text-xs text-sf-text-subtle">{n.milestones.map((m) => m.label).join(" · ")}</p>
            )}
          </div>
        ) : (
          <p key={`${n.kind}-${n.id}`} data-nudge={n.kind} className="mb-2 text-sm text-sf-text last:mb-0">
            {n.text}
          </p>
        ),
      )}
      {unlocked.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {unlocked.map((u) => (
            <li key={u.id} data-unlocked={u.id} className="flex items-center gap-1 text-xs font-semibold text-sf-accent-text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              {u.label} · Unlocked
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
