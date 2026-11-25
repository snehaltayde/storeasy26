// Phase 4 line 2: the badge_row primitive. A server component: no client
// code, no event handlers, no raw HTML. Its props passed validateBlockProps
// (lib/plugins/blocks.js): each badge is an icon from BLOCK_ICONS and a plain
// label, which React escapes. The icons are drawn here, never by a plugin.
const PATHS = {
  truck: "M3 6h11v9H3zM14 9h4l3 3v3h-7M7 18a1.5 1.5 0 1 0 0-.01M17 18a1.5 1.5 0 1 0 0-.01",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z",
  return: "M9 7H4V2M4 7a8 8 0 1 1-1 5",
  leaf: "M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l7-7",
  award: "M12 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10M9 12l-2 9 5-3 5 3-2-9",
  heart: "M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z",
};

function Icon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-sf-accent-text">
      <path d={PATHS[name] || PATHS.shield} />
    </svg>
  );
}

export default function BadgeRow({ badges = [] }) {
  if (!badges.length) return null;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:gap-5">
      {badges.map((b, i) => (
        <li key={i} className="flex items-center gap-2 text-sm font-medium text-sf-text-body">
          <Icon name={b.icon} />
          <span>{b.label}</span>
        </li>
      ))}
    </ul>
  );
}
