import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { customerFromToken, customerOrder, CUSTOMER_COOKIE } from "@/lib/customers";
import { formatMoney } from "@/lib/format";
import ReorderPanel from "@/components/account/ReorderPanel";
import ReturnRequest from "@/components/account/ReturnRequest";
import { returnForOrder, returnEligibility, returnsWindowDays } from "@/lib/returns";
import { db } from "@/lib/db";
import { tfetch } from "@/lib/storefront-request";

// Account order detail (S45 / SF11 + SF12): ownership-checked server-side
// (someone else's order id is a plain 404), fulfilment + refunds from the
// provider-mirrored projection, reorder with live revalidation.
export const dynamic = "force-dynamic";
export const metadata = { title: "Order details", robots: { index: false } };

const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export default async function AccountOrderPage({ params }) {
  const { orderId } = await params;
  const jar = await cookies();
  const data = await tfetch(async () => {
    const customer = await customerFromToken(jar.get(CUSTOMER_COOKIE)?.value);
    if (!customer) return { customer: null };
    const order = await customerOrder(customer.id, orderId);
    if (!order) return { customer, order: null };
    const [fulfillments, refunds, ret] = await Promise.all([
      db.selectFrom("order_fulfillments").selectAll().where("order_id", "=", order.id).execute().catch(() => []),
      db.selectFrom("order_refunds").selectAll().where("order_id", "=", order.id).execute().catch(() => []),
      returnForOrder(customer.id, order.id),
    ]);
    const elig = ret ? { ok: false } : returnEligibility(order, { windowDays: returnsWindowDays() });
    return { customer, order, fulfillments, refunds, ret, elig };
  });

  if (!data.customer) redirect(`/account?return=${encodeURIComponent(`/account/orders/${orderId}`)}`);
  if (!data.order) notFound();
  const o = data.order;
  const snap = parse(o.snapshot, {});
  const cur = o.currency || "INR";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <nav className="mb-5 text-sm text-sf-text-faint">
        <Link href="/account" className="hover:text-sf-text-muted">
          Account
        </Link>{" "}
        / <span className="text-sf-text-muted">{o.id}</span>
      </nav>
      <h1 className="text-2xl font-extrabold tracking-tight">Order {o.id}</h1>
      <p className="mt-1 text-sm text-sf-text-subtle">
        Placed {new Date(o.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} ·{" "}
        {o.payment_method === "cod" ? "Cash on delivery" : "Paid online"}
      </p>

      <section className="mt-6 rounded-sf-card border border-sf-border p-5">
        <ul className="divide-y divide-sf-border-soft text-sm">
          {(snap.items || []).map((it, i) => (
            <li key={i} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate">{it.title}</span>
              <span className="text-xs text-sf-text-faint">×{it.quantity}</span>
              <span className="font-semibold">{formatMoney(it.lineTotal ?? it.price * it.quantity, cur)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-1 border-t border-sf-border-soft pt-3 text-sm">
          <p className="flex justify-between text-sf-text-subtle">
            <span>Subtotal</span>
            <span>{formatMoney(o.subtotal, cur)}</span>
          </p>
          {Number(o.discount_total) > 0 && (
            <p className="flex justify-between text-sf-text-subtle">
              <span>Discounts</span>
              <span>−{formatMoney(o.discount_total, cur)}</span>
            </p>
          )}
          <p className="flex justify-between text-sf-text-subtle">
            <span>Shipping</span>
            <span>{Number(o.shipping_total) > 0 ? formatMoney(o.shipping_total, cur) : "Free"}</span>
          </p>
          <p className="flex justify-between font-bold text-sf-text">
            <span>Total</span>
            <span>{formatMoney(o.total, cur)}</span>
          </p>
          {Number(o.refunded_total) > 0 && (
            <p className="flex justify-between text-sf-danger">
              <span>Refunded</span>
              <span>−{formatMoney(o.refunded_total, cur)}</span>
            </p>
          )}
        </div>
      </section>

      {data.fulfillments.length > 0 && (
        <section className="mt-4 rounded-sf-card border border-sf-border p-5">
          <h2 className="text-sm font-bold">Shipment</h2>
          {data.fulfillments.map((f) => (
            <p key={f.id} className="mt-2 text-sm text-sf-text-muted">
              {f.tracking_company || "Courier"} · {f.tracking_number || "tracking pending"}
              {f.tracking_url && (
                <a href={f.tracking_url} target="_blank" rel="noopener noreferrer" className="ml-2 font-medium text-sf-accent-text underline">
                  Track →
                </a>
              )}
              {f.updated_at && <span className="ml-2 text-xs text-sf-text-faint">updated {new Date(f.updated_at).toLocaleDateString("en-IN")}</span>}
            </p>
          ))}
        </section>
      )}

      <section className="mt-6">
        <ReorderPanel orderId={o.id} />
      </section>

      <section className="mt-6">
        <ReturnRequest orderId={o.id} existing={data.ret} eligible={data.elig.ok} reasonIfNot={data.elig.reason || "not available for this order"} />
      </section>
    </div>
  );
}
