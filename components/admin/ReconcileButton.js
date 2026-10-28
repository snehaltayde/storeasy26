"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/console/Button";
import { useToast } from "@/components/console/Toast";

// S31 (BE10/MC16): authoritative refresh of refunds + fulfillment from
// Shopify. "Requested" vs confirmed outcome stay distinct states. S50:
// outcomes land as toasts.
export default function ReconcileButton({ orderId }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function reconcile() {
    setBusy(true);
    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reconcile" }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok && !data.skipped) {
      toast.success(`Synced from Shopify: ${data.financial_status || "?"} / ${data.fulfillment_status || "?"}${data.refunds ? ` · ${data.refunds} refund(s)` : ""}`);
    } else if (data.skipped) {
      toast.info(`Skipped: ${data.skipped}`);
    } else {
      toast.error(`Reconcile failed: ${data.error || res.status}`);
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <Button size="sm" icon={<Download size={13} aria-hidden />} busy={busy} onClick={reconcile}>
      Reconcile from Shopify
    </Button>
  );
}
