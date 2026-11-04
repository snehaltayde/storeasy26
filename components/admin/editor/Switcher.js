"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/console/Button";
import { switcherRows, collectionRows, productCounts, PRODUCT_FILTERS, WORDS } from "./editorModel";

// P3-EDITOR (ED-02): every document by its label, with a name search.
// P4-EDITOR (OVL-04, ED-12): two more sections.
//   Products     every product, read ONLY through listProductContent (paged,
//                searched there by the published name, Shopify's name or the
//                web address), so product 31 and later open and a renamed
//                product is found by its new name. Filters "Changed in
//                Shopify" and "No longer in Shopify", each with its count.
//                A row opens /admin/editor?product=<gid>.
//   Collections  the store's collections (the catalog picker's read); a row
//                opens /admin/editor?collection=<gid>.
// Props only:
//   documents       listDocuments' rows
//   products        listProductContent's items for the current search,
//                   filter and pages; counts its counts
//   productsState   { status: "loading" | "ready" | "failed", message?, more }
//   collections     the refs read's collections ({ id, handle, title })
//   openId, openEntityId   the open document, and its product or collection
//   onOpen(id)      open another document (the editor saves first)
//   onOpenHref(href) open a product's or collection's content (saves first)
//   query, onQuery, filter, onFilter, onMore   the search, the filter, the next page

export function SwitcherView({
  documents = [],
  products = [],
  counts = null,
  productsState = { status: "ready", more: false },
  collections = [],
  openId = null,
  openEntityId = null,
  query = "",
  onQuery,
  filter = "all",
  onFilter,
  onMore,
  onOpen,
  onOpenHref,
  busyId = null,
}) {
  const rows = switcherRows({ documents, products, query, openId, openEntityId });
  const term = String(query ?? "").trim().toLowerCase();
  const cols = collectionRows(collections, { openEntityId }).filter((c) => !term || c.label.toLowerCase().includes(term));
  const tally = productCounts(counts);
  const countOf = (key) => tally.find((t) => t.key === key)?.count ?? 0;
  const busy = busyId != null;
  return (
    <nav aria-label="Pages in this store" className="space-y-2" data-switcher="">
      <label className="relative block">
        <span className="sr-only">Find a page, product or collection by name</span>
        <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery?.(e.target.value)}
          placeholder="Find a page, product or collection by name"
          className="w-full rounded-ctl border border-edge bg-surface py-1.5 pl-8 pr-2 text-sm text-fg focus-ring"
          data-switcher-search=""
        />
      </label>
      {rows.documents.length > 0 && (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="Pages">
          {rows.documents.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen?.(r.id)}
                aria-current={r.open ? "page" : undefined}
                disabled={busy}
                className={`flex w-full items-baseline justify-between gap-2 rounded-ctl px-2 py-1.5 text-left focus-ring hover:bg-surface-sunken ${r.open ? "bg-surface-sunken font-semibold" : ""}`}
                data-switcher-doc={r.id}
              >
                <span className="min-w-0 truncate text-sm text-fg">{r.label}</span>
                <span className="shrink-0 text-[11px] text-fg-subtle">{r.state}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Products" data-switcher-products="">
        <p className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{`Products (${countOf("all")})`}</p>
        <div className="flex flex-wrap gap-1 px-1 py-1" role="group" aria-label="Show products">
          {PRODUCT_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => onFilter?.(f.key)}
              className={`rounded-full border border-edge px-2 py-0.5 text-[11px] focus-ring ${filter === f.key ? "bg-surface-sunken font-semibold text-fg" : "text-fg-muted"}`}
              data-product-filter={f.key}
            >
              {`${f.label} (${countOf(f.key)})`}
            </button>
          ))}
        </div>
        {productsState.status === "failed" && <p className="px-2 text-[13px] text-fg-muted">{productsState.message || "We couldn't load your products. Reload the page."}</p>}
        {productsState.status !== "failed" && rows.products.length === 0 && productsState.status !== "loading" && (
          <p className="px-2 text-[13px] text-fg-muted">{term ? "No product has that name." : filter === "all" ? "No products yet." : "None right now."}</p>
        )}
        {rows.products.length > 0 && (
          <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="Product list">
            {rows.products.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpenHref?.(r.href, r.id)}
                  aria-current={r.open ? "page" : undefined}
                  disabled={busy}
                  className={`flex w-full items-baseline justify-between gap-2 rounded-ctl px-2 py-1.5 text-left focus-ring hover:bg-surface-sunken ${r.open ? "bg-surface-sunken font-semibold" : ""}`}
                  data-switcher-product={r.id}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-fg">{r.label}</span>
                    {r.secondary && <span className="block truncate text-[11px] text-fg-muted">{r.secondary}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-fg-subtle">{r.state}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {productsState.status === "loading" && <p className="px-2 text-[13px] text-fg-muted" role="status">Loading products…</p>}
        {productsState.more && productsState.status !== "loading" && (
          <div className="px-2 pt-1">
            <Button size="sm" variant="ghost" onClick={onMore} data-products-more="">
              Show more products
            </Button>
          </div>
        )}
        <p className="px-2 text-[11px] text-fg-subtle">{WORDS.productNote}</p>
      </section>

      {cols.length > 0 && (
        <section aria-label="Collections" data-switcher-collections="">
          <p className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Collections</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto" aria-label="Collection list">
            {cols.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenHref?.(c.href, c.id)}
                  aria-current={c.open ? "page" : undefined}
                  disabled={busy}
                  className={`flex w-full items-baseline justify-between gap-2 rounded-ctl px-2 py-1.5 text-left focus-ring hover:bg-surface-sunken ${c.open ? "bg-surface-sunken font-semibold" : ""}`}
                  data-switcher-collection={c.id}
                >
                  <span className="min-w-0 truncate text-sm text-fg">{c.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows.documents.length === 0 && rows.products.length === 0 && cols.length === 0 && productsState.status === "ready" && <p className="px-1 text-[13px] text-fg-muted">Nothing here has that name.</p>}
    </nav>
  );
}

// The shell's counts line (OVL-04): products, changed in Shopify, no longer in Shopify.
export function ProductCounts({ counts }) {
  if (!counts) return null;
  return (
    <p className="text-[12px] text-fg-muted" data-product-counts="">
      {productCounts(counts)
        .map((c) => `${c.label} ${c.count}`)
        .join(" · ")}
    </p>
  );
}

export default function Switcher(props) {
  const [query, setQuery] = useState("");
  return <SwitcherView {...props} query={props.query ?? query} onQuery={props.onQuery ?? setQuery} />;
}
