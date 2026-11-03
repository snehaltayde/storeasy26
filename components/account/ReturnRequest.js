"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Return request (S46 / SF21). Honest about money: approval authorizes the
// return — the refund itself arrives separately via the payment provider.
const CHIP = {
  requested: "bg-sf-warning-soft text-sf-warning",
  approved: "bg-sf-success-soft text-sf-success",
  completed: "bg-sf-success-soft text-sf-success",
  rejected: "bg-sf-surface-sunken text-sf-text-subtle",
};

export default function ReturnRequest({ orderId, existing, eligible, reasonIfNot }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (existing) {
    return (
      <div className="rounded-sf-card border border-sf-border p-4 text-sm">
        <p className="flex items-center gap-2">
          <span className={`rounded-sf-2xs px-1.5 py-0.5 text-sf-3xs font-bold uppercase ${CHIP[existing.status] || CHIP.requested}`}>{existing.status}</span>
          <span className="font-semibold">Return request</span>
          <span className="ml-auto text-xs text-sf-text-faint">{new Date(existing.created_at).toLocaleDateString("en-IN")}</span>
        </p>
        <p className="mt-1 text-sf-text-subtle">“{existing.reason}”</p>
        {existing.note && <p className="mt-1 text-sf-text-muted">Store reply: {existing.note}</p>}
        {existing.status === "approved" && (
          <p className="mt-2 text-xs text-sf-text-faint">
            Approved means we&rsquo;re taking it back — any refund arrives separately to your original payment
            method once processed.
          </p>
        )}
      </div>
    );
  }

  if (!eligible) {
    return <p className="text-xs text-sf-text-faint">Returns: {reasonIfNot}.</p>;
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
      <button type="button" onClick={() => setOpen(true)} className="rounded-sf-control border border-sf-border-strong px-4 py-2 text-sm font-semibold hover:bg-sf-surface-muted">
        Request a return
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="rounded-sf-card border border-sf-border p-4">
      {err && <p className="mb-2 rounded-sf-small bg-sf-danger-surface px-3 py-2 text-sm text-sf-danger">{err}</p>}
      <label className="block">
        <span className="text-xs font-semibold text-sf-text-muted">What went wrong?</span>
        <textarea required minLength={10} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 min-h-24 w-full rounded-sf-control border border-sf-border px-3 py-2 text-sm outline-none focus:border-sf-border-hover" />
      </label>
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy} className="rounded-sf-control bg-sf-inverse px-4 py-2 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover disabled:opacity-50">
          {busy ? "Submitting…" : "Submit request"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-sf-control border border-sf-border-strong px-4 py-2 text-sm font-semibold hover:bg-sf-surface-muted">
          Cancel
        </button>
      </div>
      <p className="mt-2 text-sf-2xs text-sf-text-faint">The store reviews each request and will reply here. Approval authorizes the return; refunds are processed separately.</p>
    </form>
  );
}
