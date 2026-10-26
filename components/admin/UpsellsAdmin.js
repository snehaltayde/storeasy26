"use client";

import { useState } from "react";

// Upsell placements console (Session 23). Merchants reference products by
// HANDLE (the /products/<handle> part); the server stores gids.
const input =
  "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-xs font-semibold text-zinc-600">{label}</span>
    {children}
    {hint && <span className="mt-0.5 block text-[11px] text-zinc-400">{hint}</span>}
  </label>
);

const EMPTY = { kind: "pdp_pairs", sourceHandle: "", targetHandles: "", title: "", position: 0 };

export default function UpsellsAdmin({ initial }) {
  const [placements, setPlacements] = useState(initial);
  const [form, setForm] = useState(null); // EMPTY-shaped | null
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const data = await fetch("/api/admin/upsells").then((r) => r.json());
    if (data.placements) setPlacements(data.placements);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/upsells", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(form.id ? { id: form.id } : {}),
        kind: form.kind,
        sourceHandle: form.sourceHandle.trim(),
        targetHandles: form.targetHandles.split(",").map((s) => s.trim()).filter(Boolean),
        title: form.title,
        position: Number(form.position) || 0,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setForm(null);
      setPlacements(data.placements);
    } else setError(data.error || `Save failed (${res.status})`);
    setBusy(false);
  }

  async function toggle(p) {
    await fetch(`/api/admin/upsells/${p.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    refresh();
  }

  async function remove(p) {
    if (!window.confirm(`Delete this ${p.kind} placement?`)) return;
    await fetch(`/api/admin/upsells/${p.id}`, { method: "DELETE" });
    refresh();
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Upsells</h1>
          <p className="text-sm text-zinc-500">
            PDP &ldquo;pairs well with&rdquo; (per product; auto same-collection when unset) and the cart-drawer slot.
          </p>
        </div>
        {!form && (
          <button onClick={() => setForm(EMPTY)} className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300">
            + New placement
          </button>
        )}
      </div>

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      {form && (
        <form onSubmit={save} className="mt-5 rounded-2xl border border-lime-300 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <select className={input} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="pdp_pairs">PDP — pairs well with</option>
                <option value="cart_upsell">Cart drawer slot</option>
              </select>
            </Field>
            {form.kind === "pdp_pairs" ? (
              <Field label="Source product handle" hint="the PDP this strip appears on">
                <input className={input} value={form.sourceHandle} onChange={(e) => setForm({ ...form, sourceHandle: e.target.value })} placeholder="whey-protein-1kg" />
              </Field>
            ) : (
              <Field label="Position" hint="lower shows first when several slots exist">
                <input className={input} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
              </Field>
            )}
            <div className="sm:col-span-2">
              <Field label="Target product handles" hint="comma-separated, shown in this order">
                <input className={input} value={form.targetHandles} onChange={(e) => setForm({ ...form, targetHandles: e.target.value })} placeholder="creatine-100g, shaker-neon" />
              </Field>
            </div>
            <Field label="Title" hint={form.kind === "pdp_pairs" ? 'blank = "Pairs well with"' : 'blank = "You might also like"'}>
              <input className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
          </div>
          <div className="mt-4 flex gap-2">
            <button type="submit" disabled={busy} className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300 disabled:opacity-50">
              {busy ? "Saving…" : "Save placement"}
            </button>
            <button type="button" onClick={() => setForm(null)} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
              Cancel
            </button>
          </div>
        </form>
      )}

      <ul className="mt-6 divide-y divide-zinc-100 rounded-2xl border border-zinc-200">
        {placements.map((p) => (
          <li key={p.id} className="flex items-center gap-4 px-4 py-4">
            <button
              onClick={() => toggle(p)}
              aria-label={p.enabled ? "Disable" : "Enable"}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${p.enabled ? "bg-lime-400" : "bg-zinc-200"}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${p.enabled ? "left-[22px]" : "left-0.5"}`} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {p.title || (p.kind === "pdp_pairs" ? "Pairs well with" : "You might also like")}
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">{p.kind}</span>
              </p>
              <p className="truncate text-xs text-zinc-500">
                {p.kind === "pdp_pairs" ? `on ${p.source_handle} → ` : "→ "}
                {p.target_handles.join(", ")}
              </p>
            </div>
            <button
              onClick={() =>
                setForm({
                  id: p.id,
                  kind: p.kind,
                  sourceHandle: p.source_handle || "",
                  targetHandles: p.target_handles.join(", "),
                  title: p.title || "",
                  position: p.position,
                })
              }
              className="text-sm font-medium text-lime-700 hover:underline"
            >
              Edit
            </button>
            <button onClick={() => remove(p)} className="text-sm text-zinc-400 hover:text-red-600">
              Delete
            </button>
          </li>
        ))}
        {placements.length === 0 && <li className="px-4 py-8 text-center text-sm text-zinc-500">No placements yet — PDPs use the automatic same-collection strip.</li>}
      </ul>
    </div>
  );
}
