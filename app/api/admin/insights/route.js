import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listInsights, generateInsights, setInsightStatus, applyInsightDraft, aiBudget, aiConfigured, AI_MODEL } from "@/lib/ai/insights";
import { tenantHandler } from "@/lib/tenant-request";
import { writeRefusalBody } from "@/lib/content-writes";
import { validationBody } from "@/lib/cms/issues";

// AI insights admin API (S47 / BE32 + MC19). Honest states throughout: no
// key = "not configured" (never a mock), budget spent = refused with the
// numbers, invalid model output = rejected, nothing stored. Applying a
// draft writes through the normal CMS store; the AI never publishes.
//   GET                          → insights + budget + configured
//   POST {generate: true}        → call the model (budget-gated)
//   POST {dismiss:{id}} | {restore:{id}}
//   POST {apply:{id, index}}     → proposal's draft → CMS draft
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, configured: aiConfigured(), model: AI_MODEL(), budget: await aiBudget(), insights: await listInsights() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.generate) {
      const r = await generateInsights();
      await audit({ actor: auth.actor, action: "storefront.write", resource: `ai_insight:${r.id}`, diff: { proposals: r.proposals.length, tokens: r.tokens_in + r.tokens_out } });
      return NextResponse.json({ ok: true, insight: { ...r, facts: undefined } });
    }
    if (body.dismiss || body.restore) {
      const id = String((body.dismiss || body.restore).id || "");
      const status = body.dismiss ? "dismissed" : "proposed";
      const r = await setInsightStatus(id, status);
      await audit({ actor: auth.actor, action: "storefront.write", resource: `ai_insight:${id}`, diff: { status } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.apply) {
      // P2-WRITERS: through lib/content-writes.js, which reads the mode itself
      const r = await applyInsightDraft(String(body.apply.id || ""), Number(body.apply.index), { actor: auth.actor });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `ai_insight:${r.id}`, diff: { applied: r.applied } });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    // the AI provider's own failures first: they are not the store's database
    if (e?.code === "AI_UNCONFIGURED" || e?.code === "AI_UNAVAILABLE") return NextResponse.json({ error: String(e.message).slice(0, 300), code: e.code }, { status: 503 });
    // the draft door's own answers (lib/content-writes.js): every issue, then
    // a deliberate refusal (409 concurrent edit, 409 store mode, stale document)
    if (e?.issues) return NextResponse.json(validationBody(e.issues), { status: 422 });
    if (e?.expose) return NextResponse.json(writeRefusalBody(e), { status: e.status });
    const infra = infraResponse(e, { route: "admin/insights" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), code: e.code || null }, { status: 422 });
  }
});
