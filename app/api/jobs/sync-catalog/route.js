import { NextResponse } from "next/server";
import { getTenant, listTenants } from "@/lib/platform/control.js";
import { syncTenantCatalog } from "@/lib/sync.js";

// Full-reconcile catalog sync per tenant (Session 21) — the backstop behind
// webhook-driven freshness. No vercel.json cron entry (Hobby's 2 slots are
// taken by sync-shopify + forward-events): hit it manually, from an external
// scheduler, or use `pnpm tenant:sync <slug>` for big catalogs — 60s of
// function budget only fits small-to-mid stores.
//   POST {tenant: "slug"}  — sync one tenant
//   GET ?limit=N           — loop active tenants (default 3 per call)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}` || request.nextUrl.searchParams.get("secret") === secret;
}

async function syncOne(slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return { tenant: slug, ok: false, error: "not found" };
  if (tenant.status !== "active") return { tenant: slug, ok: false, error: `status ${tenant.status}` };
  try {
    const r = await syncTenantCatalog(tenant);
    return { tenant: slug, ok: true, products: r.products, collections: r.collections, searchIndexed: r.search?.indexed ?? 0, ...(r.search?.error ? { searchError: r.search.error } : {}) };
  } catch (e) {
    return { tenant: slug, ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

export async function POST(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.tenant) return NextResponse.json({ error: "tenant required" }, { status: 400 });
  const result = await syncOne(body.tenant);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = Math.max(1, Number(request.nextUrl.searchParams.get("limit") || 3));
  const tenants = (await listTenants()).filter((t) => t.status === "active").slice(0, limit);
  const results = [];
  for (const t of tenants) results.push(await syncOne(t.id));
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
