// A theme's three colours (accent, background, text) as small dots.
export function Swatch({ colors, label }) {
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={label}>
      {colors.filter(Boolean).map((c, i) => (
        <span key={i} className="size-4 rounded-full border border-border" style={{ backgroundColor: c }} />
      ))}
    </span>
  );
}
