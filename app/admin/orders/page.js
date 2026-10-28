import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import OrdersAdmin from "@/components/admin/OrdersAdmin";
import { ReturnsPanel } from "@/components/admin/CommercePanels";
import { listReturns } from "@/lib/returns";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders · Admin", robots: { index: false } };

export default async function AdminOrdersPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const [list, counts, name, returns] = await tfetch(async () => [
    await listOrders({}),
    await orderStatusCounts(),
    siteName(),
    await listReturns({}),
  ]);
  return (
    <>
      <AdminNav storeName={name} />
      <ReturnsPanel initial={returns} />
      <OrdersAdmin initial={{ ...list, counts }} />
    </>
  );
}
