"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { formatPaise, rupeesToPaise } from "@/lib/platform/billing-money";
import { platformApi, shortDate } from "./billingWords";
import { useBillingData } from "./useBillingData";
import { selectClass } from "./Subscriptions";

const featureText = (v) => (typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

// Plans: every version with its price (paise, shown in rupees), interval,
// features and live subscribers. New version (validated here and on the
// server); retire a version (no new sales; pinned subscribers keep it).
export default function Plans() {
  const { loading, error, data, reload } = useBillingData("/api/platform/billing");
  const [dialog, setDialog] = useState(null); // { kind: "new", plan? } | { kind: "retire", plan }
  const [notice, setNotice] = useState(null);
  const plans = data?.plans || [];

  const columns = [
    {
      key: "plan",
      header: "Plan",
      cell: (p) => (
        <span className="flex flex-col leading-tight">
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-medium">
              {p.name} <span className="text-muted-foreground">v{p.version}</span>
            </span>
            <Badge variant={p.status === "active" ? "success" : "muted"}>{p.status === "active" ? "On sale" : "Retired"}</Badge>
          </span>
          <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: (p) =>
        p.price ? (
          <span className="flex flex-col items-end leading-tight">
            <MoneyCell amount={p.price / 100} currency="INR" />
            <span className="text-xs text-muted-foreground">a {p.interval}</span>
          </span>
        ) : (
          <span className="block text-right">Free</span>
        ),
    },
    {
      key: "features",
      header: "Features",
      cell: (p) => (
        <ul className="flex max-w-md flex-wrap gap-1 py-1.5">
          {Object.entries(p.features || {}).map(([k, v]) => (
            <li key={k} className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs whitespace-nowrap">
              {k}: {featureText(v)}
            </li>
          ))}
        </ul>
      ),
    },
    { key: "subscribers", header: "Subscribers", align: "right", cell: (p) => <span className="font-mono tabular-nums">{p.subscribers}</span> },
    { key: "created_at", header: "Created", className: "hidden xl:table-cell", cell: (p) => <span className="whitespace-nowrap">{shortDate(p.created_at)}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">A change to a plan is a new version. Stores already on an older version keep it.</p>
        <Button size="sm" onClick={() => setDialog({ kind: "new" })} disabled={!data}>
          <Plus className="size-3.5" aria-hidden /> New version
        </Button>
      </div>
      {notice && (
        <Alert role="status">
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>We couldn&apos;t load plans</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DataTable
        label="Plan versions"
        columns={columns}
        rows={plans}
        rowKey={(p) => `${p.id}@${p.version}`}
        loading={loading && !data}
        empty={<EmptyState title="No plans yet." description="Create the first plan version." />}
        rowActions={(p) => (
          <span className="flex flex-col items-end gap-1 lg:flex-row lg:justify-end">
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "new", plan: p })}>
              New version
            </Button>
            {p.status === "active" && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDialog({ kind: "retire", plan: p })}>
                Retire
              </Button>
            )}
          </span>
        )}
      />
      {dialog?.kind === "new" && (
        <NewVersionDialog
          plans={plans}
          from={dialog.plan || null}
          onClose={() => setDialog(null)}
          onDone={async (text) => {
            setDialog(null);
            setNotice(text);
            await reload();
          }}
        />
      )}
      {dialog?.kind === "retire" && (
        <RetireDialog
          plan={dialog.plan}
          onClose={() => setDialog(null)}
          onDone={async (text) => {
            setDialog(null);
            setNotice(text);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// features object -> editable rows, and back (numbers, true/false, or text)
export const toRows = (features) => Object.entries(features || {}).map(([k, v]) => ({ key: k, value: featureText(v) }));
export function fromRows(rows) {
  const out = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (!k) continue;
    if (Object.hasOwn(out, k)) return { error: `"${k}" is listed twice.` };
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return { error: `Feature "${k}": use lowercase letters, digits and _.` };
    const v = value.trim();
    out[k] = v === "yes" || v === "true" ? true : v === "no" || v === "false" ? false : v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return { features: out };
}

function NewVersionDialog({ plans, from, onClose, onDone }) {
  const ids = [...new Set(plans.map((p) => p.id))];
  const latestOf = (id) => plans.filter((p) => p.id === id).sort((a, b) => b.version - a.version)[0] || null;
  const start = from ? latestOf(from.id) : null;
  const [planId, setPlanId] = useState(start?.id || "");
  const [isNew, setIsNew] = useState(!start && ids.length === 0);
  const [name, setName] = useState(start?.name || "");
  const [price, setPrice] = useState(start ? String(start.price / 100) : "");
  const [interval, setPlanInterval] = useState(start?.interval || "month");
  const [rows, setRows] = useState(start ? toRows(start.features) : [{ key: "", value: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function pick(id) {
    setPlanId(id);
    const p = latestOf(id);
    if (p) {
      setName(p.name);
      setPrice(String(p.price / 100));
      setPlanInterval(p.interval);
      setRows(toRows(p.features));
    }
  }

  const paise = rupeesToPaise(price);
  const feats = fromRows(rows);
  const problem = !/^[a-z][a-z0-9-]{1,30}$/.test(planId)
    ? "Plan id: 2 to 31 lowercase letters, digits or -, starting with a letter."
    : !name.trim()
      ? "Give the plan a name."
      : paise == null
        ? "Price: an amount in rupees, like 999 or 999.50."
        : feats.error || null;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await platformApi("/api/platform/billing", { action: "plan_version", plan: planId, spec: { name: name.trim(), price: paise, interval, features: feats.features } });
      await onDone(`${name.trim()} v${r.result.version} is on sale. Earlier versions of ${planId} stopped selling; their subscribers keep them.`);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New plan version</DialogTitle>
          <DialogDescription>The new version goes on sale now and earlier versions of the same plan stop selling. Stores on them keep what they have.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="pv-plan" className="mb-1">
              Plan
            </Label>
            {isNew ? (
              <Input id="pv-plan" value={planId} onChange={(e) => setPlanId(e.target.value.toLowerCase())} placeholder="e.g. scale" className="font-mono" />
            ) : (
              <select id="pv-plan" className={`${selectClass} w-full`} value={planId} onChange={(e) => pick(e.target.value)}>
                <option value="">Choose a plan</option>
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => {
                setIsNew(!isNew);
                setPlanId("");
              }}
            >
              {isNew ? "Pick an existing plan" : "A new plan"}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Label htmlFor="pv-name" className="mb-1">
                Name
              </Label>
              <Input id="pv-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="pv-price" className="mb-1">
                Price in rupees (0 for free)
              </Label>
              <Input id="pv-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="font-mono" />
              {paise != null && <p className="mt-1 text-xs text-muted-foreground">{formatPaise(paise)} a {interval}</p>}
            </div>
            <div>
              <Label htmlFor="pv-interval" className="mb-1">
                Billed every
              </Label>
              <select id="pv-interval" className={`${selectClass} w-full`} value={interval} onChange={(e) => setPlanInterval(e.target.value)}>
                <option value="month">month</option>
                <option value="year">year</option>
              </select>
            </div>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Features</legend>
            <p className="mb-2 text-xs text-muted-foreground">A number, yes or no, or short text. Limits end in _per_month or _seats.</p>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Feature ${i + 1} name`} value={r.key} placeholder="orders_per_month" className="font-mono" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                  <Input aria-label={`Feature ${i + 1} value`} value={r.value} placeholder="500" className="font-mono" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <Button variant="ghost" size="icon" aria-label={`Remove feature ${r.key || i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setRows([...rows, { key: "", value: "" }])}>
              <Plus className="size-3.5" aria-hidden /> Add a feature
            </Button>
          </fieldset>
          {(err || (problem && planId)) && (
            <p role="alert" className="text-sm text-destructive">
              {err || problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy || Boolean(problem)} onClick={save}>
            {busy ? "Saving…" : "Put on sale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetireDialog({ plan, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Retire {plan.name} v{plan.version}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            No store can start {plan.name} v{plan.version} after this. The {plan.subscribers} {plan.subscribers === 1 ? "store" : "stores"} on it keep it at the same price. Retiring can&apos;t be undone: to sell this plan again, put a new version on sale.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {err && (
          <p role="alert" className="text-sm text-destructive">
            {err}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep selling</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await platformApi("/api/platform/billing", { action: "retire", plan: plan.id, version: plan.version });
                await onDone(`${plan.name} v${plan.version} is retired.`);
              } catch (x) {
                setErr(String(x?.message || x));
                setBusy(false);
              }
            }}
          >
            {busy ? "Retiring…" : "Retire version"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
