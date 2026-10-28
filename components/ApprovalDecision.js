"use client";

import { useState } from "react";

// Approve/reject form for the client review link (S48 / AG04).
export default function ApprovalDecision({ token }) {
  const [approver, setApprover] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);

  async function decide(decision) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, decision, approver, comment }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) setDone(json.status);
    else setErr(json.error || "Couldn't record the decision — try again.");
  }

  if (done) {
    return (
      <p className={`rounded-xl px-4 py-3 text-sm ${done === "approved" ? "bg-lime-50 text-lime-800" : "bg-zinc-100 text-zinc-600"}`}>
        Recorded: <strong>{done}</strong>. Your agency can see this — publishing still happens through the store&rsquo;s
        own release workflow.
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-zinc-200 p-4">
      {err && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      <label className="block text-xs font-semibold text-zinc-600">
        Your name (recorded with the decision)
        <input className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400" value={approver} onChange={(e) => setApprover(e.target.value)} />
      </label>
      <label className="mt-3 block text-xs font-semibold text-zinc-600">
        Comment (optional)
        <textarea className="mt-1 min-h-20 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400" value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy || approver.trim().length < 2} onClick={() => decide("approved")} className="rounded-xl bg-lime-500 px-5 py-2.5 text-sm font-bold text-zinc-950 hover:bg-lime-400 disabled:opacity-50">
          Approve
        </button>
        <button type="button" disabled={busy || approver.trim().length < 2} onClick={() => decide("rejected")} className="rounded-xl border border-zinc-300 px-5 py-2.5 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">
          Request changes
        </button>
      </div>
    </div>
  );
}
