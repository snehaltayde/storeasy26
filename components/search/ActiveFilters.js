import Link from "next/link";
import { facetHref, toggled, clearedFilters } from "@/lib/catalog/facets";

// The filters that are on, each a chip whose link removes it, plus "Clear
// all" (P7-FACETS). Server component; plain links.
export function chipsFor(state, labels = {}) {
  const chips = [];
  for (const v of state.types) chips.push({ label: v, href: facetHref(toggled(state, "type", v)) });
  for (const v of state.vendors) chips.push({ label: v, href: facetHref(toggled(state, "vendor", v)) });
  for (const g of state.options) for (const v of g.values) chips.push({ label: `${labels[g.name] || g.name}: ${v}`, href: facetHref(toggled(state, `o:${g.name}`, v)) });
  if (state.min != null || state.max != null) {
    const text = state.min != null && state.max != null ? `${state.min} – ${state.max}` : state.min != null ? `From ${state.min}` : `Up to ${state.max}`;
    chips.push({ label: `Price: ${text}`, href: facetHref({ ...state, min: null, max: null }) });
  }
  if (state.instock) chips.push({ label: "In stock", href: facetHref({ ...state, instock: false }) });
  return chips;
}

export default function ActiveFilters({ state, labels }) {
  const chips = chipsFor(state, labels);
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap items-center gap-2" data-active-filters aria-label="Active filters">
      {chips.map((c) => (
        <li key={c.href + c.label}>
          <Link href={c.href} scroll={false} data-chip={c.label} className="sf-focus inline-flex min-h-11 items-center gap-1.5 rounded-full border border-sf-border bg-sf-surface-muted px-3.5 py-1 text-sm text-sf-text-body hover:border-sf-border-hover lg:min-h-9">
            {c.label}
            <span aria-hidden="true" className="text-sf-text-faint">
              ×
            </span>
            <span className="sr-only">Remove filter</span>
          </Link>
        </li>
      ))}
      <li>
        <Link href={facetHref(clearedFilters(state))} scroll={false} data-clear-all className="sf-focus inline-flex min-h-11 items-center rounded-sf-small px-1 text-sm font-medium text-sf-accent-text hover:underline lg:min-h-9">
          Clear all
        </Link>
      </li>
    </ul>
  );
}
