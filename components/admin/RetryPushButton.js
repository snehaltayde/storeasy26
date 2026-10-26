"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RetryPushButton({ orderId }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  async function retry() {
    setBusy(true);
    setMsg("");
    const res = await fetch(`/api/admin/orders/${orderId}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setMsg(data.ok === false || !res.ok ? `Push failed: ${data.error || data.reason || res.status}` : "Pushed ✓");
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
