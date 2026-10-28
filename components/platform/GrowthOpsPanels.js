"use client";

import { useEffect, useState, useCallback } from "react";

// S47 operator panels: FlagsPanel (OP13) + CostsPanel (OP09).
const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";
const input = "rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400";
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

// ---- OP13: feature flags ------------------------------------------------------

export function FlagsPanel() {
  const [flags, setFlags] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/platform/flags");
    if (res.ok) setFlags((await res.json()).flags);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body, label) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/platform/flags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? `${label}: ok` : `${label}: ${j.error || res.status}`);
    setBusy(false);
    refresh();
  }

  if (!flags) return null;
  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">Feature flags</h2>
        <button type="button" className={btn} onClick={() => setForm({ key: "ff_", description: "", default_on: false, critical: false, tenantsText: "", expires_at: "" })}>
          New flag
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Server-evaluated rollout/kill switches (ff_*) — separate from billing entitlements. Critical flags are
        read uncached on every request, so an emergency disable is immediate everywhere. All changes audited.
      </p>
      {msg && <p className="mt-2 text-xs text-zinc-500">{msg}</p>}
      {flags.length === 0 && !form && <p className="mt-3 text-sm text-zinc-400">No flags defined — absent flags fall back to each consumer&rsquo;s default.</p>}
      <ul className="mt-3 space-y-2 text-sm">
        {flags.map((f) => (
          <li key={f.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-100 p-2.5">
            <code className="font-mono text-xs font-bold">{f.key}</code>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${f.expired ? "bg-zinc-100 text-zinc-400" : Number(f.default_on) || f.default_on ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>
              {f.expired ? "expired" : f.default_on ? "on" : "off"}
            </span>
            {f.critical && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">critical · uncached</span>}
            {Object.keys(f.tenants || {}).length > 0 && (
              <span className="text-xs text-zinc-400">
                cohort: {Object.entries(f.tenants).map(([t, v]) => `${t}=${v ? "on" : "off"}`).join(", ")}
              </span>
            )}
            {f.description && <span className="text-xs text-zinc-500">{f.description}</span>}
            <span className="ml-auto flex gap-2">
              <button type="button" className={btn} onClick={() => setForm({ key: f.key, description: f.description || "", default_on: !!f.default_on, critical: !!f.critical, tenantsText: Object.entries(f.tenants || {}).map(([t, v]) => `${t}=${v ? 1 : 0}`).join(", "), expires_at: f.expires_at || "" })}>
                Edit
              </button>
              <button type="button" className={`${btn} text-red-600`} disabled={busy} onClick={() => post({ disable: { key: f.key } }, `emergency-disable ${f.key}`)}>
                Emergency disable
              </button>
              <button type="button" className={btn} disabled={busy} onClick={() => post({ remove: { key: f.key } }, `delete ${f.key}`)}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      {form && (
        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} placeholder="ff_my-flag" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            <input className={input} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <input className={`${input} sm:col-span-2`} placeholder="Tenant cohort: demo=1, beastlife=0 (optional)" value={form.tenantsText} onChange={(e) => setForm({ ...form, tenantsText: e.target.value })} />
            <input className={input} placeholder="Expires (ISO, optional)" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
            <div className="flex items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.default_on} onChange={(e) => setForm({ ...form, default_on: e.target.checked })} /> default on
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.critical} onChange={(e) => setForm({ ...form, critical: e.target.checked })} /> checkout-critical (uncached)
              </label>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnDark}
              disabled={busy}
              onClick={async () => {
                const tenants = {};
                for (const part of form.tenantsText.split(",").map((s) => s.trim()).filter(Boolean)) {
                  const [t, v] = part.split("=");
                  if (t?.trim()) tenants[t.trim()] = v?.trim() !== "0";
                }
                await post({ flag: { key: form.key.trim(), description: form.description, default_on: form.default_on, critical: form.critical, tenants, expires_at: form.expires_at.trim() || null } }, `save ${form.key}`);
                setForm(null);
              }}
            >
              Save flag
            </button>
            <button type="button" className={btn} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- OP09: tenant unit costs --------------------------------------------------

export function CostsPanel() {
  const [report, setReport] = useState(null);
  const [inputs, setInputs] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/platform/costs");
    if (res.ok) setReport((await res.json()).report);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body, label) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/platform/costs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? `${label}: ok` : `${label}: ${j.error || res.status}`);
    setBusy(false);
    refresh();
  }

  if (!report) return null;
  if (!report.configured) return null;
  const t = report.inputs?.totals || {};
  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">Tenant unit costs — {report.month}</h2>
        <button type="button" className={btn} onClick={() => setInputs({ month: report.month, compute: t.compute || "", db: t.db || "", mail: t.mail || "", ai: t.ai || "", other: t.other || "", note: report.inputs?.note || "" })}>
          {report.inputs ? "Edit provider totals" : "Enter provider totals"}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Real provider bills, allocated by measured drivers. Method per bucket: compute {report.method.compute}; db {report.method.db}; mail {report.method.mail}; ai {report.method.ai}.
        Gaps: {report.gaps.join("; ")}.
      </p>
      {msg && <p className="mt-2 text-xs text-zinc-500">{msg}</p>}

      {!report.inputs && !inputs && <p className="mt-3 text-sm text-zinc-400">No provider totals entered for {report.month} yet — nothing is allocated.</p>}

      {inputs && (
        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {["compute", "db", "mail", "ai", "other"].map((k) => (
              <label key={k} className="text-xs text-zinc-600">
                {k} (₹/month)
                <input className={`${input} w-full`} type="number" min="0" value={inputs[k]} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} />
              </label>
            ))}
            <label className="text-xs text-zinc-600 sm:col-span-3">
              Note
              <input className={`${input} w-full`} value={inputs.note} onChange={(e) => setInputs({ ...inputs, note: e.target.value })} />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnDark}
              disabled={busy}
              onClick={async () => {
                await post({ inputs: { month: inputs.month, totals: { compute: Number(inputs.compute) || 0, db: Number(inputs.db) || 0, mail: Number(inputs.mail) || 0, ai: Number(inputs.ai) || 0, other: Number(inputs.other) || 0 }, note: inputs.note } }, "save totals");
                setInputs(null);
              }}
            >
              Save totals
            </button>
            <button type="button" className={btn} onClick={() => setInputs(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {report.inputs && (
        <>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <span className="rounded-lg bg-zinc-100 px-3 py-2">total {inr(report.total)}</span>
            <span className="rounded-lg bg-lime-50 px-3 py-2 text-lime-800">allocated {inr(report.allocated)}</span>
            <span className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">unallocated {inr(report.unallocated)} — stays visible, never invented into per-tenant numbers</span>
            {report.unmeasured.length > 0 && <span className="rounded-lg bg-red-50 px-3 py-2 text-red-700">unmeasured tenants: {report.unmeasured.join(", ")}</span>}
          </div>
          {report.alerts.length > 0 && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              Over budget: {report.alerts.map((a) => `${a.tenant} (${inr(a.allocated)} / ${inr(a.budget)})`).join("; ")} — review quotas/flags; nothing is auto-charged.
            </p>
          )}
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-400">
                <th className="py-1 font-medium">tenant</th>
                <th className="font-medium">compute</th>
                <th className="font-medium">db</th>
                <th className="font-medium">mail</th>
                <th className="font-medium">ai</th>
                <th className="font-medium">allocated</th>
                <th className="font-medium">budget</th>
              </tr>
            </thead>
            <tbody>
              {report.tenants.map((row) => (
                <tr key={row.tenant} className={`border-t border-zinc-100 ${row.overBudget ? "bg-red-50/50" : ""}`}>
                  <td className="py-1 font-semibold">
                    {row.tenant}
                    {!row.measured && <span className="ml-1 text-red-500">(unmeasured)</span>}
                  </td>
                  <td>{inr(row.costs.compute)}</td>
                  <td>{inr(row.costs.db)}</td>
                  <td>{inr(row.costs.mail)}</td>
                  <td>{inr(row.costs.ai)}</td>
                  <td className="font-semibold">{inr(row.allocated)}</td>
                  <td>
                    <BudgetCell row={row} busy={busy} onSet={(amount) => post({ budget: { tenant: row.tenant, amount } }, `budget ${row.tenant}`)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function BudgetCell({ row, busy, onSet }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(row.budget ?? "");
  if (!editing) {
    return (
      <button type="button" className="text-zinc-500 underline-offset-2 hover:underline" onClick={() => setEditing(true)}>
        {row.budget != null ? inr(row.budget) : "set"}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <input className="w-20 rounded border border-zinc-200 px-1 py-0.5" type="number" min="1" value={val} onChange={(e) => setVal(e.target.value)} />
      <button
        type="button"
        className="font-semibold"
        disabled={busy}
        onClick={() => {
          onSet(val === "" ? null : Number(val));
          setEditing(false);
        }}
      >
        ✓
      </button>
    </span>
  );
}
