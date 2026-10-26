import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { getOrder } from "@/lib/orders";
import { pushOrderToShopify } from "@/lib/shopify-push";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export const GET = tenantHandler(async (request, { params }) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, order });
});

// Retry the Shopify push for one order — same state-machine-guarded path the
// webhook/cron use, so an invalid state is refused, never forced.
export const POST = tenantHandler(async (request, { params }) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  try {
    const result = await pushOrderToShopify(id);
    slog("admin_order_push", { order_id: id, ok: result?.ok !== false });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
});
