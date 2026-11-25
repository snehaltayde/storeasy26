"use client";

import { useState } from "react";
import Link from "next/link";
import { Info, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { orderTime } from "@/lib/admin/order-view";

// The Returns tab (?view=returns; docs/plans/phase-2.md "Line 2" §1.2): open
// requests with the order link, the shopper's reason and the requested date;
// approve or reject with a note (returns.decide, an AlertDialog). Approving
// moves no money: refunds stay with the payment provider and mirror onto the
// order. A role without returns.decide (support) sees each request's status
// only: RoleGate hides the decisions.
const RETURN_WORDS = {
  requested: ["Requested", "warning"],
  approved: ["Approved", "info"],
  rejected: ["Rejected", "muted"],
  completed: ["Received", "success"],
};
const OPEN = ["requested", "approved"];
const DECISIONS = {
  approve: { title: "Approve this return?", body: "The shopper is told to send the items back. No refund happens here: refund through your payment provider and the order mirrors it.", confirm: "Approve return" },
  complete: { title: "Mark the items received?", body: "The return is closed as received. Refund through your payment provider if one is due; the order mirrors it.", confirm: "Mark received" },
  reject: { title: "Reject this return?", body: "The shopper sees the rejection and your note.", confirm: "Reject return" },
};
const REASON = "Your role can view returns but not decide them.";

function ReturnStatus({ status }) {
  const [label, tone] = RETURN_WORDS[status] || ["Unknown", "muted"];
  return (
    <Badge variant={tone} data-status={status}>
      {label}
    </Badge>
  );
}

function ReturnRow({ r, role, timeZone, onDecide }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <ReturnStatus status={r.status} />
          <Link href={`/admin/orders/${encodeURIComponent(r.order_id)}`} data-read-control className="rounded-md font-mono font-medium text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            {r.order_id}
          </Link>
          <span className="text-xs text-muted-foreground">Requested {orderTime(r.created_at, timeZone)}</span>
        </div>
        {r.pii_redacted ? (
          <p className="text-sm text-muted-foreground">Reason hidden for support</p>
        ) : (
          <p className="max-w-prose text-sm break-words text-foreground">“{r.reason}”</p>
        )}
        {r.note && <p className="text-xs text-muted-foreground">Your note: {r.note}</p>}
      </div>
      {/* the amount is last at a fixed width, so amounts line up down the list */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-end">
        {OPEN.includes(r.status) && (
          <>
            {r.status === "requested" ? (
              <RoleGate role={role} action="returns.decide" reason={REASON} mode="hide">
                <Button type="button" size="sm" onClick={() => onDecide(r, "approve")}>
                  Approve
                </Button>
              </RoleGate>
            ) : (
              <RoleGate role={role} action="returns.decide" reason={REASON} mode="hide">
                <Button type="button" size="sm" onClick={() => onDecide(r, "complete")}>
                  Mark received
                </Button>
              </RoleGate>
            )}
            <RoleGate role={role} action="returns.decide" reason={REASON} mode="hide">
              <Button type="button" size="sm" variant="destructive" onClick={() => onDecide(r, "reject")}>
                Reject
              </Button>
            </RoleGate>
          </>
        )}
        <MoneyCell amount={r.total} currency={r.currency} className="order-first w-24 text-left text-[0.8125rem] sm:order-none sm:text-right" />
      </div>
    </li>
  );
}

export function ReturnsList({ returns = [], role, timeZone }) {
  const router = useRouter();
  const toast = useToast();
  const [decision, setDecision] = useState(null); // { r, action }
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = returns.filter((r) => OPEN.includes(r.status));
  const closed = returns.filter((r) => !OPEN.includes(r.status));
  const words = decision ? DECISIONS[decision.action] : null;

  function start(r, action) {
    setDecision({ r, action });
    setNote("");
    setError(null);
  }

  async function decide(e) {
    e.preventDefault(); // keep the dialog open until the server answers
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: decision.r.id, action: decision.action, note: note.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) throw new Error("Your role can't decide returns. Ask the store owner or an admin.");
      if (!res.ok) throw new Error(res.status >= 500 ? "We couldn't save that just now. Your note is still here; try again in a minute." : "This request changed since you opened it. Close this, refresh the page and try again.");
      toast.success(`Return ${RETURN_WORDS[data.status]?.[0].toLowerCase() || "updated"}. No money moved.`);
      setDecision(null);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="flex gap-2 text-[0.8125rem] text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
        <span>Approving a return authorises the shopper to send items back. It moves no money: refund through your payment provider and the order mirrors it.</span>
      </p>
      {open.length === 0 ? (
        <EmptyState icon={Undo2} title="No open return requests" description="Requests shoppers make from their account pages show here." />
      ) : (
        <Card className="gap-0 py-0">
          <ul aria-label="Open return requests" className="divide-y divide-border">
            {open.map((r) => (
              <ReturnRow key={r.id} r={r} role={role} timeZone={timeZone} onDecide={start} />
            ))}
          </ul>
        </Card>
      )}
      {closed.length > 0 && (
        <section>
          <h2 className="mb-2 text-[0.8125rem] font-medium text-muted-foreground">Resolved ({closed.length})</h2>
          <Card className="gap-0 py-0">
            <ul aria-label="Resolved return requests" className="divide-y divide-border">
              {closed.map((r) => (
                <ReturnRow key={r.id} r={r} role={role} timeZone={timeZone} onDecide={start} />
              ))}
            </ul>
          </Card>
        </section>
      )}
      <AlertDialog open={Boolean(decision)} onOpenChange={(o) => !o && !busy && setDecision(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{words?.title}</AlertDialogTitle>
            <AlertDialogDescription>{words?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="return-note">Note to the shopper (optional)</Label>
            <Textarea id="return-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Please use the original box" />
          </div>
          {error && (
            <p role="alert" className="text-[0.8125rem] text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it as it is</AlertDialogCancel>
            <AlertDialogAction variant={decision?.action === "reject" ? "destructive" : "default"} disabled={busy} onClick={decide}>
              {busy ? "Saving…" : words?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
