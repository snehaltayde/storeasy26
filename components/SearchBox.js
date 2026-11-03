"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { formatMoney } from "@/lib/format";

// Header search (S38 / SF05): debounced suggestions with stale-response
// cancellation (AbortController), per-session recent searches (sessionStorage
// — a per-viewer convenience, never required for the box to work) and full
// keyboard navigation (↑/↓/Enter/Escape over the visible rows).

const RECENT_KEY = "storeasy_recent_searches";
const readRecent = () => {
  try {
    const v = JSON.parse(sessionStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
};
const pushRecent = (term) => {
  try {
    const next = [term, ...readRecent().filter((t) => t !== term)].slice(0, 6);
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
};

export default function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1); // keyboard cursor over visible rows
  const boxRef = useRef(null);
  const abortRef = useRef(null);

  // Debounced fetch against /api/search; stale in-flight requests are aborted.
  useEffect(() => {
    const term = q.trim();
    setActive(-1);
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        setResults(data.hits || []);
      } catch (e) {
        if (e.name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function go(term) {
    const t = term.trim();
    if (!t) return;
    setRecent(pushRecent(t));
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(t)}`);
  }

  function openProduct(hit) {
    setRecent(pushRecent(q.trim() || hit.title));
    setOpen(false);
    router.push(`/products/${hit.handle}`);
  }

  function submit(e) {
    e.preventDefault();
    go(q);
  }

  const term = q.trim();
  const showRecent = open && term.length < 2 && recent.length > 0;
  const showPanel = open && (term.length >= 2 || showRecent);
  // the keyboard-navigable rows currently on screen
  const rows = showRecent ? recent.map((t) => ({ type: "recent", term: t })) : results.map((r) => ({ type: "hit", hit: r }));

  function onKeyDown(e) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!showPanel || !rows.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? rows.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0 && rows[active]) {
      e.preventDefault();
      const row = rows[active];
      if (row.type === "recent") {
        setQ(row.term);
        go(row.term);
      } else openProduct(row.hit);
    }
  }

  const activeCls = (i) => (i === active ? "bg-sf-surface-sunken" : "hover:bg-sf-surface-muted");

  return (
    <div ref={boxRef} className="relative w-full">
      <form onSubmit={submit} className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sf-text-faint">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
        </span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setRecent(readRecent());
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          type="search"
          placeholder="Search products…"
          aria-label="Search products"
          aria-expanded={showPanel}
          role="combobox"
          aria-autocomplete="list"
          className="w-full rounded-full border border-sf-border bg-sf-surface-muted py-2.5 pl-11 pr-4 text-sm text-sf-text outline-none transition focus:border-sf-border-hover focus:bg-sf-surface"
        />
      </form>

      {showPanel && (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-sf-card border border-sf-border-soft bg-sf-surface shadow-xl">
          {showRecent ? (
            <>
              <p className="flex items-center justify-between px-4 pt-3 text-sf-2xs font-semibold uppercase tracking-wide text-sf-text-faint">
                Recent searches
                <button
                  type="button"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(RECENT_KEY);
                    } catch { /* blocked storage */ }
                    setRecent([]);
                  }}
                  className="font-medium normal-case tracking-normal text-sf-text-faint hover:text-sf-text-muted"
                >
                  Clear
                </button>
              </p>
              <ul className="py-1">
                {recent.map((t, i) => (
                  <li key={t}>
                    <button
                      type="button"
                      onClick={() => {
                        setQ(t);
                        go(t);
                      }}
                      className={`block w-full px-4 py-2 text-left text-sm text-sf-text-body ${activeCls(i)}`}
                    >
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : loading && results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sf-text-faint">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-sf-text-faint">
              No products match “{term}”.
            </p>
          ) : (
            <>
              <ul className="max-h-[60vh] divide-y divide-sf-surface-muted overflow-y-auto">
                {results.map((r, i) => (
                  <li key={r.handle}>
                    <Link
                      href={`/products/${r.handle}`}
                      onClick={() => {
                        setRecent(pushRecent(term));
                        setOpen(false);
                      }}
                      className={`flex items-center gap-3 px-3 py-2.5 ${activeCls(i)}`}
                    >
                      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                        {r.image ? (
                          <Image src={r.image} alt={r.title} fill sizes="48px" className="object-cover" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-sf-text">{r.title}</p>
                        {r.product_type ? (
                          <p className="truncate text-xs text-sf-text-faint">{r.product_type}</p>
                        ) : null}
                      </div>
                      {r.price != null && (
                        <span className="shrink-0 text-sm font-semibold text-sf-text">
                          {formatMoney(r.price, r.currency)}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
              <button
                onClick={submit}
                className="block w-full border-t border-sf-border-soft bg-sf-surface-muted px-4 py-2.5 text-center text-sm font-medium text-sf-accent-text hover:bg-sf-surface-sunken"
              >
                View all results for “{term}”
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
