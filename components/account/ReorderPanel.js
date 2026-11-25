"use client";

import { useState } from "react";
import { useCart } from "@/components/cart/CartContext";
import { formatMoney } from "@/lib/format";
import { useMoney } from "@/components/MarketContext";

// Reorder with LIVE revalidation (S45 / SF12): the old order is rebuilt
// against today's catalog and every line says honestly whether it can come
// back as-is, changed price, or is gone — BEFORE anything hits the cart.
export default function ReorderPanel({ orderId }) {
  const { money } = useMoney(); // Phase 8 line 4: today's catalog price, in the shopper's market
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
    ok: "bg-sf-success-soft text-sf-success",
    price_changed: "bg-sf-warning-soft text-sf-warning",
    unavailable: "bg-sf-surface-sunken text-sf-text-subtle",
    missing: "bg-sf-surface-sunken text-sf-text-subtle",
  };

  if (state === "idle" || state === "error") {
    return (
      <div>
        {err && <p className="mb-2 rounded-sf-small bg-sf-danger-surface px-3 py-2 text-sm text-sf-danger">{err}</p>}
        <button type="button" onClick={check} className="rounded-sf-control bg-sf-accent px-5 py-2.5 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover">
          Reorder these items
        </button>
      </div>
    );
  }
  if (state === "loading") return <p className="text-sm text-sf-text-faint">Checking today&rsquo;s prices and stock…</p>;

  return (
    <div className="rounded-sf-card border border-sf-border p-4">
      <ul className="divide-y divide-sf-border-soft">
        {data.lines.map((l, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <span className={`rounded-sf-2xs px-1.5 py-0.5 text-sf-3xs font-bold uppercase ${CHIP[l.state]}`}>{l.state.replace("_", " ")}</span>
            <span className="min-w-0 flex-1 truncate">{l.title}</span>
            <span className="text-xs text-sf-text-faint">×{l.quantity}</span>
            {l.price_now != null && <span className="text-xs font-semibold">{money(l.price_now, data.currency)}</span>}
            {l.note && <span className="w-full text-xs text-sf-text-faint">{l.note}</span>}
          </li>
        ))}
      </ul>
      {state === "done" ? (
        <p className="mt-3 rounded-sf-small bg-sf-success-surface px-3 py-2 text-sm text-sf-success">Added ✓ — the cart shows today&rsquo;s prices.</p>
      ) : data.addable === 0 ? (
        <p className="mt-3 text-sm text-sf-text-faint">Nothing from this order is available right now.</p>
      ) : (
        <button type="button" disabled={state === "adding"} onClick={addAll} className="mt-3 rounded-sf-control bg-sf-accent px-5 py-2.5 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover disabled:opacity-60">
          {state === "adding" ? "Adding…" : `Add ${data.addable} item${data.addable === 1 ? "" : "s"} at today's prices`}
        </button>
      )}
    </div>
  );
}
