import { NextResponse } from "next/server";
import { approvalByToken, decideApproval, currentDraftHash } from "@/lib/platform/agency";
import { rateLimit } from "@/lib/rate-limit";
import { tenantId } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";

// Client approval decision (S48 / AG04). The token is the capability: signed
// at creation, expiring, single-decision, bound to ONE store and ONE content
// hash. A decision on a link whose draft has since changed is refused — an
// approval never authorizes content it wasn't shown for.
//   POST {token, decision: approved|rejected, approver, comment?}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  const limited = rateLimit(request, { name: "approve", limit: 10 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || "");
  try {
    const approval = await approvalByToken(token);
    if (!approval || approval.tenant_id !== tenantId()) return NextResponse.json({ error: "unknown approval link" }, { status: 404 });
    if (approval.status !== "pending") return NextResponse.json({ error: `this request is already ${approval.status}` }, { status: 422 });
    const nowHash = await currentDraftHash(approval.tenant_id);
    if (nowHash !== approval.content_hash) {
      return NextResponse.json({ error: "The draft changed after this link was created — a decision here would approve content you haven't seen. Ask your agency for a fresh review link." }, { status: 409 });
    }
    const r = await decideApproval(token, { decision: String(body.decision || ""), approver: body.approver, comment: body.comment });
    return NextResponse.json({ ok: true, status: r.status, content_hash: r.content_hash });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
