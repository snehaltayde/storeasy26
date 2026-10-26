import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = request.nextUrl.searchParams;
  const [list, counts] = await Promise.all([
    listOrders({ status: p.get("status"), q: p.get("q"), before: p.get("before") }),
    orderStatusCounts(),
  ]);
  return NextResponse.json({ ok: true, ...list, counts });
});
