import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import OrdersAdmin from "@/components/admin/OrdersAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders · Admin", robots: { index: false } };

export default async function AdminOrdersPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const authed = await tfetch(() => verifyAdminToken(token));
  if (!authed) redirect("/admin/login");
  const [list, counts, name] = await tfetch(async () => [
    await listOrders({}),
    await orderStatusCounts(),
    siteName(),
  ]);
  return (
    <>
      <AdminNav storeName={name} />
      <OrdersAdmin initial={{ ...list, counts }} />
    </>
  );
}
