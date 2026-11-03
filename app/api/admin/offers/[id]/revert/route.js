import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { revertOffer } from "@/lib/offers/store";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// "Go back to previous offer settings" (COM-03): POST { expect }. Swaps the
// offer's live settings with the ones it had before its last change, so the
// next cart read uses them. `expect` is the `replaced_at` of the earlier
// settings the page showed; if they've changed since, the answer is 409
// CHANGED and nothing changes. PUB-04's "Recently published" Undo calls this
// too, and should send the `changedAt` it listed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS = { NOT_FOUND: 404, NOT_HERE: 409, NO_PREVIOUS: 409, CHANGED: 409, OFFER_INVALID: 422 };

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "offers.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const expect = typeof body?.expect === "string" ? body.expect : null;
  try {
    const offer = await revertOffer(id, { expect });
    slog("offer_reverted", { offer_id: id });
    await audit({ actor: auth.actor, action: "offers.write", resource: `offer:${id}`, diff: { reverted: true } });
    return NextResponse.json({ ok: true, offer });
  } catch (e) {
    if (!STATUS[e?.code]) throw e;
    return NextResponse.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
  }
});
