import Link from "next/link";
import { cookies } from "next/headers";
import { customerFromToken, customerOrders, CUSTOMER_COOKIE, safeReturnPath } from "@/lib/customers";
import { formatMoney } from "@/lib/format";
import AccountAuth from "@/components/account/AccountAuth";
import ProfileForm from "@/components/account/ProfileForm";
import { tfetch } from "@/lib/tenant-request";

// Account home (S45 / SF10 + SF11): sign-in (passwordless) or the dashboard
// — orders + profile. Guest purchase is untouched; this page is optional.
export const dynamic = "force-dynamic";
export const metadata = { title: "Your account", robots: { index: false } };

const STATUS_LABEL = {
  pending_payment: "payment pending",
  paid: "paid",
  cod_pending: "placed (COD)",
  syncing_shopify: "processing",
  synced: "processing",
  sync_failed: "processing",
  cancelled: "cancelled",
};

// Shopify's fulfillment values, lowercased. Only these two say more than the
// order's own status. Any other value falls back to it, and never shows as written.
const FULFILLMENT_LABEL = {
  fulfilled: "shipped",
  partially_fulfilled: "partly shipped",
};

const orderBadge = (o) => FULFILLMENT_LABEL[o.fulfillment] || STATUS_LABEL[o.status] || "processing";

export default async function AccountPage({ searchParams }) {
  const sp = await searchParams;
  const jar = await cookies();
  const { customer, orders } = await tfetch(async () => {
    const customer = await customerFromToken(jar.get(CUSTOMER_COOKIE)?.value);
    return { customer, orders: customer ? await customerOrders(customer.id) : [] };
  });

  if (!customer) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <AccountAuth returnTo={safeReturnPath(sp?.return)} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-extrabold tracking-tight">
        {customer.name ? `Hi, ${customer.name.split(" ")[0]}` : "Your account"}
      </h1>

      <section className="mt-6">
        <h2 className="text-sm font-bold">Orders</h2>
        {orders.length === 0 ? (
          <p className="mt-3 rounded-sf-card border border-sf-border bg-sf-surface-muted p-6 text-sm text-sf-text-subtle">
            No orders on this account yet — anything you buy with {customer.email} lands here after sign-in.{" "}
            <Link href="/collections" className="font-medium text-sf-accent-text underline">
              Start shopping
            </Link>
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={`/account/orders/${o.id}`} className="flex flex-wrap items-center gap-3 rounded-sf-card border border-sf-border p-4 text-sm transition hover:border-sf-border-hover">
                  <span className="font-mono text-xs text-sf-text-faint">{o.id}</span>
                  <span className="min-w-0 flex-1 truncate text-sf-text-muted">
                    {o.items.map((i) => i.title).join(", ") || "—"}
                  </span>
                  <span className="rounded-sf-2xs bg-sf-surface-sunken px-1.5 py-0.5 text-sf-3xs font-bold uppercase text-sf-text-subtle">
                    {orderBadge(o)}
                  </span>
                  <span className="font-semibold">{formatMoney(o.total, o.currency)}</span>
                  <span className="text-xs text-sf-text-faint">{new Date(o.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <ProfileForm customer={customer} />
      </section>
    </div>
  );
}
