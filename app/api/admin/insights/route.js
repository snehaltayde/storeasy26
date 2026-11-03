import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listInsights, generateInsights, setInsightStatus, applyInsightDraft, aiBudget, aiConfigured, AI_MODEL } from "@/lib/ai/insights";
import { tenantHandler } from "@/lib/tenant-request";
import { legacyWritesRefusal } from "@/lib/cms-mode";

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
  if (body.apply && !body.generate && !body.dismiss && !body.restore) {
    // P2-GUARD: applying writes a hero or announcement draft. Until
    // P2-WRITERS routes it through a mode-aware facade, a store on the new
    // editor refuses it.
    const refused = await legacyWritesRefusal({ route: "admin/insights" });
    if (refused) return NextResponse.json(refused.body, { status: refused.status });
  }
  try {
    if (body.generate) {
      const r = await generateInsights();
      await audit({ actor: auth.actor, action: "storefront.write", resource: `ai_insight:${r.id}`, diff: { proposals: r.proposals.length, tokens: r.tokens_in + r.tokens_out } });
      return NextResponse.json({ ok: true, insight: { ...r, facts: undefined } });
    }
    if (body.dismiss) return NextResponse.json({ ok: true, ...(await setInsightStatus(String(body.dismiss.id || ""), "dismissed")) });
    if (body.restore) return NextResponse.json({ ok: true, ...(await setInsightStatus(String(body.restore.id || ""), "proposed")) });
    if (body.apply) {
      const r = await applyInsightDraft(String(body.apply.id || ""), Number(body.apply.index));
      await audit({ actor: auth.actor, action: "storefront.write", resource: `ai_insight:${r.id}`, diff: { applied: r.applied } });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    // the AI provider's own failures first: they are not the store's database
    if (e?.code === "AI_UNCONFIGURED" || e?.code === "AI_UNAVAILABLE") return NextResponse.json({ error: String(e.message).slice(0, 300), code: e.code }, { status: 503 });
    const infra = infraResponse(e, { route: "admin/insights" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), code: e.code || null }, { status: 422 });
  }
});
