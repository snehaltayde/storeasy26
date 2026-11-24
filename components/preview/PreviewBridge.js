"use client";

import { useEffect } from "react";
import { createBridge } from "./bridge-core";
import { paletteById } from "@/lib/themes/palettes";
import { brandCssVars } from "@/lib/brand";

// Designer and editor ⇄ preview bridge (S54; P3-FRAME). The storefront layout
// mounts it only for a founder: in a preview, when a preview has just ended,
// and on the live store of a browser signed in to the console (so the editor
// learns its frame shows the live store). Shoppers never get it.
//
// The protocol lives in ./bridge-core.js (plain module, window and document
// passed in, tested without a browser). This is the React mount plus the
// outline styles. It stays inert unless the page is inside a same-origin
// console frame that says hello.
//
// Props: what the layout says this frame shows.
//   state   documents preview: {kind, sid, docs, offline, skipped, designShown}
//   ok      true for a working documents preview
//   reason  why not ("revoked", "expired", "not_found", "live", "legacy")
const STYLES = `
  [data-sec].storeasy-selected { outline: 2px solid #0ea5e9; outline-offset: 4px; border-radius: 4px; }
  body.storeasy-designing [data-sec] { cursor: pointer; }
  body.storeasy-designing [data-sec]:hover { outline: 2px dashed #0ea5e9aa; outline-offset: 4px; border-radius: 4px; }
  body.storeasy-editing [data-section-id]:hover { outline: 2px dashed #0ea5e9aa; outline-offset: 4px; border-radius: 4px; }
  body.storeasy-editing [data-field]:hover { outline: 1px dotted #0ea5e9; outline-offset: 2px; }
  body.storeasy-editing [data-section-id].storeasy-selected { outline: 2px solid #0ea5e9; outline-offset: 4px; border-radius: 4px; }
  body.storeasy-look [data-preview-bar] { display: none !important; }
`;

// Phase 1 line 6 (look mode): a palette's colours, worked out inside the
// frame from its id, the way the layout draws a saved one (brandCssVars on
// the palette's own kit). Unknown id: null. Both imports are Edge-safe.
export function brandFor(id) {
  const p = paletteById(id);
  return p ? { css: brandCssVars(p.brand, { kit: p.kit }), kit: p.kit } : null;
}

export default function PreviewBridge({ state = null, ok = false, reason = null }) {
  const key = JSON.stringify([state, ok, reason]);
  useEffect(() => {
    const [s, o, r] = JSON.parse(key);
    return createBridge({ window, document, state: s, ok: o, reason: r, css: STYLES, brandFor });
  }, [key]);
  return null;
}
