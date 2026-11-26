import { Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { orderTime } from "@/lib/admin/order-view";

// Phase 9 line 4: the order's parcel as Shiprocket last reported it
// (lib/shipments.js trackingForOrder). orders.read, so support sees it too:
// it holds no customer details (scans keep only time, hub and activity, with
// names and phone numbers taken out). Nothing renders without a parcel.
//   shipment: trackingForOrder(…) | null; timeZone: the store's
export const SHIPMENT_WORDS = Object.freeze({
  placed: ["Waiting for pickup", "muted"],
  in_transit: ["In transit", "info"],
  out_for_delivery: ["Out for delivery", "info"],
  delivered: ["Delivered", "success"],
  returning: ["Returning to you", "warning"],
  cancelled: ["Cancelled", "muted"],
  exception: ["Delayed or failed", "danger"],
});

export function ShipmentCard({ shipment, timeZone }) {
  if (!shipment) return null;
  const [words, tone] = SHIPMENT_WORDS[shipment.status] || SHIPMENT_WORDS.in_transit;
  const rows = [
    ["AWB", shipment.awb],
    ["Courier", shipment.courier || "—"],
    ["Shiprocket says", shipment.statusLabel || "—"],
    ["Expected", shipment.etd ? orderTime(shipment.etd, timeZone) : "—"],
    ...(shipment.deliveredAt ? [["Delivered", orderTime(shipment.deliveredAt, timeZone)]] : []),
    ...(shipment.returnAwb ? [["Return AWB", shipment.returnAwb]] : []),
    ["Last checked", shipment.fetchedAt ? orderTime(shipment.fetchedAt, timeZone) : "—"],
  ];
  const last = shipment.scans.at(-1);
  return (
    <Card data-shipment-card={shipment.status}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[1.125rem]">
          <Truck aria-hidden className="size-4" />
          Shipment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Badge variant={tone}>{words}</Badge>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {last && (
          <p className="text-muted-foreground">
            Latest: {last.activity || "Update"}
            {last.hub ? ` · ${last.hub}` : ""} · {orderTime(last.at, timeZone)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
