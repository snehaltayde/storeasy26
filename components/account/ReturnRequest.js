"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Return request (S46 / SF21). Honest about money: approval authorizes the
// return — the refund itself arrives separately via the payment provider.
const CHIP = {
  requested: "bg-amber-100 text-amber-700",
  approved: "bg-lime-100 text-lime-700",
  completed: "bg-lime-100 text-lime-700",
  rejected: "bg-zinc-100 text-zinc-500",
};

export default function ReturnRequest({ orderId, existing, eligible, reasonIfNot }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (existing) {
    return (
      <div className="rounded-2xl border border-zinc-200 p-4 text-sm">
        <p className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${CHIP[existing.status] || CHIP.requested}`}>{existing.status}</span>
          <span className="font-semibold">Return request</span>
          <span className="ml-auto text-xs text-zinc-400">{new Date(existing.created_at).toLocaleDateString("en-IN")}</span>
        </p>
        <p className="mt-1 text-zinc-500">“{existing.reason}”</p>
        {existing.note && <p className="mt-1 text-zinc-600">Store reply: {existing.note}</p>}
        {existing.status === "approved" && (
          <p className="mt-2 text-xs text-zinc-400">
            Approved means we&rsquo;re taking it back — any refund arrives separately to your original payment
            method once processed.
          </p>
        )}
      </div>
    );
  }

  if (!eligible) {
    return <p className="text-xs text-zinc-400">Returns: {reasonIfNot}.</p>;
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request_return", orderId, reason }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) router.refresh();
    else setErr(json.error || "Couldn't submit — try again.");
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
        Request a return
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="rounded-2xl border border-zinc-200 p-4">
      {err && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      <label className="block">
        <span className="text-xs font-semibold text-zinc-600">What went wrong?</span>
        <textarea required minLength={10} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 min-h-24 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400" />
      </label>
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy} className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
          {busy ? "Submitting…" : "Submit request"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
          Cancel
        </button>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">We review requests within a working day. Approval authorizes the return; refunds are processed separately.</p>
    </form>
  );
}
