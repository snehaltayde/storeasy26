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
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { platformApi, shortDate } from "./billingWords";
import { useBillingData } from "./useBillingData";
import { fromRows, toRows } from "./Plans";
import { selectClass } from "./Subscriptions";
import { useStores } from "./Events";

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Overrides: per-store feature values that win over the plan's, each with a
// reason and an expiry. Set (or replace) and clear.
export default function Overrides() {
  const { loading, error, data, reload } = useBillingData("/api/platform/billing");
  const stores = useStores();
  const [dialog, setDialog] = useState(null); // { kind: "set", row? } | { kind: "clear", row }
  const [notice, setNotice] = useState(null);
  const now = Date.now();
  const nameOf = (id) => stores.find((s) => s.id === id)?.name || id;

  async function done(text) {
    setDialog(null);
    setNotice(text);
    await reload();
  }

  const columns = [
    { key: "tenant", header: "Store", cell: (o) => (
        <span className="block max-w-[10rem] truncate font-medium lg:max-w-[14rem]" title={nameOf(o.tenant)}>
          {nameOf(o.tenant)}
        </span>
      ),
    },
    {
      key: "features",
      header: "Overrides",
      cell: (o) => (
        <ul className="flex flex-wrap gap-1">
          {Object.entries(o.features || {}).map(([k, v]) => (
            <li key={k} className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs whitespace-nowrap">
              {k}: {String(v)}
            </li>
          ))}
        </ul>
      ),
    },
    { key: "reason", header: "Reason", truncate: true, cell: (o) => o.reason || "" },
    {
      key: "expires_at",
      header: "Expires",
      cell: (o) =>
        o.expires_at && Date.parse(o.expires_at) <= now ? (
          <span className="flex flex-col items-start gap-0.5 leading-tight">
            <Badge variant="muted">Expired</Badge>
            <span className="text-xs whitespace-nowrap text-muted-foreground">{shortDate(o.expires_at)}</span>
          </span>
        ) : o.expires_at ? (
          <span className="whitespace-nowrap">{shortDate(o.expires_at)}</span>
        ) : (
          "Never"
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">An override changes one store&apos;s limits without changing its plan. It stops counting when it expires.</p>
        <Button size="sm" onClick={() => setDialog({ kind: "set" })}>
          <Plus className="size-3.5" aria-hidden /> Set an override
        </Button>
      </div>
      {notice && (
        <Alert role="status">
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>We couldn&apos;t load overrides</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DataTable
        label="Overrides"
        columns={columns}
        rows={data?.overrides || []}
        rowKey={(o) => o.tenant}
        loading={loading && !data}
        empty={<EmptyState title="No overrides." description="Every store gets exactly what its plan gives." />}
        rowActions={(o) => (
          <span className="flex flex-col items-end gap-1 lg:flex-row lg:justify-end">
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "set", row: o })}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDialog({ kind: "clear", row: o })}>
              Clear
            </Button>
          </span>
        )}
      />
      {dialog?.kind === "set" && <SetDialog stores={stores} row={dialog.row || null} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "clear" && <ClearDialog name={nameOf(dialog.row.tenant)} tenant={dialog.row.tenant} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function SetDialog({ stores, row, onClose, onDone }) {
  const [tenant, setTenant] = useState(row?.tenant || "");
  const [rows, setRows] = useState(row ? toRows(row.features) : [{ key: "orders_per_month", value: "" }]);
  const [reason, setReason] = useState(row?.reason || "");
  const [expires, setExpires] = useState(row?.expires_at && Date.parse(row.expires_at) > Date.now() ? row.expires_at.slice(0, 10) : inDays(30));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const feats = fromRows(rows);
  const problem = !tenant
    ? "Choose a store."
    : feats.error || (!Object.keys(feats.features || {}).length ? "Add at least one feature." : !reason.trim() ? "Say why." : !expires || Date.parse(`${expires}T23:59:59Z`) <= Date.now() ? "Pick an expiry date in the future." : null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await platformApi("/api/platform/billing", { action: "override", tenant, features: feats.features, reason: reason.trim(), expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() });
      await onDone(`The override for ${tenant} is saved until ${shortDate(`${expires}T23:59:59Z`)}.`);
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
          <DialogTitle>{row ? "Edit override" : "Set an override"}</DialogTitle>
          <DialogDescription>These values win over the store&apos;s plan until the expiry date. Saving replaces the store&apos;s current override.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="ov-store" className="mb-1">
              Store
            </Label>
            <select id="ov-store" className={`${selectClass} w-full`} value={tenant} disabled={Boolean(row)} onChange={(e) => setTenant(e.target.value)}>
              <option value="">Choose a store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Features</legend>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Feature ${i + 1} name`} value={r.key} className="font-mono" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                  <Input aria-label={`Feature ${i + 1} value`} value={r.value} className="font-mono" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
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
          <div>
            <Label htmlFor="ov-reason" className="mb-1">
              Reason
            </Label>
            <Textarea id="ov-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ov-expires" className="mb-1">
              Expires at the end of
            </Label>
            <Input id="ov-expires" type="date" min={inDays(0)} value={expires} onChange={(e) => setExpires(e.target.value)} className="w-44" />
          </div>
          {(err || problem) && (
            <p role={err ? "alert" : undefined} className={`text-sm ${err ? "text-destructive" : "text-muted-foreground"}`}>
              {err || problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy || Boolean(problem)} onClick={save}>
            {busy ? "Saving…" : "Save override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClearDialog({ name, tenant, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear {name}&apos;s override?</AlertDialogTitle>
          <AlertDialogDescription>The store goes back to exactly what its plan gives, now.</AlertDialogDescription>
        </AlertDialogHeader>
        {err && (
          <p role="alert" className="text-sm text-destructive">
            {err}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await platformApi("/api/platform/billing", { action: "clear_override", tenant });
                await onDone(`${name}'s override is cleared.`);
              } catch (x) {
                setErr(String(x?.message || x));
                setBusy(false);
              }
            }}
          >
            {busy ? "Clearing…" : "Clear override"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
