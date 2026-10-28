"use client";

import { useEffect, useState } from "react";

// Wishlist toggle (S49 / SF22). LOCAL-FIRST: writes browser storage only —
// nothing leaves the device unless the shopper explicitly merges on the
// /wishlist page while signed in. Storage is per store origin, so lists
// never cross tenant boundaries.
const KEY = "_wl_v1";

export function readLocalWishlist() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function writeLocalWishlist(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100)));
    window.dispatchEvent(new Event("wishlist-changed"));
  } catch {
    /* storage unavailable → the button simply doesn't persist */
  }
}

export default function WishlistButton({ handle, variantId = null }) {
  const [saved, setSaved] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setSaved(readLocalWishlist().some((i) => i.handle === handle));
    sync();
    setReady(true);
    window.addEventListener("wishlist-changed", sync);
    return () => window.removeEventListener("wishlist-changed", sync);
  }, [handle]);

  if (!ready) return null;
  return (
    <button
      type="button"
      aria-pressed={saved}
      onClick={() => {
        const list = readLocalWishlist();
        writeLocalWishlist(saved ? list.filter((i) => i.handle !== handle) : [...list, { handle, variantId, at: new Date().toISOString() }]);
      }}
      className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition ${saved ? "border-red-200 bg-red-50 text-red-600" : "border-zinc-300 text-zinc-600 hover:bg-zinc-50"}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z" />
      </svg>
      {saved ? "Saved" : "Save for later"}
    </button>
  );
}
