"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { Field, Input } from "@/components/console/fields";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// S47 operator panels (redesigned S50): FlagsPanel (OP13) + CostsPanel (OP09).
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

// ---- OP13: feature flags ------------------------------------------------------

export function FlagsPanel() {
  const [flags, setFlags] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type: "disable"|"remove", flag }
  const toast = useToast();

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/platform/flags");
      if (res.ok) setFlags((await res.json()).flags);
      else setErr(`Couldn't load flags (${res.status})`);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body, label) {
    const res = await fetch("/api/platform/flags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${label}: ${j.error || res.status}`);
    toast.success(`${label}: ok`);
    refresh();
  }

  return (
    <Card id="flags">
      <CardHeader
        title="Feature flags"
        description="Server-evaluated rollout/kill switches (ff_*) — separate from billing entitlements. Critical flags are read uncached on every request, so an emergency disable is immediate everywhere. All changes audited."
        actions={
          <Button
            size="sm"
            onClick={() => setForm({ key: "ff_", description: "", default_on: false, critical: false, tenantsText: "", expires_at: "" })}
          >
            New flag
          </Button>
        }
      />
      {err && <ErrorState title="Couldn't load feature flags" detail={err} onRetry={refresh} />}
      {!flags && !err && <SkeletonText lines={3} />}
      {flags && (
        <>
          {flags.length === 0 && !form && (
            <EmptyState title="No flags defined" body="Absent flags fall back to each consumer's default." />
          )}
          <ul className="space-y-2 text-sm">
            {flags.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge p-3">
                <code className="font-mono text-xs font-semibold text-fg">{f.key}</code>
                <StatusBadge status={f.expired ? "expired" : f.default_on ? "on" : "off"} />
                {f.critical && (
                  <Badge tone="danger" title="critical">
                    Critical · uncached
                  </Badge>
                )}
                {Object.keys(f.tenants || {}).length > 0 && (
                  <span className="text-xs text-fg-subtle">
                    cohort: {Object.entries(f.tenants).map(([t, v]) => `${t}=${v ? "on" : "off"}`).join(", ")}
                  </span>
                )}
                {f.description && <span className="text-xs text-fg-muted">{f.description}</span>}
                <span className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      setForm({
                        key: f.key,
                        description: f.description || "",
                        default_on: !!f.default_on,
                        critical: !!f.critical,
                        tenantsText: Object.entries(f.tenants || {}).map(([t, v]) => `${t}=${v ? 1 : 0}`).join(", "),
                        expires_at: f.expires_at || "",
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="dangerOutline" disabled={busy} onClick={() => setConfirm({ type: "disable", flag: f })}>
                    Emergency disable
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => setConfirm({ type: "remove", flag: f })}>
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          {form && (
            <div className="mt-3 rounded-ctl border border-edge bg-surface-sunken p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Key" htmlFor="ff-key" required>
                  <Input id="ff-key" mono placeholder="ff_my-flag" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
                </Field>
                <Field label="Description" htmlFor="ff-desc">
                  <Input id="ff-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </Field>
                <Field label="Tenant cohort" htmlFor="ff-cohort" hint="Format: demo=1, beastlife=0 (optional)." className="sm:col-span-2">
                  <Input id="ff-cohort" mono value={form.tenantsText} onChange={(e) => setForm({ ...form, tenantsText: e.target.value })} />
                </Field>
                <Field label="Expires" htmlFor="ff-expires" hint="ISO timestamp, optional.">
                  <Input id="ff-expires" mono value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
                </Field>
                <div className="flex items-center gap-6 text-xs text-fg-muted">
                  <span className="flex items-center gap-2">
                    <Switch label="Default on" checked={form.default_on} onChange={(v) => setForm({ ...form, default_on: v })} />
                    default on
                  </span>
                  <span className="flex items-center gap-2">
                    <Switch label="Checkout-critical (uncached)" checked={form.critical} onChange={(v) => setForm({ ...form, critical: v })} />
                    checkout-critical (uncached)
                  </span>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={async () => {
                    const tenants = {};
                    for (const part of form.tenantsText.split(",").map((s) => s.trim()).filter(Boolean)) {
                      const [t, v] = part.split("=");
                      if (t?.trim()) tenants[t.trim()] = v?.trim() !== "0";
                    }
                    setBusy(true);
                    try {
                      await post(
                        { flag: { key: form.key.trim(), description: form.description, default_on: form.default_on, critical: form.critical, tenants, expires_at: form.expires_at.trim() || null } },
                        `save ${form.key}`
                      );
                      setForm(null);
                    } catch (e) {
                      toast.error(String(e?.message || e));
                    }
                    setBusy(false);
                  }}
                >
                  Save flag
                </Button>
                <Button size="sm" onClick={() => setForm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirm?.type === "disable"}
        onClose={() => setConfirm(null)}
        title={`Emergency-disable ${confirm?.flag?.key}?`}
        tone="danger"
        confirmLabel="Disable now"
        body="Forces the flag off and stops the next request on every instance — critical flags are read uncached. The change is audited."
        onConfirm={() => post({ disable: { key: confirm.flag.key } }, `emergency-disable ${confirm.flag.key}`)}
      />
      <ConfirmDialog
        open={confirm?.type === "remove"}
        onClose={() => setConfirm(null)}
        title={`Delete ${confirm?.flag?.key}?`}
        tone="danger"
        confirmLabel="Delete flag"
        body="Consumers fall back to their own defaults once the flag is gone."
        onConfirm={() => post({ remove: { key: confirm.flag.key } }, `delete ${confirm.flag.key}`)}
      />
    </Card>
  );
}

// ---- OP09: tenant unit costs --------------------------------------------------

const COST_COLUMNS = [
  { key: "tenant", header: "Tenant" },
  { key: "compute", header: "Compute", align: "right" },
  { key: "db", header: "DB", align: "right" },
  { key: "mail", header: "Mail", align: "right" },
  { key: "ai", header: "AI", align: "right" },
  { key: "allocated", header: "Allocated", align: "right" },
  { key: "budget", header: "Budget", align: "right" },
];

export function CostsPanel() {
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const [inputs, setInputs] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/platform/costs");
      if (res.ok) setReport((await res.json()).report);
      else setErr(`Couldn't load costs (${res.status})`);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body, label) {
    setBusy(true);
    const res = await fetch("/api/platform/costs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) toast.success(`${label}: ok`);
    else toast.error(`${label}: ${j.error || res.status}`);
    setBusy(false);
    refresh();
  }

  const t = report?.inputs?.totals || {};

  return (
    <Card id="costs">
      <CardHeader
        title={report ? `Tenant unit costs — ${report.month}` : "Tenant unit costs"}
        description={
          report?.configured
            ? `Real provider bills, allocated by measured drivers. Method per bucket: compute ${report.method.compute}; db ${report.method.db}; mail ${report.method.mail}; ai ${report.method.ai}. Gaps: ${report.gaps.join("; ")}.`
            : "Real provider bills, allocated by measured drivers."
        }
        actions={
          report?.configured ? (
            <Button
              size="sm"
              onClick={() =>
                setInputs({ month: report.month, compute: t.compute || "", db: t.db || "", mail: t.mail || "", ai: t.ai || "", other: t.other || "", note: report.inputs?.note || "" })
              }
            >
              {report.inputs ? "Edit provider totals" : "Enter provider totals"}
            </Button>
          ) : null
        }
      />
      {err && <ErrorState title="Couldn't load tenant costs" detail={err} onRetry={refresh} />}
      {!report && !err && <SkeletonText lines={3} />}
      {report && !report.configured && <Banner tone="info">No provider totals configured — cost allocation is off until it is.</Banner>}
      {report?.configured && (
        <>
          {!report.inputs && !inputs && (
            <EmptyState
              title={`No provider totals entered for ${report.month} yet`}
              body="Nothing is allocated until the month's real bills are entered."
            />
          )}

          {inputs && (
            <div className="mt-1 rounded-ctl border border-edge bg-surface-sunken p-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {["compute", "db", "mail", "ai", "other"].map((k) => (
                  <Field key={k} label={`${k} (₹/month)`} htmlFor={`cost-${k}`}>
                    <Input id={`cost-${k}`} type="number" min="0" value={inputs[k]} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} />
                  </Field>
                ))}
                <Field label="Note" htmlFor="cost-note" className="sm:col-span-3">
                  <Input id="cost-note" value={inputs.note} onChange={(e) => setInputs({ ...inputs, note: e.target.value })} />
                </Field>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={async () => {
                    await post(
                      {
                        inputs: {
                          month: inputs.month,
                          totals: { compute: Number(inputs.compute) || 0, db: Number(inputs.db) || 0, mail: Number(inputs.mail) || 0, ai: Number(inputs.ai) || 0, other: Number(inputs.other) || 0 },
                          note: inputs.note,
                        },
                      },
                      "save totals"
                    );
                    setInputs(null);
                  }}
                >
                  Save totals
                </Button>
                <Button size="sm" onClick={() => setInputs(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {report.inputs && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="neutral">total {inr(report.total)}</Badge>
                <Badge tone="success">allocated {inr(report.allocated)}</Badge>
                <Badge tone="warning" title="unallocated">
                  unallocated {inr(report.unallocated)}
                </Badge>
                <span className="text-fg-subtle">— stays visible, never invented into per-tenant numbers</span>
                {report.unmeasured.length > 0 && <Badge tone="danger">unmeasured tenants: {report.unmeasured.join(", ")}</Badge>}
              </div>
              {report.alerts.length > 0 && (
                <Banner tone="danger" className="mt-3">
                  Over budget: {report.alerts.map((a) => `${a.tenant} (${inr(a.allocated)} / ${inr(a.budget)})`).join("; ")} — review quotas/flags;
                  nothing is auto-charged.
                </Banner>
              )}
              <Table
                className="mt-3"
                dense
                columns={COST_COLUMNS}
                rows={report.tenants}
                rowKey={(row) => row.tenant}
                empty={<EmptyState title="No measured tenants" body="Per-tenant allocations appear once drivers are measured." className="py-6" />}
                renderCell={(row, col) => {
                  switch (col.key) {
                    case "tenant":
                      return (
                        <span className={`font-medium ${row.overBudget ? "text-danger" : ""}`}>
                          {row.tenant}
                          {!row.measured && <span className="ml-1 text-xs text-danger">(unmeasured)</span>}
                        </span>
                      );
                    case "allocated":
                      return <span className="font-semibold">{inr(row.allocated)}</span>;
                    case "budget":
                      return <BudgetCell row={row} busy={busy} onSet={(amount) => post({ budget: { tenant: row.tenant, amount } }, `budget ${row.tenant}`)} />;
                    default:
                      return inr(row.costs[col.key]);
                  }
                }}
              />
            </>
          )}
        </>
      )}
    </Card>
  );
}

function BudgetCell({ row, busy, onSet }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(row.budget ?? "");
  if (!editing) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        {row.budget != null ? inr(row.budget) : "Set"}
      </Button>
    );
  }
  return (
    <span className="flex items-center justify-end gap-1.5">
      <Input type="number" min="1" value={val} onChange={(e) => setVal(e.target.value)} className="w-24 px-2 py-1 text-xs" aria-label={`Budget for ${row.tenant}`} />
      <Button
        size="sm"
        variant="primary"
        busy={busy}
        onClick={() => {
          onSet(val === "" ? null : Number(val));
          setEditing(false);
        }}
      >
        Save
      </Button>
    </span>
  );
}
