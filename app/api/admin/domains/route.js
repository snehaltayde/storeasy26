import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listDomains, verifyDomain } from "@/lib/platform/domains";
import { currentTenant } from "@/lib/tenant-context";
import { platformConfigured } from "@/lib/platform/control";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Merchant domains & SEO surface (S43 / MC21) over the S28 BE12 registry.
//   GET  → THIS tenant's domains (status, challenge TXT record, primary)
//   POST {action:"verify", host} → run the DNS TXT check for OWN hosts only
// Claiming/removing stays operator-side (it changes routing for the fleet);
// this surface shows the merchant exactly what to add at their DNS and lets
// them trigger verification themselves.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function view(tenantId) {
  const rows = await listDomains({ tenantId });
  return rows.map((d) => ({
    host: d.host,
    verified: Boolean(d.verified_at),
    primary: Boolean(d.is_primary),
    challenge: d.verified_at ? null : { record: `_storeasy-challenge.${d.host.replace(/^www\./, "")}`, type: "TXT", value: d.challenge },
    claimed_at: d.created_at || null,
    verified_at: d.verified_at || null,
  }));
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return NextResponse.json({ ok: true, supported: false, reason: "Custom domains need the platform control plane." });
  }
  return NextResponse.json({ ok: true, supported: true, domains: await view(tenant.id), activeHosts: tenant.domains || [] });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return NextResponse.json({ error: "Custom domains need the platform control plane" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action !== "verify") return NextResponse.json({ error: "action must be verify" }, { status: 400 });
    const host = String(body.host || "").trim().toLowerCase();
    // ownership check: merchants verify only hosts CLAIMED FOR THEIR tenant
    const mine = (await listDomains({ tenantId: tenant.id })).some((d) => d.host === host);
    if (!mine) return NextResponse.json({ error: "that host isn't claimed for this store — ask the platform operator to claim it first" }, { status: 403 });
    const r = await verifyDomain({ host, actor: auth.actor });
    slog("domain_verify_attempt", { host, ok: !!r.ok });
    await audit({ actor: auth.actor, action: "settings.write", resource: `domain:${host}`, diff: { verified: !!r.ok } });
    return NextResponse.json({ ok: true, result: { verified: !!r.ok, error: r.error || null }, domains: await view(tenant.id) });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
