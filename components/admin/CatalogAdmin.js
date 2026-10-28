"use client";

import { useEffect, useRef, useState } from "react";

// Catalog browser (S39 / MC05 + MC06). Shopify-owned values are READ-ONLY
// here, labeled and linked to Shopify admin; what the console edits is
// per-tenant PRESENTATION: per-product PDP modules + badge, and per-
// collection pinned ordering. Overrides whose product vanished from the
// catalog are flagged ORPHANED (deleted-product guard), never hidden.

const input =
  "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";

export default function CatalogAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null); // {product, override}
  const [colHandle, setColHandle] = useState("");
  const [colPins, setColPins] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const res = await fetch(`/api/admin/catalog?q=${encodeURIComponent(q)}`);
      const json = await res.json().catch(() => ({}));
      if (json.ok) setData(json);
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [q]);

  async function openProduct(gid) {
    setBusy(true);
    const res = await fetch(`/api/admin/catalog?product=${encodeURIComponent(gid)}`);
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (json.ok) setEditing({ product: json.product, modules: json.override.modules || [], badge: json.override.badge || "" });
  }

  async function post(body, okText) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setMsg({ ok: true, text: okText });
      const r = await fetch(`/api/admin/catalog?q=${encodeURIComponent(q)}`).then((x) => x.json()).catch(() => ({}));
      if (r.ok) setData(r);
    } else {
      setMsg({ ok: false, text: (json.errors || [json.error || `Save failed (${res.status})`]).join(" · ") });
    }
    setBusy(false);
    return res.ok && json.ok;
  }

  const mod = (i, patch) => setEditing((e) => ({ ...e, modules: e.modules.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  return (
    <div className="space-y-5">
      {msg && <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>{msg.text}</div>}

      {editing ? (
        <section className="rounded-2xl border border-lime-300 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold">{editing.product.title}</h2>
              <p className="mt-0.5 font-mono text-xs text-zinc-400">/products/{editing.product.handle}</p>
            </div>
            {editing.product.shopify_url && (
              <a href={editing.product.shopify_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs font-medium text-lime-700 hover:underline">
                Open in Shopify admin ↗
              </a>
            )}
          </div>

          {/* Shopify-owned values: labeled, read-only */}
          <div className="mt-4 rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600">
            <p className="mb-1 font-semibold text-zinc-500">Shopify owns these — edit them in Shopify admin; they sync here.</p>
            <p>
              Type: {editing.product.product_type || "—"} · Vendor: {editing.product.vendor || "—"} · Price: {editing.product.price_min}
              {editing.product.price_max !== editing.product.price_min ? `–${editing.product.price_max}` : ""} {editing.product.currency} ·{" "}
              {editing.product.available ? "In stock" : "Sold out"}
            </p>
          </div>

          <div className="mt-4">
            <label className="block">
              <span className="text-xs font-semibold text-zinc-600">Badge</span>
              <input className={input + " max-w-xs"} placeholder='e.g. "Lab tested" (blank = none)' value={editing.badge} onChange={(e) => setEditing({ ...editing, badge: e.target.value })} />
            </label>
          </div>

          <p className="mt-4 text-xs font-semibold text-zinc-600">Product-page modules (ingredients, usage, specs — accordions on this PDP)</p>
          {editing.modules.map((m, i) => (
            <div key={i} className="mt-2 rounded-xl border border-zinc-100 p-3">
              <div className="flex items-center gap-2">
                <input className={input + " mt-0"} placeholder="Module title (e.g. Ingredients)" value={m.title} onChange={(e) => mod(i, { title: e.target.value })} />
                <button type="button" onClick={() => setEditing((e) => ({ ...e, modules: e.modules.filter((_, j) => j !== i) }))} className="text-zinc-400 hover:text-red-600">
                  ✕
                </button>
              </div>
              <textarea className={input + " min-h-20 font-mono text-xs"} placeholder="<p>HTML — sanitized on save</p>" value={m.html} onChange={(e) => mod(i, { html: e.target.value })} />
            </div>
          ))}
          <button type="button" onClick={() => setEditing((e) => ({ ...e, modules: [...e.modules, { title: "", html: "" }] }))} className="mt-2 text-sm font-medium text-lime-700 hover:underline">
            + Add module
          </button>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = await post({ product: { handle: editing.product.handle, modules: editing.modules, badge: editing.badge } }, "Saved — live on the product page now.");
                if (ok) setEditing(null);
              }}
              className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300 disabled:opacity-50"
            >
              Save presentation
            </button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="rounded-2xl border border-zinc-200 p-5">
            <h2 className="text-sm font-bold">Products</h2>
            <input className={input + " mt-3"} type="search" placeholder="Search by title, handle or type…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search catalog" />
            <ul className="mt-3 divide-y divide-zinc-100">
              {data.products.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{p.title}</span>
                    <span className="ml-2 font-mono text-xs text-zinc-400">{p.handle}</span>
                    {!p.available && <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">SOLD OUT</span>}
                    {p.customized && <span className="ml-2 rounded bg-lime-100 px-1.5 py-0.5 text-[10px] font-bold text-lime-700">CUSTOMIZED</span>}
                  </span>
                  <button type="button" disabled={busy} onClick={() => openProduct(p.id)} className="font-medium text-lime-700 hover:underline">
                    Presentation
                  </button>
                </li>
              ))}
              {data.products.length === 0 && <li className="py-6 text-center text-sm text-zinc-400">No products match.</li>}
            </ul>
          </section>

          {data.overrides.some((o) => o.orphaned) && (
            <section className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-800">
              <h2 className="font-bold">Orphaned overrides</h2>
              <p className="mt-1 text-xs">These products were deleted from the catalog; their presentation rows do nothing. Remove them or restore the product in Shopify.</p>
              <ul className="mt-2 space-y-1">
                {data.overrides.filter((o) => o.orphaned).map((o) => (
                  <li key={o.product_id} className="font-mono text-xs">{o.product_id}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-2xl border border-zinc-200 p-5">
            <h2 className="text-sm font-bold">Collection merchandising</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Pin products to the top of a collection&rsquo;s default (&ldquo;Featured&rdquo;) order — everything else keeps Shopify&rsquo;s order. Pins must belong to the collection.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold text-zinc-600">Collection handle</span>
                <input className={input} list="catalog-collections" value={colHandle} onChange={(e) => setColHandle(e.target.value)} placeholder="protein" />
                <datalist id="catalog-collections">
                  {data.collections.map((c) => (
                    <option key={c.handle} value={c.handle}>
                      {c.title}
                      {c.pinned ? ` (${c.pinned} pinned)` : ""}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-zinc-600">Pinned product handles</span>
                <textarea className={input + " min-h-20 font-mono text-xs"} value={colPins} onChange={(e) => setColPins(e.target.value)} placeholder={"whey-gold-1kg\ncreatine-250g"} />
                <span className="mt-0.5 block text-[11px] text-zinc-400">one per line, in display order · empty = back to Shopify&rsquo;s order</span>
              </label>
            </div>
            <button
              type="button"
              disabled={busy || !colHandle.trim()}
              onClick={() => post({ collection: { handle: colHandle.trim(), pinnedHandles: colPins.split("\n").map((s) => s.trim()).filter(Boolean) } }, "Pinned order saved — live on the collection page now.")}
              className="mt-3 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              Save pinned order
            </button>
          </section>
        </>
      )}
    </div>
  );
}
