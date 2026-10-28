"use client";

import { useState } from "react";

// AI insights console (S47 / MC19). Honest everywhere: unconfigured says
// so (no mock), the budget is visible, every proposal shows the facts it
// cites, and "apply" makes a DRAFT the Releases tab ships — the AI cannot
// publish, refund or touch prices.
const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";

export default function InsightsAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  async function refresh() {
    const r = await fetch("/api/admin/insights").then((r) => r.json()).catch(() => null);
    if (r?.ok) setData(r);
  }

  async function post(body) {
    setBusy(true);
    setErr(null);
    setNote(null);
    const res = await fetch("/api/admin/insights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return null;
    }
    return json;
  }

  const { configured, model, budget, insights } = data;
  const factById = (ins) => Object.fromEntries((ins.facts || []).map((f) => [f.id, f.text]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Insights</h1>
        <button type="button" className={btnDark} disabled={busy || !configured} onClick={async () => (await post({ generate: true })) && refresh()}>
          {busy ? "Thinking…" : "Generate insights"}
        </button>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Evidence-linked suggestions from this store&rsquo;s own numbers (catalog, sales, zero-result searches — never
        another store&rsquo;s, never shopper PII). The assistant proposes; <strong>you</strong> review, and anything applied is a
        draft until you publish a release. It cannot publish, refund or change prices.
      </p>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <span className={`rounded-lg px-3 py-2 ${configured ? "bg-lime-50 text-lime-800" : "bg-amber-50 text-amber-800"}`}>
          {configured ? `model: ${model}` : "Not configured — set ANTHROPIC_API_KEY. Nothing here is mocked."}
        </span>
        <span className="rounded-lg bg-zinc-100 px-3 py-2 text-zinc-600">
          {budget.metered ? `budget: ${budget.spent.toLocaleString("en-IN")} / ${budget.budget.toLocaleString("en-IN")} tokens this month` : `budget: ${budget.budget.toLocaleString("en-IN")} tokens (unmetered in legacy mode)`}
        </span>
      </div>

      {err && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      {note && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">{note}</p>}

      {insights.length === 0 && <p className="mt-6 text-sm text-zinc-400">No insights yet{configured ? " — generate the first batch." : "."}</p>}
      <ul className="mt-5 space-y-3">
        {insights.map((ins) => (
          <li key={ins.id} className={`rounded-2xl border p-4 ${ins.status === "dismissed" ? "border-zinc-100 opacity-60" : "border-zinc-200"}`}>
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>{new Date(ins.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
              <span>· {ins.model} · {ins.tokens_in + ins.tokens_out} tokens</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${ins.status === "applied" ? "bg-lime-100 text-lime-700" : ins.status === "dismissed" ? "bg-zinc-100 text-zinc-400" : "bg-sky-100 text-sky-700"}`}>{ins.status}</span>
              <span className="ml-auto">
                {ins.status !== "dismissed" ? (
                  <button type="button" className={btn} disabled={busy} onClick={async () => (await post({ dismiss: { id: ins.id } })) && refresh()}>
                    Dismiss
                  </button>
                ) : (
                  <button type="button" className={btn} disabled={busy} onClick={async () => (await post({ restore: { id: ins.id } })) && refresh()}>
                    Restore
                  </button>
                )}
              </span>
            </div>
            <ul className="mt-2 space-y-3">
              {ins.proposals.map((p, i) => (
                <li key={i} className="rounded-xl bg-zinc-50 p-3 text-sm">
                  <p className="font-semibold">{p.title}</p>
                  <p className="mt-0.5 text-zinc-600">{p.mechanism}</p>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-zinc-400">Evidence ({p.evidence.length})</summary>
                    <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
                      {p.evidence.map((e) => (
                        <li key={e}>· {factById(ins)[e] || e}</li>
                      ))}
                    </ul>
                  </details>
                  {p.draft && ins.status !== "dismissed" && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-xs text-zinc-400">draft → {p.component}</span>
                      <button
                        type="button"
                        className={btn}
                        disabled={busy}
                        onClick={async () => {
                          const r = await post({ apply: { id: ins.id, index: i } });
                          if (r) {
                            setNote(r.note);
                            await refresh();
                          }
                        }}
                      >
                        Apply as draft
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
