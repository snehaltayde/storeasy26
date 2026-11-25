import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { costReport, setCostInputs } from "@/lib/platform/costs";
import { patchTenant, getTenant } from "@/lib/platform/control";
import { audit } from "@/lib/platform/audit";

// Operator unit costs (S47 / OP09; shown in Billing → Costs since Phase 3 line 3). The operator enters the real monthly
// provider totals; allocation uses MEASURED drivers with the method stated,
// and the unallocated remainder stays visible. Budgets alert — they never
// silently charge a merchant anything.
//   GET ?month=YYYY-MM          → report (defaults to this month)
//   POST {inputs:{month, totals, note}}
//   POST {budget:{tenant, amount|null}}   → per-tenant monthly alert budget
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const month = new URL(request.url).searchParams.get("month") || undefined;
  if (month && !/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 422 });
  return NextResponse.json({ ok: true, report: await costReport(month) });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.inputs) {
      const r = await setCostInputs(String(body.inputs.month || ""), body.inputs.totals, body.inputs.note);
      await audit({ actor: auth.operator, action: "costs.inputs", resource: `costs:${r.month}`, diff: r.totals });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.budget) {
      const t = await getTenant(String(body.budget.tenant || ""));
      if (!t) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
      const amount = body.budget.amount == null ? null : Number(body.budget.amount);
      if (amount != null && (!Number.isFinite(amount) || amount <= 0)) return NextResponse.json({ error: "budget must be a positive number (or null to clear)" }, { status: 422 });
      // only the budget: patchTenant merges it into the row as it is now. Spreading
      // the (cached) config here wrote back an old copy of every other setting.
      await patchTenant(t.id, { config: { cost_budget: amount } });
      await audit({ actor: auth.operator, action: "costs.budget", tenantId: t.id, diff: { cost_budget: amount } });
      return NextResponse.json({ ok: true, tenant: t.id, cost_budget: amount });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
