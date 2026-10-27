import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { getOrder } from "@/lib/orders";
import { pushOrderToShopify } from "@/lib/shopify-push";
import { getOrderProjection, reconcileOrderProjection } from "@/lib/order-projection";
import { redactOrderForRole } from "@/lib/admin/order-view";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "orders.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const projection = await getOrderProjection(id);
  // S31: support sees the order's state and money, never the customer's PII
  return NextResponse.json({ ok: true, order: redactOrderForRole(order, auth.actor.role), ...projection });
});

// POST {action?: "push" | "reconcile"}
//   push      — retry the Shopify push (state-machine-guarded; refusals come
//               back 200 with their reason — the console explains them)
//   reconcile — authoritative refetch of refunds/fulfillment from Shopify
export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "orders.push");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const { action = "push" } = await request.json().catch(() => ({}));
  try {
    if (action === "reconcile") {
      const result = await reconcileOrderProjection(id);
      await audit({ actor: auth.actor, action: "orders.reconcile", resource: `order:${id}`, diff: { ok: result.ok, skipped: result.skipped ?? null } });
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    }
    const result = await pushOrderToShopify(id);
    slog("admin_order_push", { order_id: id, ok: result?.ok !== false });
    await audit({ actor: auth.actor, action: "orders.push", resource: `order:${id}`, diff: { ok: result?.ok !== false } });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
});
