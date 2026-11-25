import { NextResponse } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
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

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const tenant = request.nextUrl.searchParams.get("tenant");
  return NextResponse.json({ ok: true, domains: await listDomains({ tenantId: tenant || null }) });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "claim":
        return NextResponse.json({
          ok: true,
          ...(await claimDomain({ host: body.host, tenantId: body.tenant, preVerified: Boolean(body.preVerified), actor: auth.operator })),
        });
      case "verify": {
        const r = await verifyDomain({ host: body.host, actor: auth.operator });
        return NextResponse.json({ ok: r.ok, ...(r.error ? { error: r.error } : {}) }, { status: r.ok ? 200 : 409 });
      }
      case "remove":
        return NextResponse.json({ ok: true, removed: await removeDomain({ host: body.host, actor: auth.operator }) });
      case "primary":
        await setPrimaryDomain({ host: body.host, actor: auth.operator });
        return NextResponse.json({ ok: true });
      default:
        return NextResponse.json({ error: "action must be claim|verify|remove|primary" }, { status: 400 });
    }
  } catch (e) {
    return operatorError(e, { words: "That domain change didn't go through just now. Try again.", status: 400, event: "domain_action_failed" });
  }
}
