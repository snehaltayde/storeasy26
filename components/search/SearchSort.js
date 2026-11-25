"use client";

import { useRef } from "react";

// Sort (P7-FACETS): a GET form with the filters as hidden fields. With
// JavaScript the select submits on change; without it, the Sort button does.
const LABELS = { relevance: "Relevance", "price-asc": "Price: low to high", "price-desc": "Price: high to low", new: "Newest" };

export default function SearchSort({ sort, keep }) {
  const form = useRef(null);
  return (
    <form ref={form} method="get" action="/search" className="flex items-center gap-2 text-sm text-sf-text-subtle" data-search-sort>
      {keep.map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
      <label className="flex items-center gap-2">
        Sort
        <select
          name="sort"
          key={sort}
          defaultValue={sort}
          onChange={() => form.current?.requestSubmit()}
          className="min-h-11 rounded-sf-small border border-sf-border bg-sf-surface px-2.5 py-1.5 text-base font-medium text-sf-text-soft outline-none focus:border-sf-accent-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sf-accent-strong lg:min-h-9 lg:text-sm"
        >
          {Object.entries(LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit" className="rounded-sf-small border border-sf-border px-2.5 py-1.5 font-medium">
          Sort
        </button>
      </noscript>
    </form>
  );
}
