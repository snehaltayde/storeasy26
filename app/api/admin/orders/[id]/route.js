import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { getOrder } from "@/lib/orders";
import { pushOrderToShopify } from "@/lib/shopify-push";
import { getOrderProjection, reconcileOrderProjection } from "@/lib/order-projection";
import { cancelOrder } from "@/lib/order-cancel";
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

// POST {action?: "push" | "reconcile" | "cancel"}
//   push      — retry the Shopify push (state-machine-guarded; refusals come
//               back 200 with their reason — the console explains them)
//   reconcile — authoritative refetch of refunds/fulfillment from Shopify
//   cancel    — cancel on both sides (S51): Shopify orderCancel (restock, no
//               refund, no email) then our row → cancelled. Captured payments
//               are refused unless a Razorpay refund id is recorded (body:
//               {refundId}); refunds themselves stay manual (docs/refunds.md).
export const POST = tenantHandler(async (request, { params }) => {
  const body = await request.json().catch(() => ({}));
  const action = body.action || "push";
  const auth = await requireAdmin(request, action === "cancel" ? "orders.cancel" : "orders.push");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  try {
    if (action === "cancel") {
      const result = await cancelOrder(id, {
        reason: String(body.reason || "cancelled from admin console").slice(0, 200),
        refundId: body.refundId ? String(body.refundId).slice(0, 80) : null,
        via: "admin-console",
      });
      slog("admin_order_cancel", { order_id: id, ok: result.ok, code: result.code });
      await audit({ actor: auth.actor, action: "orders.cancel", resource: `order:${id}`, diff: { ok: result.ok, code: result.code ?? null } });
      const { status, ...payload } = result;
      return NextResponse.json(payload, { status });
    }
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
