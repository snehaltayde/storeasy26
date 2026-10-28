"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { formatMoney } from "@/lib/format";

// Quiz runner (S46 / SF19): steps through the questions client-side, sends
// the answers once for a DETERMINISTIC result. Contact capture at the end is
// optional and explicitly consented — skipping it loses nothing.
export default function QuizRunner({ quiz }) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [state, setState] = useState("quiz"); // quiz | loading | results
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [lead, setLead] = useState({ email: "", consent: false, sent: false, busy: false });

  const q = quiz.questions[idx];

  async function choose(optionId) {
    const next = { ...answers, [q.id]: optionId };
    setAnswers(next);
    if (idx + 1 < quiz.questions.length) {
      setIdx(idx + 1);
      return;
    }
    setState("loading");
    const res = await fetch(`/api/quiz/${quiz.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: next }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setResult(json);
      setState("results");
    } else {
      setErr(json.error || "Something went wrong — try again.");
      setState("quiz");
    }
  }

  async function sendLead(e) {
    e.preventDefault();
    setLead((l) => ({ ...l, busy: true }));
    const res = await fetch(`/api/quiz/${quiz.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, email: lead.email, consent: true }),
    });
    const json = await res.json().catch(() => ({}));
    setLead((l) => ({ ...l, busy: false, sent: res.ok && json.ok }));
  }

  if (state === "results" && result) {
    return (
      <div>
        <h2 className="text-2xl font-extrabold tracking-tight">Your picks</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Matched on: {result.topTags.join(", ") || "your answers"} — same answers, same picks, every time.
        </p>
        {result.products.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500">
            Nothing in the catalog matches those answers right now —{" "}
            <Link href="/collections" className="font-medium text-accent-700 underline">browse everything</Link> instead.
          </p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-4">
            {result.products.map((p) => (
              <Link key={p.handle} href={`/products/${p.handle}`} className="group overflow-hidden rounded-2xl border border-zinc-200 transition hover:border-zinc-400">
                <div className="relative aspect-square bg-zinc-100">
                  {p.image && <Image src={p.image} alt={p.title} fill sizes="(max-width: 640px) 50vw, 300px" className="object-cover" />}
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-semibold group-hover:underline">{p.title}</p>
                  <p className="text-sm text-zinc-500">{formatMoney(p.price, p.currency)}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
        <div className="mt-8 rounded-2xl border border-zinc-200 p-5">
          {lead.sent ? (
            <p className="text-sm text-lime-700">Sent ✓ — check your inbox.</p>
          ) : (
            <form onSubmit={sendLead}>
              <p className="text-sm font-semibold">Want these picks in your inbox? (optional)</p>
              <div className="mt-2 flex gap-2">
                <input
                  type="email"
                  required
                  value={lead.email}
                  onChange={(e) => setLead((l) => ({ ...l, email: e.target.value }))}
                  placeholder="you@example.com"
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                />
                <button type="submit" disabled={lead.busy} className="shrink-0 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
                  {lead.busy ? "…" : "Send"}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-zinc-400">
                One email with these picks — that&rsquo;s the whole deal. No list, no follow-ups.
              </p>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {err && <p className="mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{err}</p>}
      <p className="text-xs font-semibold text-zinc-400">
        {idx + 1} / {quiz.questions.length}
      </p>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
        <div className="h-full bg-accent-400 transition-all" style={{ width: `${Math.round((idx / quiz.questions.length) * 100)}%` }} />
      </div>
      <h2 className="mt-5 text-xl font-bold">{state === "loading" ? "Matching…" : q.prompt}</h2>
      {state !== "loading" && (
        <div className="mt-4 space-y-2">
          {q.options.map((o) => (
            <button key={o.id} type="button" onClick={() => choose(o.id)} className="block w-full rounded-xl border border-zinc-200 px-4 py-3 text-left text-sm font-medium transition hover:border-zinc-900">
              {o.label}
            </button>
          ))}
        </div>
      )}
      {idx > 0 && state !== "loading" && (
        <button type="button" onClick={() => setIdx(idx - 1)} className="mt-4 text-xs text-zinc-400 hover:text-zinc-600">
          ← Back
        </button>
      )}
    </div>
  );
}
