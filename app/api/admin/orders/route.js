import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listOrders, orderStatusCounts } from "@/lib/admin/orders";
import { redactOrderForRole, redactsPii } from "@/lib/admin/order-view";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "orders.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const p = request.nextUrl.searchParams;
  const [list, counts] = await Promise.all([
    // S4: a role that loses customer PII searches by order id only
    listOrders({ status: p.get("status"), q: p.get("q"), before: p.get("before"), piiSearch: !redactsPii(auth.actor.role) }),
    orderStatusCounts(),
  ]);
  // S31: support never sees contact PII, in lists either
  const orders = (list.orders || []).map((o) => redactOrderForRole(o, auth.actor.role));
  return NextResponse.json({ ok: true, ...list, orders, counts });
});
