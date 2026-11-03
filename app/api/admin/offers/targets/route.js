import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { offerTargetOptions, storeCurrency } from "@/lib/offers/catalog";
import { tenantHandler } from "@/lib/tenant-request";

// The store's tags and product types, for the offer form's "All products
// with a tag" and "All products of one type" pickers (COM-03), so a founder
// picks one instead of typing it. GET → { ok, tags, types, currency }, each
// option { value, count, maxPrice }. Read-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "offers.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const [options, currency] = await Promise.all([offerTargetOptions(), storeCurrency()]);
  return NextResponse.json({ ok: true, ...options, currency });
});
