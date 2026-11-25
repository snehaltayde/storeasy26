import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { offerTargetOptions, storeCurrency } from "@/lib/offers/catalog";
import { tenantHandler } from "@/lib/tenant-request";

// The store's tags, product types and collections, for the offer form's
// "Products with a tag", "Products of one type" (COM-03) and "Products in a
// collection" (Phase 8 line 5) pickers, so a founder picks one instead of
// typing it. GET → { ok, tags, types, collections, currency }; each option is
// { value, count, maxPrice }, and a collection's also has label (its title;
// value is its handle). Only this store's synced collections. Read-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const [options, currency] = await Promise.all([offerTargetOptions(), storeCurrency()]);
  return NextResponse.json({ ok: true, ...options, currency });
});
