"use client";

import { useCallback } from "react";
import { track } from "@/lib/track/client";

// Search click-through (Session 16): wraps the results grid and fires
// select_item with the query + result position when a product link is clicked.
// Event delegation, so the server-rendered grid stays untouched; sendBeacon in
// track() survives the navigation.
export default function SearchResults({ query, items, children }) {
  const onClick = useCallback(
    (e) => {
      const a = e.target.closest?.('a[href^="/products/"]');
      if (!a) return;
      const handle = a.getAttribute("href").split("/products/")[1]?.split("?")[0];
      const idx = items.findIndex((it) => it.handle === handle);
      const item = idx >= 0 ? items[idx] : null;
      track("select_item", {
        params: { search_term: query, position: idx >= 0 ? idx + 1 : undefined, handle },
        ...(item ? { items: [{ id: item.id, name: item.title, price: item.price }] } : {}),
      });
    },
    [query, items],
  );
  return <div onClick={onClick}>{children}</div>;
}
