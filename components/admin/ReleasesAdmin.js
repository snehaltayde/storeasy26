"use client";

import { useState } from "react";
import { localInputToIso } from "@/lib/admin/schedule";

// Releases console (S36 / MC13): what's live, whether drafts differ, publish
// now / schedule / preview draft / roll back. Validation errors surface
// BEFORE publish (the server re-gates anyway).
const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function ReleasesAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [note, setNote] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function call(body) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/releases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) {
      if (json.releases) setData(json);
      if (json.url) {
        window.open(json.url, "_blank", "noopener");
        setMsg({ ok: true, text: ["Preview opened in a new tab (valid 1 hour, this browser only)."] });
      } else {
        setMsg({ ok: true, text: [json.scheduled ? `Scheduled for ${when(json.scheduled.scheduledFor)}.` : "Published — live now.", ...(json.published?.warnings || json.scheduled?.warnings || [])] });
        setNote("");
        setAt("");
      }
    } else {
      setMsg({ ok: false, text: json.errors ? [json.error, ...json.errors] : [json.error || `Failed (${res.status})`] });
    }
    return json;
  }

  const v = data.validation || { ok: true, errors: [], warnings: [] };

  return (
    <div className="space-y-5">
      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>
          {msg.text.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold">Draft state</h2>
          {data.dirty ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">UNPUBLISHED CHANGES</span>
          ) : (
            <span className="rounded-full bg-lime-100 px-2 py-0.5 text-xs font-bold text-lime-700">IN SYNC WITH LIVE</span>
          )}
          {!data.live && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-500">NO RELEASE YET — DRAFTS SERVE DIRECTLY</span>}
        </div>
        {!v.ok && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-600">
            {v.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {v.warnings?.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-600">
            {v.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-48">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Release note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Diwali hero + navy brand" className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm" />
          </label>
          <button
            onClick={() => call({ action: "publish", note })}
            disabled={busy || !v.ok}
            className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-zinc-700 disabled:opacity-50"
          >
            {busy ? "Working…" : "Publish now"}
          </button>
          <button
            onClick={() => call({ action: "preview" })}
            disabled={busy}
            className="rounded-xl border border-zinc-200 px-5 py-2.5 text-sm font-semibold text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-40"
          >
            Preview draft
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">…or publish at (your local time)</span>
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="mt-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm" />
          </label>
          <button
            onClick={() => {
              const iso = localInputToIso(at);
              if (!iso) return setMsg({ ok: false, text: ["Pick a date and time first."] });
              call({ action: "schedule", note, at: iso });
            }}
            disabled={busy || !v.ok || !at}
            className="rounded-xl border border-zinc-300 px-5 py-2.5 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-40"
          >
            Schedule
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200">
        <h2 className="border-b border-zinc-100 px-5 py-3 text-sm font-bold">History</h2>
        <ul className="divide-y divide-zinc-100">
          {data.releases.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="font-mono text-xs text-zinc-400">{r.content_hash.slice(0, 12)}</span>
              <span className="min-w-0 flex-1 truncate">
                {r.note || <span className="text-zinc-400">no note</span>}
                {r.scheduled_for && !r.published_at && <span className="ml-2 text-xs text-amber-600">scheduled {when(r.scheduled_for)}</span>}
              </span>
              <span className="text-xs text-zinc-400">{when(r.created_at)}</span>
              {r.id === data.live ? (
                <span className="rounded-full bg-lime-100 px-2 py-0.5 text-xs font-bold text-lime-700">LIVE</span>
              ) : r.published_at ? (
                <button
                  onClick={() => confirm("Point the live storefront back at this release? Drafts are not affected.") && call({ action: "rollback", id: r.id })}
                  disabled={busy}
                  className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
                >
                  Roll back to this
                </button>
              ) : (
                <span className="text-xs text-zinc-400">{r.scheduled_for ? "pending" : "never live"}</span>
              )}
            </li>
          ))}
          {data.releases.length === 0 && <li className="px-5 py-6 text-sm text-zinc-500">Nothing published yet — the storefront serves your drafts directly until the first release.</li>}
        </ul>
      </section>
    </div>
  );
}
