"use client";

import { useEffect, useState } from "react";

// Incidents panel (S43 / OP12): open/update/resolve with INTERNAL notes kept
// apart from the PUBLIC message merchants see in their console banner.
const input = "rounded-lg border border-zinc-200 px-2 py-1.5 text-xs";

export default function IncidentsPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [f, setF] = useState({ title: "", tenant: "", publicMessage: "", internalNote: "" });
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/platform/incidents")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/platform/incidents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData(json);
      setF({ title: "", tenant: "", publicMessage: "", internalNote: "" });
    } else setErr(json.error || `failed (${res.status})`);
    setBusy(false);
  }

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Incidents</h2>
      <p className="mt-0.5 text-xs text-zinc-500">Public message shows in affected merchant consoles while open; internal notes never leave this page.</p>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <input className={input} placeholder="title (required)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input className={input} placeholder="tenant (blank = platform-wide)" value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} />
        <input className={input} placeholder="public message (merchants see this)" value={f.publicMessage} onChange={(e) => setF({ ...f, publicMessage: e.target.value })} />
        <div className="flex gap-2">
          <input className={input + " min-w-0 flex-1"} placeholder="internal note" value={f.internalNote} onChange={(e) => setF({ ...f, internalNote: e.target.value })} />
          <button
            type="button"
            disabled={busy || !f.title.trim()}
            onClick={() => post({ action: "open", title: f.title, tenant: f.tenant.trim() || null, publicMessage: f.publicMessage, internalNote: f.internalNote })}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            Open
          </button>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {data?.incidents?.map((i) => (
          <li key={i.id} className={`rounded-xl border p-3 text-sm ${i.status === "open" ? "border-amber-200 bg-amber-50/50" : "border-zinc-100 opacity-60"}`}>
            <p className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${i.status === "open" ? "bg-amber-100 text-amber-700" : "bg-zinc-100 text-zinc-500"}`}>{i.status}</span>
              <span className="font-semibold">{i.title}</span>
              <span className="text-xs text-zinc-400">{i.tenant_id || "platform-wide"} · {new Date(i.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              {i.status === "open" && (
                <button type="button" disabled={busy} onClick={() => post({ action: "resolve", id: i.id })} className="ml-auto rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50">
                  Resolve
                </button>
              )}
            </p>
            {i.public_message && <p className="mt-1 text-xs text-sky-700">public: {i.public_message}</p>}
            {i.internal_note && <p className="mt-0.5 text-xs text-zinc-500">internal: {i.internal_note}</p>}
          </li>
        ))}
        {data && data.incidents.length === 0 && <li className="py-2 text-sm text-zinc-400">No incidents recorded.</li>}
      </ul>
    </section>
  );
}
