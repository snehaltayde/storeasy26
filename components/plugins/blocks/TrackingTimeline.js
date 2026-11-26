// Phase 9 line 4: the tracking_timeline primitive (Shiprocket's "Tracking"
// block on the order page). A server component: no client code, no raw HTML.
// Every prop is plain words that passed validateBlockProps; the courier link
// is built here from the tracking number on Shiprocket's own tracking site
// (a fixed origin, never an address a plugin hands over). Nothing renders
// for an order with no parcel yet.
export const TRACK_ORIGIN = "https://shiprocket.co/tracking/";

export default function TrackingTimeline({ status, headline, expected, courier, awb, steps = [] }) {
  if (!status || !headline) return null;
  return (
    <section data-tracking={status} aria-labelledby="tracking-title" className="rounded-sf-card border border-sf-border-soft p-4 text-sm">
      <h2 id="tracking-title" className="text-xs font-semibold uppercase tracking-wide text-sf-text-subtle">
        Tracking
      </h2>
      <p data-tracking-status className="mt-1 text-base font-semibold text-sf-text">
        {headline}
      </p>
      {expected ? (
        <p data-tracking-expected className="mt-0.5 text-sf-text-muted">
          {expected}
        </p>
      ) : null}
      {steps.length ? (
        <ol data-tracking-steps className="mt-3 space-y-2 border-l border-sf-border pl-4">
          {steps.map((s, i) => (
            <li key={`${s.at}-${i}`} data-tracking-step>
              <p className="text-sf-text">{s.activity || "Update"}</p>
              <p className="text-xs text-sf-text-subtle">
                {[s.at, s.hub].filter(Boolean).join(" · ")}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      {awb ? (
        <p className="mt-3 text-xs text-sf-text-subtle">
          {courier ? `${courier} · ` : ""}
          <a href={`${TRACK_ORIGIN}${encodeURIComponent(awb)}`} target="_blank" rel="noopener noreferrer nofollow" data-tracking-link className="font-semibold text-sf-accent-text underline">
            Track with the courier
          </a>
        </p>
      ) : null}
    </section>
  );
}
