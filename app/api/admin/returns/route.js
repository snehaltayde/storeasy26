import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listReturns, decideReturn } from "@/lib/returns";
import { tenantHandler } from "@/lib/tenant-request";

// Returns admin API (S46 / SF21). State machine only: requested → approved |
// rejected, approved → completed | rejected. APPROVAL MOVES NO MONEY — the
// refund happens through the provider flow and mirrors onto the order via
// the S31 projection; this route never touches money columns.
//   GET ?status=              → return requests (joined order totals)
//   POST {id, action, note?}  → approve | reject | complete
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "orders.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const status = new URL(request.url).searchParams.get("status") || null;
  return NextResponse.json({ ok: true, returns: await listReturns({ status }) });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "returns.decide");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    const r = await decideReturn(String(body.id || ""), { action: String(body.action || ""), note: body.note });
    await audit({ actor: auth.actor, action: "returns.decide", resource: `return:${r.id}`, diff: { status: r.status } });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/returns" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
