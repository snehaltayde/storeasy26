// Phase 8 line 4: the market of this request, for storefront pages and the
// shopper APIs. Edge-safe (next/headers and lib/markets.js only). Always read
// inside the store's context (tfetch / tenantHandler / storefrontHandler), so a
// market comes only from this store's own config: store B's markets never
// apply on store A, whatever the cookie says.
import { cookies, headers } from "next/headers";
import { currentTenant } from "./tenant-context.js";
import { MARKET_COOKIE, resolveMarket } from "./markets.js";

// The hosting's country suggestion, used only when the shopper has no cookie.
export const IP_COUNTRY_HEADER = "x-vercel-ip-country";

// RSC pages and layouts → { country, market } (market null = the base market).
export async function storefrontMarket() {
  let cookie = null;
  let ipCountry = null;
  try {
    cookie = (await cookies()).get(MARKET_COOKIE)?.value ?? null;
    ipCountry = (await headers()).get(IP_COUNTRY_HEADER);
  } catch {
    // outside a request (build, scripts): the base market
  }
  return resolveMarket({ cookie, ipCountry, config: currentTenant()?.config ?? null });
}

// Route handlers: the same rule from the request itself.
export const requestMarket = (request) =>
  resolveMarket({
    cookie: request.cookies.get(MARKET_COOKIE)?.value ?? null,
    ipCountry: request.headers.get(IP_COUNTRY_HEADER),
    config: currentTenant()?.config ?? null,
  });

export const MARKET_COOKIE_OPTS = {
  httpOnly: true, // only the server reads it
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  secure: process.env.NODE_ENV === "production",
};
