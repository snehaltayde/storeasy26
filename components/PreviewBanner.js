"use client";

import { usePathname } from "next/navigation";
import { liveExitUrl } from "@/lib/documents/paths";
import { routeDocFor } from "@/components/preview/bridge-core";

// P2-PREVIEW (PV-03, spec 8.8): the words inside the founder's preview bar.
// The bar itself (its colour) stays in app/(storefront)/layout.js; this only
// says what the preview shows. P3-FRAME: a client component, because two of
// its lines depend on the address the founder is on (usePathname).
//
//   frame null         a legacy preview: today's words and Exit link only
//   frame              a documents preview ({ routes, offline }):
//                      "You're seeing your unpublished changes." and
//                      "See the live store", the exit to this same address on
//                      the live store (/api/preview?exit=1&to=<path>, never a
//                      token); plus "This page is offline. Publishing it
//                      brings it back." when this address's document is one
//                      taken offline
//   overlay.otherTab   the same person opened a newer preview in another tab
//   overlay.designDirty the design document has unpublished changes: say
//                      whether they are shown (overlay.designShown), with a
//                      one-click toggle (a same-origin form POST to
//                      /api/preview) where the toggle changes something
export const OFFLINE_LINE = "This page is offline. Publishing it brings it back.";

export default function PreviewBanner({ overlay = null, frame = null }) {
  const pathname = usePathname() || "/";
  const routeDoc = frame ? routeDocFor(pathname, frame.routes) : null;
  const offline = Boolean(routeDoc && Array.isArray(frame?.offline) && frame.offline.includes(routeDoc));
  return (
    <>
      {frame ? (
        <>
          You&apos;re seeing your unpublished changes.{" "}
          <a href={liveExitUrl(pathname)} className="underline">
            See the live store
          </a>
          {offline ? (
            <span data-preview-note="offline" className="ml-3">
              {OFFLINE_LINE}
            </span>
          ) : null}
        </>
      ) : (
        <>
          Draft preview — this is NOT what shoppers see.{" "}
          <a href="/api/preview?exit=1" className="underline">
            Exit preview
          </a>
        </>
      )}
      {overlay?.otherTab ? (
        <span data-preview-note="other-tab" className="ml-3">
          You opened a newer preview in another tab. Both tabs show all your saved drafts.
        </span>
      ) : null}
      {overlay?.designDirty ? <DesignNote overlay={overlay} /> : null}
    </>
  );
}

// The design line. What it says comes from what the preview really shows
// (overlay.designShown), not from the toggle: on a store with no live design
// (a closed store, or one opened on the platform default) the draft is shown
// with the toggle off (P6-LOGO-REG), so the bar says the colours are shown and
// offers no button, because the toggle changes nothing there (P6-LOGO-RENDER).
// An overlay without designShown (older callers) reads the toggle, as before.
export const DESIGN_SHOWN_LINE = "Your new colours are shown here.";
export const DESIGN_HIDDEN_LINE = "Your new colours are not shown here.";

function DesignNote({ overlay }) {
  const shown = typeof overlay.designShown === "boolean" ? overlay.designShown : Boolean(overlay.showDesign);
  if (shown && !overlay.showDesign) {
    return (
      <span data-preview-note="design" className="ml-3">
        {DESIGN_SHOWN_LINE}
      </span>
    );
  }
  return (
    <form data-preview-note="design" method="post" action="/api/preview" className="ml-3 inline">
      <input type="hidden" name="design" value={overlay.showDesign ? "off" : "on"} />
      {shown ? DESIGN_SHOWN_LINE : DESIGN_HIDDEN_LINE}{" "}
      <button type="submit" className="font-semibold underline">
        {overlay.showDesign ? "Hide them" : "Show them"}
      </button>
    </form>
  );
}

// P3-FRAME (ED-04): <main> in a documents preview, carrying data-doc, the
// document this address shows (the editor's pick reads it for clicks outside
// any section). Only the layout's documents-preview branch renders it; every
// other request gets the layout's plain <main>, byte for byte.
export function PreviewMain({ routes = {}, children }) {
  const doc = routeDocFor(usePathname() || "/", routes);
  return (
    <main className="flex-1" {...(doc ? { "data-doc": doc } : {})}>
      {children}
    </main>
  );
}
