import { NextResponse } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
import { upsertCaseStudy, setCaseStudyPublished, listCaseStudies, deleteCaseStudy } from "@/lib/platform/case-studies";
import { audit, operatorActor } from "@/lib/platform/audit";

// Case-study authoring for the marketing site's /customers (MK06), operator
// only. Publishing is gated in lib/platform/case-studies.js; every save,
// publish and delete writes an audit_log row. Saving a published study
// takes it back to draft, so republishing runs the gate again.
//   GET → { caseStudies }
//   POST {case_study:{…}} | {publish_case:{slug, published}} | {delete_case:{slug}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ ok: true, caseStudies: await listCaseStudies() });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body?.case_study) {
      const caseStudy = await upsertCaseStudy(body.case_study);
      await audit({ actor: operatorActor(auth.operator), action: "case_study.save", resource: `case:${caseStudy.slug}`, tenantId: null });
      return NextResponse.json({ ok: true, caseStudy });
    }
    if (body?.publish_case) {
      const r = await setCaseStudyPublished(String(body.publish_case.slug || ""), !!body.publish_case.published);
      await audit({ actor: operatorActor(auth.operator), action: "case_study.publish", resource: `case:${r.slug}`, diff: { published: r.published }, tenantId: null });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body?.delete_case) {
      const r = await deleteCaseStudy(String(body.delete_case.slug || ""));
      // the row is gone, so the audit row keeps what was removed (Phase 3 line 6)
      await audit({ actor: operatorActor(auth.operator), action: "case_study.delete", resource: `case:${r.slug}`, tenantId: null, diff: { slug: r.slug, removed: "the study with its consent record and measurements" } });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return operatorError(e, { words: "The case study didn't save just now. Try again.", event: "case_study_action_failed", fields: e?.blocks ? { blocks: e.blocks } : {} });
  }
}
