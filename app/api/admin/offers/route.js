import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listOffers, upsertOffer } from "@/lib/offers/store";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return deny(auth);
  return NextResponse.json({ ok: true, offers: await listOffers() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return deny(auth);
  const body = await request.json().catch(() => ({}));
  try {
    const saved = await upsertOffer({
      offer: body.offer,
      enabled: body.enabled !== false,
      startsAt: body.startsAt || null,
      endsAt: body.endsAt || null,
    });
    slog("offer_saved", { offer_id: saved.id, type: saved.type, enabled: saved.enabled });
    await audit({ actor: auth.actor, action: "offers.write", resource: `offer:${saved.id}`, diff: { type: saved.type, enabled: saved.enabled } });
    return NextResponse.json({ ok: true, offer: saved });
  } catch (e) {
    if (e?.code === "OFFER_INVALID") return NextResponse.json({ error: String(e.message), errors: e.errors }, { status: 422 });
    const infra = infraResponse(e, { route: "admin/offers" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e), errors: e?.errors }, { status: 400 });
  }
});
