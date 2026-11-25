import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { mailConfigured } from "@/lib/mail";
import { storeOrigin } from "@/lib/platform/onboarding-ops";
import {
  createSupportGrant,
  revokeSupportGrant,
  listSupportGrants,
  supportAccessView,
  openSupportGrants,
  mailSupportOpened,
  mintSupportEntry,
  SupportEntryRefused,
  SUPPORT_HOURS,
} from "@/lib/platform/support";

// Support-grant API (S34 / OP10; Phase 3 line 5), operator-only:
//   GET  ?tenant=            → grants (newest first)
//   GET  ?view=store&tenant= → { open, history, mail } for the store page's card
//   GET  ?view=open          → every open grant across stores
//   POST {action:"grant", tenant, reason, hours?} (owners and admins are emailed)
//   POST {action:"revoke", id}
//   POST {action:"enter", tenant} → { token, entryUrl, expiresAt }: the
//        single-use, 60-second entry token the page posts to the store's
//        /api/admin/support-entry. Never for the setup password (403). The
//        answer is no-store and the token is never logged or audited.
// With an active grant, the operator's _platform cookie also opens that
// tenant's /admin as the read-only SUPPORT role on the same host.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const p = request.nextUrl.searchParams;
  const tenant = p.get("tenant");
  if (p.get("view") === "open") return NextResponse.json({ ok: true, grants: await openSupportGrants() }, { headers: NO_STORE });
  if (p.get("view") === "store") {
    if (!tenant) return NextResponse.json({ error: "tenant is required" }, { status: 400 });
    return NextResponse.json({ ok: true, ...(await supportAccessView(tenant)), mail: mailConfigured() }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, grants: await listSupportGrants({ tenantId: tenant || null }) });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "grant") {
      const hours = Number(body.hours ?? 4);
      if (!SUPPORT_HOURS.includes(hours)) return NextResponse.json({ error: `hours must be one of ${SUPPORT_HOURS.join(", ")}` }, { status: 400 });
      const grant = await createSupportGrant({ tenantId: body.tenant, reason: body.reason, hours, operator: auth.operator });
      const mail = await mailSupportOpened({ tenantId: grant.tenantId, grant: { ...grant, reason: String(body.reason).trim() }, operator: auth.operator });
      return NextResponse.json({ ok: true, ...grant, mail });
    }
    if (body.action === "revoke") {
      const ok = await revokeSupportGrant(String(body.id || ""), { operator: auth.operator });
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    if (body.action === "enter") {
      // a local store's domain has no port: the operator console's is kept (as the onboarding sheet's links do)
      const entry = await mintSupportEntry({ tenantId: body.tenant, operator: auth.operator, storeOrigin: (t) => storeOrigin(t, request.nextUrl.origin) });
      return NextResponse.json({ ok: true, ...entry }, { headers: NO_STORE });
    }
    return NextResponse.json({ error: "action must be grant|revoke|enter" }, { status: 400 });
  } catch (e) {
    if (e instanceof SupportEntryRefused) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 });
  }
}
