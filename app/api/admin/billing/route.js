import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { platformConfigured } from "@/lib/platform/control";
import { buildBillingView } from "@/lib/admin/billing-view";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Merchant billing API (S40 / MC24).
//   GET  → plan catalog + this store's subscription/entitlements/quotas/history
//   POST {action:"subscribe", plan} → start a subscription (free = instant
//        local activation; paid = provider authorization short_url; an
//        unconfigured provider answers an honest 503, never a mock)
// Billing is settings territory (owner/admin).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, ...(await buildBillingView()) });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return NextResponse.json({ error: "Billing needs the platform control plane" }, { status: 503 });
  }
  try {
    if (body.action !== "subscribe") return NextResponse.json({ error: "action must be subscribe" }, { status: 400 });
    const B = await import("@/lib/platform/billing.js");
    let r;
    try {
      r = await B.startSubscription(tenant.id, String(body.plan || ""));
    } catch (e) {
      // a start that failed part way (Razorpay refused, or a change at the same moment) is audited as it happened
      if (["PROVIDER_ERROR", "BILLING_CONFLICT"].includes(e?.code) || e?.detail?.provider_subscription) {
        await B.auditStartFailed({ actor: auth.actor, tenantId: tenant.id, plan: String(body.plan || ""), error: e });
        const words = e.code ? String(e.message).slice(0, 300) : "The plan couldn't start. Try again in a few minutes.";
        return NextResponse.json({ error: words }, { status: e.code === "BILLING_CONFLICT" ? 409 : 502 });
      }
      throw e;
    }
    slog("billing_subscribe_requested", { plan: body.plan, status: r.status });
    await audit({ actor: auth.actor, action: "settings.write", resource: `billing:subscribe:${body.plan}`, diff: { status: r.status } });
    await B.auditStart({ actor: auth.actor, tenantId: tenant.id, result: r });
    // only what the founder needs: never Razorpay's error text about the old subscription
    const result = { id: r.id, plan: r.plan, status: r.status, local: Boolean(r.local), shortUrl: r.shortUrl || null, previousEnded: r.previous.every((p) => p.ended != null) };
    return NextResponse.json({ ok: true, result, ...(await buildBillingView()) });
  } catch (e) {
    if (e?.code === "BILLING_UNCONFIGURED") return NextResponse.json({ error: String(e.message).slice(0, 300) }, { status: 503 });
    const infra = infraResponse(e, { route: "admin/billing" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
