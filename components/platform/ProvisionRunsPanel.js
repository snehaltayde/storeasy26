"use client";

import { useEffect, useState } from "react";

// Provisioning runs panel (S41 / OP04): per-step state, safe resume of
// failed runs (steps are idempotent — no duplicate resources), conservative
// compensation. Done runs are history, not buttons.
const STEP_CHIP = {
  done: "bg-lime-100 text-lime-700",
  failed: "bg-red-100 text-red-600",
  running: "bg-amber-100 text-amber-700",
  pending: "bg-zinc-100 text-zinc-400",
  compensated: "bg-purple-100 text-purple-700",
  skipped: "bg-zinc-100 text-zinc-400",
};

export default function ProvisionRunsPanel() {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState(null); // {run, password}

  const load = () =>
    fetch("/api/platform/provisions")
      .then((r) => r.json())
      .then((j) => (j.ok ? setRuns(j.runs) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function act(action, run) {
    if (action === "compensate" && !window.confirm(`Roll back run ${run.id}? Deregisters what it created (the database is never deleted).`)) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/platform/provisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, run: run.id }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      if (json.generated?.admin_password) setGenerated({ run: run.id, password: json.generated.admin_password });
      load();
    } else setErr(json.error || `failed (${res.status})`);
    setBusy(false);
  }

  if (runs !== null && runs.length === 0) return null; // nothing to show yet

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Provisioning runs</h2>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {generated && (
        <p className="mt-2 rounded-lg bg-lime-50 px-3 py-2 text-sm text-lime-800">
          Run {generated.run} finished — console password: <code className="rounded bg-white px-1.5 font-mono">{generated.password}</code> (shown once).
        </p>
      )}
      {!runs && !err && <p className="mt-2 text-sm text-zinc-400">Loading…</p>}
      <ul className="mt-3 space-y-2">
        {runs?.map((r) => (
          <li key={r.id} className="rounded-xl border border-zinc-100 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-bold">{r.tenant_id}</span>
              <span className="font-mono text-xs text-zinc-400">{r.id}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${STEP_CHIP[r.status] || STEP_CHIP.pending}`}>{r.status}</span>
              <span className="ml-auto text-xs text-zinc-400">{new Date(r.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.steps.map((s) => (
                <span key={s.name} title={s.detail || ""} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STEP_CHIP[s.status] || STEP_CHIP.pending}`}>
                  {s.name} {s.status === "done" ? "✓" : s.status === "failed" ? "✗" : ""}
                </span>
              ))}
            </div>
            {r.error && <p className="mt-1.5 text-xs text-red-500">{r.error}</p>}
            {r.status === "failed" && (
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} onClick={() => act("resume", r)} className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
                  Resume
                </button>
                <button type="button" disabled={busy} onClick={() => act("compensate", r)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">
                  Roll back
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-zinc-400">Resume re-runs only unfinished steps against real state (no duplicate resources). Roll-back deregisters what a failed run created — databases are never deleted automatically.</p>
    </section>
  );
}
