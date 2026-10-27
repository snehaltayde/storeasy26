"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// S31 (BE10/MC16): authoritative refresh of refunds + fulfillment from
// Shopify. "Requested" vs confirmed outcome are distinct states on screen.
export default function ReconcileButton({ orderId }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function reconcile() {
    setBusy(true);
    setMsg("Requested…");
    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reconcile" }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok && !data.skipped) {
      setMsg(`Synced from Shopify: ${data.financial_status || "?"} / ${data.fulfillment_status || "?"}${data.refunds ? ` · ${data.refunds} refund(s)` : ""}`);
    } else {
      setMsg(data.skipped ? `Skipped: ${data.skipped}` : `Failed: ${data.error || res.status}`);
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={reconcile} disabled={busy} className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
        {busy ? "Reconciling…" : "Reconcile from Shopify"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </span>
  );
}
