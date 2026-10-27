"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ResetForm({ token }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    const res = await fetch("/api/admin/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    if (res.ok) {
      setDone(true);
      setTimeout(() => router.push("/admin/login"), 1200);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error || `Reset failed (${res.status})`);
    setBusy(false);
  }

  if (done) {
    return (
      <div className="mx-auto max-w-sm px-4 py-24">
        <h1 className="text-xl font-bold">Password updated</h1>
        <p className="mt-2 text-sm text-zinc-500">
          All previous sessions are signed out. Taking you to the login…
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-24">
      <h1 className="text-xl font-bold">Choose a new password</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password (min 8 characters)"
          autoFocus
          autoComplete="new-password"
          className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm password"
          autoComplete="new-password"
          className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Updating…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}
