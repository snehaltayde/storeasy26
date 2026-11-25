import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { orderFilters, redactOrderForRole, redactReturnForRole, redactsPii } from "@/lib/admin/order-view";
import { merchantTz } from "@/lib/reporting";
import { listReturns } from "@/lib/returns";
import { PageHeader } from "@/components/kit/page-header";
import { OrderFilters, ViewTabs } from "@/components/admin/orders/OrderFilters";
import { OrdersList } from "@/components/admin/orders/OrdersList";
import { ReturnsList } from "@/components/admin/orders/ReturnsList";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders · Admin", robots: { index: false } };

// The orders list on the new UI (docs/plans/phase-2.md "Line 2"): the address
// holds the state (?status=, ?payment=, ?q=, ?view=returns), so every filter
// is a link and the page reads it on the server. The first page is redacted
// exactly as GET /api/admin/orders is (S31), and a role that may not see
// customer details searches by order id only (S4).
export default async function AdminOrdersPage({ searchParams }) {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "orders.read")) return <NoAccess role={actor.role} page />;
  const filters = orderFilters((await searchParams) ?? {});
  const piiSearch = !redactsPii(actor.role);
  const header = <PageHeader title="Orders" description="Every checkout lands here. Shopify stays the record for payments, shipping and refunds." />;

  if (filters.view === "returns") {
    const [returns, counts, timeZone] = await tfetch(async () => [await listReturns({}), await orderStatusCounts(), merchantTz()]);
    const openReturns = returns.filter((r) => ["requested", "approved"].includes(r.status)).length;
    return (
      <>
        {header}
        <ViewTabs view="returns" total={counts.all ?? 0} openReturns={openReturns} />
        <ReturnsList returns={returns.map((r) => redactReturnForRole(r, actor.role))} role={actor.role} timeZone={timeZone} />
      </>
    );
  }

  const query = { payment: filters.payment || null, q: filters.q || null, piiSearch };
  const [list, counts, returns, timeZone] = await tfetch(async () => [
    await listOrders({ ...query, status: filters.status === "all" ? null : filters.status }),
    await orderStatusCounts(query),
    await listReturns({}),
    merchantTz(),
  ]);
  const orders = list.orders.map((o) => redactOrderForRole(o, actor.role));
  const openReturns = returns.filter((r) => ["requested", "approved"].includes(r.status)).length;
  return (
    <>
      {header}
      <OrderFilters filters={filters} counts={counts} piiSearch={piiSearch} openReturns={openReturns} />
      <OrdersList
        // a new filter is a new list: remount so "Load more" starts over
        key={`${filters.status}|${filters.payment}|${filters.q}`}
        orders={orders}
        nextBefore={list.nextBefore}
        total={filters.status === "all" ? (counts.all ?? 0) : (counts[filters.status] ?? 0)}
        filters={filters}
        role={actor.role}
        piiSearch={piiSearch}
        timeZone={timeZone}
      />
    </>
  );
}
