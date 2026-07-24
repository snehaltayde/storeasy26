import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listOffers, upsertOffer } from "@/lib/offers/store";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET(request) {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  return NextResponse.json({ ok: true, offers: await listOffers() });
}

export async function POST(request) {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
    const saved = await upsertOffer({
      offer: body.offer,
      enabled: body.enabled !== false,
      startsAt: body.startsAt || null,
      endsAt: body.endsAt || null,
    });
    slog("offer_saved", { offer_id: saved.id, type: saved.type, enabled: saved.enabled });
    return NextResponse.json({ ok: true, offer: saved });
  } catch (e) {
    const status = e?.code === "OFFER_INVALID" ? 422 : 400;
    return NextResponse.json({ error: String(e?.message || e), errors: e?.errors }, { status });
  }
}
