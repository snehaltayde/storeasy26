import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { getOrder } from "@/lib/orders";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import { StatusBadge } from "@/components/admin/OrdersAdmin";
import RetryPushButton from "@/components/admin/RetryPushButton";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order · Admin", robots: { index: false } };

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export default async function AdminOrderDetail({ params }) {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const authed = await tfetch(() => verifyAdminToken(token));
  if (!authed) redirect("/admin/login");

  const { id } = await params;
  const [order, name] = await tfetch(async () => [await getOrder(id), siteName()]);
  if (!order) notFound();

  return (
    <>
      <AdminNav storeName={name} />
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <Link href="/admin/orders" className="text-sm text-zinc-500 hover:underline">
          ← Orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{order.id}</h1>
          <StatusBadge status={order.status} />
          <span className="text-sm text-zinc-500">{order.payment_method}</span>
          {order.status === "sync_failed" && <RetryPushButton orderId={order.id} />}
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <section className="rounded-2xl border border-zinc-200 p-5">
            <h2 className="text-sm font-bold">Customer</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div><dt className="inline text-zinc-500">Name: </dt><dd className="inline">{order.name || "—"}</dd></div>
              <div><dt className="inline text-zinc-500">Email: </dt><dd className="inline">{order.email || "—"}</dd></div>
              <div><dt className="inline text-zinc-500">Phone: </dt><dd className="inline">{order.phone || "—"}</dd></div>
              <div className="pt-2 text-zinc-600">
                {[order.address_line1, order.address_line2, order.city, order.state, order.pincode].filter(Boolean).join(", ") || "No address"}
              </div>
            </dl>
          </section>

          <section className="rounded-2xl border border-zinc-200 p-5">
            <h2 className="text-sm font-bold">Payment & sync</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div><dt className="inline text-zinc-500">Created: </dt><dd className="inline">{when(order.created_at)}</dd></div>
              <div><dt className="inline text-zinc-500">Paid: </dt><dd className="inline">{when(order.paid_at)}</dd></div>
              <div><dt className="inline text-zinc-500">Razorpay: </dt><dd className="inline">{order.razorpay_payment_id || order.razorpay_order_id || "—"}</dd></div>
              <div><dt className="inline text-zinc-500">Shopify order: </dt><dd className="inline">{order.shopify_order_id ? order.shopify_order_id.split("/").pop() : "—"}</dd></div>
              <div><dt className="inline text-zinc-500">Sync attempts: </dt><dd className="inline">{order.sync_attempts}</dd></div>
              {order.sync_error && <div className="pt-1 text-red-600">{order.sync_error}</div>}
            </dl>
          </section>
        </div>

        <section className="mt-5 rounded-2xl border border-zinc-200">
          <ul className="divide-y divide-zinc-100">
            {order.items.map((it, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-3 text-sm">
                {it.image && <img src={it.image} alt="" className="h-10 w-10 rounded-lg object-cover" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {it.title}
                    {it.is_gift && <span className="ml-2 rounded bg-lime-100 px-1.5 py-0.5 text-[10px] font-bold text-lime-700">GIFT</span>}
                  </p>
                  <p className="text-xs text-zinc-500">{it.variant_title || ""} × {it.quantity}</p>
                </div>
                <span className="font-medium">{inr(it.line_total)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-1 border-t border-zinc-200 px-5 py-4 text-sm">
            <div className="flex justify-between"><dt className="text-zinc-500">Subtotal</dt><dd>{inr(order.subtotal)}</dd></div>
            {order.discount_total > 0 && <div className="flex justify-between text-lime-700"><dt>Discounts{order.coupon_code ? ` (${order.coupon_code})` : ""}</dt><dd>−{inr(order.discount_total)}</dd></div>}
            <div className="flex justify-between"><dt className="text-zinc-500">Shipping</dt><dd>{order.shipping_total ? inr(order.shipping_total) : "Free"}</dd></div>
            <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd>{inr(order.total)}</dd></div>
          </dl>
        </section>

        <section className="mt-5 rounded-2xl border border-zinc-200 p-5">
          <h2 className="text-sm font-bold">Timeline</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {order.events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="w-36 shrink-0 text-xs text-zinc-400">{when(e.created_at)}</span>
                <span className="font-medium">{e.from_status ? `${e.from_status} → ${e.to_status}` : e.to_status}</span>
                {e.meta && <span className="truncate text-xs text-zinc-500">{JSON.stringify(e.meta).slice(0, 80)}</span>}
              </li>
            ))}
            {order.events.length === 0 && <li className="text-zinc-500">No events recorded.</li>}
          </ul>
        </section>
      </div>
    </>
  );
}
