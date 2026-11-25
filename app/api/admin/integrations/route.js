import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { integrationStatus, testIntegration, revokeIntegration } from "@/lib/integrations";
import { tenantHandler } from "@/lib/tenant-request";

// Integrations console API (S34 / MC20+BE24). GET = provider registry
// (presence flags + metadata, never secret values). POST {action, provider}:
//   test   — cheapest real credential check (settings.read: owner and admin;
//            a read that stores nothing, a READ_POSTS row)
//   revoke — clears the provider's stored credentials (settings.write, audited)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return deny(auth);
  return NextResponse.json({ ok: true, integrations: await integrationStatus() });
});

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const action = body.action === "revoke" ? "revoke" : "test";
  const auth = await requireAdmin(request, action === "revoke" ? "settings.write" : "settings.read");
  if (!auth.ok) return deny(auth);
  try {
    if (action === "revoke") {
      const result = await revokeIntegration(String(body.provider || ""), { actor: auth.actor });
      return NextResponse.json({ ok: true, ...result, integrations: await integrationStatus() });
    }
    const result = await testIntegration(String(body.provider || ""));
    return NextResponse.json(result);
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/integrations" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 });
  }
});
