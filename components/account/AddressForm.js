"use client";

import { useState } from "react";

// Add or edit one saved address (Phase 8 line 3). The same fields and rules as
// checkout (lib/addresses.js validateAddress); the server checks again.
const input = "mt-1 w-full rounded-sf-control border border-sf-border px-3 py-2 text-sm outline-none focus:border-sf-border-hover";

const FIELDS = [
  { key: "label", label: "Label (optional, e.g. Home)", maxLength: 30, half: true },
  { key: "name", label: "Full name", autoComplete: "name", half: true },
  { key: "phone", label: "Phone", type: "tel", autoComplete: "tel", half: true },
  { key: "line1", label: "Address", autoComplete: "address-line1", full: true },
  { key: "line2", label: "Apartment, suite (optional)", autoComplete: "address-line2", full: true },
  { key: "city", label: "City", autoComplete: "address-level2", half: true },
  { key: "state", label: "State", autoComplete: "address-level1", half: true },
  { key: "pincode", label: "PIN code", autoComplete: "postal-code", half: true },
];

export const BLANK_ADDRESS = { label: "", name: "", phone: "", line1: "", line2: "", city: "", state: "", pincode: "" };

export const addressFilled = (a) => ["name", "line1", "city", "state", "pincode"].every((k) => String(a[k] || "").trim()) && String(a.phone || "").trim().length >= 7;

export default function AddressForm({ initial = BLANK_ADDRESS, showDefault = false, busy = false, onSave, onCancel }) {
  const [a, setA] = useState({ ...BLANK_ADDRESS, ...initial });
  const [makeDefault, setMakeDefault] = useState(false);

  function submit(e) {
    e.preventDefault();
    onSave({ ...a }, makeDefault);
  }

  return (
    <form onSubmit={submit} className="rounded-sf-card border border-sf-border p-4" aria-label={initial.id ? "Edit address" : "New address"}>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className={`block ${f.full ? "sm:col-span-2" : ""}`}>
            <span className="text-xs font-semibold text-sf-text-muted">{f.label}</span>
            <input
              className={input}
              name={f.key}
              type={f.type || "text"}
              autoComplete={f.autoComplete}
              maxLength={f.maxLength}
              value={a[f.key] || ""}
              onChange={(e) => setA({ ...a, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {showDefault && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          Make this my default address
        </label>
      )}
      <div className="mt-4 flex gap-3">
        <button type="submit" disabled={busy || !addressFilled(a)} className="rounded-sf-control bg-sf-inverse px-5 py-2.5 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover disabled:opacity-50">
          {busy ? "Saving…" : "Save address"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-sf-control border border-sf-border-strong px-5 py-2.5 text-sm font-semibold hover:bg-sf-surface-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}
