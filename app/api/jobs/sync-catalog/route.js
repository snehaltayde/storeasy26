import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { getTenant, listTenants } from "@/lib/platform/control.js";
import { withTenant } from "@/lib/tenant-context.js";
import { startCatalogSync } from "@/lib/platform/sync-jobs";
import { runJobById } from "@/lib/platform/worker";

// Full-reconcile catalog sync per tenant (Session 21) — the backstop behind
// webhook-driven freshness. No vercel.json cron entry (Hobby's 2 slots are
// taken by sync-shopify + forward-events): hit it manually or from an
// external scheduler.
// GEN-02: this QUEUES a resumable run per tenant (or joins the one under way)
// and spends the rest of its own 60s on their first slices; the job tick
// finishes them, so any catalog size fits.
//   POST {tenant: "slug"}  — sync one tenant
//   GET ?limit=N           — every active tenant (or the first N)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 45_000;

async function queueOne(slug) {
  const tenant = await getTenant(slug);
  if (!tenant) return { tenant: slug, ok: false, error: "not found" };
  if (tenant.status !== "active") return { tenant: slug, ok: false, error: `status ${tenant.status}` };
  try {
    const { run, action, job } = await withTenant(tenant, () => startCatalogSync({ startedBy: "scheduled" }));
    return { tenant: slug, ok: true, runId: run.id, action, jobId: job?.id ?? null };
  } catch (e) {
    return { tenant: slug, ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

// Spend what's left of this request on the queued runs' first slices, one
// after another; whatever doesn't fit waits for the tick.
async function runFirstSlices(results, started) {
  for (const r of results) {
    const left = BUDGET_MS - (Date.now() - started);
    if (!r.ok || !r.jobId || left <= 0) continue;
    const ran = await runJobById(r.jobId, { budgetMs: left }).catch(() => null);
    if (ran) r.slice = { ok: ran.ok, requeued: Boolean(ran.requeued), status: ran.result?.status ?? null };
  }
  return results;
}

export async function POST(request) {
  const started = Date.now();
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.tenant) return NextResponse.json({ error: "tenant required" }, { status: 400 });
  const [result] = await runFirstSlices([await queueOne(body.tenant)], started);
  return NextResponse.json(result, { status: result.ok ? 202 : 500 });
}

export async function GET(request) {
  const started = Date.now();
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limit = Number(request.nextUrl.searchParams.get("limit") || 0);
  let tenants = (await listTenants()).filter((t) => t.status === "active");
  if (limit > 0) tenants = tenants.slice(0, limit);
  const results = [];
  for (const t of tenants) results.push(await queueOne(t.id));
  await runFirstSlices(results, started);
  return NextResponse.json({ ok: results.every((r) => r.ok), results }, { status: 202 });
}
