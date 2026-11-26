// Phase 9 line 1: the link_list primitive (Reviews' "Review links" block on the
// order page). A server component: no client code, no raw HTML. Each href
// passed isStorefrontHref, so it is a path on this store.
export default function LinkList({ links = [] }) {
  if (!links.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" data-link-list="">
      {links.map((l, i) => (
        <li key={i}>
          <a href={l.href} className="inline-block rounded-sf-button border border-sf-border px-3 py-2 text-sm font-semibold text-sf-text hover:bg-sf-surface-muted">
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
