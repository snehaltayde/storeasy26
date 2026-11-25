import { NextResponse } from "next/server";
import { storefrontHandler } from "@/lib/storefront-request";
import { currentTenant } from "@/lib/tenant-context";
import { MARKET_COOKIE, resolveMarket, baseCountry, safeReturnPath } from "@/lib/markets";
import { MARKET_COOKIE_OPTS } from "@/lib/market-request";
import { rateLimitAsync } from "@/lib/rate-limit";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// Phase 8 line 4 (decision 17): the footer's "Ship to" picker, a plain GET form
// (no JavaScript needed). ?country=US&return=/products/x → the `_market` cookie,
// then back to the page. Only this store's base country or an enabled market's
// country is stored; anything else stores the base country. `return` must be a
// path on this site.

export const GET = storefrontHandler(async (request) => {
  const limited = await rateLimitAsync(request, { name: "market", limit: 30 });
  if (limited) return limited;
  const url = new URL(request.url);
  const config = currentTenant()?.config ?? null;
  const asked = url.searchParams.get("country");
  const { country } = resolveMarket({ cookie: asked || baseCountry(config), config });
  // a relative Location: behind a proxy request.url can name another origin,
  // and the storefront's CSP (form-action 'self') then blocks the redirect
  const res = new NextResponse(null, { status: 303, headers: { Location: safeReturnPath(url.searchParams.get("return")) } });
  res.cookies.set(MARKET_COOKIE, country, MARKET_COOKIE_OPTS);
  return res;
});
