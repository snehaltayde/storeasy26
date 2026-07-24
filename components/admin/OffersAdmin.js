"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import OfferForm from "./OfferForm";

// Single-store offer console (Session 19). List + enable/disable + schedule +
// edit/create for the 4 engine offer types. Every save is live on the next
// cart read — deliberately NOT a SaaS console (no tenants/theming/billing).
export default function OffersAdmin({ initialOffers }) {
  const [offers, setOffers] = useState(initialOffers);
  const [editing, setEditing] = useState(null); // offer row | "new"
  const [error, setError] = useState("");
  const router = useRouter();

  async function refresh() {
    const data = await fetch("/api/admin/offers").then((r) => r.json());
    if (data.offers) setOffers(data.offers);
  }

  async function toggle(offer) {
    setError("");
    const res = await fetch(`/api/admin/offers/${offer.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !offer.enabled }),
    });
    if (!res.ok) setError((await res.json()).error || "Toggle failed");
    await refresh();
  }

  async function remove(offer) {
    if (!window.confirm(`Delete "${offer.label}"? This cannot be undone.`)) return;
    await fetch(`/api/admin/offers/${offer.id}`, { method: "DELETE" });
    await refresh();
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  const summarize = (o) => {
    const c = o.config || {};
    switch (o.type) {
      case "BXGY":
        return `buy ${c.buy} get ${c.free} free · ${c.target?.kind}=${c.target?.value}`;
      case "TIERED_QTY":
        return `${(c.tiers || []).map((t) => `${t.minQty}+→${t.percent}%`).join(", ")} · ${c.target?.kind}=${c.target?.value}`;
      case "FREE_GIFT":
        return `over ₹${c.threshold} → ${c.gift?.title?.slice(0, 30)}`;
      case "COUPON":
        return `${c.code} · ${c.discount?.kind === "percent" ? `${c.discount.value}%` : `₹${c.discount?.value}`}${c.minSubtotal ? ` (min ₹${c.minSubtotal})` : ""}${c.combinable === false ? " · exclusive" : ""}`;
      default:
        return "";
    }
  };

  const schedule = (o) => {
    if (!o.starts_at && !o.ends_at) return "always";
    const f = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "…");
    return `${f(o.starts_at)} → ${f(o.ends_at)}`;
  };

  if (editing) {
    return (
      <OfferForm
        existing={editing === "new" ? null : editing}
        onDone={async () => {
          setEditing(null);
          await refresh();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Offers</h1>
          <p className="text-sm text-zinc-500">
            Changes are live on the next cart read — no deploy needed.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditing("new")}
            className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300"
          >
            + New offer
          </button>
          <button onClick={logout} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
            Sign out
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      <ul className="mt-6 divide-y divide-zinc-100 rounded-2xl border border-zinc-200">
        {offers.map((o) => (
          <li key={o.id} className="flex items-center gap-4 px-4 py-4">
            <button
              onClick={() => toggle(o)}
              aria-label={o.enabled ? "Disable" : "Enable"}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${o.enabled ? "bg-lime-400" : "bg-zinc-200"}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${o.enabled ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {o.label}
                <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">{o.type}</span>
              </p>
              <p className="truncate text-xs text-zinc-500">
                {summarize(o)} · <span className={o.starts_at || o.ends_at ? "text-amber-600" : ""}>{schedule(o)}</span>
              </p>
            </div>
            <button onClick={() => setEditing(o)} className="text-sm font-medium text-lime-700 hover:underline">
              Edit
            </button>
            <button onClick={() => remove(o)} className="text-sm text-zinc-400 hover:text-red-600">
              Delete
            </button>
          </li>
        ))}
        {offers.length === 0 && <li className="px-4 py-8 text-center text-sm text-zinc-500">No offers yet.</li>}
      </ul>
    </div>
  );
}
