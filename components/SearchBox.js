"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { formatMoney } from "@/lib/format";

export default function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const abortRef = useRef(null);

  // Debounced fetch against /api/search (Typesense, or DB fallback).
  useEffect(() => {
    const term = q.trim();
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

  function submit(e) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(term)}`);
  }

  const showPanel = open && q.trim().length >= 2;

  return (
    <div ref={boxRef} className="relative w-full">
      <form onSubmit={submit} className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400">
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
          onFocus={() => setOpen(true)}
          type="search"
          placeholder="Search protein, creatine, shakers…"
          aria-label="Search products"
          className="w-full rounded-full border border-zinc-200 bg-zinc-50 py-2.5 pl-11 pr-4 text-sm text-zinc-900 outline-none transition focus:border-zinc-400 focus:bg-white"
        />
      </form>

      {showPanel && (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-zinc-100 bg-white shadow-xl">
          {loading && results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-zinc-400">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-zinc-400">
              No products match “{q.trim()}”.
            </p>
          ) : (
            <>
              <ul className="max-h-[60vh] divide-y divide-zinc-50 overflow-y-auto">
                {results.map((r) => (
                  <li key={r.handle}>
                    <Link
                      href={`/products/${r.handle}`}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-50"
                    >
                      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                        {r.image ? (
                          <Image src={r.image} alt={r.title} fill sizes="48px" className="object-cover" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900">{r.title}</p>
                        {r.product_type ? (
                          <p className="truncate text-xs text-zinc-400">{r.product_type}</p>
                        ) : null}
                      </div>
                      {r.price != null && (
                        <span className="shrink-0 text-sm font-semibold text-zinc-900">
                          {formatMoney(r.price, r.currency)}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
              <button
                onClick={submit}
                className="block w-full border-t border-zinc-100 bg-zinc-50 px-4 py-2.5 text-center text-sm font-medium text-lime-700 hover:bg-zinc-100"
              >
                View all results for “{q.trim()}”
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
