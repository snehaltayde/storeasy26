import { NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { audit } from "@/lib/platform/audit";
import { runCatalogSync } from "@/lib/sync.js";
import { startCatalogSync, catalogSyncProgress, KICK_BUDGET_MS } from "@/lib/platform/sync-jobs";
import { plainSyncError } from "@/lib/admin/sync-view";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Bringing the catalog in from Shopify, for the merchant console.
// GEN-02: a full sync is a queued, resumable run (lib/platform/sync-jobs.js),
// so this route never holds the whole catalog inside its 60 seconds:
//   POST {}              start a sync (or join the one under way); 202 + progress
//   POST {retry: true}   the founder's "Try again": resume a failed or stuck run
//   POST {searchOnly}    reindex search from the local DB, inline (as before)
//   GET                  progress, read from sync_runs; while a sync runs, the
//                        poll also gives it its next slice after the response
// Webhooks keep day-to-day freshness; this is the founder's reconcile button.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// What an after() slice may still spend, given the time this request used.
const budgetFrom = (started) => Math.max(0, KICK_BUDGET_MS - (Date.now() - started));

export const GET = tenantHandler(async (request) => {
  const started = Date.now();
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // Only a role that may run a sync keeps it moving; support just looks.
  const nudge = roleAllows(auth.actor?.role, "sync.run");
  const { view } = await catalogSyncProgress({ nudge, defer: after, budgetMs: budgetFrom(started) });
  return NextResponse.json({ ok: true, sync: view });
});

export const POST = tenantHandler(async (request) => {
  const started = Date.now();
  const auth = await requireAdmin(request, "sync.run");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const limited = rateLimit(request, { name: "admin-sync", limit: 6 });
  if (limited) return limited;

  const { searchOnly = false, retry = false } = await request.json().catch(() => ({}));
  if (searchOnly) {
    try {
      const res = await runCatalogSync({ searchOnly: true });
      return NextResponse.json({ ok: true, searchIndexed: res.search?.indexed ?? 0, ...(res.search?.error ? { searchError: res.search.error } : {}) });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
    }
  }
  try {
    const { run, action } = await startCatalogSync({ startedBy: "manual", retry: Boolean(retry), defer: after, budgetMs: budgetFrom(started) });
    slog("admin_sync", { run: run.id, action, retry: Boolean(retry) });
    await audit({ actor: auth.actor, action: "sync.run", diff: { run: run.id, action } });
    const { view } = await catalogSyncProgress();
    return NextResponse.json({ ok: true, action, sync: view }, { status: 202 });
  } catch (e) {
    const raw = String(e?.message || e).slice(0, 300);
    slog("admin_sync_failed", { error: raw });
    return NextResponse.json({ ok: false, error: plainSyncError(raw) }, { status: /credentials/i.test(raw) ? 409 : 500 });
  }
});
