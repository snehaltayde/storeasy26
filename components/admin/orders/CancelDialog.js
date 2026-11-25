"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/console/Toast";
import { cancelAnswer } from "@/lib/admin/order-view";

// Cancel an order (orders.cancel; docs/plans/phase-2.md "Line 2" §1.6). The
// server owns the policy (lib/order-cancel.js): an order in Shopify is
// cancelled there first (restock, no refund, no customer email), and a
// captured payment needs its Razorpay refund done first and the refund id
// recorded here. A refusal stays in the dialog with what was typed.
const MAX_REASON = 200;

export function CancelDialog({ orderId, paymentCaptured = false, open, onOpenChange, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [refundId, setRefundId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const needsRefund = paymentCaptured && !refundId.trim();

  async function cancel(e) {
    e.preventDefault(); // stay open until the server answers
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", ...(reason.trim() ? { reason: reason.trim() } : {}), ...(refundId.trim() ? { refundId: refundId.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      const answer = cancelAnswer(data, res.status);
      if (!answer.ok) return setError(answer.text);
      toast.success(answer.text);
      onOpenChange(false);
      onDone?.();
    } catch {
      setError("We couldn't reach the server. What you typed is still here; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel order {orderId}?</AlertDialogTitle>
          <AlertDialogDescription>If the order is in Shopify it is cancelled there too: items restock, no refund is issued and the customer is not emailed. This can&apos;t be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4">
          {paymentCaptured && (
            // the refund comes first: it is the one thing that must happen elsewhere
            <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 p-3">
              <Label htmlFor="cancel-refund-id">Razorpay refund id</Label>
              <p id="cancel-refund-hint" className="text-xs text-foreground">
                This order was paid online. Refund it in Razorpay first, then paste the refund id here (it starts with rfnd_). Cancelling here moves no money.
              </p>
              <Input id="cancel-refund-id" className="bg-card font-mono" value={refundId} maxLength={80} onChange={(e) => setRefundId(e.target.value)} placeholder="rfnd_…" aria-describedby="cancel-refund-hint" aria-required="true" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Textarea id="cancel-reason" value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON))} placeholder="e.g. The customer asked to cancel" aria-describedby="cancel-reason-hint" rows={3} />
            <p id="cancel-reason-hint" className="flex justify-between text-xs text-muted-foreground">
              <span>Optional. Saved on the order&apos;s timeline.</span>
              <span className="font-mono tabular-nums">
                {reason.length}/{MAX_REASON}
              </span>
            </p>
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/5 px-3 py-2 text-[0.8125rem] text-destructive">
              {error}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep the order</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy || needsRefund} aria-describedby={needsRefund ? "cancel-refund-hint" : undefined} onClick={cancel}>
            {busy ? "Cancelling…" : "Cancel order"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
