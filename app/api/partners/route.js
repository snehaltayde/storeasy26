import { NextResponse } from "next/server";
import {
  agencyFromToken,
  AGENCY_COOKIE,
  agencyPortfolio,
  grantsForAgency,
  createGrantInvite,
  revokeGrant,
  exportAgencyKit,
  listAgencyKits,
  applyAgencyKit,
  createClientApproval,
  approvalsForAgency,
  commissionStatement,
  agencyClientReport,
  activeGrant,
} from "@/lib/platform/agency";
import { platformDb } from "@/lib/platform/control";
import { sameOrigin } from "@/lib/origin-check";
import { rateLimit } from "@/lib/rate-limit";
import { runAsTenant } from "@/lib/platform/ops";
import { legacyWritesRefusal } from "@/lib/cms-mode";

// Agency workspace API (S48 / AG01–06). EVERY tenant-touching action
// re-checks the accepted grant on this request — revocation is immediate,
// and there is no cross-client read: each call names ONE granted store.
//   GET  ?view=portfolio|grants|kits|approvals|referrals
//   GET  ?view=report&tenant=<slug>
//   POST {invite:{clientEmail, role}} | {revoke:{id}}
//   POST {kit_export:{tenant, name}} | {kit_apply:{kit, tenant}}
//   POST {approval:{tenant, note}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fail = (status, error) => NextResponse.json({ error }, { status });
const me = (request) => agencyFromToken(request.cookies.get(AGENCY_COOKIE)?.value);

export async function GET(request) {
  const actor = await me(request);
  if (!actor) return fail(401, "Sign in");
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "portfolio";
  const agencyId = actor.agency.id;
  try {
    if (view === "portfolio") return NextResponse.json({ ok: true, agency: actor.agency, portfolio: await agencyPortfolio(agencyId) });
    if (view === "grants") return NextResponse.json({ ok: true, grants: await grantsForAgency(agencyId) });
    if (view === "kits") return NextResponse.json({ ok: true, kits: await listAgencyKits(agencyId) });
    if (view === "approvals") return NextResponse.json({ ok: true, approvals: await approvalsForAgency(agencyId) });
    if (view === "referrals") {
      const refs = await platformDb().execute({ sql: "SELECT * FROM agency_referrals WHERE agency_id = ?", args: [agencyId] });
      return NextResponse.json({ ok: true, eligible: actor.agency.referral_eligible, commission_bps: actor.agency.commission_bps, referrals: refs.rows.map((r) => ({ ...r })), statement: await commissionStatement(agencyId) });
    }
    if (view === "report") {
      const tenant = String(url.searchParams.get("tenant") || "");
      return NextResponse.json({ ok: true, report: await agencyClientReport(agencyId, tenant) });
    }
    return fail(400, "unknown view");
  } catch (e) {
    return fail(422, String(e?.message || e).slice(0, 300));
  }
}

export async function POST(request) {
  if (!sameOrigin(request)) return fail(403, "Cross-origin request rejected");
  const actor = await me(request);
  if (!actor) return fail(401, "Sign in");
  const limited = rateLimit(request, { name: "partners", limit: 30 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const agencyId = actor.agency.id;
  try {
    if (body.invite) {
      const r = await createGrantInvite({ agencyId, clientEmail: body.invite.clientEmail, role: body.invite.role });
      return NextResponse.json({ ok: true, grant: { id: r.id, expires_at: r.expires_at }, token: r.token, note: "send this code to your client — they accept it in their own console (Settings → Agency access); it binds to their email and expires" });
    }
    if (body.revoke) {
      // an agency may walk away from its own grant; the client has the same
      // control in their console
      const g = (await grantsForAgency(agencyId)).find((x) => x.id === String(body.revoke.id || ""));
      if (!g) return fail(404, "grant not found");
      return NextResponse.json({ ok: true, ...(await revokeGrant(g.id, `agency:${agencyId}`)) });
    }
    if (body.kit_export) {
      const r = await exportAgencyKit({ agencyId, tenantId: String(body.kit_export.tenant || ""), name: body.kit_export.name });
      return NextResponse.json({ ok: true, kit: { id: r.id, name: r.name, payload: r.payload } });
    }
    if (body.kit_apply) {
      const tenant = String(body.kit_apply.tenant || "");
      // P2-GUARD: the grant first (no probing other stores), then the store's
      // own mode: a store on the new editor refuses the kit's legacy drafts.
      // P2-WRITERS replaces this with a mode-aware facade.
      if (!(await activeGrant(agencyId, tenant))) return fail(422, "no accepted grant for that store");
      const refused = await runAsTenant(tenant, () => legacyWritesRefusal({ route: "partners" }));
      if (refused) return NextResponse.json(refused.body, { status: refused.status });
      const r = await applyAgencyKit({ agencyId, kitId: String(body.kit_apply.kit || ""), tenantId: tenant });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.approval) {
      const tenant = String(body.approval.tenant || "");
      if (!(await activeGrant(agencyId, tenant))) return fail(422, "no accepted grant for that store");
      const r = await createClientApproval({ agencyId, tenantId: tenant, note: body.approval.note });
      return NextResponse.json({ ok: true, approval: { id: r.id, content_hash: r.content_hash, expires_at: r.expires_at }, token: r.token, note: "share /approve/<code> ON THE CLIENT'S STORE DOMAIN — signed, expiring, bound to this exact draft hash" });
    }
    return fail(400, "Nothing to do");
  } catch (e) {
    return fail(422, String(e?.message || e).slice(0, 300));
  }
}
