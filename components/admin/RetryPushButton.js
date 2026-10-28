"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { pushResultMessage } from "@/lib/admin/order-view";
import { Button } from "@/components/console/Button";
import { useToast } from "@/components/console/Toast";

// S31 (MC16): says what actually happened — push REFUSALS arrive as HTTP 200
// with reason keys (skipped/inFlight/mismatch/dead), which used to render as
// the nonsense "Push failed: 200". S50: result goes to a toast.
export default function RetryPushButton({ orderId }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function retry() {
    setBusy(true);
    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "push" }),
    });
    const data = await res.json().catch(() => ({}));
    const msg = pushResultMessage(data, res.status);
    (res.ok && data.ok && !data.skipped ? toast.success : toast.info)(msg);
    setBusy(false);
    router.refresh();
  }

  return (
    <Button size="sm" icon={<RefreshCw size={13} aria-hidden />} busy={busy} onClick={retry}>
      Retry Shopify push
    </Button>
  );
}
