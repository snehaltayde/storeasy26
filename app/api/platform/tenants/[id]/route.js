import { NextResponse, after } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
import { patchTenant, getTenant, listTenants } from "@/lib/platform/control.js";
import { audit, operatorActor } from "@/lib/platform/audit";
import { operatorRotate, setMaintenance, setStoreStatus } from "@/lib/platform/store-lifecycle";
import { startCatalogSync, KICK_BUDGET_MS } from "@/lib/platform/sync-jobs";
import { withTenant } from "@/lib/tenant-context.js";
import { slog } from "@/lib/log";
import { storeDetail } from "@/lib/platform/stores-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET — the store page's read model (Phase 3 line 1, lib/platform/stores-list.js
// storeDetail): lifecycle, Shopify connection, plan, live release and
// migrations, secrets by NAME only (values never leave the envelope; no
// database url or token), provisioning runs, recent audit rows, open incidents,
// support access and notes. It keeps the fields the old console reads.
export async function GET(request, { params }) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const detail = await storeDetail(id);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...detail }, { headers: { "Cache-Control": "no-store" } });
}

// PATCH {status, reason} — suspend/resume a tenant (S25: suspended hosts FAIL
// CLOSED; Phase 3 line 2: a reason of 5+ characters, 409 when already there,
// the owner mailed when mail is set up). PATCH {maintenance: {enabled,
// message?}} — S43 (OP12): branded maintenance page for shoppers, console
// stays reachable, checkout closes. PATCH {rotate: {keys}} — Phase 3 line 2:
// new order-link key and/or console password (lib/platform/store-lifecycle.js).
// PATCH {update: {name?, domains?, shop_domain?, client_id?, client_secret?,
// support_email?}} — S51: edit tenant details after provisioning (the form
// used to be the only writer). client_secret is write-only; values never
// come back. Domains are validated and checked against every other tenant,
// since resolveHost would otherwise serve one host from two stores.
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?$/;
const bad = (error, field = null) => NextResponse.json({ ok: false, error, ...(field ? { field } : {}) }, { status: 400 });

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
    if (!name) return bad("Name can't be empty", "name");
    patch.name = name;
    // the storefront site name follows the registry name only while the
    // merchant hasn't customized it away from the old registry name
    const site = current.config?.site || {};
    if (!site.name || site.name === current.name) config.site = { ...site, name };
    changed.push("name");
  }
  if (u.domains !== undefined) {
    if (!Array.isArray(u.domains)) return bad("domains must be a list of hosts", "domains");
    const domains = [...new Set(u.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
    const invalid = domains.find((d) => !HOST_RE.test(d));
    if (invalid) return bad(`"${invalid}" is not a valid host (e.g. pavos.in or pavos.localhost:3007)`, "domains");
    const taken = new Map();
    for (const t of await listTenants()) {
      if (t.id === id) continue;
      for (const d of t.domains || []) taken.set(String(d).toLowerCase(), t.id);
    }
    const clash = domains.find((d) => taken.has(d));
    if (clash) return bad(`"${clash}" already belongs to tenant "${taken.get(clash)}"`, "domains");
    patch.domains = domains;
    const firstReal = domains.find((d) => !/^(localhost|127\.0\.0\.1|\[::1\])/.test(d));
    config.site_url = firstReal ? `https://${firstReal.split(":")[0]}` : current.config?.site_url || null;
    changed.push("domains");
  }
  if (u.shop_domain !== undefined) {
    const sd = String(u.shop_domain).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(sd)) return bad("Shopify store domain must look like x.myshopify.com", "shop_domain");
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
    if (p && !/^[A-Z0-9]{2,4}$/.test(p)) return bad("Order id prefix must be 2–4 letters/digits (e.g. PAV)", "order_prefix");
    config.order_prefix = p || null;
    changed.push("order_prefix");
  }
  if (u.support_email !== undefined) {
    const email = String(u.support_email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("Support email doesn't look like an email address", "support_email");
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
  await audit({ actor: operatorActor(operator), action: "tenant.update", resource: `tenant:${id}`, tenantId: id, diff: { changed } });
  return NextResponse.json({ ok: true, tenant: { id: t.id, name: t.name, domains: t.domains }, changed });
}

export async function PATCH(request, { params }) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.update && typeof body.update === "object") return await applyUpdate(id, body.update, auth.operator);
    // Phase 3 line 2 (lib/platform/store-lifecycle.js): rotate the keys Storeasy
    // holds. A new console password is in this answer once and nowhere else.
    if (body.rotate !== undefined) {
      const r = await operatorRotate(id, body.rotate?.keys, { actor: auth.operator });
      return NextResponse.json({ ok: true, ...r }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.maintenance !== undefined) {
      const { tenant: t } = await setMaintenance(id, body.maintenance || {}, { actor: auth.operator });
      return NextResponse.json({ ok: true, tenant: { id: t.id, maintenance: t.config?.maintenance || null } });
    }
    if (!["active", "suspended"].includes(body.status))
      return NextResponse.json({ ok: false, error: 'status must be "active" or "suspended" (or pass maintenance or rotate)' }, { status: 400 });
    const { tenant: t, mail } = await setStoreStatus(id, body.status, { reason: body.reason, actor: auth.operator });
    return NextResponse.json({ ok: true, tenant: { id: t.id, status: t.status }, mail });
  } catch (e) {
    // a LifecycleError (4xx) keeps its words; anything else is logged scrubbed, plain words back
    return operatorError(e, { tenant: await getTenant(id).catch(() => null), words: "That didn't save because of a problem on our side. Try again.", status: 500, event: "tenant_patch_failed", fields: { ok: false } });
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
    await audit({ actor: operatorActor(auth.operator), action: "tenant.sync", resource: `tenant:${id}`, tenantId: id, diff: { run: run.id, action } });
    return NextResponse.json(
      { ok: true, queued: true, action, runId: run.id, products: Number(run.products_fetched || 0), collections: Number(run.collections_fetched || 0) },
      { status: 202 },
    );
  } catch (e) {
    // the store's database address or token never reaches the browser
    return operatorError(e, { tenant, words: "The sync didn't start because of a problem on our side. Try again.", status: 500, event: "tenant_sync_failed", fields: { ok: false } });
  }
}
