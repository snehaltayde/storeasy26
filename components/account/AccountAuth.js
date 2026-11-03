"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Passwordless sign-in (S45 / SF10): email → 6-digit code from your inbox.
// Honest states; the server never says whether an account exists.
const input = "mt-1 w-full rounded-sf-control border border-sf-border bg-sf-surface px-3 py-2.5 text-sm outline-none focus:border-sf-border-hover";

export default function AccountAuth({ returnTo = "/account" }) {
  const router = useRouter();
  const [step, setStep] = useState("email"); // email | code
  const [f, setF] = useState({ email: "", code: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [claimed, setClaimed] = useState(0);

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !json.ok) {
      setErr(res.status === 429 ? "Too many attempts — give it a few minutes." : json.error || "Something went wrong.");
      return null;
    }
    return json;
  }

  async function sendCode(e) {
    e.preventDefault();
    const r = await post({ action: "request_otp", email: f.email, website: f.website });
    if (r) setStep("code");
  }

  async function verify(e) {
    e.preventDefault();
    const r = await post({ action: "verify", email: f.email, code: f.code });
    if (r) {
      setClaimed(r.claimedOrders || 0);
      router.push(returnTo);
      router.refresh();
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-extrabold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-sf-text-subtle">
        No passwords — we email you a 6-digit code. Your past orders with this email join your account
        automatically once it&rsquo;s verified.
      </p>
      {err && (
        <p className="mt-4 rounded-sf-control bg-sf-danger-surface px-4 py-3 text-sm text-sf-danger" role="alert">
          {err}
        </p>
      )}
      {step === "email" ? (
        <form onSubmit={sendCode} className="mt-5">
          <label className="block">
            <span className="text-xs font-semibold text-sf-text-muted">Email</span>
            <input className={input} type="email" required autoComplete="email" autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <div className="hidden" aria-hidden="true">
            <input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
          </div>
          <button type="submit" disabled={busy} className="mt-4 w-full rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover disabled:opacity-60">
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-5">
          <p className="text-sm text-sf-text-muted">
            Code sent to <span className="font-semibold">{f.email}</span>. {claimed > 0 && ""}
          </p>
          <label className="mt-3 block">
            <span className="text-xs font-semibold text-sf-text-muted">6-digit code</span>
            <input
              className={input + " text-center font-mono text-lg tracking-[0.4em]"}
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, "") })}
            />
          </label>
          <button type="submit" disabled={busy || f.code.length !== 6} className="mt-4 w-full rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover disabled:opacity-60">
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" onClick={() => setStep("email")} className="mt-3 w-full text-center text-xs text-sf-text-faint hover:text-sf-text-muted">
            Different email / resend
          </button>
        </form>
      )}
    </div>
  );
}
