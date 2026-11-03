import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { simulateOffer } from "@/lib/offers/simulate";
import { tenantHandler } from "@/lib/tenant-request";

// Offer simulator (S32 / BE07+MC14, COM-03): POST {offer, enabled?}
// → example carts from this store's own products, each checked against the
// offer's sentence (alone, and with the store's other live offers).
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
  const result = await simulateOffer({ offer: body.offer, enabled: body.enabled !== false });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
});
