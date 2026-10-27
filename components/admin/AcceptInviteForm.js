"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AcceptInviteForm({ token, storeName }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    const res = await fetch("/api/admin/accept-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    });
    if (res.ok) {
      router.push("/admin/offers");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error || `Could not accept the invitation (${res.status})`);
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-24">
      <h1 className="text-xl font-bold">Join {storeName}</h1>
      <p className="mt-1 text-sm text-zinc-500">Set up your console account to accept the invitation.</p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          className="w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm outline-none focus:border-zinc-400"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min 8 characters)"
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
          {busy ? "Creating account…" : "Accept invitation"}
        </button>
      </form>
    </div>
  );
}
