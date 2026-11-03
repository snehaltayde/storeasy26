import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { getOfferRow, upsertOffer, setOfferEnabled, deleteOffer } from "@/lib/offers/store";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const offer = await getOfferRow(id);
  if (!offer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, offer });
});

export const PUT = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  // enable/disable fast path
  if (body.offer === undefined && typeof body.enabled === "boolean") {
    const existing = await getOfferRow(id);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const saved = await setOfferEnabled(id, body.enabled);
    slog("offer_toggled", { offer_id: id, enabled: body.enabled });
    await audit({ actor: auth.actor, action: "offers.write", resource: `offer:${id}`, diff: { enabled: body.enabled } });
    return NextResponse.json({ ok: true, offer: saved });
  }

  if (body.offer?.id && body.offer.id !== id)
    return NextResponse.json({ error: "Offer id cannot change (delete + recreate)" }, { status: 400 });
  try {
    const saved = await upsertOffer({
      offer: { ...body.offer, id },
      enabled: body.enabled !== false,
      startsAt: body.startsAt || null,
      endsAt: body.endsAt || null,
    });
    slog("offer_saved", { offer_id: id, type: saved.type, enabled: saved.enabled });
    await audit({ actor: auth.actor, action: "offers.write", resource: `offer:${id}`, diff: { type: saved.type, enabled: saved.enabled } });
    return NextResponse.json({ ok: true, offer: saved });
  } catch (e) {
    if (e?.code === "OFFER_INVALID") return NextResponse.json({ error: String(e.message), errors: e.errors }, { status: 422 });
    const infra = infraResponse(e, { route: "admin/offers/[id]" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e), errors: e?.errors }, { status: 400 });
  }
});

export const DELETE = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  await deleteOffer(id);
  slog("offer_deleted", { offer_id: id });
  await audit({ actor: auth.actor, action: "offers.write", resource: `offer:${id}`, diff: { deleted: true } });
  return NextResponse.json({ ok: true, deleted: id });
});
