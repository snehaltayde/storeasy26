"use client";

import { useRouter } from "next/navigation";

// Sort select for the collection filter bar (S38 / SF03). Filters are plain
// links (URL-backed, so back/forward and sharing restore the exact view);
// only the <select> needs client-side navigation.
export default function CollectionControls({ basePath, params, sort }) {
  const router = useRouter();

  function onSort(e) {
    const next = new URLSearchParams(params);
    if (e.target.value === "featured") next.delete("sort");
    else next.set("sort", e.target.value);
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <label className="flex items-center gap-2 text-sm text-sf-text-subtle">
      Sort
      <select
        value={sort}
        onChange={onSort}
        aria-label="Sort products"
        className="rounded-sf-small border border-sf-border bg-sf-surface px-2.5 py-1.5 text-sm font-medium text-sf-text-soft outline-none focus:border-sf-border-hover"
      >
        <option value="featured">Featured</option>
        <option value="new">Newest</option>
        <option value="price-asc">Price: low to high</option>
        <option value="price-desc">Price: high to low</option>
      </select>
    </label>
  );
}
