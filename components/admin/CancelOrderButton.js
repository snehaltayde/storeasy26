"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { DangerDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// S51: in-product order cancellation (was CLI-only). The server owns the
// policy (lib/order-cancel.js): Shopify is cancelled first (restock, no
// refund, no customer email), and CAPTURED payments are refused unless a
// Razorpay refund id is recorded — refunds themselves stay manual.
export default function CancelOrderButton({ orderId, paymentCaptured = false }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [refundId, setRefundId] = useState("");
  const toast = useToast();
  const router = useRouter();

  async function doCancel() {
    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "cancel",
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(refundId.trim() ? { refundId: refundId.trim() } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Cancel failed (${res.status})`);
    toast.success(
      data.already
        ? "Order was already cancelled"
        : data.shopifyCancelled
          ? "Cancelled here and in Shopify (restocked, no refund)"
          : "Order cancelled",
    );
    router.refresh();
  }

  return (
    <>
      <Button
        size="sm"
        variant="dangerOutline"
        icon={<Ban size={13} aria-hidden />}
        onClick={() => {
          setReason("");
          setRefundId("");
          setOpen(true);
        }}
      >
        Cancel order
      </Button>
      <DangerDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel this order?"
        confirmLabel="Cancel order"
        typedConfirmation={orderId}
        onConfirm={doCancel}
        body={
          <div className="space-y-3">
            <p>
              If the order reached Shopify it is cancelled there too — items restock, no refund is issued, and the
              customer is not emailed.
            </p>
            <Field label="Reason" hint="Recorded on the order's timeline." htmlFor="cancel-reason">
              <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer request" />
            </Field>
            {paymentCaptured && (
              <Field
                label="Razorpay refund id"
                hint="This payment is captured — refund it in Razorpay first, then record the rfnd_… id here."
                htmlFor="cancel-refund-id"
              >
                <Input id="cancel-refund-id" mono value={refundId} onChange={(e) => setRefundId(e.target.value)} placeholder="rfnd_…" />
              </Field>
            )}
          </div>
        }
      />
    </>
  );
}
