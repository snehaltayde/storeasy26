import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { simulateOffer, SAMPLE_CARTS } from "@/lib/offers/simulate";
import { tenantHandler } from "@/lib/tenant-request";

// Offer simulator (S32 / BE07+MC14): POST {offer, enabled?, cartKey?, coupon?}
// → deterministic sample-cart evaluation (alone + combined with active offers).
// Read-only — no writes, so offers.read suffices (staff/support can preview).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  if (!body.offer || typeof body.offer !== "object") {
    return NextResponse.json({ error: "offer object required" }, { status: 400 });
  }
  const result = await simulateOffer({
    offer: body.offer,
    enabled: body.enabled !== false,
    cartKey: SAMPLE_CARTS[body.cartKey] ? body.cartKey : "medium",
    coupon: body.coupon ?? null,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
});
