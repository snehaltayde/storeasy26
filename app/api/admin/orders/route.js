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
  // S4: a role that loses customer PII searches by order id only. Phase 2
  // line 2: ?payment=cod|online; the counts follow the same payment and search.
  const filters = { payment: p.get("payment"), q: p.get("q"), piiSearch: !redactsPii(auth.actor.role) };
  const [list, counts] = await Promise.all([listOrders({ ...filters, status: p.get("status"), before: p.get("before") }), orderStatusCounts(filters)]);
  // S31: support never sees contact PII, in lists either
  const orders = (list.orders || []).map((o) => redactOrderForRole(o, auth.actor.role));
  return NextResponse.json({ ok: true, ...list, orders, counts });
});
