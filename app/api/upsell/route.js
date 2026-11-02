import { NextResponse } from "next/server";
import { resolvedCartUpsell } from "@/lib/content/resolve";
import { storefrontHandler } from "@/lib/storefront-request";

// Cart-drawer upsell slot (Session 23). Fetched lazily by the drawer when it
// opens — kept OFF the cart read/mutate hot path. ?exclude=<gid,gid> hides
// products already in the cart.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = storefrontHandler(async (request) => {
  const exclude = (request.nextUrl.searchParams.get("exclude") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const slot = await resolvedCartUpsell(exclude, { limit: 3 }); // release-gated since S53
  return NextResponse.json(slot, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
});
