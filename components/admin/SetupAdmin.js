"use client";

import { useState } from "react";
import Link from "next/link";

// Onboarding checklist (S41 / MC02). Auto items derive from real state and
// just link where the work happens; manual items (preview, test order,
// launch) are explicit check-offs — launch stays gated until everything
// above it is done (server-enforced too).
export default function SetupAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  if (!data.supported) {
    return <p className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500">{data.reason}</p>;
  }

  async function mark(step, done) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, done }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData(json);
      if (step === "launch" && done) setMsg({ ok: true, text: "🎉 Launched — congratulations! Publish releases any time; this checklist stays here for reference." });
    } else {
      setMsg({ ok: false, text: json.error || `Failed (${res.status})` });
    }
    setBusy(false);
  }

  const pct = Math.round((data.doneCount / data.total) * 100);

  return (
    <div className="space-y-4">
      {msg && <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>{msg.text}</div>}

      <div className="rounded-2xl border border-zinc-200 p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-bold">{data.launched ? "Launched ✓" : "Getting your store live"}</span>
          <span className="text-zinc-400">
            {data.doneCount}/{data.total}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
          <div className="h-full bg-lime-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="space-y-2">
        {data.items.map((item, i) => (
          <li key={item.id} className={`flex items-start gap-3 rounded-2xl border p-4 ${item.done ? "border-zinc-100 bg-zinc-50/50" : item.gated ? "border-zinc-100 opacity-60" : "border-zinc-200"}`}>
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${item.done ? "bg-lime-400 text-zinc-950" : "bg-zinc-100 text-zinc-400"}`}
            >
              {item.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold ${item.done ? "text-zinc-500" : "text-zinc-900"}`}>
                {item.label}
                {item.kind === "manual" && <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-400">YOU CONFIRM</span>}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">{item.hint}</p>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              {!item.done && !item.gated && (
                <Link href={item.href} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50">
                  Open
                </Link>
              )}
              {item.kind === "manual" &&
                (item.done ? (
                  item.id !== "launch" && (
                    <button type="button" disabled={busy} onClick={() => mark(item.id, false)} className="text-xs text-zinc-400 hover:text-zinc-600">
                      undo
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={busy || item.gated}
                    onClick={() => mark(item.id, true)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold ${item.id === "launch" ? "bg-lime-400 text-zinc-950 hover:bg-lime-300" : "bg-zinc-900 text-white hover:bg-zinc-800"} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {item.id === "launch" ? "Launch 🚀" : "Mark done"}
                  </button>
                ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
