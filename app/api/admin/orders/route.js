import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "orders.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const p = request.nextUrl.searchParams;
  const [list, counts] = await Promise.all([
    listOrders({ status: p.get("status"), q: p.get("q"), before: p.get("before") }),
    orderStatusCounts(),
  ]);
  return NextResponse.json({ ok: true, ...list, counts });
});
