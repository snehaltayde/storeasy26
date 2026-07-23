import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getOrder, verifyOrderStatusToken, ORDER_STATUS } from "@/lib/orders";
import { getShopifyOrderStatus } from "@/lib/shopify-order-status";
import { formatMoney } from "@/lib/format";

// Guest order-status page (Session 18): reachable ONLY via the tokenized link
// (confirmation page + future comms). Merges our durable state machine with
// Shopify's live fulfillment + tracking. Needs the Admin API → Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Order status", robots: { index: false } };

const STEPS = [
  { key: "placed", label: "Order placed" },
  { key: "confirmed", label: "Payment confirmed" },
  { key: "processing", label: "Being prepared" },
  { key: "shipped", label: "Shipped" },
];

function deriveSteps(order, shopify) {
  const cancelled = order.status === ORDER_STATUS.CANCELLED || shopify?.cancelledAt;
  const shipped = ["FULFILLED", "PARTIALLY_FULFILLED", "IN_TRANSIT"].includes(
    shopify?.fulfillment || "",
  );
  const confirmed =
    order.payment_status === "paid" || order.payment_method === "cod"; // COD = confirmed on placement
  const processing = [ORDER_STATUS.SYNCING_SHOPIFY, ORDER_STATUS.SYNCED].includes(order.status) || shipped;
  const reached = { placed: true, confirmed, processing, shipped };
  const current = shipped ? "shipped" : processing ? "processing" : confirmed ? "confirmed" : "placed";
  return { cancelled, reached, current };
}

export default async function OrderStatusPage({ params, searchParams }) {
  const { orderId } = await params;
  const { t } = await searchParams;
  if (!(await verifyOrderStatusToken(orderId, t))) notFound();
  const order = await getOrder(orderId);
  if (!order) notFound();

  const shopify = await getShopifyOrderStatus(order.shopify_order_id);
  const { cancelled, reached, current } = deriveSteps(order, shopify);
  const cod = order.payment_method === "cod";

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div className="rounded-2xl border border-zinc-200 p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Order status</h1>
            <p className="text-sm text-zinc-500">
              {order.id}
              {shopify?.name ? ` · ${shopify.name}` : ""} · placed{" "}
              {new Date(order.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              cancelled ? "bg-red-50 text-red-600" : "bg-lime-100 text-lime-800"
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
                    reached[s.key] ? "bg-lime-400 text-zinc-950" : "bg-zinc-100 text-zinc-400"
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
            the original payment method — reach us at care@beastlife.in with your order id for
            anything unclear.
          </p>
        )}

        {shopify?.tracking?.length > 0 && (
          <div className="mt-5 rounded-xl bg-zinc-50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Tracking</p>
            {shopify.tracking.map((tr) => (
              <p key={tr.number} className="mt-1 text-sm">
                {tr.company ? `${tr.company} · ` : ""}
                {tr.url ? (
                  <a href={tr.url} className="font-semibold text-lime-700 underline" target="_blank" rel="noopener noreferrer">
                    {tr.number}
                  </a>
                ) : (
                  <span className="font-semibold">{tr.number}</span>
                )}
              </p>
            ))}
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
              <span className={`text-sm font-semibold ${it.is_gift ? "text-lime-700" : ""}`}>
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

        <p className="mt-6 border-t border-zinc-100 pt-4 text-xs text-zinc-400">
          Questions? <a href="mailto:care@beastlife.in" className="underline">care@beastlife.in</a> ·{" "}
          <a href="tel:+919599339358" className="underline">+91-9599339358</a> (Mon–Sat, 10am–10pm)
        </p>
        <Link href="/" className="mt-4 inline-block rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800">
          Continue shopping
        </Link>
      </div>
    </div>
  );
}
