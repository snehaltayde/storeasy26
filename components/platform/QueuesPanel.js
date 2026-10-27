"use client";

import { useEffect, useState, useCallback } from "react";

// Queue & webhook inspector (S29 / OP05): stats, non-done jobs and inbox rows
// (metadata only — payloads never leave the server), per-row replay, and a
// "run due now" button. Replays are audited server-side.
export default function QueuesPanel() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/platform/queues?limit=30");
    if (res.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function act(body, label) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/platform/queues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? `${label}: ok${j.ran !== undefined ? ` (ran ${j.ran}, failed ${j.failed})` : ""}` : `${label}: ${j.error || res.status}`);
    setBusy(false);
    refresh();
  }

  if (!data) return null;
  const { stats, jobs, inbox } = data;
  const interesting = (jobs || []).filter((j) => j.status !== "done");
  const inboxRows = (inbox || []).filter((r) => r.status !== "done" && r.status !== "ignored");

  const badge = (s) =>
    s === "dead"
      ? "bg-red-100 text-red-700"
      : s === "pending" || s === "leased"
        ? "bg-amber-100 text-amber-700"
        : "bg-zinc-100 text-zinc-600";

  return (
    <div className="mt-10 rounded-2xl border border-zinc-200 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold">Queues & webhooks</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            jobs: {stats.jobs.pending} pending · {stats.jobs.leased} leased · {stats.jobs.dead} dead
            {stats.jobs.oldest_pending_min ? ` · oldest ${stats.jobs.oldest_pending_min}m` : ""} — inbox:{" "}
            {stats.inbox.pending} pending · {stats.inbox.dead} dead
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => act({ action: "tick" }, "tick")}
            disabled={busy}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 font-semibold hover:bg-zinc-50 disabled:opacity-50"
          >
            Run due now
          </button>
          <button onClick={refresh} disabled={busy} className="rounded-lg border border-zinc-300 px-2.5 py-1 font-semibold hover:bg-zinc-50 disabled:opacity-50">
            Refresh
          </button>
        </div>
      </div>
      {msg && <p className="mt-2 text-xs text-zinc-500">{msg}</p>}

      {interesting.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-xs">
          {interesting.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-1.5">
              <span className="truncate">
                <span className={`mr-2 rounded px-1.5 py-0.5 font-semibold ${badge(j.status)}`}>{j.status}</span>
                <span className="font-mono">{j.type}</span>
                {j.tenant_id ? <span className="text-zinc-500"> · {j.tenant_id}</span> : null}
                <span className="text-zinc-400"> · try {j.attempts}/{j.max_attempts}</span>
                {j.last_error ? <span className="text-red-500"> · {String(j.last_error).slice(0, 80)}</span> : null}
              </span>
              {j.status === "dead" && (
                <button
                  onClick={() => act({ action: "replay", kind: "job", id: j.id }, `replay ${j.id}`)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-lime-300 px-2 py-0.5 font-semibold text-lime-700 hover:bg-lime-50 disabled:opacity-50"
                >
                  Replay
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {inboxRows.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-xs">
          {inboxRows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-50 px-3 py-1.5">
              <span className="truncate">
                <span className={`mr-2 rounded px-1.5 py-0.5 font-semibold ${badge(r.status)}`}>{r.status}</span>
                <span className="font-mono">{r.source}:{r.topic || "?"}</span>
                {r.tenant_id ? <span className="text-zinc-500"> · {r.tenant_id}</span> : null}
                {r.last_error ? <span className="text-red-500"> · {String(r.last_error).slice(0, 80)}</span> : null}
              </span>
              {r.status === "dead" && (
                <button
                  onClick={() => act({ action: "replay", kind: "inbox", id: r.id }, `replay ${r.id}`)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-lime-300 px-2 py-0.5 font-semibold text-lime-700 hover:bg-lime-50 disabled:opacity-50"
                >
                  Replay
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {interesting.length === 0 && inboxRows.length === 0 && (
        <p className="mt-3 text-xs text-zinc-400">Nothing pending or dead — the queue is drained.</p>
      )}
    </div>
  );
}
