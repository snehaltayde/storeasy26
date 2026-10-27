"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// S26 (MC01): individual email+password sign-in. Leaving email empty falls
// back to the store's bootstrap/legacy shared password — the server only
// accepts that while the tenant has no member users (or in legacy mode).
export default function LoginForm({ storeName }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(email ? { email, password } : { password }),
    });
    if (res.ok) {
      router.push("/admin/offers");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error || `Login failed (${res.status})`);
    setBusy(false);
  }

  async function forgot() {
    if (!email) {
      setError("Enter your email first, then tap “Forgot password?”");
      return;
    }
    setError("");
    setBusy(true);
    const res = await fetch("/api/admin/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    setNotice(data.message || data.error || "If that account exists, a reset link is on its way.");
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-24">
      <h1 className="text-xl font-bold">{storeName} admin</h1>
      <p className="mt-1 text-sm text-zinc-500">Store console — offers, orders, settings.</p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-zinc-600">{notice}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <button type="button" onClick={forgot} disabled={busy} className="underline hover:text-zinc-600">
            Forgot password?
          </button>
          <span>No email yet? Leave it empty to use the setup password.</span>
        </div>
      </form>
    </div>
  );
}
