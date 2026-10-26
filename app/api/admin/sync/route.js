import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { runCatalogSync } from "@/lib/sync.js";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// "Sync now" for the merchant console (Session 22): full catalog pull for the
// ACTIVE tenant, inline (fits small/mid catalogs in the 60s budget; big ones
// use `pnpm tenant:sync <slug>`). Webhooks keep day-to-day freshness — this is
// the merchant-visible reconcile button.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = tenantHandler(async (request) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(request, { name: "admin-sync", limit: 2 });
  if (limited) return limited;

  const { searchOnly = false } = await request.json().catch(() => ({}));
  try {
    const res = await runCatalogSync({ searchOnly });
    slog("admin_sync", { products: res.products, collections: res.collections, search_indexed: res.search?.indexed ?? 0 });
    return NextResponse.json({
      ok: true,
      products: res.products,
      collections: res.collections,
      searchIndexed: res.search?.indexed ?? 0,
      ...(res.search?.error ? { searchError: res.search.error } : {}),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
});
