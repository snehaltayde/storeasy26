"use client";

import { useEffect, useRef } from "react";

// FAQ accordions (S39 / SF16). Native <details>/<summary> = keyboard and
// screen-reader support for free; each question has a stable anchor id so
// /policies/faq#q-how-long-does-delivery-take deep-links straight to it
// (opened + scrolled into view, on load and on hash changes). The ¶ button
// copies the deep link.
export const faqAnchor = (q) =>
  "q-" +
  String(q)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export default function FaqSection({ heading, items }) {
  const rootRef = useRef(null);

  useEffect(() => {
    function openFromHash() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const el = rootRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
      if (el?.tagName === "DETAILS") {
        el.open = true;
        el.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  async function copyLink(anchor, btn) {
    const url = `${window.location.origin}${window.location.pathname}#${anchor}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "✓";
      setTimeout(() => (btn.textContent = "¶"), 1200);
    } catch {
      window.location.hash = anchor; // fallback: put it in the address bar
    }
  }

  return (
    <section ref={rootRef}>
      {heading ? <h2 className="text-lg font-bold text-zinc-900">{heading}</h2> : null}
      <div className="mt-2 divide-y divide-zinc-100 rounded-2xl border border-zinc-200">
        {items.map((it) => {
          const anchor = faqAnchor(it.q);
          return (
            <details key={anchor} id={anchor} className="group scroll-mt-24 px-4 py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-zinc-800 [&::-webkit-details-marker]:hidden">
                <span>{it.q}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Copy link to "${it.q}"`}
                    onClick={(e) => {
                      e.preventDefault();
                      copyLink(anchor, e.currentTarget);
                    }}
                    className="rounded px-1 text-zinc-300 hover:text-zinc-600"
                  >
                    ¶
                  </button>
                  <span aria-hidden="true" className="text-zinc-400 transition group-open:rotate-45">
                    +
                  </span>
                </span>
              </summary>
              {/* answers are allowlist-sanitized at save (lib/cms/store.js) */}
              <div className="rte mt-2 text-sm text-zinc-600" dangerouslySetInnerHTML={{ __html: it.a }} />
            </details>
          );
        })}
      </div>
    </section>
  );
}
