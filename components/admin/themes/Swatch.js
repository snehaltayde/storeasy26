// A theme's three colours (accent, background, text).
//   dots (default): small dots beside a name, in a table row or a title
//   band: one strip split into the three colours, the theme at a glance on a
//         card or the theme's own page; the accent takes the widest share
export function Swatch({ colors, label, band = false, className = "" }) {
  const list = (colors || []).filter(Boolean);
  if (band) {
    return (
      <span role="img" aria-label={label} data-themes="swatch-band" className={`flex h-8 w-full overflow-hidden rounded-md border border-border ${className}`}>
        {list.map((c, i) => (
          <span key={i} className={i === 0 ? "flex-[2]" : "flex-1"} style={{ backgroundColor: c }} />
        ))}
      </span>
    );
  }
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`} role="img" aria-label={label}>
      {list.map((c, i) => (
        <span key={i} className="size-4 rounded-full border border-border" style={{ backgroundColor: c }} />
      ))}
    </span>
  );
}
