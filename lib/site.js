import { tenantCfg, currentTenant } from "./tenant-context.js";

// Canonical site origin + identity (Session 16; tenant-aware since S20).
// `siteUrl()`/`abs()` resolve the ACTIVE tenant's configured origin first and
// fall back to env — so sitemaps, canonicals and JSON-LD emit each tenant's
// own domain. SITE_URL (const) remains for the layout's STATIC metadata
// export (env/default-tenant only; per-tenant metadata lands with S23's
// generateMetadata conversion).
const ENV_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
  "http://localhost:3007"
).replace(/\/$/, "");

export const SITE_URL = ENV_URL;

export const siteUrl = () => String(tenantCfg("site_url", null, ENV_URL)).replace(/\/$/, "");

export const siteName = () => {
  const site = tenantCfg("site", null, null);
  // S51: a tenant without site.name gets ITS OWN registry name, never another
  // brand's — "BeastLife" remains only the legacy env store's fallback.
  return site?.name || currentTenant()?.name || "BeastLife";
};

export const abs = (path) => `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;

// ---- Session 23: the rest of the brand surface, config-first ---------------
// Every accessor falls back to something derived from siteName(), so a fresh
// tenant renders coherently before any branding is configured. BeastLife's
// specific strings live in ITS tenant config (seed script), not in code.

const site = () => tenantCfg("site", null, null) || {};

export const siteTagline = () =>
  site().tagline || `Browse the ${siteName()} catalog — a fast storefront over the live Shopify store.`;

// Home/default <title>; the %s template still appends "· name" on inner pages.
export const siteTitle = () => site().title || `${siteName()} — Shop online`;

export const siteFooterTagline = () => site().footer_tagline || siteTagline();

// Logo wordmark: two-part split for accent styling ({text1, text2}); default
// = whole name, no accent part.
export const siteLogo = () => {
  const logo = site().logo;
  if (logo?.text1) return { text1: logo.text1, text2: logo.text2 || "" };
  return { text1: siteName(), text2: "" };
};

export const siteLegalName = () => site().legal_name || siteName();

export const siteSupport = () => ({
  email: site().support_email || null,
  phone: site().support_phone || null,
});
