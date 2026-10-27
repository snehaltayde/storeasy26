import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { createSupportGrant, revokeSupportGrant, listSupportGrants } from "@/lib/platform/support";

// Support-grant API (S34 / OP10), operator-only:
//   GET  ?tenant=            → grants (newest first)
//   POST {action:"grant", tenant, reason, hours?}
//   POST {action:"revoke", id}
// With an active grant, the operator's _platform cookie opens that tenant's
// /admin as the read-only SUPPORT role; the merchant sees a banner.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const tenant = request.nextUrl.searchParams.get("tenant");
  return NextResponse.json({ ok: true, grants: await listSupportGrants({ tenantId: tenant || null }) });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "grant") {
      const grant = await createSupportGrant({ tenantId: body.tenant, reason: body.reason, hours: body.hours });
      return NextResponse.json({ ok: true, ...grant });
    }
    if (body.action === "revoke") {
      const ok = await revokeSupportGrant(String(body.id || ""));
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    return NextResponse.json({ error: "action must be grant|revoke" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 });
  }
}
