"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { pushResultMessage } from "@/lib/admin/order-view";

// S31 (MC16): says what actually happened — push REFUSALS arrive as HTTP 200
// with reason keys (skipped/inFlight/mismatch/dead), which used to render as
// the nonsense "Push failed: 200".
export default function RetryPushButton({ orderId }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function retry() {
    setBusy(true);
    setMsg("Requested…");
    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "push" }),
    });
    const data = await res.json().catch(() => ({}));
    setMsg(pushResultMessage(data, res.status));
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={retry} disabled={busy} className="rounded-lg border border-zinc-300 px-3 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
        {busy ? "Pushing…" : "Retry Shopify push"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </span>
  );
}
