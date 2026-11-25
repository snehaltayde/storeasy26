import { NextResponse, after } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { patchTenant, getTenant, listTenants, platformDb } from "@/lib/platform/control.js";
import { audit } from "@/lib/platform/audit";
import { startCatalogSync, KICK_BUDGET_MS } from "@/lib/platform/sync-jobs";
import { withTenant } from "@/lib/tenant-context.js";
import { slog } from "@/lib/log";
import { themePinOf } from "@/lib/themes/kits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — tenant DETAIL (S41 / OP03): lifecycle, config summary, secrets as a
// PRESENCE MAP (which keys exist — values never leave the envelope), billing
// snapshot, onboarding progress, provisioning history.
export async function GET(request, { params }) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const tenant = await getTenant(id, { fresh: true }); // the operator's next view after a save shows it
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
    // Phase 1 line 3: the four step states (a read-only role: actions and the shop domain are not this view's)
    const { onboardingFor } = await import("@/lib/onboarding/service.js");
    onboarding = await withTenant(tenant, () => onboardingFor({ role: "support" }));
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
        order_prefix: tenant.config?.order_prefix || null,
        site_name: tenant.config?.site?.name || null,
        support_email: tenant.config?.site?.support_email || null,
        checkout_mode: tenant.config?.checkout_mode || "direct",
        // P3-DESIGN (TOK-03): the live look's pin, not the draft
        theme_pin: themePinOf(tenant.config),
        billing: tenant.config?.billing || null,
        onboarding_manual: tenant.config?.onboarding?.manual || {},
      },
      secretsPresent,
    },
    // Phase 1 line 4: the founder connect's callback on each store domain, to add to the store's Shopify app
    connect: {
      appReady: Boolean(tenant.config?.shopify_client_id && tenant.secrets?.shopify_client_secret),
      redirectUrls: (tenant.domains || []).map((d) => `${/(^|\.)localhost(:|$)|^127\.0\.0\.1/.test(d) ? "http" : "https"}://${d}/api/admin/shopify/callback`),
    },
    onboarding: onboarding && onboarding.supported ? { doneCount: onboarding.doneCount, total: onboarding.total, open: onboarding.open, steps: onboarding.steps.map((s) => ({ id: s.id, label: s.label, state: s.state })) } : null,
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

async function applyUpdate(id, u, operator) {
  // fresh: `site` below is merged from this read, so a cached copy would undo
  // a founder's save from the last 30 seconds (P1-FIX-C)
  const current = await getTenant(id, { fresh: true });
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
  if (u.order_prefix !== undefined) {
    const p = String(u.order_prefix).trim().toUpperCase();
    if (p && !/^[A-Z0-9]{2,4}$/.test(p)) return bad("Order id prefix must be 2–4 letters/digits (e.g. PAV)");
    config.order_prefix = p || null;
    changed.push("order_prefix");
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
  await audit({ actor: operator, action: "tenant.update", tenantId: id, diff: { changed } });
  return NextResponse.json({ ok: true, tenant: { id: t.id, name: t.name, domains: t.domains }, changed });
}

export async function PATCH(request, { params }) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.update && typeof body.update === "object") return await applyUpdate(id, body.update, auth.operator);
    if (body.maintenance !== undefined) {
      const m = body.maintenance;
      const maintenance = m?.enabled
        ? { enabled: true, message: String(m.message || "").slice(0, 300), since: new Date().toISOString() }
        : null;
      const t = await patchTenant(id, { config: { maintenance } });
      slog("tenant_maintenance", { tenant: id, enabled: !!maintenance });
      await audit({ actor: auth.operator, action: "tenant.status", tenantId: id, diff: { maintenance: !!maintenance } });
      return NextResponse.json({ ok: true, tenant: { id: t.id, maintenance: t.config?.maintenance || null } });
    }
    if (!["active", "suspended"].includes(body.status))
      return NextResponse.json({ error: 'status must be "active" or "suspended" (or pass maintenance)' }, { status: 400 });
    const t = await patchTenant(id, { status: body.status });
    slog("tenant_status_changed", { tenant: id, status: body.status });
    await audit({ actor: auth.operator, action: "tenant.status", tenantId: id, diff: { status: body.status } });
    return NextResponse.json({ ok: true, tenant: { id: t.id, status: t.status } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 404 });
  }
}

// POST — full catalog sync for this tenant (operator "sync now"). GEN-02:
// queued and resumable like every full sync — starts (or joins the run under
// way), kicks the first slice after the response, and answers 202 with the
// run's progress; the queue finishes it.
export async function POST(request, { params }) {
  const started = Date.now();
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tenant.status !== "active") {
    return NextResponse.json({ ok: false, error: `tenant is ${tenant.status}` }, { status: 409 });
  }
  try {
    const { run, action } = await withTenant(tenant, () =>
      startCatalogSync({ startedBy: "operator", defer: after, budgetMs: Math.max(0, KICK_BUDGET_MS - (Date.now() - started)) }),
    );
    slog("tenant_sync_queued", { tenant: id, run: run.id, action, via: "platform-console" });
    await audit({ actor: auth.operator, action: "tenant.sync", tenantId: id, diff: { run: run.id, action } });
    return NextResponse.json(
      { ok: true, queued: true, action, runId: run.id, products: Number(run.products_fetched || 0), collections: Number(run.collections_fetched || 0) },
      { status: 202 },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
