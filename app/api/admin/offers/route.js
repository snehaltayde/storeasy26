import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listOffers, offerExists, upsertOffer } from "@/lib/offers/store";
import { offerTargetNames, storeCurrency } from "@/lib/offers/catalog";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return deny(auth);
  const offers = await listOffers();
  // COM-03: the console says each offer in plain words, in the store's currency
  const [names, currency] = await Promise.all([offerTargetNames(offers.flatMap((o) => [o.config, o.previous?.config].filter(Boolean))), storeCurrency()]);
  return NextResponse.json({ ok: true, offers, names, currency });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return deny(auth);
  const body = await request.json().catch(() => ({}));
  // COM-03: creating never replaces an offer that happens to share an id (the
  // old form derived ids, so two codes with the same letters collided).
  if (typeof body.offer?.id === "string" && (await offerExists(body.offer.id))) {
    return NextResponse.json({ error: "An offer with this name already exists. Close this form and start the offer again.", code: "OFFER_EXISTS" }, { status: 409 });
  }
  try {
    const saved = await upsertOffer({
      offer: body.offer,
      enabled: body.enabled !== false,
      startsAt: body.startsAt || null,
      endsAt: body.endsAt || null,
    });
    slog("offer_saved", { offer_id: saved.id, type: saved.type, enabled: saved.enabled });
    await audit({ actor: auth.actor, action: "offers.write", resource: `offer:${saved.id}`, diff: { type: saved.type, enabled: saved.enabled, starts_at: saved.starts_at ?? null, ends_at: saved.ends_at ?? null, ...(saved.config?.target?.kind === "collection" ? { target: "collection" } : {}) } });
    return NextResponse.json({ ok: true, offer: saved });
  } catch (e) {
    if (e?.code === "OFFER_INVALID") return NextResponse.json({ error: String(e.message), errors: e.errors }, { status: 422 });
    const infra = infraResponse(e, { route: "admin/offers" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e), errors: e?.errors }, { status: 400 });
  }
});
