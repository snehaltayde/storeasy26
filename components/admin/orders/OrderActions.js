"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/console/Toast";
import { pushAnswer, reconcileAnswer } from "@/lib/admin/order-view";
import { CancelDialog } from "./CancelDialog";

// The order page's writes (docs/plans/phase-2.md "Line 2" §1.4-1.7):
//   Push to Shopify (orders.push), only when canPush allows it;
//   Refresh from Shopify (orders.push, reconcile), only once pushed;
//   Cancel order (orders.cancel), only when the state machine allows it.
// `can` comes from the page, already the role's permission AND the order's
// state; RoleGate hides each control again for a role without the action
// (staff, support), so neither a stray prop nor a stale page shows a button
// the server will refuse. Each answer is a toast in plain words, then the
// page refreshes.
const NO_PUSH = "Only the store owner or an admin can send orders to Shopify.";
const NO_CANCEL = "Only the store owner or an admin can cancel orders.";

export function OrderActions({ orderId, role, can = {}, paymentCaptured = false }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(null); // "push" | "reconcile"
  const [cancelOpen, setCancelOpen] = useState(false);

  async function run(action, words) {
    setBusy(action);
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      const answer = words(data, res.status);
      (answer.ok ? toast.success : toast.info)(answer.text);
    } catch {
      toast.info("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  if (!can.push && !can.reconcile && !can.cancel) return null;
  return (
    <>
      {can.push && (
        <RoleGate role={role} action="orders.push" reason={NO_PUSH} mode="hide">
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => run("push", pushAnswer)}>
            <Upload aria-hidden />
            {busy === "push" ? "Sending…" : "Push to Shopify"}
          </Button>
        </RoleGate>
      )}
      {can.reconcile && (
        <RoleGate role={role} action="orders.push" reason={NO_PUSH} mode="hide">
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => run("reconcile", reconcileAnswer)}>
            <RefreshCw aria-hidden />
            {busy === "reconcile" ? "Refreshing…" : "Refresh from Shopify"}
          </Button>
        </RoleGate>
      )}
      {can.cancel && (
        <>
          <RoleGate role={role} action="orders.cancel" reason={NO_CANCEL} mode="hide">
            <Button type="button" size="sm" variant="destructive" disabled={busy !== null} onClick={() => setCancelOpen(true)}>
              <Ban aria-hidden />
              Cancel order
            </Button>
          </RoleGate>
          {cancelOpen && <CancelDialog orderId={orderId} paymentCaptured={paymentCaptured} open={cancelOpen} onOpenChange={setCancelOpen} onDone={() => router.refresh()} />}
        </>
      )}
    </>
  );
}
