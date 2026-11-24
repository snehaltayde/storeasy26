import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { infraMessage } from "@/lib/cms/issues";
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
    // The store's own refusals first, then the database check (DOC-04: a
    // database failure is never a 4xx), then the catch-all.
    if (e?.code === "NOT_FOUND") return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
    if (e?.code === "NOT_HERE" || e?.code === "NO_PREVIOUS") return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    if (e?.code === "CHANGED") return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    if (e?.code === "OFFER_INVALID") return NextResponse.json({ error: e.message, code: e.code }, { status: 422 });
    const infra = infraResponse(e, { route: "admin/offers/[id]/revert" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    slog("offer_revert_failed", { offer_id: id, error: String(e?.message || e).slice(0, 300) });
    return NextResponse.json({ error: infraMessage("internal"), code: "INTERNAL_ERROR" }, { status: 500 });
  }
});
