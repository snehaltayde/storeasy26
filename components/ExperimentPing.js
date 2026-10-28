"use client";

import { useEffect } from "react";

// Experiment unit persistence + exposure ping (S47 / BE22). The server
// ASSIGNS (pure hash — this component never picks a variant); this only
// (1) persists the functional unit cookie so the next request assigns the
// same way, and (2) reports "this unit saw the surface" — the server
// re-derives the variant from the cookie, so the payload carries no vote.
export default function ExperimentPing({ slug, unit }) {
  useEffect(() => {
    try {
      if (!document.cookie.includes("_unit=")) {
        document.cookie = `_unit=${unit}; path=/; max-age=31536000; samesite=lax`;
      }
      const key = `_exp_${slug}`;
      if (sessionStorage.getItem(key)) return; // server dedupes anyway (first exposure wins)
      sessionStorage.setItem(key, "1");
      fetch("/api/exp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }), keepalive: true }).catch(() => {});
    } catch {
      /* no cookies/storage → no exposure, honestly uncounted */
    }
  }, [slug, unit]);
  return null;
}
