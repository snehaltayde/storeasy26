import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import {
  billingOverview,
  ensureDefaultPlans,
  setOverride,
  clearOverride,
  listPlansWithSubscribers,
  createPlanVersion,
  retirePlanVersion,
  startSubscription,
  extendGrace,
  cancelSubscription,
  listSubscriptions,
  listBillingEvents,
  auditStart,
  auditStartFailed,
} from "@/lib/platform/billing";
import { billingProviderConfigured } from "@/lib/platform/razorpay-billing";
import { slog } from "@/lib/log";
import { scrubSecrets } from "@/lib/platform/turso-api";
import { audit, OPERATOR_ONLY } from "@/lib/platform/audit";

// Operator billing (S40 / OP08; Phase 3 line 3): fleet subscriptions, MRR,
// gross/refunds/net by month (sums over the deduped provider-event ledger),
// the exception queue (payment trouble, past grace, orphan events), the plan
// catalog, the ledger and entitlement overrides.
//   GET                          overview + plans (with subscriber counts) + overrides
//   GET ?view=subscriptions&q=&status=&plan=&store=&offset=
//   GET ?view=events&store=&type=&month=&offset=
//   POST {action: override | clear_override | plan_version | retire | start | grace | cancel}
// Every write is audited (billing.*) with the operator from requireOperator.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const summary = async () => ({
  ...(await billingOverview()),
  plans: await listPlansWithSubscribers(),
  provider_configured: billingProviderConfigured(),
});

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const sp = new URL(request.url).searchParams;
  const get = (k) => (sp.get(k) || "").slice(0, 80);
  try {
    await ensureDefaultPlans();
    if (get("view") === "subscriptions") {
      const list = await listSubscriptions({ q: get("q"), status: get("status"), plan: get("plan"), store: get("store"), offset: get("offset") });
      return NextResponse.json({ ok: true, ...list, plans: await listPlansWithSubscribers(), provider_configured: billingProviderConfigured() });
    }
    if (get("view") === "events") {
      return NextResponse.json({ ok: true, ...(await listBillingEvents({ store: get("store"), type: get("type"), month: get("month"), offset: get("offset") })) });
    }
    return NextResponse.json({ ok: true, ...(await summary()) });
  } catch (e) {
    // P3-G: fixed words; the scrubbed error goes to the log
    slog("billing_read_failed", { error: scrubSecrets(e?.message || e).slice(0, 300) });
    return NextResponse.json({ error: "We couldn't read billing just now. Try again." }, { status: 422 });
  }
}

const tenantOf = (body) => String(body.tenant || "");
const reasonOf = (body) => String(body.reason || "").trim().slice(0, 300);

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  const actor = auth.operator;
  let result = null;
  try {
    if (body.action === "override") {
      if (body.expiresAt != null && !(new Date(body.expiresAt).getTime() > Date.now())) throw new Error("the expiry must be a date in the future");
      await setOverride(String(body.tenant || ""), { features: body.features, reason: body.reason, setBy: actor, expiresAt: body.expiresAt || null });
      slog("billing_override_set", { tenant: body.tenant });
    } else if (body.action === "clear_override") {
      await clearOverride(String(body.tenant || ""), { setBy: actor });
      slog("billing_override_cleared", { tenant: body.tenant });
    } else if (body.action === "plan_version") {
      // versioned catalog: a change = a NEW version; old versions stay for
      // pinned subscribers
      const p = await createPlanVersion(String(body.plan || ""), body.spec || {});
      slog("billing_plan_version", { plan: p.id, version: p.version });
      await audit({ actor, action: "billing.plan_version", resource: `plan:${p.id}`, tenantId: null, diff: { version: p.version, name: p.name, price: p.price, interval: p.interval, features: p.features } });
      result = { plan: p.id, version: p.version };
    } else if (body.action === "retire") {
      const p = await retirePlanVersion(String(body.plan || ""), Number(body.version));
      await audit({ actor, action: "billing.plan_retired", resource: `plan:${p.id}`, tenantId: null, diff: { version: p.version } });
      result = { plan: p.id, version: p.version, status: "retired" };
    } else if (body.action === "start") {
      const r = await startSubscription(tenantOf(body), String(body.plan || ""));
      await auditStart({ actor, tenantId: tenantOf(body), result: r });
      // the founder's payment link is shown to the operator once, here
      result = { id: r.id, plan: r.plan, status: r.status, local: Boolean(r.local), shortUrl: r.shortUrl || null, previous: r.previous };
    } else if (body.action === "grace") {
      const reason = reasonOf(body);
      const r = await extendGrace(String(body.subscription || ""), { days: body.days, reason });
      await audit({ actor, action: "billing.grace", resource: `subscription:${r.id}`, tenantId: r.tenant, diff: { days: Number(body.days), previous: r.previous, grace_until: r.grace_until, [OPERATOR_ONLY]: { reason } } });
      result = r;
    } else if (body.action === "cancel") {
      const r = await cancelSubscription(String(body.subscription || ""), { atCycleEnd: body.atCycleEnd !== false });
      await audit({ actor, action: "billing.cancel", resource: `subscription:${r.id}`, tenantId: r.tenant, diff: { ended: r.ended, local: r.local, [OPERATOR_ONLY]: { reason: reasonOf(body) || null } } });
      result = r;
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result, ...(await summary()) });
  } catch (e) {
    // a start or cancel that failed part way is audited as it happened
    if ((["PROVIDER_ERROR", "BILLING_CONFLICT"].includes(e?.code) || e?.detail?.provider_subscription) && ["start", "cancel"].includes(body.action)) {
      if (body.action === "start") await auditStartFailed({ actor, tenantId: tenantOf(body), plan: body.plan, error: e });
      else {
        const { error = null, ...detail } = e.detail || {};
        await audit({ actor, action: "billing.cancel_failed", resource: `subscription:${detail.subscription}`, tenantId: detail.tenant || null, diff: { code: e.code, ...detail, [OPERATOR_ONLY]: { error, reason: reasonOf(body) || null } } });
      }
      return NextResponse.json({ error: String(e.message).slice(0, 300), code: e.code || null, detail: e.detail || null }, { status: e.code === "BILLING_CONFLICT" ? 409 : 502 });
    }
    if (e?.code === "BILLING_UNCONFIGURED") return NextResponse.json({ error: String(e.message).slice(0, 300), code: e.code }, { status: 503 });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
