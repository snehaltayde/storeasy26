import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { upsertCaseStudy, setCaseStudyPublished, listCaseStudies, deleteCaseStudy } from "@/lib/platform/case-studies";
import { audit } from "@/lib/platform/audit";
import { sameOrigin } from "@/lib/origin-check";

// Case-study authoring for the marketing site's /customers (MK06), operator
// only. Publishing is gated in lib/platform/case-studies.js; every save,
// publish and delete writes an audit_log row. Saving a published study
// takes it back to draft, so republishing runs the gate again.
//   GET → { caseStudies }
//   POST {case_study:{…}} | {publish_case:{slug, published}} | {delete_case:{slug}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPERATOR = { kind: "operator", id: "operator" };
const authed = async (request) => verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value);

export async function GET(request) {
  if (!(await authed(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, caseStudies: await listCaseStudies() });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await authed(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    if (body?.case_study) {
      const caseStudy = await upsertCaseStudy(body.case_study);
      await audit({ actor: OPERATOR, action: "case_study.save", resource: `case:${caseStudy.slug}`, tenantId: null });
      return NextResponse.json({ ok: true, caseStudy });
    }
    if (body?.publish_case) {
      const r = await setCaseStudyPublished(String(body.publish_case.slug || ""), !!body.publish_case.published);
      await audit({ actor: OPERATOR, action: "case_study.publish", resource: `case:${r.slug}`, diff: { published: r.published }, tenantId: null });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body?.delete_case) {
      const r = await deleteCaseStudy(String(body.delete_case.slug || ""));
      await audit({ actor: OPERATOR, action: "case_study.delete", resource: `case:${r.slug}`, tenantId: null });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), ...(e.blocks ? { blocks: e.blocks } : {}) }, { status: 422 });
  }
}
