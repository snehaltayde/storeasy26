"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Field, Input, Select } from "@/components/console/fields";
import { useToast } from "@/components/console/Toast";

// Merchant settings console (Session 22, redesigned S50). One form,
// sectioned into anchor-target Cards; secret fields are WRITE-ONLY — a
// "set ✓" hint shows presence, blank means keep. Saves are live within the
// control-plane cache TTL (~30s per isolate), no deploy.
//
// S50 UX fix: the lone top Save is gone. A sticky save bar appears at the
// bottom of the viewport only while the form is dirty (current state vs the
// last-saved snapshot); Discard resets to the snapshot. Validation errors
// stay in a persistent danger Banner until the next attempt.

const secretHint = (isSet) => (isSet ? "Set ✓ — leave blank to keep" : "Not set");

// The editable form state, derived from a server settings view. Built the
// same way everywhere so the dirty check (JSON compare) is order-stable.
const buildState = (s) => ({
  identity: { ...s.identity },
  payments: { razorpay_key_id: s.payments.razorpay_key_id, razorpay_key_secret: "", razorpay_webhook_secret: "" },
  commerce: { checkout_mode: s.commerce?.checkout_mode || "direct", timezone: s.commerce?.timezone || "Asia/Kolkata" },
  tracking: {
    ga4_measurement_id: s.tracking.ga4_measurement_id,
    ga4_api_secret: "",
    meta_pixel_id: s.tracking.meta_pixel_id,
    meta_capi_token: "",
    meta_test_event_code: s.tracking.meta_test_event_code,
  },
  shipping: {
    ...s.shipping,
    zones: (s.shipping.zones || []).map((z) => ({ ...z, prefixes: (z.prefixes || []).join(", ") })),
  },
  adminPassword: "",
});

export default function SettingsAdmin({ initial }) {
  const toast = useToast();
  const [s, setS] = useState(initial);
  const ro = s.readOnly;
  const init = buildState(initial);
  const [identity, setIdentity] = useState(init.identity);
  const [payments, setPayments] = useState(init.payments);
  const [commerce, setCommerce] = useState(init.commerce);
  const [tracking, setTracking] = useState(init.tracking);
  const [shipping, setShipping] = useState(init.shipping);
  const [adminPassword, setAdminPassword] = useState("");
  const [errors, setErrors] = useState(null); // string[] — persistent until the next attempt
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const current = { identity, payments, commerce, tracking, shipping, adminPassword };
  const dirty = JSON.stringify(current) !== JSON.stringify(buildState(s));

  function apply(state) {
    setIdentity(state.identity);
    setPayments(state.payments);
    setCommerce(state.commerce);
    setTracking(state.tracking);
    setShipping(state.shipping);
    setAdminPassword(state.adminPassword);
  }

  const discard = () => {
    apply(buildState(s));
    setErrors(null);
  };

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setErrors(null);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity,
        payments,
        commerce,
        tracking,
        shipping,
        ...(adminPassword ? { admin_password: adminPassword } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setS(data.settings);
      apply(buildState(data.settings)); // clean slate: secrets blanked, zones renormalized
      toast.success(data.passwordRotated ? "Saved — console password rotated; other sessions are signed out." : "Saved — live within ~30s.");
    } else {
      setErrors(data.errors || [data.error || `Save failed (${res.status})`]);
    }
    setBusy(false);
  }

  async function syncNow() {
    setSyncBusy(true);
    const res = await fetch("/api/admin/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      toast.success(`Synced ${data.products} products, ${data.collections} collections${data.searchError ? " (search index degraded)" : ""}`);
    } else {
      toast.error(`Sync failed: ${data.error || res.status}`);
    }
    setSyncBusy(false);
  }

  const zone = (i, patch) =>
    setShipping((sh) => ({ ...sh, zones: sh.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) }));

  const grid = "grid gap-4 sm:grid-cols-2";

  return (
    <form onSubmit={save} className="space-y-4">
      {ro && (
        <Banner tone="info" title="Settings are read-only">
          This store runs on environment config (no control-plane row) — settings are read-only here.
        </Banner>
      )}

      <Card id="store-profile">
        <CardHeader title="Store identity" description="Shown across the storefront, emails and receipts." />
        <div className={grid}>
          <Field label="Store name" htmlFor="sa-name">
            <Input id="sa-name" disabled={ro} value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
          </Field>
          <Field label="Site URL" hint="Canonical origin for sitemaps & links" htmlFor="sa-site-url">
            <Input id="sa-site-url" disabled={ro} value={identity.site_url} onChange={(e) => setIdentity({ ...identity, site_url: e.target.value })} placeholder="https://store.example" />
          </Field>
          <Field label="Support email" htmlFor="sa-support-email">
            <Input id="sa-support-email" disabled={ro} value={identity.support_email} onChange={(e) => setIdentity({ ...identity, support_email: e.target.value })} />
          </Field>
          <Field label="Support phone" htmlFor="sa-support-phone">
            <Input id="sa-support-phone" disabled={ro} value={identity.support_phone} onChange={(e) => setIdentity({ ...identity, support_phone: e.target.value })} />
          </Field>
          <Field label="Site title" hint="Browser tab + search results title" htmlFor="sa-title">
            <Input id="sa-title" disabled={ro} value={identity.title} onChange={(e) => setIdentity({ ...identity, title: e.target.value })} />
          </Field>
          <Field label="Tagline" hint="Default description + hero fallback copy" htmlFor="sa-tagline">
            <Input id="sa-tagline" disabled={ro} value={identity.tagline} onChange={(e) => setIdentity({ ...identity, tagline: e.target.value })} />
          </Field>
          <Field label="Footer tagline" htmlFor="sa-footer-tagline">
            <Input id="sa-footer-tagline" disabled={ro} value={identity.footer_tagline} onChange={(e) => setIdentity({ ...identity, footer_tagline: e.target.value })} />
          </Field>
          <Field label="Logo text" hint="The storefront logo is text; the second part renders in your accent color" htmlFor="sa-logo-text1">
            <div className="flex gap-2">
              <Input id="sa-logo-text1" aria-label="Logo text, first part" disabled={ro} value={identity.logo_text1} onChange={(e) => setIdentity({ ...identity, logo_text1: e.target.value })} />
              <Input id="sa-logo-text2" aria-label="Logo text, accent part" disabled={ro} value={identity.logo_text2} onChange={(e) => setIdentity({ ...identity, logo_text2: e.target.value })} />
            </div>
          </Field>
          <Field label="Legal name" hint="Shown in the footer and on policy pages" htmlFor="sa-legal-name">
            <Input id="sa-legal-name" disabled={ro} value={identity.legal_name} onChange={(e) => setIdentity({ ...identity, legal_name: e.target.value })} />
          </Field>
          <Field label="Domains" hint="Managed by the platform operator" htmlFor="sa-domains">
            <Input id="sa-domains" disabled value={(s.domains || []).join(", ")} />
          </Field>
          <Field
            label="Shopify store"
            htmlFor="sa-shopify"
            hint={s.shopify.connected ? `Connected${s.shopify.uninstalled_at ? " · APP UNINSTALLED — reconnect!" : ""}` : "Not connected — ask the operator"}
          >
            <Input id="sa-shopify" disabled value={s.shopify.store_domain} />
          </Field>
        </div>
      </Card>

      <Card id="commerce">
        <CardHeader title="Commerce" description="Checkout capability and schedule timezone. Prices, stock, tax and final totals are Shopify-owned — edit them there." />
        <div className={grid}>
          <Field label="Checkout mode" hint="Explicit per-store capability — never switched silently. 'Disabled' keeps browsing + cart up and refuses orders loudly." htmlFor="sa-checkout-mode">
            <Select id="sa-checkout-mode" disabled={ro} value={commerce.checkout_mode} onChange={(e) => setCommerce({ ...commerce, checkout_mode: e.target.value })}>
              <option value="direct">direct — first-party checkout (Razorpay + COD)</option>
              <option value="disabled">disabled — checkout off</option>
            </Select>
          </Field>
          <Field label="Merchant timezone" hint="IANA name; offer schedules are edited in your local time and stored as exact instants." htmlFor="sa-timezone">
            <Input id="sa-timezone" disabled={ro} value={commerce.timezone} onChange={(e) => setCommerce({ ...commerce, timezone: e.target.value })} placeholder="Asia/Kolkata" />
          </Field>
          <Field label="Shopper emails" hint={s.commerce?.shopper_emails || ""} htmlFor="sa-shopper-emails">
            <Input id="sa-shopper-emails" disabled value="Shopify-native (no duplicates from Storeasy)" />
          </Field>
        </div>
      </Card>

      <Card id="payments">
        <CardHeader title="Payments — Razorpay" description="Checkout offers prepaid only when these are set; COD always works." />
        <div className={grid}>
          <Field label="Key id" htmlFor="sa-rzp-key-id">
            <Input id="sa-rzp-key-id" disabled={ro} value={payments.razorpay_key_id} onChange={(e) => setPayments({ ...payments, razorpay_key_id: e.target.value })} placeholder="rzp_live_…" />
          </Field>
          <div className="hidden sm:block" />
          <Field label="Key secret" hint={secretHint(s.payments.has_key_secret)} htmlFor="sa-rzp-key-secret">
            <Input id="sa-rzp-key-secret" type="password" autoComplete="new-password" disabled={ro} value={payments.razorpay_key_secret} onChange={(e) => setPayments({ ...payments, razorpay_key_secret: e.target.value })} />
          </Field>
          <Field label="Webhook secret" hint={secretHint(s.payments.has_webhook_secret)} htmlFor="sa-rzp-webhook-secret">
            <Input id="sa-rzp-webhook-secret" type="password" autoComplete="new-password" disabled={ro} value={payments.razorpay_webhook_secret} onChange={(e) => setPayments({ ...payments, razorpay_webhook_secret: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card id="tracking">
        <CardHeader title="Tracking — GA4 & Meta" description="Server-side events use the secrets; pixels use the ids." />
        <div className={grid}>
          <Field label="GA4 measurement id" htmlFor="sa-ga4-id">
            <Input id="sa-ga4-id" disabled={ro} value={tracking.ga4_measurement_id} onChange={(e) => setTracking({ ...tracking, ga4_measurement_id: e.target.value })} placeholder="G-XXXXXXX" />
          </Field>
          <Field label="GA4 API secret" hint={secretHint(s.tracking.has_ga4_api_secret)} htmlFor="sa-ga4-secret">
            <Input id="sa-ga4-secret" type="password" autoComplete="new-password" disabled={ro} value={tracking.ga4_api_secret} onChange={(e) => setTracking({ ...tracking, ga4_api_secret: e.target.value })} />
          </Field>
          <Field label="Meta pixel id" htmlFor="sa-meta-pixel">
            <Input id="sa-meta-pixel" disabled={ro} value={tracking.meta_pixel_id} onChange={(e) => setTracking({ ...tracking, meta_pixel_id: e.target.value })} />
          </Field>
          <Field label="Meta CAPI token" hint={secretHint(s.tracking.has_meta_capi_token)} htmlFor="sa-meta-capi">
            <Input id="sa-meta-capi" type="password" autoComplete="new-password" disabled={ro} value={tracking.meta_capi_token} onChange={(e) => setTracking({ ...tracking, meta_capi_token: e.target.value })} />
          </Field>
          <Field label="Meta test event code" hint="Only while testing — remove for live traffic" htmlFor="sa-meta-test">
            <Input id="sa-meta-test" disabled={ro} value={tracking.meta_test_event_code} onChange={(e) => setTracking({ ...tracking, meta_test_event_code: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card id="shipping">
        <CardHeader title="Shipping rules" description="The same engine prices the drawer, checkout and the Shopify push." />
        <div className={grid}>
          <Field label="Flat rate (₹)" htmlFor="sa-flat-rate">
            <Input id="sa-flat-rate" disabled={ro} value={shipping.flatRate ?? ""} onChange={(e) => setShipping({ ...shipping, flatRate: e.target.value })} />
          </Field>
          <Field label="Free shipping over (₹)" hint="Blank = never free" htmlFor="sa-free-over">
            <Input id="sa-free-over" disabled={ro} value={shipping.freeThreshold ?? ""} onChange={(e) => setShipping({ ...shipping, freeThreshold: e.target.value })} />
          </Field>
          <Field label="COD fee (₹)" htmlFor="sa-cod-fee">
            <Input id="sa-cod-fee" disabled={ro} value={shipping.codFee ?? ""} onChange={(e) => setShipping({ ...shipping, codFee: e.target.value })} />
          </Field>
          <Field label="Waive COD fee over (₹)" hint="Blank = never waived" htmlFor="sa-cod-waive">
            <Input id="sa-cod-waive" disabled={ro} value={shipping.codFeeWaivedAt ?? ""} onChange={(e) => setShipping({ ...shipping, codFeeWaivedAt: e.target.value })} />
          </Field>
          <Field label="Threshold basis" hint="net = after discounts" htmlFor="sa-basis">
            <Select id="sa-basis" disabled={ro} value={shipping.basis} onChange={(e) => setShipping({ ...shipping, basis: e.target.value })}>
              <option value="net">net</option>
              <option value="gross">gross</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-fg-muted">Pincode zones (first match wins)</p>
            {shipping.zones.map((z, i) => (
              <div key={i} className="mt-2 grid grid-cols-[1fr_1fr_90px_90px_auto] items-center gap-2">
                <Input aria-label={`Zone ${i + 1} label`} disabled={ro} placeholder="Label" value={z.label || ""} onChange={(e) => zone(i, { label: e.target.value })} />
                <Input aria-label={`Zone ${i + 1} pincode prefixes`} disabled={ro} placeholder="Prefixes e.g. 19, 18" value={z.prefixes} onChange={(e) => zone(i, { prefixes: e.target.value })} />
                <Input aria-label={`Zone ${i + 1} rate`} disabled={ro} placeholder="Rate" value={z.flatRate ?? ""} onChange={(e) => zone(i, { flatRate: e.target.value })} />
                <Input aria-label={`Zone ${i + 1} free threshold`} disabled={ro} placeholder="Free ≥" value={z.freeThreshold ?? ""} onChange={(e) => zone(i, { freeThreshold: e.target.value })} />
                <IconButton
                  label={`Remove zone ${z.label || i + 1}`}
                  icon={<X size={14} aria-hidden />}
                  disabled={ro}
                  onClick={() => setShipping((sh) => ({ ...sh, zones: sh.zones.filter((_, j) => j !== i) }))}
                />
              </div>
            ))}
            <Button
              size="sm"
              icon={<Plus size={13} aria-hidden />}
              disabled={ro}
              className="mt-3"
              onClick={() => setShipping((sh) => ({ ...sh, zones: [...sh.zones, { label: "", prefixes: "", flatRate: "", freeThreshold: "" }] }))}
            >
              Add zone
            </Button>
          </div>
        </div>
      </Card>

      <Card id="catalog-sync">
        <CardHeader
          title="Catalog sync"
          description={
            s.sync
              ? `${s.sync.products} products · ${s.sync.collections} collections · last synced ${s.sync.lastSyncedAt ? new Date(s.sync.lastSyncedAt).toLocaleString("en-IN") : "never"}`
              : "Status unavailable"
          }
        />
        <Button onClick={syncNow} busy={syncBusy}>
          {syncBusy ? "Syncing — this can take a minute…" : "Sync now"}
        </Button>
      </Card>

      <Card id="password">
        <CardHeader title="Console password" description="Rotating signs out every other session immediately." />
        <div className={grid}>
          <Field label="New password" hint="Min 8 characters · blank = unchanged" htmlFor="sa-admin-password">
            <Input id="sa-admin-password" type="password" autoComplete="new-password" disabled={ro} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          </Field>
        </div>
      </Card>

      {/* sticky save stack: validation Banner stays until the next attempt;
          the save bar itself only exists while the form is dirty */}
      {(errors || (dirty && !ro)) && (
        <div className="sticky bottom-4 z-10 space-y-2">
          {errors && (
            <Banner tone="danger" title="Couldn't save" className="shadow-overlay">
              {errors.map((t, i) => (
                <p key={i}>{t}</p>
              ))}
            </Banner>
          )}
          {dirty && !ro && (
            <div className="flex flex-wrap items-center gap-2 rounded-card border border-edge bg-surface px-4 py-3 shadow-overlay">
              <p className="flex-1 text-sm font-medium text-fg">Unsaved changes</p>
              <Button onClick={discard} disabled={busy}>
                Discard
              </Button>
              <Button type="submit" variant="primary" busy={busy}>
                Save settings
              </Button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
