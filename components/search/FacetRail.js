import Link from "next/link";
import { facetHref, toggled, SHOWN_VALUES } from "@/lib/catalog/facets";
import PriceRange from "./PriceRange";

// The filter groups (P7-FACETS): every value is a plain link to the URL with
// that value toggled, so filters work without JavaScript and Back/Forward
// restore them. Past eight values the rest sit in a <details> ("Show all"),
// open when one of them is selected. Server component; the desktop left rail
// and the phone's FacetSheet both render it.
function ValueLink({ state, group, v }) {
  return (
    <li>
      <Link
        href={facetHref(toggled(state, group, v.value))}
        scroll={false}
        data-facet-value={v.value}
        data-selected={v.selected ? "true" : undefined}
        className="flex items-center gap-2.5 rounded-sf-small py-1.5 text-sm text-sf-text-body hover:text-sf-text"
      >
        <span
          aria-hidden="true"
          className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${v.selected ? "border-sf-accent bg-sf-accent text-sf-on-accent" : "border-sf-border-strong bg-sf-surface"}`}
        >
          {v.selected ? (
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2.5 6.5l2.5 2.5 4.5-6" />
            </svg>
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {v.value}
          {v.selected ? <span className="sr-only"> (selected)</span> : null}
        </span>
        <span className="tabular-nums text-sf-text-faint">{v.count}</span>
      </Link>
    </li>
  );
}

export default function FacetRail({ state, groups, price, idPrefix = "r" }) {
  const instockHref = facetHref({ ...state, instock: !state.instock });
  return (
    <div className="space-y-6" data-facet-rail>
      <div>
        <Link
          href={instockHref}
          scroll={false}
          data-facet-instock
          data-selected={state.instock ? "true" : undefined}
          className="flex items-center gap-2.5 text-sm font-medium text-sf-text-body"
        >
          <span aria-hidden="true" className={`flex size-4 items-center justify-center rounded-[4px] border ${state.instock ? "border-sf-accent bg-sf-accent text-sf-on-accent" : "border-sf-border-strong bg-sf-surface"}`}>
            {state.instock ? (
              <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2.5 6.5l2.5 2.5 4.5-6" />
              </svg>
            ) : null}
          </span>
          In stock only
          {state.instock ? <span className="sr-only"> (selected)</span> : null}
        </Link>
      </div>
      {groups.map((g) => {
        const shown = g.values.slice(0, SHOWN_VALUES);
        const more = g.values.slice(SHOWN_VALUES);
        return (
          <section key={g.key} data-facet-group={g.key} aria-labelledby={`${idPrefix}-facet-${g.key}`}>
            <h2 id={`${idPrefix}-facet-${g.key}`} className="text-xs font-semibold uppercase tracking-wide text-sf-text-muted">
              {g.title}
            </h2>
            <ul className="mt-2">
              {shown.map((v) => (
                <ValueLink key={v.value} state={state} group={g.key} v={v} />
              ))}
            </ul>
            {more.length ? (
              <details open={more.some((v) => v.selected)} className="group">
                <summary className="mt-1 cursor-pointer list-none text-sm font-medium text-sf-accent-text hover:underline group-open:hidden">Show all ({g.values.length})</summary>
                <ul>
                  {more.map((v) => (
                    <ValueLink key={v.value} state={state} group={g.key} v={v} />
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        );
      })}
      <PriceRange state={state} price={price} idPrefix={idPrefix} />
    </div>
  );
}
