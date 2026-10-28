import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getOrder, canTransition, ORDER_STATUS } from "@/lib/orders";
import { roleAllows } from "@/lib/platform/authz";
import { getOrderProjection } from "@/lib/order-projection";
import { redactOrderForRole } from "@/lib/admin/order-view";
import { StatusBadge, Badge } from "@/components/console/Badge";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { KeyValue } from "@/components/console/bits";
import { Banner } from "@/components/console/Banner";
import RetryPushButton from "@/components/admin/RetryPushButton";
import ReconcileButton from "@/components/admin/ReconcileButton";
import CancelOrderButton from "@/components/admin/CancelOrderButton";
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
  const [rawOrder, projection] = await tfetch(async () => [await getOrder(id), await getOrderProjection(id)]);
  if (!rawOrder) notFound();
  const order = redactOrderForRole(rawOrder, role);

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Orders", href: "/admin/orders" }, { label: order.id }]}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-xl">{order.id}</span>
            <StatusBadge status={order.status} />
            {order.financial_status && <Badge tone={order.refunded_total > 0 ? "warning" : "neutral"}>{order.financial_status}</Badge>}
            {order.fulfillment_status && <Badge tone="neutral">{order.fulfillment_status}</Badge>}
          </span>
        }
        description={`${order.payment_method === "cod" ? "Cash on delivery" : "Paid online"} · placed ${when(order.created_at)}`}
        actions={
          <>
            {order.status === "sync_failed" && <RetryPushButton orderId={order.id} />}
            {order.shopify_order_id && role !== "support" && <ReconcileButton orderId={order.id} />}
            {roleAllows(role, "orders.cancel") && canTransition(order.status, ORDER_STATUS.CANCELLED) && (
              <CancelOrderButton orderId={order.id} paymentCaptured={rawOrder.payment_status === "paid"} />
            )}
          </>
        }
      />

      {order.sync_error && (
        <Banner tone="danger" title="Shopify push failing" className="mb-4">
          {order.sync_error} ({order.sync_attempts} attempt{order.sync_attempts === 1 ? "" : "s"})
        </Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Customer" badge={order.pii_redacted ? <Badge tone="warning">PII hidden for support</Badge> : null} />
          <KeyValue
            items={[
              { key: "Name", value: order.name || "—" },
              { key: "Email", value: order.email || "—" },
              { key: "Phone", value: order.phone || "—" },
              { key: "Address", value: [order.address_line1, order.address_line2, order.city, order.state, order.pincode].filter(Boolean).join(", ") || "No address" },
            ]}
          />
        </Card>
        <Card>
          <CardHeader title="Payment & sync" />
          <KeyValue
            items={[
              { key: "Created", value: when(order.created_at) },
              { key: "Paid", value: when(order.paid_at) },
              { key: "Razorpay", value: order.razorpay_payment_id || order.razorpay_order_id || "—", mono: true },
              { key: "Shopify order", value: order.shopify_order_id ? order.shopify_order_id.split("/").pop() : "not pushed", mono: true },
              { key: "Sync attempts", value: String(order.sync_attempts) },
            ]}
          />
        </Card>
      </div>

      <Card className="mt-4" padded={false}>
        <ul className="divide-y divide-edge">
          {order.items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-3 text-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {it.image && <img src={it.image} alt="" className="size-10 rounded-ctl object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-fg">
                  {it.title}
                  {it.is_gift && (
                    <Badge tone="accent" className="ml-2">
                      Gift
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-fg-muted">
                  {it.variant_title ? `${it.variant_title} · ` : ""}× {it.quantity}
                </p>
              </div>
              <span className="font-medium tabular-nums">{inr(it.line_total)}</span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1 border-t border-edge px-5 py-4 text-sm">
          <div className="flex justify-between text-fg-muted">
            <dt>Subtotal</dt>
            <dd className="tabular-nums">{inr(order.subtotal)}</dd>
          </div>
          {order.discount_total > 0 && (
            <div className="flex justify-between text-fg-muted">
              <dt>Discounts{order.coupon_code ? ` (${order.coupon_code})` : ""}</dt>
              <dd className="tabular-nums">−{inr(order.discount_total)}</dd>
            </div>
          )}
          <div className="flex justify-between text-fg-muted">
            <dt>Shipping</dt>
            <dd className="tabular-nums">{order.shipping_total ? inr(order.shipping_total) : "Free"}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold text-fg">
            <dt>Total</dt>
            <dd className="tabular-nums">{inr(order.total)}</dd>
          </div>
          {order.refunded_total > 0 && (
            <div className="flex justify-between text-danger">
              <dt>Refunded</dt>
              <dd className="tabular-nums">−{inr(order.refunded_total)}</dd>
            </div>
          )}
        </dl>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Shipments (${projection.fulfillments.length})`} />
          <ul className="space-y-2 text-sm">
            {projection.fulfillments.map((f, i) => (
              <li key={f.id}>
                <span className="text-xs font-medium text-fg-subtle">#{i + 1}</span>{" "}
                {f.tracking_company ? `${f.tracking_company} · ` : ""}
                {f.tracking_url ? (
                  <a href={f.tracking_url} target="_blank" rel="noopener noreferrer" className="rounded font-medium text-info underline-offset-2 focus-ring hover:underline">
                    {f.tracking_number}
                  </a>
                ) : (
                  <span className="font-medium">{f.tracking_number || "no tracking yet"}</span>
                )}
                <span className="ml-2 text-xs text-fg-subtle">
                  {f.status || ""} {f.updated_at ? `· ${when(f.updated_at)}` : ""}
                </span>
              </li>
            ))}
            {projection.fulfillments.length === 0 && <li className="text-fg-muted">No shipments yet.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Refunds" description="Shopify is authoritative — Reconcile refreshes this." />
          <ul className="space-y-2 text-sm">
            {projection.refunds.map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span className="text-fg-muted">
                  {when(r.created_at)}
                  {r.note ? <span className="ml-2 text-xs text-fg-subtle">{r.note}</span> : null}
                </span>
                <span className="font-medium tabular-nums text-danger">−{inr(r.amount)}</span>
              </li>
            ))}
            {projection.refunds.length === 0 && <li className="text-fg-muted">No refunds recorded.</li>}
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Timeline" />
        <ol className="space-y-2 text-sm">
          {order.events.map((e) => {
            const meta = typeof e.meta === "string" ? (() => { try { return JSON.parse(e.meta); } catch { return null; } })() : e.meta;
            const detail = meta && (meta.note || meta.reason || meta.source || meta.error);
            return (
              <li key={e.id} className="flex gap-3">
                <span className="w-36 shrink-0 text-xs text-fg-subtle">{when(e.created_at)}</span>
                <span className="font-medium text-fg">{e.from_status ? `${e.from_status} → ${e.to_status}` : e.to_status}</span>
                {detail && <span className="min-w-0 truncate text-xs text-fg-muted">{String(detail)}</span>}
              </li>
            );
          })}
          {order.events.length === 0 && <li className="text-fg-muted">No events recorded.</li>}
        </ol>
      </Card>
    </>
  );
}
