import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { createSupportGrant, revokeSupportGrant, listSupportGrants } from "@/lib/platform/support";

// Support-grant API (S34 / OP10), operator-only:
//   GET  ?tenant=            → grants (newest first)
//   POST {action:"grant", tenant, reason, hours?}
//   POST {action:"revoke", id}
// With an active grant, the operator's _platform cookie opens that tenant's
// /admin as the read-only SUPPORT role; the merchant sees a banner.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const tenant = request.nextUrl.searchParams.get("tenant");
  return NextResponse.json({ ok: true, grants: await listSupportGrants({ tenantId: tenant || null }) });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "grant") {
      const grant = await createSupportGrant({ tenantId: body.tenant, reason: body.reason, hours: body.hours, operator: auth.operator.id });
      return NextResponse.json({ ok: true, ...grant });
    }
    if (body.action === "revoke") {
      const ok = await revokeSupportGrant(String(body.id || ""), { operator: auth.operator.id });
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    return NextResponse.json({ error: "action must be grant|revoke" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 });
  }
}
