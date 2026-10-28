"use client";

import { useState } from "react";

// Billing tab (S40 / MC24). Everything shown derives from provider state +
// the plan catalog — the console never invents money numbers. States are
// honest: grace shows a countdown warning, degraded explains exactly what is
// paused (checkout) and what is not (everything else).

const money = (paise, currency = "INR") =>
  paise === 0 ? "Free" : `₹${(paise / 100).toLocaleString("en-IN")}${currency !== "INR" ? ` ${currency}` : ""}`;

const CHIP = {
  none: "bg-zinc-100 text-zinc-500",
  created: "bg-amber-100 text-amber-700",
  authenticated: "bg-lime-100 text-lime-700",
  active: "bg-lime-100 text-lime-700",
  grace: "bg-amber-100 text-amber-700",
  degraded: "bg-red-100 text-red-600",
  paused: "bg-amber-100 text-amber-700",
  halted: "bg-amber-100 text-amber-700",
  cancelled: "bg-zinc-100 text-zinc-500",
  completed: "bg-zinc-100 text-zinc-500",
  expired: "bg-zinc-100 text-zinc-500",
};

export default function BillingAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  if (!data.supported) {
    return <p className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-500">{data.reason}</p>;
  }

  async function subscribe(planId) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "subscribe", plan: planId }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData(json);
      setMsg(
        json.result.shortUrl
          ? { ok: true, text: "Subscription created — authorize the first payment via the link below. The plan activates once Razorpay confirms." }
          : { ok: true, text: "Plan active." },
      );
    } else {
      setMsg({ ok: false, text: json.error || `Failed (${res.status})` });
    }
    setBusy(false);
  }

  const sub = data.subscription;

  return (
    <div className="space-y-5">
      {msg && <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>{msg.text}</div>}

      {data.degraded && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <p className="font-bold">Checkout is paused — subscription payment is overdue.</p>
          <p className="mt-1">Your storefront, catalog and order lookups stay fully live; only new checkouts are held. Renew below and checkout resumes on the next payment confirmation.</p>
        </div>
      )}
      {data.inGrace && !data.degraded && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-bold">Payment trouble — grace period running.</p>
          <p className="mt-1">
            Everything keeps working until {sub?.grace_until ? new Date(sub.grace_until).toLocaleString("en-IN", { dateStyle: "medium" }) : "the grace deadline"}; after that, checkout pauses (nothing else shuts down).
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">Current plan</h2>
          <span className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase ${CHIP[data.label] || CHIP.none}`}>{data.label}</span>
        </div>
        {sub ? (
          <p className="mt-2 text-sm text-zinc-600">
            <span className="font-semibold capitalize">{sub.plan}</span> (v{sub.version})
            {sub.current_end ? ` · renews ${new Date(sub.current_end).toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">No subscription yet — this store runs on the Free plan's limits.</p>
        )}
        {sub?.short_url && ["created", "authenticated"].includes(sub.status) && (
          <a href={sub.short_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
            Authorize payment with Razorpay ↗
          </a>
        )}
        {data.entitlements.override && (
          <p className="mt-3 rounded-lg bg-purple-50 px-3 py-2 text-xs text-purple-700">
            Operator adjustment active on: {data.entitlements.override.fields.join(", ")} ({data.entitlements.override.reason})
            {data.entitlements.override.expiresAt ? ` — until ${new Date(data.entitlements.override.expiresAt).toLocaleDateString("en-IN")}` : ""}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Usage this month</h2>
        <div className="mt-3 space-y-3">
          {data.quotas.map((q) => (
            <div key={q.metric}>
              <div className="flex justify-between text-xs">
                <span className="font-medium text-zinc-600">{q.metric.replace(/_/g, " ")}</span>
                <span className={q.over ? "font-bold text-red-600" : q.warn ? "font-bold text-amber-600" : "text-zinc-400"}>
                  {q.used} / {q.limit}
                  {q.over ? " — over" : q.warn ? " — nearing limit" : ""}
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className={`h-full ${q.over ? "bg-red-500" : q.warn ? "bg-amber-400" : "bg-lime-400"}`}
                  style={{ width: `${Math.min(100, Math.round((q.used / q.limit) * 100))}%` }}
                />
              </div>
            </div>
          ))}
          {data.quotas.length === 0 && <p className="text-sm text-zinc-400">No metered limits on this plan.</p>}
        </div>
        <p className="mt-3 text-[11px] text-zinc-400">Going over warns — it never blocks a sale. Checkout pauses only when a subscription stays unpaid past its grace period.</p>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Plans</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {data.plans.map((p) => {
            const current = sub?.plan === p.id;
            return (
              <div key={p.id} className={`rounded-xl border p-4 ${current ? "border-lime-400 bg-lime-50/40" : "border-zinc-200"}`}>
                <p className="font-bold">{p.name}</p>
                <p className="mt-1 text-lg font-extrabold">
                  {money(p.price, p.currency)}
                  {p.price > 0 && <span className="text-xs font-normal text-zinc-400">/{p.interval}</span>}
                </p>
                <ul className="mt-2 space-y-1 text-xs text-zinc-500">
                  {Object.entries(p.features).map(([k, v]) => (
                    <li key={k}>
                      {typeof v === "boolean" ? (v ? "✓ " : "✕ ") : `${v} `}
                      {k.replace(/_/g, " ")}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={busy || current}
                  onClick={() => subscribe(p.id)}
                  className="mt-3 w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {current ? "Current plan" : p.price === 0 ? "Switch to Free" : "Choose plan"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Charges & refunds</h2>
        <ul className="mt-3 divide-y divide-zinc-100 text-sm">
          {data.history
            .filter((h) => h.amount !== 0)
            .map((h, i) => (
              <li key={i} className="flex items-center justify-between py-2">
                <span className="text-zinc-600">
                  {h.type.replace("subscription.", "").replace("refund.processed", "refund")}
                  <span className="ml-2 text-xs text-zinc-400">{new Date(h.occurred_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}</span>
                </span>
                <span className={`font-semibold ${h.amount < 0 ? "text-red-600" : "text-zinc-900"}`}>
                  {h.amount < 0 ? "−" : ""}₹{(Math.abs(h.amount) / 100).toLocaleString("en-IN")}
                </span>
              </li>
            ))}
          {data.history.filter((h) => h.amount !== 0).length === 0 && <li className="py-4 text-center text-zinc-400">No charges yet.</li>}
        </ul>
      </section>
    </div>
  );
}
