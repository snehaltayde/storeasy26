import { NextResponse } from "next/server";
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
    const r = await B.startSubscription(tenant.id, String(body.plan || ""));
    slog("billing_subscribe_requested", { plan: body.plan, status: r.status });
    await audit({ actor: auth.actor, action: "settings.write", resource: `billing:subscribe:${body.plan}`, diff: { status: r.status } });
    return NextResponse.json({ ok: true, result: r, ...(await buildBillingView()) });
  } catch (e) {
    const status = e.code === "BILLING_UNCONFIGURED" ? 503 : 422;
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status });
  }
});
