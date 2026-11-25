import { facetParams } from "@/lib/catalog/facets";

// Price (P7-FACETS): a GET form, so it works without JavaScript. Every other
// filter rides along as hidden fields; the page goes back to 1. The
// placeholders are the cheapest and dearest price in the current results.
export default function PriceRange({ state, price, idPrefix = "r" }) {
  const keep = [...facetParams({ ...state, min: null, max: null, page: 1 })];
  const input = "w-full rounded-sf-control border border-sf-border bg-sf-surface px-2.5 py-1.5 text-sm text-sf-text outline-none focus:border-sf-border-hover";
  return (
    <form method="get" action="/search" data-facet-price aria-labelledby={`${idPrefix}-facet-price`}>
      <h2 id={`${idPrefix}-facet-price`} className="text-xs font-semibold uppercase tracking-wide text-sf-text-muted">
        Price
      </h2>
      {keep.map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
      <div className="mt-2 flex items-center gap-2">
        <label className="flex-1">
          <span className="sr-only">Minimum price</span>
          <input name="min" type="number" inputMode="decimal" min="0" step="any" defaultValue={state.min ?? ""} placeholder={price ? String(Math.floor(price.min)) : "Min"} className={input} />
        </label>
        <span className="text-sf-text-faint" aria-hidden="true">
          –
        </span>
        <label className="flex-1">
          <span className="sr-only">Maximum price</span>
          <input name="max" type="number" inputMode="decimal" min="0" step="any" defaultValue={state.max ?? ""} placeholder={price ? String(Math.ceil(price.max)) : "Max"} className={input} />
        </label>
      </div>
      <button type="submit" className="mt-2 w-full rounded-sf-control border border-sf-border bg-sf-surface px-3 py-1.5 text-sm font-medium text-sf-text-soft hover:border-sf-border-hover">
        Apply price
      </button>
    </form>
  );
}
