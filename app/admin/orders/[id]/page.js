import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getOrder } from "@/lib/orders";
import { getOrderProjection } from "@/lib/order-projection";
import { redactOrderForRole } from "@/lib/admin/order-view";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import { StatusBadge } from "@/components/admin/OrdersAdmin";
import RetryPushButton from "@/components/admin/RetryPushButton";
import ReconcileButton from "@/components/admin/ReconcileButton";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order · Admin", robots: { index: false } };

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export default async function AdminOrderDetail({ params }) {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { id } = await params;
  // S31: the SUPPORT role sees order state and money, never customer PII
  const role = actor.role;
  const [rawOrder, projection, name] = await tfetch(async () => [await getOrder(id), await getOrderProjection(id), siteName()]);
  if (!rawOrder) notFound();
  const order = redactOrderForRole(rawOrder, role);

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
          {order.financial_status && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${order.refunded_total > 0 ? "bg-amber-100 text-amber-700" : "bg-zinc-100 text-zinc-600"}`}>
              {order.financial_status}
            </span>
          )}
          {order.fulfillment_status && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-600">{order.fulfillment_status}</span>
          )}
          {order.status === "sync_failed" && <RetryPushButton orderId={order.id} />}
          {order.shopify_order_id && role !== "support" && <ReconcileButton orderId={order.id} />}
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <section className="rounded-2xl border border-zinc-200 p-5">
            <h2 className="text-sm font-bold">Customer</h2>
            {order.pii_redacted && (
              <p className="mt-2 text-xs text-zinc-400">Contact details are hidden for the support role.</p>
            )}
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

        {(projection.fulfillments.length > 0 || projection.refunds.length > 0) && (
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <section className="rounded-2xl border border-zinc-200 p-5">
              <h2 className="text-sm font-bold">Shipments ({projection.fulfillments.length})</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {projection.fulfillments.map((f, i) => (
                  <li key={f.id}>
                    <span className="text-xs font-bold text-zinc-400">#{i + 1}</span>{" "}
                    {f.tracking_company ? `${f.tracking_company} · ` : ""}
                    {f.tracking_url ? (
                      <a href={f.tracking_url} target="_blank" rel="noopener noreferrer" className="font-medium text-lime-700 underline">
                        {f.tracking_number}
                      </a>
                    ) : (
                      <span className="font-medium">{f.tracking_number || "no tracking yet"}</span>
                    )}
                    <span className="ml-2 text-xs text-zinc-400">
                      {f.status || ""} {f.updated_at ? `· ${when(f.updated_at)}` : ""}
                    </span>
                  </li>
                ))}
                {projection.fulfillments.length === 0 && <li className="text-zinc-500">No shipments yet.</li>}
              </ul>
            </section>
            <section className="rounded-2xl border border-zinc-200 p-5">
              <h2 className="text-sm font-bold">
                Refunds {order.refunded_total > 0 ? `· ${inr(order.refunded_total)} refunded` : ""}
              </h2>
              <ul className="mt-3 space-y-2 text-sm">
                {projection.refunds.map((r) => (
                  <li key={r.id} className="flex justify-between gap-3">
                    <span className="text-zinc-600">
                      {when(r.created_at)}
                      {r.note ? <span className="ml-2 text-xs text-zinc-400">{r.note}</span> : null}
                    </span>
                    <span className="font-medium text-amber-700">−{inr(r.amount)}</span>
                  </li>
                ))}
                {projection.refunds.length === 0 && <li className="text-zinc-500">No refunds recorded (Shopify is authoritative — Reconcile to refresh).</li>}
              </ul>
            </section>
          </div>
        )}

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
