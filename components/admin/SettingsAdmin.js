"use client";

import { useState } from "react";

// Merchant settings console (Session 22). One form, sectioned; secret fields
// are WRITE-ONLY — a "set ✓" hint shows presence, blank means keep. Saves are
// live within the control-plane cache TTL (~30s per isolate), no deploy.

const Field = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-xs font-semibold text-zinc-600">{label}</span>
    {children}
    {hint && <span className="mt-0.5 block text-[11px] text-zinc-400">{hint}</span>}
  </label>
);

const input =
  "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 disabled:bg-zinc-50 disabled:text-zinc-400";

const Section = ({ title, desc, children }) => (
  <section className="rounded-2xl border border-zinc-200 p-5">
    <h2 className="text-sm font-bold">{title}</h2>
    {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
    <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
  </section>
);

const secretHint = (isSet) => (isSet ? "Set ✓ — leave blank to keep" : "Not set");

export default function SettingsAdmin({ initial }) {
  const [s, setS] = useState(initial);
  const ro = s.readOnly;
  const [identity, setIdentity] = useState(s.identity);
  const [payments, setPayments] = useState({ razorpay_key_id: s.payments.razorpay_key_id, razorpay_key_secret: "", razorpay_webhook_secret: "" });
  const [tracking, setTracking] = useState({
    ga4_measurement_id: s.tracking.ga4_measurement_id,
    ga4_api_secret: "",
    meta_pixel_id: s.tracking.meta_pixel_id,
    meta_capi_token: "",
    meta_test_event_code: s.tracking.meta_test_event_code,
  });
  const [shipping, setShipping] = useState({
    ...s.shipping,
    zones: (s.shipping.zones || []).map((z) => ({ ...z, prefixes: (z.prefixes || []).join(", ") })),
  });
  const [adminPassword, setAdminPassword] = useState("");
  const [msg, setMsg] = useState(null); // { ok, text[] }
  const [busy, setBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity,
        payments,
        tracking,
        shipping,
        ...(adminPassword ? { admin_password: adminPassword } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setS(data.settings);
      setPayments((p) => ({ ...p, razorpay_key_secret: "", razorpay_webhook_secret: "" }));
      setTracking((t) => ({ ...t, ga4_api_secret: "", meta_capi_token: "" }));
      setAdminPassword("");
      setMsg({ ok: true, text: [data.passwordRotated ? "Saved. Console password rotated — other sessions are signed out." : "Saved — live within ~30s."] });
    } else {
      setMsg({ ok: false, text: data.errors || [data.error || `Save failed (${res.status})`] });
    }
    setBusy(false);
  }

  async function syncNow() {
    setSyncBusy(true);
    setSyncMsg("Syncing — this can take a minute…");
    const res = await fetch("/api/admin/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await res.json().catch(() => ({}));
    setSyncMsg(
      data.ok
        ? `Synced ${data.products} products, ${data.collections} collections${data.searchError ? " (search index degraded)" : ""}`
        : `Sync failed: ${data.error || res.status}`,
    );
    setSyncBusy(false);
  }

  const zone = (i, patch) =>
    setShipping((sh) => ({ ...sh, zones: sh.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) }));

  return (
    <form onSubmit={save} className="mx-auto max-w-4xl space-y-5 px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-sm text-zinc-500">Store configuration — changes go live without a deploy.</p>
        </div>
        <button
          type="submit"
          disabled={busy || ro}
          className="rounded-xl bg-lime-400 px-5 py-2 text-sm font-bold text-zinc-950 hover:bg-lime-300 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>

      {ro && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
          This store runs on environment config (no control-plane row) — settings are read-only here.
        </p>
      )}
      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>
          {msg.text.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}

      <Section title="Store identity" desc="Shown across the storefront, emails and receipts.">
        <Field label="Store name">
          <input className={input} disabled={ro} value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
        </Field>
        <Field label="Site URL" hint="Canonical origin for sitemaps & links">
          <input className={input} disabled={ro} value={identity.site_url} onChange={(e) => setIdentity({ ...identity, site_url: e.target.value })} placeholder="https://store.example" />
        </Field>
        <Field label="Support email">
          <input className={input} disabled={ro} value={identity.support_email} onChange={(e) => setIdentity({ ...identity, support_email: e.target.value })} />
        </Field>
        <Field label="Support phone">
          <input className={input} disabled={ro} value={identity.support_phone} onChange={(e) => setIdentity({ ...identity, support_phone: e.target.value })} />
        </Field>
        <Field label="Domains" hint="Managed by the platform operator">
          <input className={input} disabled value={(s.domains || []).join(", ")} />
        </Field>
        <Field label="Shopify store" hint={s.shopify.connected ? `Connected${s.shopify.uninstalled_at ? " · APP UNINSTALLED — reconnect!" : ""}` : "Not connected — ask the operator"}>
          <input className={input} disabled value={s.shopify.store_domain} />
        </Field>
      </Section>

      <Section title="Payments — Razorpay" desc="Checkout offers prepaid only when these are set; COD always works.">
        <Field label="Key id">
          <input className={input} disabled={ro} value={payments.razorpay_key_id} onChange={(e) => setPayments({ ...payments, razorpay_key_id: e.target.value })} placeholder="rzp_live_…" />
        </Field>
        <div />
        <Field label="Key secret" hint={secretHint(s.payments.has_key_secret)}>
          <input type="password" autoComplete="new-password" className={input} disabled={ro} value={payments.razorpay_key_secret} onChange={(e) => setPayments({ ...payments, razorpay_key_secret: e.target.value })} />
        </Field>
        <Field label="Webhook secret" hint={secretHint(s.payments.has_webhook_secret)}>
          <input type="password" autoComplete="new-password" className={input} disabled={ro} value={payments.razorpay_webhook_secret} onChange={(e) => setPayments({ ...payments, razorpay_webhook_secret: e.target.value })} />
        </Field>
      </Section>

      <Section title="Tracking — GA4 & Meta" desc="Server-side events use the secrets; pixels use the ids.">
        <Field label="GA4 measurement id">
          <input className={input} disabled={ro} value={tracking.ga4_measurement_id} onChange={(e) => setTracking({ ...tracking, ga4_measurement_id: e.target.value })} placeholder="G-XXXXXXX" />
        </Field>
        <Field label="GA4 API secret" hint={secretHint(s.tracking.has_ga4_api_secret)}>
          <input type="password" autoComplete="new-password" className={input} disabled={ro} value={tracking.ga4_api_secret} onChange={(e) => setTracking({ ...tracking, ga4_api_secret: e.target.value })} />
        </Field>
        <Field label="Meta pixel id">
          <input className={input} disabled={ro} value={tracking.meta_pixel_id} onChange={(e) => setTracking({ ...tracking, meta_pixel_id: e.target.value })} />
        </Field>
        <Field label="Meta CAPI token" hint={secretHint(s.tracking.has_meta_capi_token)}>
          <input type="password" autoComplete="new-password" className={input} disabled={ro} value={tracking.meta_capi_token} onChange={(e) => setTracking({ ...tracking, meta_capi_token: e.target.value })} />
        </Field>
        <Field label="Meta test event code" hint="Only while testing — remove for live traffic">
          <input className={input} disabled={ro} value={tracking.meta_test_event_code} onChange={(e) => setTracking({ ...tracking, meta_test_event_code: e.target.value })} />
        </Field>
      </Section>

      <Section title="Shipping rules" desc="The same engine prices the drawer, checkout and the Shopify push.">
        <Field label="Flat rate (₹)">
          <input className={input} disabled={ro} value={shipping.flatRate ?? ""} onChange={(e) => setShipping({ ...shipping, flatRate: e.target.value })} />
        </Field>
        <Field label="Free shipping over (₹)" hint="Blank = never free">
          <input className={input} disabled={ro} value={shipping.freeThreshold ?? ""} onChange={(e) => setShipping({ ...shipping, freeThreshold: e.target.value })} />
        </Field>
        <Field label="COD fee (₹)">
          <input className={input} disabled={ro} value={shipping.codFee ?? ""} onChange={(e) => setShipping({ ...shipping, codFee: e.target.value })} />
        </Field>
        <Field label="Waive COD fee over (₹)" hint="Blank = never waived">
          <input className={input} disabled={ro} value={shipping.codFeeWaivedAt ?? ""} onChange={(e) => setShipping({ ...shipping, codFeeWaivedAt: e.target.value })} />
        </Field>
        <Field label="Threshold basis" hint="net = after discounts">
          <select className={input} disabled={ro} value={shipping.basis} onChange={(e) => setShipping({ ...shipping, basis: e.target.value })}>
            <option value="net">net</option>
            <option value="gross">gross</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <p className="text-xs font-semibold text-zinc-600">Pincode zones (first match wins)</p>
          {shipping.zones.map((z, i) => (
            <div key={i} className="mt-2 grid grid-cols-[1fr_1fr_90px_90px_32px] items-center gap-2">
              <input className={input} disabled={ro} placeholder="Label" value={z.label || ""} onChange={(e) => zone(i, { label: e.target.value })} />
              <input className={input} disabled={ro} placeholder="Prefixes e.g. 19, 18" value={z.prefixes} onChange={(e) => zone(i, { prefixes: e.target.value })} />
              <input className={input} disabled={ro} placeholder="Rate" value={z.flatRate ?? ""} onChange={(e) => zone(i, { flatRate: e.target.value })} />
              <input className={input} disabled={ro} placeholder="Free ≥" value={z.freeThreshold ?? ""} onChange={(e) => zone(i, { freeThreshold: e.target.value })} />
              <button type="button" disabled={ro} onClick={() => setShipping((sh) => ({ ...sh, zones: sh.zones.filter((_, j) => j !== i) }))} className="mt-1 text-zinc-400 hover:text-red-600">
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={ro}
            onClick={() => setShipping((sh) => ({ ...sh, zones: [...sh.zones, { label: "", prefixes: "", flatRate: "", freeThreshold: "" }] }))}
            className="mt-2 text-sm font-medium text-lime-700 hover:underline disabled:opacity-50"
          >
            + Add zone
          </button>
        </div>
      </Section>

      <Section title="Catalog sync" desc={s.sync ? `${s.sync.products} products · ${s.sync.collections} collections · last synced ${s.sync.lastSyncedAt ? new Date(s.sync.lastSyncedAt).toLocaleString("en-IN") : "never"}` : "Status unavailable"}>
        <div className="sm:col-span-2">
          <button type="button" onClick={syncNow} disabled={syncBusy} className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">
            {syncBusy ? "Syncing…" : "Sync now"}
          </button>
          {syncMsg && <span className="ml-3 text-sm text-zinc-500">{syncMsg}</span>}
        </div>
      </Section>

      <Section title="Console password" desc="Rotating signs out every other session immediately.">
        <Field label="New password" hint="Min 8 characters · blank = unchanged">
          <input type="password" autoComplete="new-password" className={input} disabled={ro} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
        </Field>
      </Section>
    </form>
  );
}
