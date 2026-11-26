// Phase 9 line 1: five stars, filled to a rating (0–5, any fraction). Drawn by
// Storeasy; a server component with no client code.
const STAR = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z";

export default function Stars({ value = 0, size = 16, label = null }) {
  const v = Math.max(0, Math.min(5, Number(value) || 0));
  return (
    <span className="inline-flex items-center gap-0.5 text-sf-accent-text" role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : "true"}>
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, v - i));
        return (
          <svg key={i} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
            <path d={STAR} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            {fill > 0 ? (
              <svg x="0" y="0" width={24 * fill} height="24" viewBox={`0 0 ${24 * fill} 24`} overflow="hidden">
                <path d={STAR} fill="currentColor" />
              </svg>
            ) : null}
          </svg>
        );
      })}
    </span>
  );
}
