"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { switcherRows, WORDS } from "./editorModel";

// P3-EDITOR (ED-02): every document by its label, with a name search. The
// store's products are listed by name with a plain "Not yet editable here":
// editing one product's own content waits for OVL-02 (recorded partial).
// Props only:
//   documents  listDocuments' rows
//   products   the catalog's products ({ handle, title })
//   openId     the open document
//   onOpen(id) open another document (the editor saves first)
//   query, onQuery   optional control of the search box (tests)

export function SwitcherView({ documents = [], products = [], openId = null, query = "", onQuery, onOpen, busyId = null }) {
  const rows = switcherRows({ documents, products, query, openId });
  return (
    <nav aria-label="Pages in this store" className="space-y-2" data-switcher="">
      <label className="relative block">
        <span className="sr-only">Find a page by name</span>
        <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery?.(e.target.value)}
          placeholder="Find a page by name"
          className="w-full rounded-ctl border border-edge bg-surface py-1.5 pl-8 pr-2 text-sm text-fg focus-ring"
          data-switcher-search=""
        />
      </label>
      {rows.documents.length === 0 && rows.products.length === 0 && <p className="px-1 text-[13px] text-fg-muted">Nothing here has that name.</p>}
      {rows.documents.length > 0 && (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="Pages">
          {rows.documents.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen?.(r.id)}
                aria-current={r.open ? "page" : undefined}
                disabled={busyId != null}
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
      {rows.products.length > 0 && (
        <div>
          <p className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Products</p>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto" aria-label="Products">
            {rows.products.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-2 px-2 py-1.5" data-switcher-product={r.id}>
                <span className="min-w-0 truncate text-sm text-fg-muted">{r.label}</span>
                <span className="shrink-0 text-[11px] text-fg-subtle">{r.state}</span>
              </li>
            ))}
          </ul>
          <p className="px-2 text-[11px] text-fg-subtle">{WORDS.productNote}</p>
        </div>
      )}
    </nav>
  );
}

export default function Switcher(props) {
  const [query, setQuery] = useState("");
  return <SwitcherView {...props} query={props.query ?? query} onQuery={props.onQuery ?? setQuery} />;
}
