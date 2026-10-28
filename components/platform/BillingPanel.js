"use client";

import { useEffect, useState } from "react";

// Operator billing reconciliation panel (S40 / OP08): MRR, revenue by month
// (gross / refunds / net from the provider-event ledger), per-tenant
// subscription states, the exception queue, and entitlement overrides.
const inr = (paise) => `₹${(paise / 100).toLocaleString("en-IN")}`;

export default function BillingPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [ov, setOv] = useState({ tenant: "", features: "", reason: "", expiresAt: "" });
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/platform/billing")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
  }, []);

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/platform/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) setData(json);
    else setErr(json.error || `failed (${res.status})`);
    setBusy(false);
  }

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Billing & revenue</h2>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {!data && !err && <p className="mt-2 text-sm text-zinc-400">Loading…</p>}
      {data && (
        <>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <span className="rounded-xl bg-zinc-50 px-3 py-2">
              MRR <span className="font-bold">{inr(data.mrr)}</span>
            </span>
            <span className="rounded-xl bg-zinc-50 px-3 py-2">
              Provider{" "}
              <span className={`font-bold ${data.provider_configured ? "text-lime-700" : "text-amber-600"}`}>
                {data.provider_configured ? "connected" : "not configured"}
              </span>
            </span>
          </div>

          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-400">
                <th className="py-1 pr-3">Month</th>
                <th className="py-1 pr-3">Gross</th>
                <th className="py-1 pr-3">Refunds</th>
                <th className="py-1">Net</th>
              </tr>
            </thead>
            <tbody>
              {data.revenue.map((r) => (
                <tr key={r.month} className="border-t border-zinc-100">
                  <td className="py-1.5 pr-3 font-mono text-xs">{r.month}</td>
                  <td className="py-1.5 pr-3">{inr(r.gross)}</td>
                  <td className="py-1.5 pr-3 text-red-600">{r.refunds ? `−${inr(r.refunds)}` : "—"}</td>
                  <td className="py-1.5 font-semibold">{inr(r.net)}</td>
                </tr>
              ))}
              {data.revenue.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-zinc-400">
                    No provider charges recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-zinc-400">Subscriptions</h3>
          <table className="mt-2 w-full text-left text-sm">
            <tbody>
              {data.tenants.map((t) => (
                <tr key={t.tenant} className="border-t border-zinc-100">
                  <td className="py-1.5 pr-3 font-medium">{t.tenant}</td>
                  <td className="py-1.5 pr-3">
                    {t.plan} v{t.version} · {inr(t.monthly)}/mo
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        t.pastGrace ? "bg-red-100 text-red-600" : ["active", "authenticated"].includes(t.status) ? "bg-lime-100 text-lime-700" : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {t.pastGrace ? "degraded" : t.status}
                    </span>
                  </td>
                  <td className="py-1.5 text-xs text-zinc-400">{t.current_end ? `period ends ${new Date(t.current_end).toLocaleDateString("en-IN")}` : "—"}</td>
                </tr>
              ))}
              {data.tenants.length === 0 && (
                <tr>
                  <td className="py-3 text-center text-zinc-400">No subscriptions — every tenant runs on Free limits.</td>
                </tr>
              )}
            </tbody>
          </table>

          {data.exceptions.length > 0 && (
            <>
              <h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-amber-600">Exceptions</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {data.exceptions.map((x, i) => (
                  <li key={i} className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800">
                    <span className="font-bold">{x.kind.replace(/_/g, " ")}</span>
                    {x.tenant ? ` · ${x.tenant}` : ""} — {x.detail}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-zinc-400">Entitlement overrides</h3>
          {data.overrides.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {data.overrides.map((o) => (
                <li key={o.tenant} className="flex items-center gap-2 rounded-lg bg-purple-50 px-3 py-1.5 text-purple-800">
                  <span className="font-bold">{o.tenant}</span>
                  <span className="font-mono text-xs">{JSON.stringify(o.features)}</span>
                  <span className="text-xs">({o.reason}{o.expires_at ? ` · until ${new Date(o.expires_at).toLocaleDateString("en-IN")}` : ""})</span>
                  <button type="button" disabled={busy} onClick={() => post({ action: "clear_override", tenant: o.tenant })} className="ml-auto text-xs underline hover:no-underline">
                    clear
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            <input className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs" placeholder="tenant id" value={ov.tenant} onChange={(e) => setOv({ ...ov, tenant: e.target.value })} />
            <input className="rounded-lg border border-zinc-200 px-2 py-1.5 font-mono text-xs" placeholder='{"orders_per_month":1000}' value={ov.features} onChange={(e) => setOv({ ...ov, features: e.target.value })} />
            <input className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs" placeholder="reason (required)" value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} />
            <div className="flex gap-2">
              <input type="date" className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-xs" value={ov.expiresAt} onChange={(e) => setOv({ ...ov, expiresAt: e.target.value })} />
              <button
                type="button"
                disabled={busy || !ov.tenant.trim() || !ov.reason.trim()}
                onClick={() => {
                  let features;
                  try {
                    features = JSON.parse(ov.features || "{}");
                  } catch {
                    setErr("features must be JSON");
                    return;
                  }
                  post({ action: "override", tenant: ov.tenant.trim(), features, reason: ov.reason, expiresAt: ov.expiresAt ? `${ov.expiresAt}T23:59:59.000Z` : null });
                }}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40"
              >
                Set
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-zinc-400">
            Entitlements derive from provider events + these overrides only. Degraded pauses checkout — a published store is never hard-shut-down from here.
          </p>
        </>
      )}
    </section>
  );
}
