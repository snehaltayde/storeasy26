"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Agency sign-in + member-invite acceptance (S48).
export default function PartnersLogin() {
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", token: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/partners/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(json.error || "Request failed");
      return null;
    }
    return json;
  }

  const input = "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";
  return (
    <div className="mx-auto max-w-sm px-4 py-20 sm:px-6">
      <h1 className="text-2xl font-extrabold tracking-tight">Partner console</h1>
      <p className="mt-1 text-sm text-zinc-500">For agencies managing client stores. Access exists only where a client granted it.</p>
      {err && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      {note && <p className="mt-4 rounded-lg bg-lime-50 px-3 py-2 text-sm text-lime-800">{note}</p>}

      {mode === "login" ? (
        <form
          className="mt-6"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post({ action: "login", email: form.email, password: form.password })) router.refresh();
          }}
        >
          <label className="block text-xs font-semibold text-zinc-600">
            Email
            <input type="email" required className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="mt-3 block text-xs font-semibold text-zinc-600">
            Password
            <input type="password" required className={input} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <button type="submit" disabled={busy} className="mt-5 w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-800 disabled:opacity-50">
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <button type="button" className="mt-3 w-full text-xs text-zinc-400 hover:text-zinc-600" onClick={() => setMode("invite")}>
            Have an invitation code?
          </button>
        </form>
      ) : (
        <form
          className="mt-6"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await post({ action: "accept_invite", token: form.token.trim(), name: form.name, password: form.password });
            if (r) {
              setNote(`Account ready for ${r.email} — sign in below.`);
              setMode("login");
              setForm({ ...form, email: r.email, password: "" });
            }
          }}
        >
          <label className="block text-xs font-semibold text-zinc-600">
            Invitation code
            <input required className={`${input} font-mono`} value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </label>
          <label className="mt-3 block text-xs font-semibold text-zinc-600">
            Your name
            <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="mt-3 block text-xs font-semibold text-zinc-600">
            Choose a password (10+ characters)
            <input type="password" required minLength={10} className={input} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <button type="submit" disabled={busy} className="mt-5 w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-zinc-800 disabled:opacity-50">
            Join your agency
          </button>
          <button type="button" className="mt-3 w-full text-xs text-zinc-400 hover:text-zinc-600" onClick={() => setMode("login")}>
            Back to sign-in
          </button>
        </form>
      )}
    </div>
  );
}
