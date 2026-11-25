import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/format";
import { SHOPIFY_LINE_CLASS } from "@/lib/admin/order-view";

// The order's lines and totals (docs/plans/phase-2.md "Line 2" §1.3). Under a
// line the shopper saw under another title, "Shopify title: X, SKU: Y"
// (OVL-06, lib/admin/order-view.js shopifyMatchLine; the page passes one entry
// per line, null where the titles match). Discounts name the coupon.
export function OrderLines({ items = [], shopifyLines = [], totals = {}, currency }) {
  const money = (n) => formatMoney(n ?? 0, currency);
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b border-border py-3">
        <CardTitle className="text-[1.125rem]">Items ({items.length})</CardTitle>
      </CardHeader>
      <ul className="divide-y divide-border">
        {items.map((it, i) => (
          <li key={i} data-order-line className="flex items-center gap-3 px-4 py-3 text-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {it.image && <img src={it.image} alt="" className="size-10 shrink-0 rounded-md object-cover" />}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">
                {it.title}
                {it.is_gift ? (
                  <Badge variant="info" className="ml-2">
                    Gift
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {it.variant_title && it.variant_title !== "Default Title" ? `${it.variant_title}, ` : ""}qty <span className="font-mono tabular-nums">{it.quantity}</span>
              </p>
              {shopifyLines[i] && <p className={SHOPIFY_LINE_CLASS}>{shopifyLines[i]}</p>}
            </div>
            <span className="shrink-0 text-right font-mono tabular-nums">{money(it.line_total)}</span>
          </li>
        ))}
      </ul>
      <CardContent className="border-t border-border py-4">
        <dl className="ml-auto max-w-sm space-y-1 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <dt>Subtotal</dt>
            <dd className="font-mono tabular-nums">{money(totals.subtotal)}</dd>
          </div>
          {totals.discount_total > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <dt>Discounts{totals.coupon_code ? ` (coupon ${totals.coupon_code})` : ""}</dt>
              <dd className="font-mono tabular-nums">−{money(totals.discount_total)}</dd>
            </div>
          )}
          <div className="flex justify-between text-muted-foreground">
            <dt>Shipping</dt>
            <dd className="font-mono tabular-nums">{totals.shipping_total ? money(totals.shipping_total) : "Free"}</dd>
          </div>
          <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-semibold text-foreground">
            <dt>Total</dt>
            <dd className="font-mono tabular-nums">{money(totals.total)}</dd>
          </div>
          {totals.refunded_total > 0 && (
            <div className="flex justify-between text-destructive">
              <dt>Refunded</dt>
              <dd className="font-mono tabular-nums">−{money(totals.refunded_total)}</dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
