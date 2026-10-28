"use client";

import { useState } from "react";

// Marketing lead form (S44 / MK08). Consent-aware: submitting = consent to a
// reply about this inquiry; marketing updates are a separate unchecked-by-
// default opt-in. Honest states, honeypot included.
const input = "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400";

export default function LeadForm() {
  const [f, setF] = useState({ name: "", email: "", storeUrl: "", message: "", marketingConsent: false, website: "" });
  const [state, setState] = useState("idle");
  const [errs, setErrs] = useState([]);

  async function submit(e) {
    e.preventDefault();
    setState("sending");
    setErrs([]);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, source: window.location.pathname }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setState("done");
      else {
        setState("error");
        setErrs(json.errors || [json.error || `Something went wrong (${res.status}).`]);
      }
    } catch {
      setState("error");
      setErrs(["Couldn't reach the server — please try again."]);
    }
  }

  if (state === "done") {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center" role="status">
        <p className="font-bold">Got it ✓</p>
        <p className="mt-1 text-sm text-zinc-500">We&rsquo;ll reply to {f.email} — usually within a working day.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-zinc-200 p-6">
      {errs.length > 0 && (
        <ul className="mb-4 space-y-1 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {errs.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold text-zinc-600">Your name</span>
          <input className={input} required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-zinc-600">Email</span>
          <input className={input} type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-zinc-600">Your Shopify store (optional)</span>
          <input className={input} placeholder="yourbrand.myshopify.com" value={f.storeUrl} onChange={(e) => setF({ ...f, storeUrl: e.target.value })} />
        </label>
        <div className="hidden" aria-hidden="true">
          <input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
        </div>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-zinc-600">What are you building?</span>
          <textarea className={input + " min-h-28"} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
        </label>
        <label className="flex items-start gap-2 text-xs text-zinc-500 sm:col-span-2">
          <input type="checkbox" className="mt-0.5" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} />
          Also send me occasional product updates (optional — we reply to your inquiry either way, and that&rsquo;s all submitting this form opts you into).
        </label>
      </div>
      <button type="submit" disabled={state === "sending"} className="mt-5 rounded-xl bg-zinc-900 px-6 py-3 text-sm font-bold text-white hover:bg-zinc-800 disabled:opacity-60">
        {state === "sending" ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
