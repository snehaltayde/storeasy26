// Platform marketing-site host detection (S44 / MK01–08). PURE + EDGE-SAFE.
//
// The marketing website is THIS same Next app rendered on designated
// PLATFORM hosts (env PLATFORM_SITE_HOSTS, comma-separated). Those hosts are
// not tenants: the S25 resolver keeps failing closed for every unknown host —
// the layout and the marketing pages check THIS list first, so adding a
// marketing host can never leak a tenant's (or the env default's) storefront.
// Matching mirrors resolveHost: lowercased, exact host:port first, bare host
// second.

export function platformSiteHosts() {
  return String(process.env.PLATFORM_SITE_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformSiteHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  const hosts = platformSiteHosts();
  return hosts.includes(h) || hosts.includes(h.split(":")[0]);
}

// Server-component helper (next/headers import stays at the caller to keep
// this module importable from plain Node tests).
export async function isMarketingRequest(headersList) {
  return isPlatformSiteHost(headersList.get("host"));
}
