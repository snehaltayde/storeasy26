"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { Field, Input } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { Stat, SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/kit/toast";

// Operator billing reconciliation panel (S40 / OP08, redesigned S50): MRR,
// revenue by month (gross / refunds / net from the provider-event ledger),
// per-tenant subscription states, the exception queue, and entitlement
// overrides.
const inr = (paise) => `₹${(paise / 100).toLocaleString("en-IN")}`;

const REVENUE_COLUMNS = [
  { key: "month", header: "Month" },
  { key: "gross", header: "Gross", align: "right" },
  { key: "refunds", header: "Refunds", align: "right" },
  { key: "net", header: "Net", align: "right" },
];

const SUB_COLUMNS = [
  { key: "tenant", header: "Tenant" },
  { key: "plan", header: "Plan" },
  { key: "status", header: "Status" },
  { key: "period", header: "Period", align: "right" },
];

export default function BillingPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null); // load failure
  const [formErr, setFormErr] = useState(null); // override-form validation/action failure
  const [ov, setOv] = useState({ tenant: "", features: "", reason: "", expiresAt: "" });
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(null); // override to clear
  const toast = useToast();

  const load = useCallback(() => {
    setErr(null);
    return fetch("/api/platform/billing")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function post(body) {
    const res = await fetch("/api/platform/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!(res.ok && json.ok)) throw new Error(json.error || `failed (${res.status})`);
    setData(json);
    return json;
  }

  async function setOverride() {
    setFormErr(null);
    let features;
    try {
      features = JSON.parse(ov.features || "{}");
    } catch {
      setFormErr("features must be JSON");
      return;
    }
    setBusy(true);
    try {
      await post({ action: "override", tenant: ov.tenant.trim(), features, reason: ov.reason, expiresAt: ov.expiresAt ? `${ov.expiresAt}T23:59:59.000Z` : null });
      setOv({ tenant: "", features: "", reason: "", expiresAt: "" });
      toast.success("Override saved");
    } catch (e) {
      setFormErr(String(e?.message || e));
    }
    setBusy(false);
  }

  return (
    <Card id="billing">
      <CardHeader
        title="Billing & revenue"
        description="Entitlements derive from provider events + overrides only. Degraded pauses checkout — a published store is never hard-shut-down from here."
      />
      {err && <ErrorState title="Couldn't load billing" detail={err} onRetry={load} />}
      {!data && !err && <SkeletonText lines={5} />}
      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:max-w-md">
            <Stat label="MRR" value={inr(data.mrr)} />
            <Stat
              label="Provider"
              value={data.provider_configured ? "Connected" : "Not configured"}
              tone={data.provider_configured ? undefined : "muted"}
            />
          </div>

          <h3 className="mt-5 text-xs font-semibold text-fg-muted">Revenue by month</h3>
          <Table
            className="mt-2"
            columns={REVENUE_COLUMNS}
            rows={data.revenue}
            rowKey={(r) => r.month}
            empty={<EmptyState title="No provider charges recorded yet" className="py-6" />}
            renderCell={(r, col) => {
              switch (col.key) {
                case "month":
                  return <span className="font-mono text-xs">{r.month}</span>;
                case "gross":
                  return inr(r.gross);
                case "refunds":
                  return r.refunds ? <span className="text-danger">−{inr(r.refunds)}</span> : "—";
                case "net":
                  return <span className="font-semibold">{inr(r.net)}</span>;
                default:
                  return r[col.key];
              }
            }}
          />

          <h3 className="mt-5 text-xs font-semibold text-fg-muted">Subscriptions</h3>
          <Table
            className="mt-2"
            columns={SUB_COLUMNS}
            rows={data.tenants}
            rowKey={(t) => t.tenant}
            empty={<EmptyState title="No subscriptions" body="Every tenant runs on Free limits." className="py-6" />}
            renderCell={(t, col) => {
              switch (col.key) {
                case "tenant":
                  return <span className="font-medium">{t.tenant}</span>;
                case "plan":
                  return `${t.plan} v${t.version} · ${inr(t.monthly)}/mo`;
                case "status":
                  return t.pastGrace ? <Badge tone="danger" title={t.status}>Degraded</Badge> : <StatusBadge status={t.status} />;
                case "period":
                  return (
                    <span className="text-xs text-fg-subtle">
                      {t.current_end ? `ends ${new Date(t.current_end).toLocaleDateString("en-IN")}` : "—"}
                    </span>
                  );
                default:
                  return t[col.key];
              }
            }}
          />

          {data.exceptions.length > 0 && (
            <>
              <h3 className="mt-5 text-xs font-semibold text-warning">Exceptions</h3>
              <ul className="mt-2 space-y-2">
                {data.exceptions.map((x, i) => (
                  <li key={i}>
                    <Banner tone="warning">
                      <span className="font-semibold">{x.kind.replace(/_/g, " ")}</span>
                      {x.tenant ? ` · ${x.tenant}` : ""} — {x.detail}
                    </Banner>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="mt-5 text-xs font-semibold text-fg-muted">Entitlement overrides</h3>
          {data.overrides.length > 0 && (
            <ul className="mt-2 space-y-2 text-sm">
              {data.overrides.map((o) => (
                <li key={o.tenant} className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge bg-surface-sunken px-3 py-2">
                  <span className="font-semibold text-fg">{o.tenant}</span>
                  <span className="font-mono text-xs text-fg-muted">{JSON.stringify(o.features)}</span>
                  <span className="text-xs text-fg-subtle">
                    ({o.reason}
                    {o.expires_at ? ` · until ${new Date(o.expires_at).toLocaleDateString("en-IN")}` : ""})
                  </span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setClearing(o)}>
                    Clear
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {formErr && (
            <Banner tone="danger" className="mt-3">
              {formErr}
            </Banner>
          )}
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Tenant id" htmlFor="ov-tenant" required>
              <Input id="ov-tenant" mono value={ov.tenant} onChange={(e) => setOv({ ...ov, tenant: e.target.value })} />
            </Field>
            <Field label="Features" htmlFor="ov-features" hint="Raw JSON object of entitlement keys.">
              <Input id="ov-features" mono placeholder='{"orders_per_month":1000}' value={ov.features} onChange={(e) => setOv({ ...ov, features: e.target.value })} />
            </Field>
            <Field label="Reason" htmlFor="ov-reason" required>
              <Input id="ov-reason" value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} />
            </Field>
            <Field label="Expires" htmlFor="ov-expires" hint="Optional — end of that day (UTC).">
              <Input id="ov-expires" type="date" value={ov.expiresAt} onChange={(e) => setOv({ ...ov, expiresAt: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3">
            <Button variant="primary" size="sm" busy={busy} disabled={!ov.tenant.trim() || !ov.reason.trim()} onClick={setOverride}>
              Set override
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!clearing}
        onClose={() => setClearing(null)}
        title={`Clear override for “${clearing?.tenant}”?`}
        confirmLabel="Clear override"
        body="Entitlements fall back to what provider events grant."
        onConfirm={async () => {
          await post({ action: "clear_override", tenant: clearing.tenant });
          toast.success("Override cleared");
        }}
      />
    </Card>
  );
}
