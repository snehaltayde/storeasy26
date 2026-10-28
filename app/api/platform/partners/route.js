import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { createAgency, setAgencyStatus, listAgencies, addAgencyMember, revokeGrant, attributeReferral, voidReferral, recomputeCommissions, commissionStatement } from "@/lib/platform/agency";
import { createInvite, findUserByEmail } from "@/lib/platform/identity";
import { upsertCaseStudy, setCaseStudyPublished, listCaseStudies, deleteCaseStudy } from "@/lib/platform/case-studies";
import { platformDb, getTenant } from "@/lib/platform/control";
import { audit } from "@/lib/platform/audit";

// Partner administration (S48 / OP14 + MK06 authoring). Commercial status
// (verified / eligible / bps) is independent of client access: nothing here
// grants an agency a store — only clients accept grants. Referral
// attribution and disputes are explicit operator acts; commissions derive
// idempotently from the billing ledger (never counted twice).
//   GET → agencies, grants, referrals, case studies
//   GET ?statement=<agencyId>
//   POST {agency:{name}} | {status:{id, status|referral_eligible|commission_bps}}
//   POST {member_invite:{agencyId, email}}
//   POST {referral:{tenant, agency}} | {void_referral:{tenant, note}}
//   POST {recompute: true} | {revoke_grant:{id}}
//   POST {case_study:{…}} | {publish_case:{slug, published}} | {delete_case:{slug}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const authed = async (request) => verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value);

export async function GET(request) {
  if (!(await authed(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const statementFor = new URL(request.url).searchParams.get("statement");
  if (statementFor) return NextResponse.json({ ok: true, statement: await commissionStatement(statementFor) });
  const [agencies, grants, referrals, cases] = await Promise.all([
    listAgencies(),
    platformDb().execute("SELECT g.*, a.name agency_name FROM agency_grants g JOIN agencies a ON a.id = g.agency_id ORDER BY g.created_at DESC LIMIT 50"),
    platformDb().execute("SELECT r.*, a.name agency_name FROM agency_referrals r JOIN agencies a ON a.id = r.agency_id"),
    listCaseStudies(),
  ]);
  return NextResponse.json({
    ok: true,
    agencies,
    grants: grants.rows.map((g) => ({ ...g, token_hash: undefined })),
    referrals: referrals.rows.map((r) => ({ ...r })),
    caseStudies: cases,
  });
}

export async function POST(request) {
  if (!(await authed(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.agency) {
      const r = await createAgency({ name: body.agency.name });
      await audit({ actor: "operator", action: "agency.create", resource: `agency:${r.id}` });
      return NextResponse.json({ ok: true, agency: r });
    }
    if (body.status) {
      const r = await setAgencyStatus(String(body.status.id || ""), body.status);
      await audit({ actor: "operator", action: "agency.status", resource: `agency:${r.id}`, diff: { ...body.status, id: undefined } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.member_invite) {
      const { agencyId, email } = body.member_invite;
      const existing = await findUserByEmail(String(email || ""));
      if (existing) {
        await addAgencyMember(String(agencyId || ""), existing.id, "member");
        await audit({ actor: "operator", action: "agency.member_added", resource: `agency:${agencyId}` });
        return NextResponse.json({ ok: true, attached: true, note: "that account already exists — attached to the agency; they sign in at /partners" });
      }
      const inv = await createInvite({ email, kind: "agency-member", role: `agency-member:${agencyId}`, invitedBy: "operator" });
      await audit({ actor: "operator", action: "agency.member_invited", resource: `agency:${agencyId}` });
      return NextResponse.json({ ok: true, token: inv.token, expires_at: inv.expiresAt, note: "send this code — they join at /partners → 'Have an invitation code?'" });
    }
    if (body.referral) {
      const t = await getTenant(String(body.referral.tenant || ""));
      if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
      const r = await attributeReferral(t.id, String(body.referral.agency || ""), body.referral.note || "");
      await audit({ actor: "operator", action: "agency.referral", tenantId: t.id, diff: { agency: r.agencyId } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.void_referral) {
      const r = await voidReferral(String(body.void_referral.tenant || ""), body.void_referral.note || "dispute");
      await audit({ actor: "operator", action: "agency.referral_void", tenantId: r.tenantId });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.recompute) return NextResponse.json({ ok: true, ...(await recomputeCommissions()) });
    if (body.revoke_grant) {
      const r = await revokeGrant(String(body.revoke_grant.id || ""), "operator");
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.case_study) return NextResponse.json({ ok: true, caseStudy: await upsertCaseStudy(body.case_study) });
    if (body.publish_case) {
      const r = await setCaseStudyPublished(String(body.publish_case.slug || ""), !!body.publish_case.published);
      await audit({ actor: "operator", action: "case_study.publish", resource: `case:${r.slug}`, diff: { published: r.published } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.delete_case) return NextResponse.json({ ok: true, ...(await deleteCaseStudy(String(body.delete_case.slug || ""))) });
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), ...(e.blocks ? { blocks: e.blocks } : {}) }, { status: 422 });
  }
}
