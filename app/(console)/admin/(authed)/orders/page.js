import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { redactOrderForRole } from "@/lib/admin/order-view";
import { listReturns } from "@/lib/returns";
import OrdersAdmin from "@/components/admin/OrdersAdmin";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders · Admin", robots: { index: false } };

export default async function AdminOrdersPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const [list, counts, returns] = await tfetch(async () => [await listOrders({}), await orderStatusCounts(), await listReturns({})]);
  // S1: the first page is redacted exactly as the API's list is (S31)
  const orders = (list.orders || []).map((o) => redactOrderForRole(o, actor.role));
  return (
    <>
      <PageHeader title="Orders" description="Every checkout lands here; Shopify stays authoritative for payments and refunds." />
      <OrdersAdmin initial={{ ...list, orders, counts }} initialReturns={returns} />
    </>
  );
}
