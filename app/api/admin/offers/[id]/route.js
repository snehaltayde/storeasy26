import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { getOfferRow, upsertOffer, setOfferEnabled, deleteOffer } from "@/lib/offers/store";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET(request, { params }) {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const offer = await getOfferRow(id);
  if (!offer) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, offer });
}

export async function PUT(request, { params }) {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  // enable/disable fast path
  if (body.offer === undefined && typeof body.enabled === "boolean") {
    const existing = await getOfferRow(id);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const saved = await setOfferEnabled(id, body.enabled);
    slog("offer_toggled", { offer_id: id, enabled: body.enabled });
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
    return NextResponse.json({ ok: true, offer: saved });
  } catch (e) {
    const status = e?.code === "OFFER_INVALID" ? 422 : 400;
    return NextResponse.json({ error: String(e?.message || e), errors: e?.errors }, { status });
  }
}

export async function DELETE(request, { params }) {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  await deleteOffer(id);
  slog("offer_deleted", { offer_id: id });
  return NextResponse.json({ ok: true, deleted: id });
}
