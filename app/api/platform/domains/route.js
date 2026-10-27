import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { claimDomain, verifyDomain, removeDomain, setPrimaryDomain, listDomains } from "@/lib/platform/domains";

// Operator domain registry API (S28 / BE12).
//   GET  ?tenant=<slug>                    → rows
//   POST {action:"claim", tenant, host, preVerified?}
//   POST {action:"verify", host}           (real DNS TXT lookup)
//   POST {action:"remove", host}
//   POST {action:"primary", host}
// Console UI arrives with MC21/OP03 (W4); until then this API + `pnpm domain`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const ACTOR = { kind: "operator", id: "operator" };

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const tenant = request.nextUrl.searchParams.get("tenant");
  return NextResponse.json({ ok: true, domains: await listDomains({ tenantId: tenant || null }) });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "claim":
        return NextResponse.json({
          ok: true,
          ...(await claimDomain({ host: body.host, tenantId: body.tenant, preVerified: Boolean(body.preVerified), actor: ACTOR })),
        });
      case "verify": {
        const r = await verifyDomain({ host: body.host, actor: ACTOR });
        return NextResponse.json({ ok: r.ok, ...(r.error ? { error: r.error } : {}) }, { status: r.ok ? 200 : 409 });
      }
      case "remove":
        return NextResponse.json({ ok: true, removed: await removeDomain({ host: body.host, actor: ACTOR }) });
      case "primary":
        await setPrimaryDomain({ host: body.host, actor: ACTOR });
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "action must be claim|verify|remove|primary" }, { status: 400 });
    }
  } catch (e) {
    const msg = String(e?.message || e);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: /registered to tenant/.test(msg) ? 409 : 400 });
  }
}
