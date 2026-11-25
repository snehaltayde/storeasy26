"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/kit/copy-button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { formatPaise } from "@/lib/platform/billing-money";
import { SUB_STATUS, UNCONFIGURED_WORDS, platformApi, shortDate, subStatus } from "./billingWords";
import { useBillingData } from "./useBillingData";

export const selectClass =
  "h-8 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background pointer-coarse:h-10";
const ENDED = ["cancelled", "completed", "expired"];
const GRACEABLE = ["halted", "cancelled", "expired", "paused"];

// Subscriptions: every subscription row, searchable by store, filtered by
// status and plan, ?store=<id> opens one store's rows (and the start dialog
// when it has none live). Start or change plan, extend grace, cancel.
export default function Subscriptions({ params, setParams }) {
  const q = params.q || "";
  const store = params.store || "";
  const offset = Math.max(0, Number(params.offset) || 0);
  const qs = new URLSearchParams({ view: "subscriptions", ...(q && { q }), ...(params.status && { status: params.status }), ...(params.plan && { plan: params.plan }), ...(store && { store }), ...(offset && { offset: String(offset) }) });
  const { loading, error, data, reload } = useBillingData(`/api/platform/billing?${qs}`);
  const [search, setSearch] = useState(q);
  const [dialog, setDialog] = useState(null); // { kind: start|grace|cancel, row?, tenant? }
  const [notice, setNotice] = useState(null);
  useEffect(() => setSearch(q), [q]);

  const configured = Boolean(data?.provider_configured);
  const salePlans = useMemo(() => {
    const latest = new Map();
    for (const p of data?.plans || []) if (p.status === "active" && !latest.has(p.id)) latest.set(p.id, p);
    return [...latest.values()].sort((a, b) => a.price - b.price);
  }, [data]);
  const planIds = useMemo(() => [...new Set((data?.plans || []).map((p) => p.id))], [data]);
  const storeName = (id) => data?.stores?.find((s) => s.id === id)?.name || id;

  // ?store= for a store with no live subscription opens the start dialog once
  const [autoOpened, setAutoOpened] = useState(null);
  useEffect(() => {
    if (!data || !store || autoOpened === store || params.status || params.plan || q) return;
    setAutoOpened(store);
    if (!data.rows.some((r) => !ENDED.includes(r.status)) && data.stores.some((s) => s.id === store)) setDialog({ kind: "start", tenant: store });
  }, [data, store, autoOpened, params.status, params.plan, q]);

  const columns = [
    {
      key: "store",
      header: "Store",
      cell: (r) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{r.store_name || r.tenant_id}</span>
          <span className="font-mono text-xs text-muted-foreground">{r.tenant_id}</span>
        </span>
      ),
    },
    { key: "plan", header: "Plan", cell: (r) => `${r.plan_id} v${r.plan_version}` },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const [label, tone] = subStatus(r.status);
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={tone}>{label}</Badge>
            {r.cancel_requested && !ENDED.includes(r.status) && <span className="text-xs text-muted-foreground">{r.cancel_requested.ended === "now" ? "Cancel sent" : "Cancels at cycle end"}</span>}
          </span>
        );
      },
    },
    { key: "source", header: "Billed by", cell: (r) => (r.provider ? "Razorpay" : "Local (free)") },
    { key: "current_end", header: "Period ends", cell: (r) => shortDate(r.current_end) },
    { key: "grace_until", header: "Grace until", cell: (r) => (r.grace_until ? shortDate(r.grace_until) : "—") },
  ];

  const rowActions = (r) => {
    const ended = ENDED.includes(r.status);
    const cancelBlocked = ended ? "This subscription has already ended." : r.provider && !configured ? "Razorpay isn't set up, so this can't be cancelled from here." : null;
    return (
      <span className="flex justify-end gap-1">
        {!ended && (
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "start", tenant: r.tenant_id, row: r })}>
            Change plan
          </Button>
        )}
        {GRACEABLE.includes(r.status) && (
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "grace", row: r })}>
            Extend grace
          </Button>
        )}
        <Gated reason={cancelBlocked}>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={Boolean(cancelBlocked)} onClick={() => setDialog({ kind: "cancel", row: r })}>
            Cancel
          </Button>
        </Gated>
      </span>
    );
  };

  async function done(message) {
    setDialog(null);
    setNotice(message);
    await reload();
  }

  return (
    <div className="space-y-4">
      {!configured && data && (
        <Alert>
          <AlertTitle>Razorpay is not set up</AlertTitle>
          <AlertDescription>{UNCONFIGURED_WORDS}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex min-w-60 flex-1 items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ q: search.trim() || null, offset: null });
          }}
        >
          <div className="flex-1">
            <Label htmlFor="sub-q" className="mb-1 text-xs text-muted-foreground">
              Store
            </Label>
            <Input id="sub-q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by store name or id" className="h-8" />
          </div>
          <Button type="submit" size="sm" variant="outline" data-read-control>
            <Search className="size-3.5" aria-hidden /> Search
          </Button>
        </form>
        <div>
          <Label htmlFor="sub-status" className="mb-1 text-xs text-muted-foreground">
            Status
          </Label>
          <select id="sub-status" className={selectClass} value={params.status || ""} onChange={(e) => setParams({ status: e.target.value, offset: null })} data-read-control>
            <option value="">Any status</option>
            {Object.entries(SUB_STATUS).map(([s, [label]]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="sub-plan" className="mb-1 text-xs text-muted-foreground">
            Plan
          </Label>
          <select id="sub-plan" className={selectClass} value={params.plan || ""} onChange={(e) => setParams({ plan: e.target.value, offset: null })} data-read-control>
            <option value="">Any plan</option>
            {planIds.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" onClick={() => setDialog({ kind: "start", tenant: store || "" })}>
          <Plus className="size-3.5" aria-hidden /> Start a plan
        </Button>
      </div>
      {store && (
        <p className="flex items-center gap-2 text-sm">
          Showing <span className="font-medium">{storeName(store)}</span>
          <Button size="sm" variant="ghost" onClick={() => setParams({ store: null, offset: null })} data-read-control>
            <X className="size-3.5" aria-hidden /> All stores
          </Button>
        </p>
      )}
      {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>We couldn&apos;t load subscriptions</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DataTable
        label="Subscriptions"
        columns={columns}
        rows={data?.rows || []}
        loading={loading && !data}
        rowActions={rowActions}
        empty={
          <EmptyState
            title={q || params.status || params.plan || store ? "No subscriptions match." : "No subscriptions yet."}
            description="Start a plan for a store to see it here."
            action={
              <Button size="sm" onClick={() => setDialog({ kind: "start", tenant: store || "" })}>
                Start a plan
              </Button>
            }
          />
        }
        footer={data && { offset: data.offset, total: data.total, onPrevious: () => setParams({ offset: Math.max(0, offset - 50) || null }), onNext: () => setParams({ offset: offset + 50 }) }}
      />

      {dialog?.kind === "start" && <StartDialog key={`${dialog.tenant}-${dialog.row?.id || ""}`} stores={data?.stores || []} plans={salePlans} configured={configured} initial={dialog} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "grace" && <GraceDialog row={dialog.row} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "cancel" && <CancelDialog row={dialog.row} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function Gated({ reason, children }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={reason}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

// A result line above the table; a founder's payment link is shown here once.
function Notice({ text, link = null, tone = "default", onClose }) {
  return (
    <Alert variant={tone === "error" ? "destructive" : "default"} role="status">
      <AlertTitle>{text}</AlertTitle>
      {link && (
        <AlertDescription>
          <p>Send this payment link to the founder. It is shown only now.</p>
          <CopyButton value={link} label="the payment link" className="mt-2 w-full" />
        </AlertDescription>
      )}
      <Button size="sm" variant="ghost" className="mt-2 w-fit" onClick={onClose}>
        Dismiss
      </Button>
    </Alert>
  );
}

function useSubmit(onDone) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function submit(body, words) {
    setBusy(true);
    setErr(null);
    try {
      const r = await platformApi("/api/platform/billing", body);
      await onDone(words(r.result));
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, err, submit };
}

function StartDialog({ stores, plans, configured, initial, onClose, onDone }) {
  const [tenant, setTenant] = useState(initial.tenant || "");
  const [plan, setPlan] = useState("");
  const { busy, err, submit } = useSubmit(onDone);
  const change = Boolean(initial.row);
  const chosen = plans.find((p) => p.id === plan);
  const needsProvider = (chosen && chosen.price > 0) || initial.row?.provider;
  const blocked = needsProvider && !configured ? "Razorpay isn't set up, so this plan change can't be made yet." : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{change ? "Change plan" : "Start a plan"}</DialogTitle>
          <DialogDescription>
            A free plan starts now. A paid plan gives you a payment link for the founder; it starts when they pay.
            {change && " The current subscription ends: a free one now, a paid one at the end of the period already paid for."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="start-store" className="mb-1">
              Store
            </Label>
            <select id="start-store" className={`${selectClass} w-full`} value={tenant} disabled={change} onChange={(e) => setTenant(e.target.value)}>
              <option value="">Choose a store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="start-plan" className="mb-1">
              Plan
            </Label>
            <select id="start-plan" className={`${selectClass} w-full`} value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">Choose a plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id} disabled={change && p.id === initial.row.plan_id && ["active", "authenticated"].includes(initial.row.status)}>
                  {p.name} v{p.version}: {p.price ? `${formatPaise(p.price)} a ${p.interval}` : "free"}
                </option>
              ))}
            </select>
          </div>
          {blocked && <p className="text-sm text-warning-text">{blocked}</p>}
          {err && (
            <p role="alert" className="text-sm text-destructive">
              {err}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={busy || !tenant || !plan || Boolean(blocked)}
            onClick={() =>
              submit({ action: "start", tenant, plan }, (r) => ({
                text: `${chosen?.name || plan} ${r.local ? "is active" : "is waiting for the founder's payment"} for ${tenant}.${r.previous?.ended === "cycle_end" ? " The old subscription ends at the end of its period." : r.previous?.ended === "now" ? " The old subscription has ended." : r.previous?.error ? ` The old subscription could not be cancelled: ${r.previous.error}` : ""}`,
                link: r.shortUrl || null,
              }))
            }
          >
            {busy ? "Starting…" : change ? "Change plan" : "Start plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GraceDialog({ row, onClose, onDone }) {
  const [days, setDays] = useState("7");
  const [reason, setReason] = useState("");
  const { busy, err, submit } = useSubmit(onDone);
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 30 && reason.trim();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extend grace for {row.store_name || row.tenant_id}</DialogTitle>
          <DialogDescription>
            Checkout keeps working until the grace period ends. {row.grace_until ? `It ends ${shortDate(row.grace_until)} now.` : "There is no grace period now."} Add up to 30 days.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="grace-days" className="mb-1">
              Days to add
            </Label>
            <Input id="grace-days" type="number" min="1" max="30" step="1" value={days} onChange={(e) => setDays(e.target.value)} className="w-28" />
          </div>
          <div>
            <Label htmlFor="grace-reason" className="mb-1">
              Reason
            </Label>
            <Textarea id="grace-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why this store gets more time" />
          </div>
          {err && (
            <p role="alert" className="text-sm text-destructive">
              {err}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={busy || !valid} onClick={() => submit({ action: "grace", subscription: row.id, days: n, reason: reason.trim() }, (r) => ({ text: `Grace for ${row.tenant_id} now ends ${shortDate(r.grace_until)}.` }))}>
            {busy ? "Saving…" : "Extend grace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ row, onClose, onDone }) {
  const [when, setWhen] = useState("cycle_end");
  const [reason, setReason] = useState("");
  const { busy, err, submit } = useSubmit(onDone);
  const name = row.store_name || row.tenant_id;
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel {name}&apos;s subscription?</AlertDialogTitle>
          <AlertDialogDescription>
            {row.provider
              ? "This cancels the subscription at Razorpay. It can't be undone: to bill this store again, start a new plan."
              : "The free subscription ends now and the usual grace period starts; checkout pauses when it ends. This can't be undone: to bill this store again, start a new plan."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {row.provider && (
          <RadioGroup value={when} onValueChange={setWhen} aria-label="When it ends" className="gap-2">
            <label htmlFor="cancel-cycle-end" className="flex items-start gap-2 text-sm">
              <RadioGroupItem id="cancel-cycle-end" value="cycle_end" className="mt-0.5" />
              <span>
                At the end of the period already paid for{row.current_end ? ` (${shortDate(row.current_end)})` : ""}. <span className="text-muted-foreground">Recommended.</span>
              </span>
            </label>
            <label htmlFor="cancel-now" className="flex items-start gap-2 text-sm">
              <RadioGroupItem id="cancel-now" value="now" className="mt-0.5" />
              <span>Now. The founder loses the rest of the period they paid for.</span>
            </label>
          </RadioGroup>
        )}
        <div>
          <Label htmlFor="cancel-reason" className="mb-1">
            Reason (kept in the audit log)
          </Label>
          <Textarea id="cancel-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </div>
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
            onClick={(e) => {
              e.preventDefault();
              submit({ action: "cancel", subscription: row.id, atCycleEnd: when === "cycle_end", reason: reason.trim() }, (r) => ({
                text: r.local ? `${name}'s free subscription has ended.` : r.ended === "cycle_end" ? `${name}'s subscription will end at the end of its period. Razorpay confirms it by webhook.` : `${name}'s subscription was cancelled at Razorpay. Razorpay confirms it by webhook.`,
              }));
            }}
          >
            {busy ? "Cancelling…" : "Cancel subscription"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
