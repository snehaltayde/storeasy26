import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { ModerationError, listQueue, moderate, redactReviewForRole, reply } from "@/lib/reviews/moderate";

// Phase 9 line 1: the review queue.
//   GET ?status=pending|approved|rejected|hidden&rating=1..5&product=<id>
//        reviews.read (support and up) → { reviews, counts, products }
//        support: no email, no order id, no reject reason
//   POST { action: approve|reject|hide|restore, ids: [..≤50], reason? }
//   POST { reply: { id, text } }        (empty text removes the reply)
//        reviews.moderate (staff and up); audited as reviews.<action>
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "reviews.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const sp = new URL(request.url).searchParams;
  try {
    const q = await listQueue({ status: sp.get("status") || "pending", rating: sp.get("rating"), productId: sp.get("product") || null });
    return NextResponse.json({ ok: true, ...q, reviews: q.reviews.map((r) => redactReviewForRole(r, auth.actor.role)) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/reviews" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    throw e;
  }
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "reviews.moderate");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = (await request.json().catch(() => null)) || {};
  try {
    if (body.reply && typeof body.reply === "object") {
      const r = await reply({ id: String(body.reply.id || ""), text: body.reply.text, actor: auth.actor });
      return NextResponse.json({ ok: true, ...r });
    }
    const r = await moderate({ ids: body.ids, action: String(body.action || ""), reason: body.reason, actor: auth.actor });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof ModerationError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    const infra = infraResponse(e, { route: "admin/reviews" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    throw e;
  }
});
