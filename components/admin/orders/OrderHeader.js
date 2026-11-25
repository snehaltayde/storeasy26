"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/kit/page-header";
import { StatusBadge } from "@/components/kit/status-badge";
import { orderTime, paymentWords } from "@/lib/admin/order-view";

// The order page's title row (docs/plans/phase-2.md "Line 2" §1.3): the id
// with Copy (a read: it only writes the clipboard, so data-read-control), the
// status, the financial and fulfilment states Shopify reports, and the page's
// actions (OrderActions, already role-gated).
const PLAIN = (s) => String(s).toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function OrderHeader({ order, timeZone, actions = null }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(order.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <PageHeader
      breadcrumb={[{ label: "Orders", href: "/admin/orders" }, { label: order.id }]}
      // The id is the heading (with Copy); the states sit under it so the
      // heading's name stays the id and the badges wrap on a phone.
      title={
        <span className="inline-flex max-w-full items-center gap-1.5 py-0.5 pr-0.5">
          <span className="truncate font-mono">{order.id}</span>
          <Button type="button" variant="ghost" size="icon-sm" data-read-control aria-label={copied ? "Order id copied" : "Copy order id"} onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </span>
      }
      description={
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <StatusBadge kind="order" status={order.status} />
          {order.financial_status && <Badge variant={order.refunded_total > 0 ? "warning" : "muted"}>Shopify: {PLAIN(order.financial_status).toLowerCase()}</Badge>}
          {order.fulfillment_status && <Badge variant="muted">{PLAIN(order.fulfillment_status)}</Badge>}
          <span>
            {paymentWords(order.payment_method)}, placed {orderTime(order.created_at, timeZone)}
          </span>
        </span>
      }
      actions={actions}
    />
  );
}
