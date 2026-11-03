"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, ExternalLink, KeyRound, LogOut, MoreHorizontal, Pencil, Plus, UserPlus, Wrench } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { Banner } from "@/components/console/Banner";
import { StatusBadge } from "@/components/console/Badge";
import { Dialog, ConfirmDialog, DangerDialog } from "@/components/console/Dialog";
import { Field, Input, Select, Textarea } from "@/components/console/fields";
import { CopyButton, SecretReveal } from "@/components/console/Copy";
import { SkeletonText, EmptyState, ErrorState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";
import QueuesPanel from "./QueuesPanel";
import { FlagsPanel, CostsPanel } from "./GrowthOpsPanels";
import PartnersPanel from "./PartnersPanel";
import ThemesPanel from "./ThemesPanel";
import BillingPanel from "./BillingPanel";
import ProvisionRunsPanel from "./ProvisionRunsPanel";
import TenantDetail from "./TenantDetail";
import OverviewPanel from "./OverviewPanel";
import IncidentsPanel from "./IncidentsPanel";
import PrivacyOpsPanel from "./PrivacyOpsPanel";

// Operator console (Session 22, redesigned S50): sticky shell + anchor nav
// over the one-page console — tenant registry with consolidated actions,
// then every ops panel as an addressable Card. All destructive paths go
// through dialogs; transient results are toasts, persistent failures are
// row banners. API contracts unchanged.

const SECTIONS = [
  ["tenants", "Tenants"],
  ["overview", "Overview"],
  ["incidents", "Incidents"],
  ["privacy", "Privacy"],
  ["provisioning", "Provisioning"],
  ["themes", "Themes"],
  ["billing", "Billing"],
  ["flags", "Flags"],
  ["costs", "Costs"],
  ["partners", "Partners"],
  ["queues", "Queues"],
];

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
      <Card>
        <CardHeader title={`Tenant “${created.tenant.id}” provisioned`} description="Next: connect Shopify from the tenant row." />
        <SecretReveal
          label="Console password"
          value={created.generated.admin_password}
          note="Shown ONCE — hand it to the merchant now; it can't be retrieved later."
        />
        <div className="mt-4">
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card as="div">
      <form onSubmit={submit}>
        <CardHeader
          title="New tenant"
          description="Recorded, resumable steps: Turso DB → schema → neutral defaults (nothing brand-flavored) → register → Free plan → onboarding record. A failed run shows below with Resume."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Slug" htmlFor="nt-slug" required hint="lowercase, hyphens — becomes storeasy-t-<slug>">
            <Input id="nt-slug" required value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="acme" />
          </Field>
          <Field label="Display name" htmlFor="nt-name">
            <Input id="nt-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Acme Nutrition" />
          </Field>
          <Field label="Shopify store domain" htmlFor="nt-shop" required hint="x.myshopify.com">
            <Input id="nt-shop" required value={f.shopDomain} onChange={(e) => setF({ ...f, shopDomain: e.target.value })} placeholder="acme.myshopify.com" />
          </Field>
          <Field label="Storefront domains" htmlFor="nt-domains" hint="comma-separated hosts">
            <Input id="nt-domains" value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="shop.acme.in" />
          </Field>
          <Field label="Shopify app client id" htmlFor="nt-client-id" hint="the tenant's custom-distribution app">
            <Input id="nt-client-id" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
          </Field>
          <Field label="Shopify app client secret" htmlFor="nt-client-secret">
            <Input id="nt-client-secret" type="password" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
          </Field>
          <Field label="Adopt existing DB url" htmlFor="nt-db-url" hint="optional — skips Turso create">
            <Input id="nt-db-url" mono value={f.dbUrl} onChange={(e) => setF({ ...f, dbUrl: e.target.value })} placeholder="libsql://…" />
          </Field>
          <Field label="Adopt DB token" htmlFor="nt-db-token">
            <Input id="nt-db-token" type="password" autoComplete="new-password" value={f.dbToken} onChange={(e) => setF({ ...f, dbToken: e.target.value })} />
          </Field>
        </div>
        {error && (
          <Banner tone="danger" className="mt-4">
            {error}
          </Banner>
        )}
        <div className="mt-4 flex gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            Provision tenant
          </Button>
          <Button type="button" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

// S51: tenants are editable after provisioning — until now the New-tenant
// form was the only writer, so a store created with missing domains or app
// credentials was stuck. client secret is write-only (blank = keep current).
function EditTenantDialog({ id, onClose, onSaved }) {
  const [loaded, setLoaded] = useState(null); // detail payload
  const [loadErr, setLoadErr] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await fetch(`/api/platform/tenants/${id}`).then((r) => r.json());
        if (!alive) return;
        if (!data.ok) return setLoadErr(data.error || "Couldn't load tenant");
        setLoaded(data);
        setF({
          name: data.tenant.name || "",
          domains: (data.tenant.domains || []).join(", "),
          shopDomain: data.tenant.config?.shop_domain || "",
          clientId: data.tenant.config?.client_id || "",
          clientSecret: "",
          supportEmail: data.tenant.config?.support_email || "",
          orderPrefix: data.tenant.config?.order_prefix || "",
        });
      } catch (e) {
        if (alive) setLoadErr(String(e?.message || e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(`/api/platform/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update: {
          name: f.name,
          domains: f.domains.split(",").map((s) => s.trim()).filter(Boolean),
          ...(f.shopDomain.trim() ? { shop_domain: f.shopDomain } : {}),
          client_id: f.clientId,
          ...(f.clientSecret.trim() ? { client_secret: f.clientSecret } : {}),
          support_email: f.supportEmail,
          order_prefix: f.orderPrefix,
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !data.ok) return setError(data.error || `Save failed (${res.status})`);
    onSaved(data);
    onClose();
  }

  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const secretPresent = !!loaded?.tenant?.secretsPresent?.shopify_client_secret;

  return (
    <Dialog open onClose={busy ? undefined : onClose} title={`Edit tenant — ${id}`} size="lg">
      {loadErr && <ErrorState title="Couldn't load tenant" detail={loadErr} />}
      {!loadErr && !f && <SkeletonText lines={5} />}
      {f && (
        <form onSubmit={save} className="space-y-3 text-left">
          <Field label="Display name" htmlFor="et-name" hint="Also updates the storefront site name unless the merchant customized it.">
            <Input id="et-name" value={f.name} onChange={set("name")} required />
          </Field>
          <Field label="Storefront domains" htmlFor="et-domains" hint="Comma-separated hosts, e.g. pavos.in, pavos.localhost:3007 — exact match, ports count.">
            <Input id="et-domains" mono value={f.domains} onChange={set("domains")} placeholder="pavos.in, pavos.localhost:3007" />
          </Field>
          <Field label="Shopify store domain" htmlFor="et-shop">
            <Input id="et-shop" mono value={f.shopDomain} onChange={set("shopDomain")} placeholder="store.myshopify.com" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Shopify app client ID" htmlFor="et-cid">
              <Input id="et-cid" mono value={f.clientId} onChange={set("clientId")} />
            </Field>
            <Field
              label="Shopify app client secret"
              htmlFor="et-csec"
              hint={secretPresent ? "A secret is stored — leave blank to keep it." : "No secret stored yet."}
            >
              <Input id="et-csec" mono type="password" value={f.clientSecret} onChange={set("clientSecret")} placeholder={secretPresent ? "unchanged" : ""} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Support email" htmlFor="et-support" hint="Merchant notifications (returns, contact form) go here.">
              <Input id="et-support" type="email" value={f.supportEmail} onChange={set("supportEmail")} />
            </Field>
            <Field label="Order id prefix" htmlFor="et-prefix" hint="2–4 letters/digits on new order ids. Blank = derived from the tenant id.">
              <Input id="et-prefix" mono value={f.orderPrefix} onChange={set("orderPrefix")} placeholder={id.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase()} />
            </Field>
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              Save changes
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// First domain → a clickable origin (local hosts are http, real ones https).
const storeOrigin = (t) => {
  const host = (t.domains || [])[0];
  if (!host) return null;
  const proto = /(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(host) ? "http" : "https";
  return `${proto}://${host}`;
};

// S51: merchant hand-off — give a store's owner their access from the console.
// Preferred path: a single-use invite link (the merchant registers their own
// email+password). Fallback: rotate the bootstrap console password (shown
// once). Both existed only as CLI commands before.
function HandoffDialog({ tenant, onClose }) {
  const origin = storeOrigin(tenant);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("owner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invite, setInvite] = useState(null); // { link, expiresAt, mail }
  const [rotateArmed, setRotateArmed] = useState(false);
  const [rotated, setRotated] = useState(null); // { password, loginUrl }

  async function call(payload) {
    setBusy(true);
    setError("");
    const data = await fetch(`/api/platform/tenants/${tenant.id}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    setBusy(false);
    if (!data.ok) {
      setError(data.error || "Request failed");
      return null;
    }
    return data;
  }

  return (
    <Dialog open onClose={busy ? undefined : onClose} title={`Share access — ${tenant.name}`} size="lg">
      <div className="space-y-5 text-left">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Links to share</p>
          {origin ? (
            <div className="mt-2 space-y-1.5">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-fg-muted">Store console</span>
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-fg">{origin}/admin/login</code>
                <CopyButton value={`${origin}/admin/login`} />
              </p>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-fg-muted">Storefront</span>
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-fg">{origin}</code>
                <CopyButton value={origin} />
              </p>
            </div>
          ) : (
            <Banner tone="warning" className="mt-2">
              No domains yet — add one first (More → Edit details) so the merchant has somewhere to sign in.
            </Banner>
          )}
        </div>

        <div className="border-t border-edge pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Invite the merchant (recommended)</p>
          <p className="mt-1 text-xs text-fg-muted">
            A single-use link, valid 7 days — they pick their own password. It's emailed when a mail provider is
            configured, and always shown here so you can pass it on yourself.
          </p>
          {!invite && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const data = await call({ action: "invite", email, role });
                if (data) setInvite(data);
              }}
            >
              <Field label="Email" htmlFor="ho-email" className="min-w-52 flex-1">
                <Input id="ho-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@store.com" />
              </Field>
              <Field label="Role" htmlFor="ho-role">
                <Select id="ho-role" value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="owner">owner</option>
                  <option value="admin">admin</option>
                  <option value="staff">staff</option>
                  <option value="support">support</option>
                </Select>
              </Field>
              <Button type="submit" variant="primary" busy={busy} icon={<UserPlus size={13} aria-hidden />}>
                Create invite
              </Button>
            </form>
          )}
          {invite && (
            <div className="mt-3 space-y-2">
              <SecretReveal label={`Invite link for ${email} (${invite.role})`} value={invite.link} note={`Single use, expires ${new Date(invite.expiresAt).toLocaleString()}. ${invite.mail?.mock ? "Mail is not configured — share this link yourself." : invite.mail?.ok ? "Also emailed." : `Email failed (${invite.mail?.error || "?"}) — share this link yourself.`}`} />
              <Button size="sm" onClick={() => setInvite(null)}>
                Invite someone else
              </Button>
            </div>
          )}
        </div>

        <div className="border-t border-edge pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Bootstrap console password</p>
          <p className="mt-1 text-xs text-fg-muted">
            The shared setup password from provisioning. Rotate it if it was lost or exposed — the old one stops
            working immediately. Once the merchant has their own account, they should stop using it.
          </p>
          {rotated ? (
            <div className="mt-3">
              <SecretReveal label="New console password" value={rotated.password} note="Shown once. Sign in with an EMPTY email + this password." />
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant={rotateArmed ? "danger" : "dangerOutline"}
                busy={busy}
                icon={<KeyRound size={13} aria-hidden />}
                onClick={async () => {
                  if (!rotateArmed) return setRotateArmed(true);
                  const data = await call({ action: "rotate_password" });
                  if (data) setRotated(data);
                  setRotateArmed(false);
                }}
              >
                {rotateArmed ? "Confirm — old password stops working" : "Rotate console password"}
              </Button>
              {rotateArmed && (
                <Button onClick={() => setRotateArmed(false)} disabled={busy}>
                  Keep current
                </Button>
              )}
            </div>
          )}
        </div>

        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}

export default function PlatformAdmin() {
  const [tenants, setTenants] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [rowErr, setRowErr] = useState({}); // id → persistent failure text
  const [detail, setDetail] = useState(null); // expanded tenant id (S41 / OP03)
  const [syncing, setSyncing] = useState({}); // id → true while sync in flight
  const [menuFor, setMenuFor] = useState(null); // tenant whose "More" menu is open
  const [editing, setEditing] = useState(null); // tenant id being edited (S51)
  const [handoff, setHandoff] = useState(null); // tenant being handed off (S51)
  const [confirm, setConfirm] = useState(null); // { type, tenant } — suspend/activate/maintenance/offboard
  const [maintMsg, setMaintMsg] = useState("");
  const router = useRouter();
  const toast = useToast();

  async function refresh() {
    try {
      const res = await fetch("/api/platform/tenants");
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        setTenants(data.tenants);
        setLoadErr(null);
      } else setLoadErr(data.error || `Couldn't load tenants (${res.status})`);
    } catch (e) {
      setLoadErr(String(e?.message || e));
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  const fail = (id, text) => setRowErr((m) => ({ ...m, [id]: text }));
  const clearFail = (id) => setRowErr((m) => ({ ...m, [id]: null }));

  async function syncNow(id) {
    setSyncing((s) => ({ ...s, [id]: true }));
    clearFail(id);
    const data = await fetch(`/api/platform/tenants/${id}`, { method: "POST" }).then((r) => r.json()).catch(() => ({}));
    if (data.ok) toast.success(`${id}: sync ${data.action === "joined" ? "already running" : "queued"} (${data.runId}) — the queue finishes it; progress shows in the store console`);
    else fail(id, `Sync failed: ${data.error || "?"}`);
    setSyncing((s) => ({ ...s, [id]: false }));
    refresh();
  }

  async function setStatus(id, status) {
    const data = await fetch(`/api/platform/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!data.ok) throw new Error(data.error || "Failed");
    toast.success(`${id}: now ${status}`);
    refresh();
  }

  // S43 (OP12): maintenance — branded closed page for shoppers, console stays
  // reachable, checkout closes for everyone.
  async function setMaintenance(id, enabling, message) {
    const data = await fetch(`/api/platform/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maintenance: enabling ? { enabled: true, message } : { enabled: false } }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!data.ok) throw new Error(data.error || "Failed");
    toast.success(enabling ? `${id}: maintenance ON — shoppers see the closed page` : `${id}: maintenance off`);
    refresh();
  }

  // S43 (BE29): expiring export link + staged offboarding.
  async function exportTenant(id) {
    clearFail(id);
    const data = await fetch(`/api/platform/tenants/${id}/export`, { method: "POST" }).then((r) => r.json()).catch(() => ({}));
    if (data.ok) window.open(data.url, "_blank");
    else fail(id, data.error || "Export link failed");
  }

  async function offboard(id) {
    const data = await fetch(`/api/platform/tenants/${id}/offboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: id }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!data.ok) throw new Error(data.error || "Failed");
    toast.success(`${id} offboarded: ${data.steps.join(" · ")}`);
    refresh();
  }

  async function logout() {
    await fetch("/api/platform/logout", { method: "POST" });
    router.refresh();
  }

  const openMenuAction = (fn) => {
    setMenuFor(null);
    fn();
  };

  return (
    <div className="min-h-screen pb-16">
      {/* Sticky shell: title row + anchor nav */}
      <div className="sticky top-0 z-30 border-b border-edge bg-surface shadow-card">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
            <h1 className="text-lg font-semibold tracking-tight text-fg">Platform operations</h1>
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => setCreating(true)}>
                New tenant
              </Button>
              <Button size="sm" icon={<LogOut size={13} aria-hidden />} onClick={logout}>
                Sign out
              </Button>
            </div>
          </div>
          <nav aria-label="Console sections" className="mt-1 overflow-x-auto">
            <div className="flex gap-0.5 pb-2">
              {SECTIONS.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="whitespace-nowrap rounded-ctl px-2.5 py-1 text-xs font-medium text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg"
                >
                  {label}
                </a>
              ))}
            </div>
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-6xl space-y-6 px-6 pt-6">
        {creating && (
          <NewTenantForm
            onDone={() => {
              setCreating(false);
              refresh();
            }}
          />
        )}

        {/* Tenant registry */}
        <section id="tenants" aria-label="Tenants" className="scroll-mt-20 space-y-3">
          {tenants === null && !loadErr && (
            <Card>
              <CardHeader title="Tenants" />
              <SkeletonText lines={4} />
            </Card>
          )}
          {loadErr && (
            <Card>
              <CardHeader title="Tenants" />
              <ErrorState title="Couldn't load tenants" detail={loadErr} onRetry={refresh} />
            </Card>
          )}
          {tenants && tenants.length === 0 && (
            <Card>
              <CardHeader title="Tenants" />
              <EmptyState
                title="No tenants yet"
                body="Provision the first store to get started."
                action={
                  <Button size="sm" variant="primary" icon={<Plus size={13} aria-hidden />} onClick={() => setCreating(true)}>
                    New tenant
                  </Button>
                }
              />
            </Card>
          )}
          {tenants?.map((t) => {
            const h = t.health || {};
            return (
              <Card key={t.id} className={t.status === "suspended" ? "opacity-75" : ""}>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                      {t.name}
                      <span className="font-mono text-xs font-normal text-fg-subtle">{t.id}</span>
                      <StatusBadge status={t.status} />
                      {h.uninstalledAt && <StatusBadge status="uninstalled" label="App uninstalled" />}
                      {h.maintenance && <StatusBadge status="maintenance" />}
                    </p>
                    <p className="mt-1 truncate text-xs text-fg-muted">
                      {(t.domains || []).join(", ") || "no domains"} · {h.shopDomain || "no shop"} ·{" "}
                      {h.reachable ? (
                        <>
                          {h.products} products · synced {when(h.lastSyncedAt)} · {h.ordersInFlight} order(s) in flight ·{" "}
                          {h.shopifyConnected ? "Shopify connected" : "Shopify not connected"}
                        </>
                      ) : (
                        <span className="text-danger">DB unreachable: {h.error}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {storeOrigin(t) && (
                      <a
                        href={storeOrigin(t)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-ctl border border-edge-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-fg focus-ring hover:bg-surface-muted"
                      >
                        <ExternalLink size={13} aria-hidden />
                        View store
                      </a>
                    )}
                    <Button size="sm" onClick={() => setDetail(detail === t.id ? null : t.id)}>
                      {detail === t.id ? "Hide details" : "Details"}
                    </Button>
                    <Button size="sm" busy={!!syncing[t.id]} onClick={() => syncNow(t.id)}>
                      Sync
                    </Button>
                    <a
                      href={`/api/connect/shopify/start?tenant=${t.id}`}
                      className="inline-flex items-center gap-1.5 rounded-ctl border border-edge-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-fg focus-ring hover:bg-surface-muted"
                    >
                      Connect Shopify
                    </a>
                    <Button
                      size="sm"
                      icon={<MoreHorizontal size={13} aria-hidden />}
                      aria-haspopup="dialog"
                      onClick={() => setMenuFor(t)}
                    >
                      More
                    </Button>
                  </div>
                </div>
                {rowErr[t.id] && (
                  <Banner
                    tone="danger"
                    className="mt-3"
                    actions={
                      <Button size="sm" onClick={() => clearFail(t.id)}>
                        Dismiss
                      </Button>
                    }
                  >
                    {rowErr[t.id]}
                  </Banner>
                )}
                {detail === t.id && <TenantDetail id={t.id} />}
              </Card>
            );
          })}
        </section>

        <OverviewPanel />
        <IncidentsPanel />
        <PrivacyOpsPanel />
        <ProvisionRunsPanel />
        <ThemesPanel />
        <BillingPanel />
        <FlagsPanel />
        <CostsPanel />
        <PartnersPanel />
        <QueuesPanel />
      </main>

      {/* Edit tenant details (S51) */}
      {editing && (
        <EditTenantDialog
          id={editing}
          onClose={() => setEditing(null)}
          onSaved={(data) => {
            toast.success(`${data.tenant.id}: updated (${data.changed.join(", ")})`);
            refresh();
          }}
        />
      )}

      {/* Share access / merchant hand-off (S51) */}
      {handoff && <HandoffDialog tenant={handoff} onClose={() => setHandoff(null)} />}

      {/* "More" overflow menu — native dialog gives keyboard/focus handling */}
      <Dialog open={!!menuFor} onClose={() => setMenuFor(null)} title={menuFor ? `More actions — ${menuFor.id}` : ""} size="sm">
        {menuFor && (
          <div className="flex flex-col gap-2">
            <Button icon={<Pencil size={13} aria-hidden />} onClick={() => openMenuAction(() => setEditing(menuFor.id))}>
              Edit details…
            </Button>
            <Button icon={<UserPlus size={13} aria-hidden />} onClick={() => openMenuAction(() => setHandoff(menuFor))}>
              Share access…
            </Button>
            <Button icon={<Download size={13} aria-hidden />} onClick={() => openMenuAction(() => exportTenant(menuFor.id))}>
              Export data
            </Button>
            <Button
              icon={<Wrench size={13} aria-hidden />}
              onClick={() =>
                openMenuAction(() => {
                  setMaintMsg("");
                  setConfirm({ type: "maintenance", tenant: menuFor, enabling: !menuFor.health?.maintenance });
                })
              }
            >
              {menuFor.health?.maintenance ? "End maintenance…" : "Maintenance…"}
            </Button>
            {menuFor.status === "active" ? (
              <Button variant="dangerOutline" onClick={() => openMenuAction(() => setConfirm({ type: "suspend", tenant: menuFor }))}>
                Suspend…
              </Button>
            ) : (
              <Button onClick={() => openMenuAction(() => setConfirm({ type: "activate", tenant: menuFor }))}>Activate…</Button>
            )}
            <Button variant="dangerOutline" onClick={() => openMenuAction(() => setConfirm({ type: "offboard", tenant: menuFor }))}>
              Offboard…
            </Button>
          </div>
        )}
      </Dialog>

      {/* Suspend / Activate */}
      <ConfirmDialog
        open={confirm?.type === "suspend"}
        onClose={() => setConfirm(null)}
        title={`Suspend “${confirm?.tenant?.id}”?`}
        tone="danger"
        confirmLabel="Suspend"
        body="Its hosts fall back to the default store until it's activated again."
        onConfirm={() => setStatus(confirm.tenant.id, "suspended")}
      />
      <ConfirmDialog
        open={confirm?.type === "activate"}
        onClose={() => setConfirm(null)}
        title={`Activate “${confirm?.tenant?.id}”?`}
        confirmLabel="Activate"
        body="The store serves again on its configured domains."
        onConfirm={() => setStatus(confirm.tenant.id, "active")}
      />

      {/* Maintenance (dialog replaces the old prompt flow) */}
      <Dialog
        open={confirm?.type === "maintenance"}
        onClose={() => setConfirm(null)}
        title={confirm?.enabling ? `Enable maintenance on “${confirm?.tenant?.id}”` : `End maintenance on “${confirm?.tenant?.id}”`}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <MaintenanceConfirmButton
              enabling={!!confirm?.enabling}
              onConfirm={async () => {
                await setMaintenance(confirm.tenant.id, confirm.enabling, confirm.enabling ? maintMsg : null);
                setConfirm(null);
              }}
            />
          </>
        }
      >
        {confirm?.enabling ? (
          <Field label="Maintenance message shoppers will see" htmlFor="maint-msg" hint="Blank = default copy. The console stays reachable; checkout closes for everyone.">
            <Textarea id="maint-msg" value={maintMsg} onChange={(e) => setMaintMsg(e.target.value)} placeholder="We're down for a short maintenance window…" autoFocus />
          </Field>
        ) : (
          <p>Shoppers see the live store again and checkout reopens.</p>
        )}
      </Dialog>

      {/* Offboard (replaces prompt-the-id) */}
      <DangerDialog
        open={confirm?.type === "offboard"}
        onClose={() => setConfirm(null)}
        title={`Offboard “${confirm?.tenant?.id}”?`}
        confirmLabel="Offboard"
        typedConfirmation={confirm?.tenant?.id}
        body="Suspends the store, revokes keys, cancels billing, purges platform-side queues. The database and export stay available."
        onConfirm={() => offboard(confirm.tenant.id)}
      />
    </div>
  );
}

// The maintenance dialog is a plain Dialog (it carries a form), so its
// confirm button owns the in-flight state the way ConfirmDialog does.
function MaintenanceConfirmButton({ enabling, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="primary"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onConfirm();
        } catch (e) {
          toast.error(String(e?.message || e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {enabling ? "Enable maintenance" : "End maintenance"}
    </Button>
  );
}
