// Phase 8 line 5: the collection page's note while a collection offer is live
// ("Buy 2+, save more"). It shows the offer's TITLE only, never its targets
// or rules; the titles come from lib/offers/store.js collectionOfferTitles,
// read at request time (start inclusive, end exclusive).
export default function CollectionOfferNote({ titles }) {
  const list = (Array.isArray(titles) ? titles : []).filter((t) => typeof t === "string" && t.trim());
  if (!list.length) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2" data-collection-offer-note>
      {list.map((t, i) => (
        <li key={i} className="rounded-full border border-sf-border bg-sf-surface-muted px-3 py-1 text-sm font-semibold text-sf-accent-text">
          {t}
        </li>
      ))}
    </ul>
  );
}
