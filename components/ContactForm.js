"use client";

import { useState } from "react";

// Contact form (S39 / SF15). Accessible: real labels, error list tied via
// aria-describedby, focus-visible states; honest states: idle → sending →
// received (or the server's validation errors). The hidden "website" field is
// a honeypot — bots fill it, shoppers never see it.
const input =
  "mt-1 w-full rounded-sf-control border border-sf-border bg-sf-surface px-3 py-2.5 text-sm text-sf-text outline-none transition focus:border-sf-border-hover";

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
      <div className="rounded-sf-card border border-sf-border bg-sf-surface-muted p-6 text-center" role="status">
        <p className="font-semibold text-sf-text-soft">Message received ✓</p>
        <p className="mt-1 text-sm text-sf-text-subtle">
          We&rsquo;ll reply to <span className="font-medium text-sf-text-body">{form.email}</span>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-sf-card border border-sf-border p-5 sm:p-6" aria-label="Contact form">
      <h2 className="text-lg font-bold text-sf-text">Send us a message</h2>
      {errors.length > 0 && (
        <ul id="contact-errors" className="mt-3 space-y-1 rounded-sf-control bg-sf-danger-surface px-4 py-3 text-sm text-sf-danger" role="alert">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">Your name</span>
          <input className={input} required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-describedby={errors.length ? "contact-errors" : undefined} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">Email</span>
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
          <span className="text-xs font-semibold text-sf-text-muted">Message</span>
          <textarea className={input + " min-h-32"} required minLength={10} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} aria-describedby={errors.length ? "contact-errors" : undefined} />
        </label>
      </div>
      <button
        type="submit"
        disabled={state === "sending"}
        className="mt-4 rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent transition enabled:hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
