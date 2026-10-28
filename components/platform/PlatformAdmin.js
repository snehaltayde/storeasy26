"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QueuesPanel from "./QueuesPanel";
import ThemesPanel from "./ThemesPanel";
import BillingPanel from "./BillingPanel";
import ProvisionRunsPanel from "./ProvisionRunsPanel";
import TenantDetail from "./TenantDetail";

// Operator console (Session 22): tenant table + health, suspend/activate,
// per-tenant sync, Shopify connect links, and the provisioning wizard.
const inputCls =
  "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";

const F = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-xs font-semibold text-zinc-600">{label}</span>
    {children}
    {hint && <span className="mt-0.5 block text-[11px] text-zinc-400">{hint}</span>}
  </label>
);

function NewTenantForm({ onDone }) {
  const [f, setF] = useState({ id: "", name: "", shopDomain: "", domains: "", clientId: "", clientSecret: "", dbUrl: "", dbToken: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null); // { tenant, generated }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/platform/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...f,
        domains: f.domains.split(",").map((d) => d.trim()).filter(Boolean),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) setCreated(data);
    else setError(data.error || `Provision failed (${res.status})`);
    setBusy(false);
  }

  if (created) {
    return (
      <div className="rounded-2xl border border-lime-300 bg-lime-50 p-5">
        <h3 className="text-sm font-bold text-lime-800">✓ Tenant “{created.tenant.id}” provisioned</h3>
        <p className="mt-2 text-sm text-lime-800">
          Console password: <code className="rounded bg-white px-2 py-0.5 font-mono text-sm">{created.generated.admin_password}</code>
        </p>
        <p className="mt-1 text-xs text-lime-700">Shown ONCE — hand it to the merchant now. Next: connect Shopify from the tenant row.</p>
        <button onClick={onDone} className="mt-3 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white">
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-zinc-200 p-5">
      <h3 className="text-sm font-bold">New tenant</h3>
      <p className="mt-0.5 text-xs text-zinc-500">
        Recorded, resumable steps: Turso DB → schema → neutral defaults (nothing brand-flavored) → register → Free plan → onboarding record. A failed run shows below with Resume.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <F label="Slug" hint="lowercase, hyphens — becomes storeasy-t-<slug>">
          <input className={inputCls} required value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="acme" />
        </F>
        <F label="Display name">
          <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Acme Nutrition" />
        </F>
        <F label="Shopify store domain" hint="x.myshopify.com">
          <input className={inputCls} required value={f.shopDomain} onChange={(e) => setF({ ...f, shopDomain: e.target.value })} placeholder="acme.myshopify.com" />
        </F>
        <F label="Storefront domains" hint="comma-separated hosts">
          <input className={inputCls} value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="shop.acme.in" />
        </F>
        <F label="Shopify app client id" hint="the tenant's custom-distribution app">
          <input className={inputCls} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
        </F>
        <F label="Shopify app client secret">
          <input type="password" autoComplete="new-password" className={inputCls} value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
        </F>
        <F label="Adopt existing DB url" hint="optional — skips Turso create">
          <input className={inputCls} value={f.dbUrl} onChange={(e) => setF({ ...f, dbUrl: e.target.value })} placeholder="libsql://…" />
        </F>
        <F label="Adopt DB token">
          <input type="password" autoComplete="new-password" className={inputCls} value={f.dbToken} onChange={(e) => setF({ ...f, dbToken: e.target.value })} />
        </F>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={busy} className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300 disabled:opacity-50">
          {busy ? "Provisioning…" : "Provision tenant"}
        </button>
        <button type="button" onClick={onDone} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function PlatformAdmin() {
  const [tenants, setTenants] = useState(null);
  const [creating, setCreating] = useState(false);
  const [rowMsg, setRowMsg] = useState({}); // id → text
  const [detail, setDetail] = useState(null); // expanded tenant id (S41 / OP03)
  const router = useRouter();

  async function refresh() {
    const data = await fetch("/api/platform/tenants").then((r) => r.json()).catch(() => ({}));
    if (data.ok) setTenants(data.tenants);
  }
  useEffect(() => {
    refresh();
  }, []);

  const say = (id, text) => setRowMsg((m) => ({ ...m, [id]: text }));

  async function syncNow(id) {
    say(id, "Syncing — can take a minute…");
    const data = await fetch(`/api/platform/tenants/${id}`, { method: "POST" }).then((r) => r.json()).catch(() => ({}));
    say(id, data.ok ? `Synced ${data.products}p/${data.collections}c` : `Sync failed: ${data.error || "?"}`);
    refresh();
  }

  async function setStatus(id, status) {
    if (status === "suspended" && !window.confirm(`Suspend "${id}"? Its hosts fall back to the default store.`)) return;
    const data = await fetch(`/api/platform/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).then((r) => r.json()).catch(() => ({}));
    say(id, data.ok ? `Now ${status}` : data.error || "Failed");
    refresh();
  }

  async function logout() {
    await fetch("/api/platform/logout", { method: "POST" });
    router.refresh();
  }

  const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Storeasy platform</h1>
          <p className="text-sm text-zinc-500">Tenants, onboarding, health.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setCreating(true)} className="rounded-xl bg-lime-400 px-4 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300">
            + New tenant
          </button>
          <button onClick={logout} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
            Sign out
          </button>
        </div>
      </div>

      {creating && (
        <div className="mt-6">
          <NewTenantForm
            onDone={() => {
              setCreating(false);
              refresh();
            }}
          />
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {tenants === null && <li className="text-sm text-zinc-500">Loading…</li>}
        {tenants?.map((t) => {
          const h = t.health || {};
          return (
            <li key={t.id} className={`rounded-2xl border p-4 ${t.status === "suspended" ? "border-zinc-200 opacity-60" : "border-zinc-200"}`}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold">
                    {t.name} <span className="font-mono text-xs font-normal text-zinc-400">{t.id}</span>
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${t.status === "active" ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>
                      {t.status}
                    </span>
                    {h.uninstalledAt && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">APP UNINSTALLED</span>}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {(t.domains || []).join(", ") || "no domains"} · {h.shopDomain || "no shop"} ·{" "}
                    {h.reachable ? (
                      <>
                        {h.products} products · synced {when(h.lastSyncedAt)} · {h.ordersInFlight} order(s) in flight ·{" "}
                        {h.shopifyConnected ? "Shopify ✓" : "Shopify not connected"}
                      </>
                    ) : (
                      <span className="text-red-600">DB unreachable: {h.error}</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs">
                  <button onClick={() => setDetail(detail === t.id ? null : t.id)} className="rounded-lg border border-zinc-300 px-2.5 py-1 font-semibold hover:bg-zinc-50">
                    {detail === t.id ? "Hide" : "Details"}
                  </button>
                  <button onClick={() => syncNow(t.id)} className="rounded-lg border border-zinc-300 px-2.5 py-1 font-semibold hover:bg-zinc-50">
                    Sync
                  </button>
                  <a href={`/api/connect/shopify/start?tenant=${t.id}`} className="rounded-lg border border-zinc-300 px-2.5 py-1 font-semibold hover:bg-zinc-50">
                    Connect Shopify
                  </a>
                  {t.status === "active" ? (
                    <button onClick={() => setStatus(t.id, "suspended")} className="rounded-lg border border-red-200 px-2.5 py-1 font-semibold text-red-600 hover:bg-red-50">
                      Suspend
                    </button>
                  ) : (
                    <button onClick={() => setStatus(t.id, "active")} className="rounded-lg border border-lime-300 px-2.5 py-1 font-semibold text-lime-700 hover:bg-lime-50">
                      Activate
                    </button>
                  )}
                </div>
              </div>
              {rowMsg[t.id] && <p className="mt-2 text-xs text-zinc-500">{rowMsg[t.id]}</p>}
              {detail === t.id && <TenantDetail id={t.id} />}
            </li>
          );
        })}
      </ul>
      <ProvisionRunsPanel />
      <ThemesPanel />
      <BillingPanel />
      <QueuesPanel />
    </div>
  );
}
