"use client";

import { useState } from "react";
import Link from "next/link";

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

export const STATUS_STYLES = {
  pending_payment: "bg-zinc-100 text-zinc-600",
  cod_pending: "bg-amber-100 text-amber-700",
  paid: "bg-lime-100 text-lime-700",
  syncing_shopify: "bg-sky-100 text-sky-700",
  synced: "bg-emerald-100 text-emerald-700",
  sync_failed: "bg-red-100 text-red-700",
  cancelled: "bg-zinc-100 text-zinc-400 line-through",
};

export function StatusBadge({ status }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${STATUS_STYLES[status] || "bg-zinc-100 text-zinc-600"}`}>
      {status}
    </span>
  );
}

const TABS = ["all", "paid", "synced", "sync_failed", "cod_pending", "pending_payment", "cancelled"];

// Orders console (Session 22): filter tabs + search + keyset "load more".
export default function OrdersAdmin({ initial }) {
  const [orders, setOrders] = useState(initial.orders);
  const [counts, setCounts] = useState(initial.counts);
  const [nextBefore, setNextBefore] = useState(initial.nextBefore);
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  async function load({ statusArg = status, qArg = q, before = null, append = false } = {}) {
    setBusy(true);
    const p = new URLSearchParams();
    if (statusArg !== "all") p.set("status", statusArg);
    if (qArg.trim()) p.set("q", qArg.trim());
    if (before) p.set("before", before);
    const data = await fetch(`/api/admin/orders?${p}`).then((r) => r.json());
    if (data.ok) {
      setOrders(append ? (prev) => [...prev, ...data.orders] : data.orders);
      setCounts(data.counts);
      setNextBefore(data.nextBefore);
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Orders</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
          className="flex gap-2"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id / email / phone"
            className="w-56 rounded-xl border border-zinc-200 px-3 py-1.5 text-sm outline-none focus:border-zinc-400"
          />
          <button className="rounded-xl bg-zinc-900 px-3 py-1.5 text-sm font-semibold text-white">Search</button>
        </form>
      </div>

      <div className="mt-4 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => {
              setStatus(t);
              load({ statusArg: t });
            }}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
              status === t ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            {t.replace(/_/g, " ")}
            <span className="ml-1 opacity-60">{counts[t === "all" ? "all" : t] || 0}</span>
          </button>
        ))}
      </div>

      <ul className="mt-4 divide-y divide-zinc-100 rounded-2xl border border-zinc-200">
        {orders.map((o) => (
          <li key={o.id}>
            <Link href={`/admin/orders/${o.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-zinc-50">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {o.id}
                  <span className="ml-2 font-normal text-zinc-500">{o.name || o.email || o.phone || ""}</span>
                </p>
                <p className="text-xs text-zinc-500">
                  {new Date(o.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {" · "}
                  {o.payment_method}
                  {o.sync_error ? <span className="text-red-600"> · {String(o.sync_error).slice(0, 60)}</span> : null}
                </p>
              </div>
              <StatusBadge status={o.status} />
              <span className="w-20 text-right text-sm font-semibold">{inr(o.total)}</span>
            </Link>
          </li>
        ))}
        {orders.length === 0 && <li className="px-4 py-8 text-center text-sm text-zinc-500">No orders match.</li>}
      </ul>

      {nextBefore && (
        <button
          onClick={() => load({ before: nextBefore, append: true })}
          disabled={busy}
          className="mt-4 w-full rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
