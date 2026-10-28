import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { getOrder, verifyOrderStatusToken, ORDER_STATUS } from "@/lib/orders";
import { getOrderProjection, reconcileOrderProjection } from "@/lib/order-projection";
import { formatMoney } from "@/lib/format";
import { siteSupport } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Guest order-status page (Session 18; S31 projection-backed). Reachable ONLY
// via the tokenized link. Renders our durable state machine PLUS the local
// financial/fulfillment projection (per-parcel tracking with last-update
// timestamps — a carrier/provider outage shows as stale data, never a broken
// page). A view with a stale projection triggers an after() reconcile, so the
// next refresh is fresh. Needs the Admin API for that → Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Order status", robots: { index: false }, referrer: "no-referrer" };

const STEPS = [
  { key: "placed", label: "Order placed" },
  { key: "confirmed", label: "Payment confirmed" },
  { key: "processing", label: "Being prepared" },
  { key: "shipped", label: "Shipped" },
];

function deriveSteps(order) {
  const cancelled = order.status === ORDER_STATUS.CANCELLED || order.financial_status === "voided";
  const shipped = ["fulfilled", "partially_fulfilled"].includes(order.fulfillment_status || "");
  const confirmed =
    order.payment_status === "paid" || order.payment_method === "cod"; // COD = confirmed on placement
  const processing = [ORDER_STATUS.SYNCING_SHOPIFY, ORDER_STATUS.SYNCED].includes(order.status) || shipped;
  const reached = { placed: true, confirmed, processing, shipped };
  const current = shipped ? "shipped" : processing ? "processing" : confirmed ? "confirmed" : "placed";
  return { cancelled, reached, current };
}

const ago = (iso) => {
  if (!iso) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (24 * 60))}d ago`;
};

export default async function OrderStatusPage({ params, searchParams }) {
  const { orderId } = await params;
  const { t } = await searchParams;
  if (!(await tfetch(() => verifyOrderStatusToken(orderId, t)))) notFound();
  const order = await tfetch(() => getOrder(orderId));
  const support = await tfetch(async () => siteSupport());
  if (!order) notFound();

  const projection = await tfetch(() => getOrderProjection(orderId));
  const { cancelled, reached, current } = deriveSteps(order);
  const cod = order.payment_method === "cod";

  // Freshness: every view of a pushed order refreshes the projection in the
  // background (same per-view cost as the old live fetch, but the page never
  // waits on Shopify — an outage just means "updated …ago" grows).
  if (order.shopify_order_id) {
    after(() => tfetch(() => reconcileOrderProjection(orderId)).catch(() => {}));
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div className="rounded-2xl border border-zinc-200 p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Order status</h1>
            <p className="text-sm text-zinc-500">
              {order.id} · placed{" "}
              {new Date(order.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              cancelled ? "bg-red-50 text-red-600" : "bg-accent-100 text-accent-800"
            }`}
          >
            {cancelled ? "CANCELLED" : STEPS.find((s) => s.key === current)?.label}
          </span>
        </div>

        {!cancelled && (
          <ol className="mt-6 space-y-3">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex items-center gap-3">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    reached[s.key] ? "bg-accent-400 text-accent-label" : "bg-zinc-100 text-zinc-400"
                  }`}
                >
                  {reached[s.key] ? "✓" : i + 1}
                </span>
                <span className={reached[s.key] ? "text-sm font-medium" : "text-sm text-zinc-400"}>
                  {s.label}
                  {s.key === "confirmed" && cod ? " (Cash on Delivery)" : ""}
                </span>
              </li>
            ))}
          </ol>
        )}

        {cancelled && (
          <p className="mt-4 text-sm text-zinc-600">
            This order was cancelled. If a payment was captured, the refund is processed back to
            the original payment method — reach us{support.email ? ` at ${support.email}` : ""} with
            your order id for anything unclear.
          </p>
        )}

        {projection.fulfillments.length > 0 && (
          <div className="mt-5 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
              {projection.fulfillments.length > 1 ? `Shipments (${projection.fulfillments.length} packages)` : "Shipment"}
            </p>
            {projection.fulfillments.map((f, i) => (
              <div key={f.id} className="rounded-xl bg-zinc-50 p-4">
                <p className="text-sm">
                  {projection.fulfillments.length > 1 ? <span className="mr-2 text-xs font-bold text-zinc-400">#{i + 1}</span> : null}
                  {f.tracking_company ? `${f.tracking_company} · ` : ""}
                  {f.tracking_number ? (
                    f.tracking_url ? (
                      <a href={f.tracking_url} className="font-semibold text-accent-700 underline" target="_blank" rel="noopener noreferrer">
                        {f.tracking_number}
                      </a>
                    ) : (
                      <span className="font-semibold">{f.tracking_number}</span>
                    )
                  ) : (
                    <span className="text-zinc-500">Preparing shipment</span>
                  )}
                  {f.status === "CANCELLED" ? <span className="ml-2 text-xs text-red-500">cancelled</span> : null}
                </p>
                {f.updated_at && <p className="mt-1 text-xs text-zinc-400">carrier status updated {ago(f.updated_at)}</p>}
              </div>
            ))}
          </div>
        )}

        {(order.refunded_total || 0) > 0 && (
          <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm">
            <p className="font-semibold text-amber-800">
              {order.financial_status === "refunded" ? "Fully refunded" : "Partially refunded"} ·{" "}
              {formatMoney(order.refunded_total, order.currency)}
            </p>
            <p className="mt-0.5 text-xs text-amber-700">
              Refunds reach the original payment method in 5–7 business days.
            </p>
          </div>
        )}

        <ul className="mt-6 divide-y divide-zinc-100 border-y border-zinc-100">
          {order.items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                {it.image ? <Image src={it.image} alt={it.title} fill sizes="48px" className="object-cover" /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{it.title}</p>
                <p className="text-xs text-zinc-500">{it.is_gift ? "Free gift 🎁" : `Qty ${it.quantity}`}</p>
              </div>
              <span className={`text-sm font-semibold ${it.is_gift ? "text-accent-700" : ""}`}>
                {it.is_gift ? "FREE" : formatMoney(it.line_total, order.currency)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex justify-between text-sm">
          <span className="text-zinc-500">
            Total ({cod ? "due on delivery" : order.payment_status === "paid" ? "paid" : "pending"})
          </span>
          <span className="text-base font-bold">{formatMoney(order.total, order.currency)}</span>
        </div>

        {(support.email || support.phone) && (
          <p className="mt-6 border-t border-zinc-100 pt-4 text-xs text-zinc-400">
            Questions?{" "}
            {support.email && (
              <a href={`mailto:${support.email}`} className="underline">
                {support.email}
              </a>
            )}
            {support.email && support.phone ? " · " : ""}
            {support.phone && (
              <a href={`tel:${support.phone.replace(/[^+\d]/g, "")}`} className="underline">
                {support.phone}
              </a>
            )}
          </p>
        )}
        <Link href="/" className="mt-4 inline-block rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800">
          Continue shopping
        </Link>
      </div>
    </div>
  );
}
