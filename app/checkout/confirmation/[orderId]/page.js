import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getOrder } from "@/lib/orders";
import { formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order confirmed" };

export default async function ConfirmationPage({ params }) {
  const { orderId } = await params;
  const order = await getOrder(orderId);
  if (!order) notFound();

  const cod = order.payment_method === "cod";
  const paid = order.payment_status === "paid";

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div className="rounded-2xl border border-zinc-200 p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-lime-100 text-lg font-bold text-lime-700">
            ✓
          </span>
          <div>
            <h1 className="text-xl font-bold">Order confirmed</h1>
            <p className="text-sm text-zinc-500">Order {order.id}</p>
          </div>
        </div>

        <p className="mt-4 text-sm text-zinc-600">
          Thanks {order.name ? order.name.split(" ")[0] : "there"}!{" "}
          {cod ? "You'll pay cash on delivery." : paid ? "Payment received." : "Payment is pending."} A
          confirmation was sent to {order.email}.
        </p>

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

        <div className="mt-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Subtotal</span>
            <span>{formatMoney(order.subtotal, order.currency)}</span>
          </div>
          {order.appliedOffers
            .filter((o) => o.amount > 0)
            .map((o) => (
              <div key={o.id} className="flex justify-between gap-3 text-lime-700">
                <span className="leading-snug">{o.label}</span>
                <span className="whitespace-nowrap">−{formatMoney(o.amount, order.currency)}</span>
              </div>
            ))}
          <div className="flex justify-between">
            <span className="text-zinc-500">{order.snapshot?.shipping?.label || "Shipping"}</span>
            {(order.shipping_total || 0) === 0 ? (
              <span className="font-semibold text-lime-700">FREE</span>
            ) : (
              <span>{formatMoney(order.shipping_total, order.currency)}</span>
            )}
          </div>
          <div className="flex justify-between border-t border-zinc-100 pt-2 text-base font-bold">
            <span>Total</span>
            <span>{formatMoney(order.total, order.currency)}</span>
          </div>
        </div>

        <div className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Shipping to</p>
            <p className="mt-1 font-medium">{order.name}</p>
            <p className="text-zinc-600">
              {order.address_line1}
              {order.address_line2 ? `, ${order.address_line2}` : ""}, {order.city}, {order.state}{" "}
              {order.pincode}
            </p>
            <p className="text-zinc-600">{order.phone}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Payment</p>
            <p className="mt-1 font-medium">{cod ? "Cash on Delivery" : "Razorpay"}</p>
            <p className="text-zinc-600">
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
          className="mt-8 inline-block rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          Continue shopping
        </Link>
      </div>
    </div>
  );
}
