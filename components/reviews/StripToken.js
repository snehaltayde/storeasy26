"use client";

import { useEffect } from "react";

// Phase 9 line 1 review fix: once the page has rendered, take the signed ?t=
// token out of the address bar (history.replaceState), so it isn't kept in the
// history, bookmarks or a copied link. The form keeps it in a hidden field.
export default function StripToken() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("t")) return;
    url.searchParams.delete("t");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return null;
}
