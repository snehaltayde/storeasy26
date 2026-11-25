"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { formatMoney } from "@/lib/format";
import { monthWords, platformApi } from "./billingWords";
import { useBillingData } from "./useBillingData";
import { Figure } from "./Overview";

// Costs (moved here from the old console's GrowthOps panel): the month's real
// provider bills (whole rupees, not paise), each allocated to stores by a
// measured driver with the method stated, the unallocated share kept in view,
// and a monthly alert budget per store (an alert only: nothing is charged).
const BUCKETS = [
  ["compute", "Compute"],
  ["db", "Database"],
  ["mail", "Mail"],
  ["ai", "AI"],
  ["other", "Other"],
];
const inr = (n) => formatMoney(n, "INR");
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function Costs({ params, setParams }) {
  const month = /^\d{4}-\d{2}$/.test(params.month || "") ? params.month : thisMonth();
  const { loading, error, data, reload } = useBillingData(`/api/platform/costs?month=${month}`);
  const report = data?.report;
  const [dialog, setDialog] = useState(null); // { kind: "inputs" } | { kind: "budget", row }
  const [notice, setNotice] = useState(null);

  async function done(text) {
    setDialog(null);
    setNotice(text);
    await reload();
  }

  const columns = [
    {
      key: "store",
      header: "Store",
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`font-medium ${r.overBudget ? "text-destructive" : ""}`}>{r.name || r.tenant}</span>
          {!r.measured && <Badge variant="danger">Not measured</Badge>}
          {r.overBudget && <Badge variant="danger">Over budget</Badge>}
        </span>
      ),
    },
    ...BUCKETS.filter(([k]) => k !== "other").map(([k, label]) => ({ key: k, header: label, align: "right", cell: (r) => <MoneyCell amount={r.costs[k]} currency="INR" /> })),
    { key: "allocated", header: "Allocated", align: "right", cell: (r) => <MoneyCell amount={r.allocated} currency="INR" className="font-semibold" /> },
    { key: "budget", header: "Budget", align: "right", cell: (r) => (r.budget != null ? <MoneyCell amount={r.budget} currency="INR" /> : <span className="block text-right text-muted-foreground">None</span>) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label htmlFor="cost-month" className="mb-1 text-xs text-muted-foreground">
            Month
          </Label>
          <Input id="cost-month" type="month" value={month} max={thisMonth()} onChange={(e) => setParams({ month: e.target.value || null })} className="h-8 w-40" data-read-control />
        </div>
        {report?.configured && report.inputs && (
          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "inputs" })}>
            Edit the month&apos;s bills
          </Button>
        )}
      </div>
      {notice && (
        <Alert role="status">
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>We couldn&apos;t load costs</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!report && !error && <Skeleton className="h-40" />}
      {report && !report.configured && <EmptyState title="Costs need the platform database." description="Set PLATFORM_DB_URL to measure and allocate costs." />}
      {report?.configured && !report.inputs && (
        <EmptyState
          title={`No bills entered for ${monthWords(month)}.`}
          description="Nothing is allocated until the month's real provider bills are entered."
          action={
            <Button size="sm" onClick={() => setDialog({ kind: "inputs" })}>
              Enter the month&apos;s bills
            </Button>
          }
        />
      )}
      {report?.configured && report.inputs && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Figure label={`Bills for ${monthWords(month)}`} value={inr(report.total)} mono />
            <Figure label="Allocated to stores" value={inr(report.allocated)} mono />
            <Figure label="Unallocated" value={inr(report.unallocated)} mono note={report.total ? `${Math.round((report.unallocated / report.total) * 100)}% of the bills. It is never spread over stores without a measure.` : null} />
          </div>
          {report.alerts.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden />
              <AlertTitle>Over budget</AlertTitle>
              <AlertDescription>{report.alerts.map((a) => `${a.tenant}: ${inr(a.allocated)} of ${inr(a.budget)}`).join("; ")}. Nothing is charged; review the store&apos;s plan or limits.</AlertDescription>
            </Alert>
          )}
          {report.unmeasured.length > 0 && <p className="text-sm text-destructive">Not measured this month: {report.unmeasured.join(", ")}. Their share stays unallocated.</p>}
          <DataTable
            label="Cost per store"
            columns={columns}
            rows={report.tenants}
            rowKey={(r) => r.tenant}
            loading={loading && !data}
            empty={<EmptyState title="No active stores to allocate to." />}
            rowActions={(r) => (
              <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "budget", row: r })}>
                {r.budget != null ? "Change budget" : "Set budget"}
              </Button>
            )}
          />
          <Card>
            <CardHeader>
              <CardTitle>How each bill is split</CardTitle>
              <CardDescription>{report.inputs.note || "Each bill is split by a measured driver."}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[11rem_1fr]">
                {BUCKETS.map(([k, label]) => (
                  <div key={k} className="contents">
                    <dt className="font-medium">
                      {label} <span className="ml-1 font-mono font-normal tabular-nums text-muted-foreground">{inr(report.inputs.totals[k] || 0)}</span>
                    </dt>
                    <dd className="text-muted-foreground">{report.method[k]}</dd>
                  </div>
                ))}
              </dl>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {report.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
      {dialog?.kind === "inputs" && <InputsDialog month={month} current={report?.inputs} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "budget" && <BudgetDialog row={dialog.row} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

const amountOk = (v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0);

function InputsDialog({ month, current, onClose, onDone }) {
  const [vals, setVals] = useState(Object.fromEntries(BUCKETS.map(([k]) => [k, current?.totals?.[k] ? String(current.totals[k]) : ""])));
  const [note, setNote] = useState(current?.note || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const bad = BUCKETS.find(([k]) => !amountOk(vals[k]));
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await platformApi("/api/platform/costs", { inputs: { month, totals: Object.fromEntries(BUCKETS.map(([k]) => [k, Number(vals[k]) || 0])), note } });
      await onDone(`Bills for ${monthWords(month)} saved and allocated.`);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bills for {monthWords(month)}</DialogTitle>
          <DialogDescription>Enter each provider&apos;s real total for the month, in rupees.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {BUCKETS.map(([k, label]) => (
            <div key={k}>
              <Label htmlFor={`cost-${k}`} className="mb-1">
                {label} (₹)
              </Label>
              <Input id={`cost-${k}`} inputMode="decimal" value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} className="font-mono" aria-invalid={!amountOk(vals[k]) || undefined} />
            </div>
          ))}
          <div className="sm:col-span-2">
            <Label htmlFor="cost-note" className="mb-1">
              Note
            </Label>
            <Input id="cost-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        {(err || bad) && (
          <p role="alert" className="text-sm text-destructive">
            {err || `${bad[1]}: an amount of zero or more.`}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy || Boolean(bad)} onClick={save}>
            {busy ? "Saving…" : "Save bills"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BudgetDialog({ row, onClose, onDone }) {
  const [val, setVal] = useState(row.budget != null ? String(row.budget) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const n = Number(val);
  const valid = val === "" || (Number.isFinite(n) && n > 0);
  async function save(amount) {
    setBusy(true);
    setErr(null);
    try {
      await platformApi("/api/platform/costs", { budget: { tenant: row.tenant, amount } });
      await onDone(amount == null ? `${row.name || row.tenant} has no budget now.` : `${row.name || row.tenant}'s monthly budget is ${inr(amount)}.`);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Monthly budget for {row.name || row.tenant}</DialogTitle>
          <DialogDescription>You get an alert here when the store&apos;s allocated cost passes it. The store is never charged.</DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="budget-amount" className="mb-1">
            Budget (₹ a month)
          </Label>
          <Input id="budget-amount" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} className="w-40 font-mono" />
        </div>
        {(err || !valid) && (
          <p role="alert" className="text-sm text-destructive">
            {err || "A budget is an amount above zero."}
          </p>
        )}
        <DialogFooter>
          {row.budget != null && (
            <Button variant="outline" className="sm:mr-auto" disabled={busy} onClick={() => save(null)}>
              Remove budget
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy || !valid || val === ""} onClick={() => save(n)}>
            {busy ? "Saving…" : "Save budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
