import Link from "next/link";
import Image from "@/components/StoreImage";
import { notFound } from "next/navigation";
import TrackEvent from "@/components/analytics/TrackEvent";
import { getOrder, orderStatusPath, verifyOrderStatusToken } from "@/lib/orders";
import { formatMoney } from "@/lib/format";
import { numericId } from "@/lib/ids";
import { tfetch } from "@/lib/storefront-request";
import { tenantCfg } from "@/lib/tenant-context";
import { DEFAULT_TIME_ZONE } from "@/lib/delivery-estimate";
import DeliveryEstimate from "@/components/checkout/DeliveryEstimate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order confirmed", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ConfirmationPage({ params, searchParams }) {
  const { orderId } = await params;
  const { t } = await searchParams;
  // S25 (SF08 containment): this page renders PII, so it requires the same
  // tokenized proof as /orders/[orderId] — verified BEFORE any order read.
  // Bad token and unknown order are indistinguishable (404 either way), so
  // order-id enumeration reveals nothing.
  if (!(await tfetch(() => verifyOrderStatusToken(orderId, t)))) notFound();
  const order = await tfetch(() => getOrder(orderId));
  if (!order) notFound();

  // Phase 8 line 1: "Expected by …" from the estimate the order was placed with
  const timeZone = await tfetch(() => tenantCfg("timezone", null, DEFAULT_TIME_ZONE));
  const cod = order.payment_method === "cod";
  const paid = order.payment_status === "paid";
  // The checkout sends a customer here when it couldn't yet record their payment.
  const confirming = !cod && !paid;

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      {/* Browser copy of the purchase event: SAME event_id (= order id) as the
          server-enqueued copy, so both collapse into one stored event — this
          one contributes the browser's first-party cookies. */}
      {confirming ? null : (
        <TrackEvent
          name="purchase"
          data={{
            event_id: order.id,
            value: order.total,
            currency: order.currency || "INR",
            items: order.items.map((it) => ({
              id: numericId(it.variant_id) || it.variant_id,
              name: it.title,
              price: it.unit_price,
              quantity: it.quantity,
            })),
            params: { transaction_id: order.id, payment_type: order.payment_method },
          }}
        />
      )}
      <div className="rounded-sf-card border border-sf-border p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sf-accent-soft text-lg font-bold text-sf-accent-text">
            ✓
          </span>
          <div>
            <h1 className="text-xl font-bold">{confirming ? "Confirming your payment" : "Order confirmed"}</h1>
            <p className="text-sm text-sf-text-subtle">Order {order.id}</p>
          </div>
        </div>

        <p className="mt-4 text-sm text-sf-text-muted">
          Thanks {order.name ? order.name.split(" ")[0] : "there"}!{" "}
          {cod ? "You'll pay cash on delivery." : paid ? "Payment received." : "If you've paid, please don't pay again."}{" "}
          {confirming ? "We'll email" : "A confirmation was sent to"} {order.email}
          {confirming ? " once it's confirmed." : "."} Keep your{" "}
          <Link href={await tfetch(() => orderStatusPath(order.id))} className="font-semibold text-sf-accent-text underline">
            order-status link
          </Link>{" "}
          to track it anytime.
        </p>

        <ul className="mt-6 divide-y divide-sf-border-soft border-y border-sf-border-soft">
          {order.items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                {it.image ? <Image src={it.image} alt={it.title} fill sizes="48px" className="object-cover" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{it.title}</p>
                <p className="text-xs text-sf-text-subtle">{it.is_gift ? "Free gift 🎁" : `Qty ${it.quantity}`}</p>
              </div>
              <span className={`text-sm font-semibold ${it.is_gift ? "text-sf-accent-text" : ""}`}>
                {it.is_gift ? "FREE" : formatMoney(it.line_total, order.currency)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-sf-text-subtle">Subtotal</span>
            <span>{formatMoney(order.subtotal, order.currency)}</span>
          </div>
          {order.appliedOffers
            .filter((o) => o.amount > 0)
            .map((o) => (
              <div key={o.id} className="flex justify-between gap-3 text-sf-accent-text">
                <span className="leading-snug">{o.label}</span>
                <span className="whitespace-nowrap">−{formatMoney(o.amount, order.currency)}</span>
              </div>
            ))}
          <div className="flex justify-between">
            <span className="text-sf-text-subtle">{order.snapshot?.shipping?.label || "Shipping"}</span>
            {(order.shipping_total || 0) === 0 ? (
              <span className="font-semibold text-sf-accent-text">FREE</span>
            ) : (
              <span>{formatMoney(order.shipping_total, order.currency)}</span>
            )}
          </div>
          <div className="flex justify-between border-t border-sf-border-soft pt-2 text-base font-bold">
            <span>Total</span>
            <span>{formatMoney(order.total, order.currency)}</span>
          </div>
        </div>

        <div className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-sf-text-faint">Shipping to</p>
            <p className="mt-1 font-medium">{order.name}</p>
            <p className="text-sf-text-muted">
              {order.address_line1}
              {order.address_line2 ? `, ${order.address_line2}` : ""}, {order.city}, {order.state}{" "}
              {order.pincode}
            </p>
            <p className="text-sf-text-muted">{order.phone}</p>
            {order.status !== "cancelled" && <DeliveryEstimate kind="expected" estimate={order.snapshot?.shipping?.estimate} from={order.created_at} timeZone={timeZone} className="mt-1 font-medium" />}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-sf-text-faint">Payment</p>
            <p className="mt-1 font-medium">{cod ? "Cash on Delivery" : "Online payment"}</p>
            <p className="text-sf-text-muted">
              {paid
                ? `Paid · ${order.razorpay_payment_id || ""}`
                : cod
                  ? "Due on delivery"
                  : "Pending"}
            </p>
          </div>
        </div>

        <Link
          href="/"
          className="mt-8 inline-block rounded-full bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover"
        >
          Continue shopping
        </Link>
      </div>
    </div>
  );
}
