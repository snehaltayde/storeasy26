import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { billingOverview, ensureDefaultPlans, setOverride, clearOverride, listPlans, createPlanVersion } from "@/lib/platform/billing";
import { billingProviderConfigured } from "@/lib/platform/razorpay-billing";
import { slog } from "@/lib/log";

// Operator billing reconciliation (S40 / OP08): fleet subscriptions, MRR,
// gross/refunds/net by month (sums over the deduped provider-event ledger),
// the exception queue (payment trouble, past-grace, orphan events) and
// entitlement overrides (time-limited, reasoned, audited).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  await ensureDefaultPlans();
  const overview = await billingOverview();
  return NextResponse.json({
    ok: true,
    ...overview,
    plans: await listPlans({ activeOnly: false }),
    provider_configured: billingProviderConfigured(),
  });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "override") {
      await setOverride(String(body.tenant || ""), {
        features: body.features,
        reason: body.reason,
        setBy: auth.operator.id,
        expiresAt: body.expiresAt || null,
      });
      slog("billing_override_set", { tenant: body.tenant });
    } else if (body.action === "clear_override") {
      await clearOverride(String(body.tenant || ""), { setBy: auth.operator.id });
      slog("billing_override_cleared", { tenant: body.tenant });
    } else if (body.action === "plan_version") {
      // versioned catalog: a change = a NEW version; old versions stay for
      // pinned subscribers
      const p = await createPlanVersion(String(body.plan || ""), body.spec || {});
      slog("billing_plan_version", { plan: p.id, version: p.version });
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    const overview = await billingOverview();
    return NextResponse.json({ ok: true, ...overview, plans: await listPlans({ activeOnly: false }), provider_configured: billingProviderConfigured() });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
