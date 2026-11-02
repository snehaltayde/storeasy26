import { NextResponse } from "next/server";
import { resolveWishlist } from "@/lib/wishlist";
import { rateLimit } from "@/lib/rate-limit";
import { storefrontHandler } from "@/lib/storefront-request";

// Anonymous wishlist resolution (S49 / SF22): the browser keeps the list;
// this endpoint only answers "what are these handles TODAY" (availability,
// price, title) so the page can label ok / unavailable / gone honestly.
// Nothing here identifies or stores anything about the shopper.
//   POST {items:[{handle, variantId?}]}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = storefrontHandler(async (request) => {
  const limited = rateLimit(request, { name: "wishlist", limit: 30 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({ ok: true, items: await resolveWishlist(body.items) });
});
