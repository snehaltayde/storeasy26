"use client";

import { useEffect, useState } from "react";

// Privacy ops (S43 / OP11): the fleet's privacy-request queue + manual
// execution of pending/manual redactions (audited). Unreachable tenants are
// listed as such, never silently skipped.
export default function PrivacyOpsPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/platform/privacy")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function redact(row) {
    if (!window.confirm(`Execute redaction for ${row.tenant} request ${row.id}? PII is scrubbed; money rows are retained. This cannot be undone.`)) return;
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/platform/privacy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "redact", tenant: row.tenant, requestId: row.id }) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) load();
    else setErr(json.error || `failed (${res.status})`);
    setBusy(false);
  }

  const open = data?.requests?.filter((r) => !r.unreachable && r.status !== "done") || [];
  if (data && open.length === 0 && !data.requests.some((r) => r.unreachable)) {
    return (
      <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Privacy ops</h2>
        <p className="mt-2 text-sm text-zinc-400">Queue clear — no open privacy requests across the fleet.</p>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Privacy ops</h2>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {!data && !err && <p className="mt-2 text-sm text-zinc-400">Loading…</p>}
      <ul className="mt-3 space-y-2">
        {data?.requests?.map((r, i) =>
          r.unreachable ? (
            <li key={i} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {r.tenant}: unreachable ({r.error}) — its queue is NOT included above
            </li>
          ) : (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-100 p-3 text-sm">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${r.status === "done" ? "bg-lime-100 text-lime-700" : "bg-amber-100 text-amber-700"}`}>{r.status}</span>
              <span className="font-medium">{r.tenant}</span>
              <span className="text-zinc-600">{String(r.kind || "").replace(/_/g, " ")}</span>
              <span className="text-xs text-zinc-400">{r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : ""}</span>
              {r.status !== "done" && (
                <button type="button" disabled={busy} onClick={() => redact(r)} className="ml-auto rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
                  Execute redaction
                </button>
              )}
              {r.notes && <span className="w-full text-xs text-zinc-400">{r.notes}</span>}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
