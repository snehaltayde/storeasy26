"use client";

import { useState } from "react";

// Automations console (S49 / MC28). The UI repeats what the engine
// enforces: bounded triggers/actions, consent on shopper emails, frequency
// caps, quiet hours, dedupe, dry runs, and the disable-all switch.
const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";
const input = "rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400";

const EMPTY = { name: "", trigger: "order_placed", conditions: { min_total: "", payment_method: "" }, action: { kind: "notify_merchant", subject: "", text: "" }, cap_per_day: 25, quiet_start: "", quiet_end: "" };

const RUN_CHIP = { done: "bg-lime-100 text-lime-700", skipped: "bg-zinc-100 text-zinc-500", failed: "bg-red-100 text-red-700", dry_run: "bg-sky-100 text-sky-700", pending: "bg-amber-100 text-amber-700" };

export default function AutomationsAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function refresh() {
    const r = await fetch("/api/admin/automations").then((r) => r.json()).catch(() => null);
    if (r?.ok) setData(r);
  }

  async function post(body, okNote = null) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: json.error || "Request failed" });
      return null;
    }
    if (okNote) setMsg({ kind: "ok", text: okNote });
    return json;
  }

  const { disabled, automations, runs } = data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Automations</h1>
        <div className="flex gap-2">
          <button
            type="button"
            className={disabled ? btnDark : `${btn} border-red-300 text-red-600`}
            disabled={busy}
            onClick={async () => (await post({ disable_all: { disabled: !disabled } })) && refresh()}
          >
            {disabled ? "Re-enable automations" : "Disable ALL"}
          </button>
          <button type="button" className={btn} onClick={() => { setForm(EMPTY); setEditId(null); setMsg(null); }}>
            New rule
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Bounded rules: a trigger, optional conditions, one action. Shopper emails send ONLY when the triggering
        order carried marketing consent. Every rule has a daily cap and optional quiet hours; the same event can
        never fire a rule twice. Dry runs send nothing.
      </p>
      {disabled && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">Disable-all is active — no automation runs, regardless of its own switch.</p>}
      {msg && <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.kind === "err" ? "bg-red-50 text-red-600" : "bg-lime-50 text-lime-800"}`}>{msg.text}</p>}

      {automations.length === 0 && !form && <p className="mt-6 text-sm text-zinc-400">No rules yet.</p>}
      <ul className="mt-5 space-y-2">
        {automations.map((a) => (
          <li key={a.id} className="rounded-xl border border-zinc-200 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${a.enabled && !disabled ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>{disabled ? "halted" : a.enabled ? "on" : "paused"}</span>
              <span className="font-semibold">{a.name}</span>
              <span className="text-xs text-zinc-400">
                {a.trigger} → {a.action.kind} · cap {a.cap_per_day}/day
                {a.quiet_start ? ` · quiet ${a.quiet_start}–${a.quiet_end}` : ""}
                {a.conditions.min_total != null ? ` · total ≥ ₹${a.conditions.min_total}` : ""}
                {a.conditions.payment_method ? ` · ${a.conditions.payment_method} only` : ""}
              </span>
              <span className="ml-auto flex gap-1.5">
                <button type="button" className={btn} disabled={busy} onClick={async () => { const r = await post({ dry_run: { id: a.id } }); if (r) setMsg({ kind: "ok", text: `Dry run on ${r.sample}: ${r.reason}${r.wouldBe ? "" : ""}` }); refresh(); }}>
                  Dry run
                </button>
                <button type="button" className={btn} disabled={busy} onClick={async () => (await post({ enable: { id: a.id, enabled: !a.enabled } })) && refresh()}>
                  {a.enabled ? "Pause" : "Enable"}
                </button>
                <button type="button" className={btn} onClick={() => { setForm({ name: a.name, trigger: a.trigger, conditions: { min_total: a.conditions.min_total ?? "", payment_method: a.conditions.payment_method ?? "" }, action: a.action, cap_per_day: a.cap_per_day, quiet_start: a.quiet_start || "", quiet_end: a.quiet_end || "" }); setEditId(a.id); }}>
                  Edit
                </button>
                <button type="button" className={`${btn} text-red-600`} disabled={busy} onClick={async () => (await post({ remove: { id: a.id } })) && refresh()}>
                  ✕
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      {form && (
        <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <select className={input} value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
              <option value="order_placed">When an order is placed</option>
              <option value="return_requested">When a return is requested</option>
            </select>
            <label className="text-xs text-zinc-600">
              Only if total ≥ (₹, optional)
              <input className={`${input} w-full`} type="number" min="0" value={form.conditions.min_total} onChange={(e) => setForm({ ...form, conditions: { ...form.conditions, min_total: e.target.value } })} />
            </label>
            <label className="text-xs text-zinc-600">
              Only this payment method (optional)
              <select className={`${input} w-full`} value={form.conditions.payment_method} onChange={(e) => setForm({ ...form, conditions: { ...form.conditions, payment_method: e.target.value } })}>
                <option value="">any</option>
                <option value="cod">cod</option>
                <option value="razorpay">razorpay</option>
              </select>
            </label>
            <select className={input} value={form.action.kind} onChange={(e) => setForm({ ...form, action: { ...form.action, kind: e.target.value } })}>
              <option value="notify_merchant">Action: email the store (support address)</option>
              <option value="email_customer">Action: email the shopper (needs their marketing consent on the order)</option>
            </select>
            <input className={input} placeholder="Subject (optional)" value={form.action.subject} onChange={(e) => setForm({ ...form, action: { ...form.action, subject: e.target.value } })} />
            <textarea className={`${input} min-h-20 sm:col-span-2`} placeholder="Message text" value={form.action.text} onChange={(e) => setForm({ ...form, action: { ...form.action, text: e.target.value } })} />
            <label className="text-xs text-zinc-600">
              Cap per day
              <input className={`${input} w-full`} type="number" min="1" max="500" value={form.cap_per_day} onChange={(e) => setForm({ ...form, cap_per_day: Number(e.target.value) || 25 })} />
            </label>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-zinc-600">
                Quiet from (HH:MM, optional)
                <input className={`${input} w-full`} placeholder="22:00" value={form.quiet_start} onChange={(e) => setForm({ ...form, quiet_start: e.target.value })} />
              </label>
              <label className="flex-1 text-xs text-zinc-600">
                until
                <input className={`${input} w-full`} placeholder="08:00" value={form.quiet_end} onChange={(e) => setForm({ ...form, quiet_end: e.target.value })} />
              </label>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnDark}
              disabled={busy}
              onClick={async () => {
                const payload = { ...form, quiet_start: form.quiet_start || null, quiet_end: form.quiet_end || null, conditions: { ...(form.conditions.min_total !== "" ? { min_total: Number(form.conditions.min_total) } : {}), ...(form.conditions.payment_method ? { payment_method: form.conditions.payment_method } : {}) } };
                const r = await post({ automation: payload, id: editId, enabled: false }, "Saved (paused — enable it when ready).");
                if (r) {
                  setForm(null);
                  setEditId(null);
                  await refresh();
                }
              }}
            >
              Save rule (paused)
            </button>
            <button type="button" className={btn} onClick={() => { setForm(null); setEditId(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-bold">Run history</h2>
          <ul className="mt-2 space-y-1 text-xs text-zinc-600">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${RUN_CHIP[r.status] || RUN_CHIP.pending}`}>{r.status}</span>
                <span className="font-mono text-zinc-400">{r.event_key}</span>
                <span>{r.reason}</span>
                <span className="text-zinc-300">{new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</span>
                {r.status === "failed" && (
                  <button type="button" className="text-sky-600 hover:underline" disabled={busy} onClick={async () => (await post({ retry: { run: r.id } })) && refresh()}>
                    retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
