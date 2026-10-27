"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// S26 (OP01): operator email+password with MANDATORY TOTP. First sign-in
// returns the enrollment secret once; the first valid code confirms it.
// Leaving email empty uses the legacy platform password — accepted only while
// no operator user exists (bootstrap).
export default function PlatformLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [enroll, setEnroll] = useState(null); // { secret, otpauth }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = email ? { email, password, ...(totp ? { totp } : {}) } : { password };
    const res = await fetch("/api/platform/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.enroll) {
      setEnroll({ secret: data.secret, otpauth: data.otpauth });
      setBusy(false);
      return;
    }
    if (res.ok) {
      router.refresh();
      return;
    }
    setError(data.error || `Login failed (${res.status})`);
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-24">
      <h1 className="text-xl font-bold">Storeasy platform</h1>
      <p className="mt-1 text-sm text-zinc-500">Operator console — tenants, onboarding, health.</p>
      {enroll && (
        <div className="mt-6 rounded-xl border border-lime-300 bg-lime-50 p-4 text-sm">
          <p className="font-semibold">Set up your authenticator</p>
          <p className="mt-1 text-zinc-600">
            Add this secret to your authenticator app (shown once), then enter the current 6-digit code
            below and sign in again:
          </p>
          <code className="mt-2 block break-all rounded bg-white px-2 py-1 font-mono text-xs">{enroll.secret}</code>
          <p className="mt-2 break-all text-xs text-zinc-500">{enroll.otpauth}</p>
        </div>
      )}
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Operator email"
          autoFocus
          autoComplete="username"
          className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
        />
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="Authenticator code (6 digits)"
          autoComplete="one-time-code"
          className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-zinc-400">
          First platform setup? Leave email empty to use the bootstrap operator password.
        </p>
      </form>
    </div>
  );
}
