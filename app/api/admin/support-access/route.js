import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";
import { activeSupportGrant, revokeSupportGrant, supportAccessView } from "@/lib/platform/support";

// Support access, as the store's team sees it (Phase 3 line 5, decision 5).
// Scoped to the HOST-RESOLVED store; a grant id in the body is never trusted.
//   GET  (audit.read)           → { ok, open, history } (the open grant and the last 20)
//   POST {action:"end"} (team.manage) → ends the open grants at once: their
//        support sessions are revoked and the audit row names the member
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unsupported = () => NextResponse.json({ ok: true, supported: false, open: null, history: [] });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "audit.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(platformConfigured() && currentTenant())) return unsupported();
  return NextResponse.json({ ok: true, supported: true, ...(await supportAccessView(currentTenant().id)) }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "team.manage");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => null);
  if (body?.action !== "end") return NextResponse.json({ error: "action must be end" }, { status: 400 });
  if (!(platformConfigured() && currentTenant())) return NextResponse.json({ error: "Support access needs the platform control plane." }, { status: 400 });
  const tenantId = currentTenant().id;
  const grant = await activeSupportGrant(tenantId);
  if (!grant) return NextResponse.json({ error: "Support access isn't open any more.", ...(await supportAccessView(tenantId)) }, { status: 409 });
  // every open grant ends (an operator may have opened a second one)
  let ended = false;
  for (let g = grant, i = 0; g && i < 20; g = await activeSupportGrant(tenantId), i++) {
    ended = (await revokeSupportGrant(String(g.id), { actor: auth.actor, tenantId })) || ended;
  }
  const view = await supportAccessView(tenantId);
  return ended ? NextResponse.json({ ok: true, ...view }) : NextResponse.json({ error: "Support access isn't open any more.", ...view }, { status: 409 });
});
