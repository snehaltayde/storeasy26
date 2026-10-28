import { cx } from "./cx";

// Plain-SVG charts (S50) — no chart library, truthful axes, primary-color
// marks. Hook-free; hover detail rides native <title>.

export function Bars({ series, height = 120, ariaLabel, formatValue = (v) => String(v), className = "" }) {
  const n = series.length;
  if (!n) return null;
  const max = Math.max(...series.map((d) => d.value), 0);
  const W = 100;
  const gap = 0.35;
  const bw = W / n;
  return (
    <figure className={className}>
      <div className="flex items-baseline justify-between text-[11px] text-fg-subtle">
        <span>{formatValue(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} 40`} preserveAspectRatio="none" role="img" aria-label={ariaLabel} style={{ width: "100%", height }} className="mt-1">
        <line x1="0" y1="39.6" x2={W} y2="39.6" stroke="var(--c-border)" strokeWidth="0.4" />
        {series.map((d, i) => {
          const h = max > 0 ? (d.value / max) * 37 : 0;
          return (
            <rect key={i} x={i * bw + gap / 2} y={39.4 - h} width={bw - gap} height={Math.max(h, d.value > 0 ? 0.6 : 0)} rx="0.4" fill="var(--c-primary)" opacity={d.value > 0 ? 0.85 : 0}>
              <title>{`${d.label}: ${formatValue(d.value)}${d.title ? ` — ${d.title}` : ""}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-fg-subtle">
        <span>{series[0].label}</span>
        {n > 1 && <span>{series[n - 1].label}</span>}
      </div>
    </figure>
  );
}

export function Sparkline({ series, width = 96, height = 28, className = "" }) {
  const n = series.length;
  if (n < 2) return null;
  const max = Math.max(...series, 1);
  const pts = series.map((v, i) => `${(i / (n - 1)) * 100},${28 - (v / max) * 26 - 1}`).join(" ");
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" style={{ width, height }} aria-hidden className={className}>
      <polyline points={pts} fill="none" stroke="var(--c-primary)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
