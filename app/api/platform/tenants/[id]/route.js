import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { patchTenant, getTenant, listTenants, platformDb } from "@/lib/platform/control.js";
import { audit } from "@/lib/platform/audit";
import { syncTenantCatalog } from "@/lib/sync.js";
import { withTenant } from "@/lib/tenant-context.js";
import { slog } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// GET — tenant DETAIL (S41 / OP03): lifecycle, config summary, secrets as a
// PRESENCE MAP (which keys exist — values never leave the envelope), billing
// snapshot, onboarding progress, provisioning history.
export async function GET(request, { params }) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const secretsPresent = Object.fromEntries(Object.keys(tenant.secrets || {}).map((k) => [k, true]));
  const runs = (
    await platformDb().execute({ sql: "SELECT id, status, steps, error, created_at FROM provision_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10", args: [id] })
  ).rows.map((r) => {
    let steps = [];
    try {
      steps = JSON.parse(r.steps || "[]").map((s) => ({ name: s.name, status: s.status }));
    } catch { /* malformed */ }
    return { id: r.id, status: r.status, steps, error: r.error, created_at: r.created_at };
  });
  let onboarding = null;
  try {
    const { buildChecklist } = await import("@/lib/admin/onboarding.js");
    onboarding = await withTenant(tenant, buildChecklist);
  } catch { /* tenant db unreachable */ }

  return NextResponse.json({
    ok: true,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      domains: tenant.domains || [],
      config: {
        shop_domain: tenant.config?.shopify_store_domain || null,
        client_id: tenant.config?.shopify_client_id || null,
        site_name: tenant.config?.site?.name || null,
        support_email: tenant.config?.site?.support_email || null,
        checkout_mode: tenant.config?.checkout_mode || "direct",
        theme: tenant.config?.theme || null,
        billing: tenant.config?.billing || null,
        onboarding_manual: tenant.config?.onboarding?.manual || {},
      },
      secretsPresent,
    },
    onboarding: onboarding && onboarding.supported ? { doneCount: onboarding.doneCount, total: onboarding.total, launched: onboarding.launched, items: onboarding.items.map((i) => ({ id: i.id, done: i.done })) } : null,
    runs,
  });
}

// PATCH {status} — suspend/reactivate a tenant (S25: suspended hosts FAIL
// CLOSED). PATCH {maintenance: {enabled, message?}} — S43 (OP12): branded
// maintenance page for shoppers, console stays reachable, checkout closes.
// PATCH {update: {name?, domains?, shop_domain?, client_id?, client_secret?,
// support_email?}} — S51: edit tenant details after provisioning (the form
// used to be the only writer). client_secret is write-only; values never
// come back. Domains are validated and checked against every other tenant,
// since resolveHost would otherwise serve one host from two stores.
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?$/;
const bad = (error) => NextResponse.json({ ok: false, error }, { status: 400 });

async function applyUpdate(id, u) {
  const current = await getTenant(id);
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const patch = {};
  const config = {};
  const secrets = {};
  const changed = [];

  if (u.name !== undefined) {
    const name = String(u.name).trim().slice(0, 80);
    if (!name) return bad("Name can't be empty");
    patch.name = name;
    // the storefront site name follows the registry name only while the
    // merchant hasn't customized it away from the old registry name
    const site = current.config?.site || {};
    if (!site.name || site.name === current.name) config.site = { ...site, name };
    changed.push("name");
  }
  if (u.domains !== undefined) {
    if (!Array.isArray(u.domains)) return bad("domains must be a list of hosts");
    const domains = [...new Set(u.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
    const invalid = domains.find((d) => !HOST_RE.test(d));
    if (invalid) return bad(`"${invalid}" is not a valid host (e.g. pavos.in or pavos.localhost:3007)`);
    const taken = new Map();
    for (const t of await listTenants()) {
      if (t.id === id) continue;
      for (const d of t.domains || []) taken.set(String(d).toLowerCase(), t.id);
    }
    const clash = domains.find((d) => taken.has(d));
    if (clash) return bad(`"${clash}" already belongs to tenant "${taken.get(clash)}"`);
    patch.domains = domains;
    const firstReal = domains.find((d) => !/^(localhost|127\.0\.0\.1|\[::1\])/.test(d));
    config.site_url = firstReal ? `https://${firstReal.split(":")[0]}` : current.config?.site_url || null;
    changed.push("domains");
  }
  if (u.shop_domain !== undefined) {
    const sd = String(u.shop_domain).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(sd)) return bad("Shopify store domain must look like x.myshopify.com");
    config.shopify_store_domain = sd;
    changed.push("shop_domain");
  }
  if (u.client_id !== undefined) {
    config.shopify_client_id = String(u.client_id).trim() || null;
    changed.push("client_id");
  }
  if (u.client_secret) {
    secrets.shopify_client_secret = String(u.client_secret).trim();
    changed.push("client_secret");
  }
  if (u.support_email !== undefined) {
    const email = String(u.support_email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Support email doesn't look like an email address");
    config.site = { ...(config.site || current.config?.site || {}), support_email: email || undefined };
    changed.push("support_email");
  }
  if (!changed.length) return bad("Nothing to update");

  const t = await patchTenant(id, {
    ...patch,
    ...(Object.keys(config).length ? { config } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}),
  });
  slog("tenant_updated", { tenant: id, changed });
  await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.update", tenantId: id, diff: { changed } });
  return NextResponse.json({ ok: true, tenant: { id: t.id, name: t.name, domains: t.domains }, changed });
}

export async function PATCH(request, { params }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.update && typeof body.update === "object") return await applyUpdate(id, body.update);
    if (body.maintenance !== undefined) {
      const m = body.maintenance;
      const maintenance = m?.enabled
        ? { enabled: true, message: String(m.message || "").slice(0, 300), since: new Date().toISOString() }
        : null;
      const t = await patchTenant(id, { config: { maintenance } });
      slog("tenant_maintenance", { tenant: id, enabled: !!maintenance });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", tenantId: id, diff: { maintenance: !!maintenance } });
      return NextResponse.json({ ok: true, tenant: { id: t.id, maintenance: t.config?.maintenance || null } });
    }
    if (!["active", "suspended"].includes(body.status))
      return NextResponse.json({ error: 'status must be "active" or "suspended" (or pass maintenance)' }, { status: 400 });
    const t = await patchTenant(id, { status: body.status });
    slog("tenant_status_changed", { tenant: id, status: body.status });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", tenantId: id, diff: { status: body.status } });
    return NextResponse.json({ ok: true, tenant: { id: t.id, status: t.status } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 404 });
  }
}

// POST — full catalog sync for this tenant (operator "sync now").
export async function POST(request, { params }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tenant.status !== "active") {
    return NextResponse.json({ ok: false, error: `tenant is ${tenant.status}` }, { status: 409 });
  }
  try {
    const r = await syncTenantCatalog(tenant);
    slog("tenant_synced", { tenant: id, products: r.products, collections: r.collections, via: "platform-console" });
    await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.sync", tenantId: id, diff: { products: r.products, collections: r.collections } });
    return NextResponse.json({ ok: true, products: r.products, collections: r.collections, searchIndexed: r.search?.indexed ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
