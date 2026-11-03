"use client";

import { useState } from "react";
import { useCart } from "@/components/cart/CartContext";
import { formatMoney } from "@/lib/format";

// Reorder with LIVE revalidation (S45 / SF12): the old order is rebuilt
// against today's catalog and every line says honestly whether it can come
// back as-is, changed price, or is gone — BEFORE anything hits the cart.
export default function ReorderPanel({ orderId }) {
  const { addItem, setOpen } = useCart();
  const [state, setState] = useState("idle"); // idle | loading | ready | adding | done | error
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  async function check() {
    setState("loading");
    setErr(null);
    const res = await fetch(`/api/account?view=reorder&order=${encodeURIComponent(orderId)}`);
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData(json);
      setState("ready");
    } else {
      setErr(json.error || "Couldn't check this order — please try again.");
      setState("error");
    }
  }

  async function addAll() {
    setState("adding");
    for (const l of data.lines) {
      if (l.state === "ok" || l.state === "price_changed") {
        // the server re-derives price/title from TODAY's catalog on add
        await addItem(l.variantId, l.quantity);
      }
    }
    setState("done");
    setOpen(true);
  }

  const CHIP = {
    ok: "bg-lime-100 text-lime-700",
    price_changed: "bg-amber-100 text-amber-700",
    unavailable: "bg-zinc-100 text-zinc-500",
    missing: "bg-zinc-100 text-zinc-500",
  };

  if (state === "idle" || state === "error") {
    return (
      <div>
        {err && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
        <button type="button" onClick={check} className="rounded-xl bg-accent-400 px-5 py-2.5 text-sm font-bold text-accent-label hover:bg-accent-300">
          Reorder these items
        </button>
      </div>
    );
  }
  if (state === "loading") return <p className="text-sm text-zinc-400">Checking today&rsquo;s prices and stock…</p>;

  return (
    <div className="rounded-2xl border border-zinc-200 p-4">
      <ul className="divide-y divide-zinc-100">
        {data.lines.map((l, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${CHIP[l.state]}`}>{l.state.replace("_", " ")}</span>
            <span className="min-w-0 flex-1 truncate">{l.title}</span>
            <span className="text-xs text-zinc-400">×{l.quantity}</span>
            {l.price_now != null && <span className="text-xs font-semibold">{formatMoney(l.price_now, data.currency)}</span>}
            {l.note && <span className="w-full text-xs text-zinc-400">{l.note}</span>}
          </li>
        ))}
      </ul>
      {state === "done" ? (
        <p className="mt-3 rounded-lg bg-lime-50 px-3 py-2 text-sm text-lime-700">Added ✓ — the cart shows today&rsquo;s prices.</p>
      ) : data.addable === 0 ? (
        <p className="mt-3 text-sm text-zinc-400">Nothing from this order is available right now.</p>
      ) : (
        <button type="button" disabled={state === "adding"} onClick={addAll} className="mt-3 rounded-xl bg-accent-400 px-5 py-2.5 text-sm font-bold text-accent-label hover:bg-accent-300 disabled:opacity-60">
          {state === "adding" ? "Adding…" : `Add ${data.addable} item${data.addable === 1 ? "" : "s"} at today's prices`}
        </button>
      )}
    </div>
  );
}
