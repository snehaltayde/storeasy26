"use client";

import { useState } from "react";

// Contact form (S39 / SF15). Accessible: real labels, error list tied via
// aria-describedby, focus-visible states; honest states: idle → sending →
// received (or the server's validation errors). The hidden "website" field is
// a honeypot — bots fill it, shoppers never see it.
const input =
  "mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-zinc-400";

export default function ContactForm() {
  const [form, setForm] = useState({ name: "", email: "", message: "", website: "" });
  const [state, setState] = useState("idle"); // idle | sending | received | error
  const [errors, setErrors] = useState([]);

  async function submit(e) {
    e.preventDefault();
    setState("sending");
    setErrors([]);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setState("received");
      } else if (res.status === 429) {
        setState("error");
        setErrors(["Too many messages from this connection — please try again in a while."]);
      } else {
        setState("error");
        setErrors(json.errors || [json.error || "Something went wrong — please try again."]);
      }
    } catch {
      setState("error");
      setErrors(["Couldn't reach the server — check your connection and try again."]);
    }
  }

  if (state === "received") {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-center" role="status">
        <p className="font-semibold text-zinc-800">Message received ✓</p>
        <p className="mt-1 text-sm text-zinc-500">
          We&rsquo;ll reply to <span className="font-medium text-zinc-700">{form.email}</span>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-zinc-200 p-5 sm:p-6" aria-label="Contact form">
      <h2 className="text-lg font-bold text-zinc-900">Send us a message</h2>
      {errors.length > 0 && (
        <ul id="contact-errors" className="mt-3 space-y-1 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold text-zinc-600">Your name</span>
          <input className={input} required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-describedby={errors.length ? "contact-errors" : undefined} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-zinc-600">Email</span>
          <input className={input} type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-describedby={errors.length ? "contact-errors" : undefined} />
        </label>
        {/* honeypot — hidden from people, present for bots */}
        <div className="hidden" aria-hidden="true">
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </label>
        </div>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-zinc-600">Message</span>
          <textarea className={input + " min-h-32"} required minLength={10} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} aria-describedby={errors.length ? "contact-errors" : undefined} />
        </label>
      </div>
      <button
        type="submit"
        disabled={state === "sending"}
        className="mt-4 rounded-xl bg-accent-400 px-6 py-3 text-sm font-bold text-accent-label transition enabled:hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
