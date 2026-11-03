"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Profile + default address (S45 / SF11), plus sign-out.
const input = "mt-1 w-full rounded-sf-control border border-sf-border px-3 py-2 text-sm outline-none focus:border-sf-border-hover";

export default function ProfileForm({ customer }) {
  const router = useRouter();
  const a = customer.address || {};
  const [f, setF] = useState({ name: customer.name, phone: customer.phone, line1: a.line1 || "", line2: a.line2 || "", city: a.city || "", state: a.state || "", pincode: a.pincode || "", country: a.country || "India" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const hasAddress = f.line1.trim() || f.city.trim() || f.pincode.trim();
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "profile",
        name: f.name,
        phone: f.phone,
        address: hasAddress ? { line1: f.line1, line2: f.line2, city: f.city, state: f.state, pincode: f.pincode, country: f.country } : null,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setMsg(res.ok && json.ok ? { ok: true, text: "Saved." } : { ok: false, text: json.error || "Save failed." });
    setBusy(false);
  }

  async function signOut() {
    await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="rounded-sf-card border border-sf-border p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">Profile</h2>
        <button type="button" onClick={signOut} className="text-xs text-sf-text-faint hover:text-sf-text-body">
          Sign out
        </button>
      </div>
      <p className="mt-1 text-xs text-sf-text-faint">{customer.email}</p>
      {msg && <p className={`mt-3 rounded-sf-small px-3 py-2 text-sm ${msg.ok ? "bg-sf-success-surface text-sf-success" : "bg-sf-danger-surface text-sf-danger"}`}>{msg.text}</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">Name</span>
          <input className={input} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">Phone</span>
          <input className={input} autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-sf-text-muted">Default address — line 1</span>
          <input className={input} autoComplete="address-line1" value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-sf-text-muted">Line 2 (optional)</span>
          <input className={input} autoComplete="address-line2" value={f.line2} onChange={(e) => setF({ ...f, line2: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">City</span>
          <input className={input} autoComplete="address-level2" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">State</span>
          <input className={input} autoComplete="address-level1" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">Pincode</span>
          <input className={input} autoComplete="postal-code" value={f.pincode} onChange={(e) => setF({ ...f, pincode: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-sf-text-muted">Country</span>
          <input className={input} autoComplete="country-name" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} />
        </label>
      </div>
      <button type="submit" disabled={busy} className="mt-4 rounded-sf-control bg-sf-inverse px-5 py-2.5 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover disabled:opacity-50">
        {busy ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
