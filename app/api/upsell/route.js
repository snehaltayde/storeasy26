import { NextResponse } from "next/server";
import { getCartUpsell } from "@/lib/cms/placements";
import { tenantHandler } from "@/lib/tenant-request";

// Cart-drawer upsell slot (Session 23). Fetched lazily by the drawer when it
// opens — kept OFF the cart read/mutate hot path. ?exclude=<gid,gid> hides
// products already in the cart.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const exclude = (request.nextUrl.searchParams.get("exclude") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const slot = await getCartUpsell(exclude, { limit: 3 });
  return NextResponse.json(slot, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
});
