"use client";

import { useEffect } from "react";

// The store's 404 is rendered once, when the tab loads, and a client-side
// click that lands on a missing page shows that copy again. It can be stale:
// if the store has since closed for maintenance, the gated page throws
// notFound() and the shopper sees "not on the shelves" instead of the closed
// page, because a soft navigation never re-renders the layout (S43). So a 404
// reached by a click reloads once, and the server's current answer shows.
// After the reload the document URL is the current URL; the session mark (one
// reload per URL per 10 seconds) is a second guard, so it cannot loop.
const withoutHash = (href) => href.split("#")[0];
const MARK = "sf-soft-404";

export default function ReloadOnSoftNotFound() {
  useEffect(() => {
    const loaded = performance.getEntriesByType?.("navigation")?.[0]?.name;
    const here = withoutHash(window.location.href);
    if (!loaded || withoutHash(loaded) === here) return;
    try {
      const last = JSON.parse(sessionStorage.getItem(MARK) || "null");
      if (last?.href === here && Date.now() - last.at < 10_000) return;
      sessionStorage.setItem(MARK, JSON.stringify({ href: here, at: Date.now() }));
    } catch {
      return; // no storage, no guard: stay on the 404
    }
    window.location.reload();
  }, []);
  return null;
}
