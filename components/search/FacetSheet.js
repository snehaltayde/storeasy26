"use client";

import { useEffect, useRef, useState } from "react";

// The phone's filters (P7-FACETS): "Filters (3)" opens a full-height sheet
// with the same rail (children, server-rendered). Focus stays inside while it
// is open (Tab and Shift+Tab wrap), Escape or "Show 12 products" closes it and
// focus goes back to the button. Picking a value is a link: the page updates
// under the sheet, which stays open with the new counts. The open flag is this
// component's own state (no shared client state). Without JavaScript the page
// shows the rail inline instead (a <noscript> copy in the page).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, summary, [tabindex]:not([tabindex="-1"])';

export default function FacetSheet({ active, total, children }) {
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  const panel = useRef(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) button.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector("[data-sheet-close]")?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!panel.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const label = `Show ${total} ${total === 1 ? "product" : "products"}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-facet-sheet-open
        className="sf-focus inline-flex min-h-11 items-center gap-2 rounded-sf-control border border-sf-border bg-sf-surface px-4 py-2 text-sm font-semibold text-sf-text-soft hover:border-sf-border-hover"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M2 4h12M4.5 8h7M7 12h2" />
        </svg>
        Filters{active ? ` (${active})` : ""}
      </button>
      {open ? (
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="facet-sheet-title" data-facet-sheet className="fixed inset-0 z-50 flex flex-col bg-sf-surface">
          <div className="flex items-center justify-between border-b border-sf-border px-4 py-3">
            <h2 id="facet-sheet-title" className="text-base font-semibold text-sf-text">
              Filters{active ? ` (${active})` : ""}
            </h2>
            <button type="button" onClick={() => setOpen(false)} data-sheet-close aria-label="Close filters" className="sf-focus -mr-2 flex size-11 items-center justify-center rounded-sf-small text-sf-text-subtle hover:text-sf-text">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
          <div className="border-t border-sf-border p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <button type="button" onClick={() => setOpen(false)} data-sheet-show className="sf-focus min-h-12 w-full rounded-sf-control bg-sf-accent px-4 py-3 text-sm font-semibold text-sf-on-accent hover:bg-sf-accent-hover">
              {label}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
