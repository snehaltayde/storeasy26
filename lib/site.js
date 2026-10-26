import { tenantCfg } from "./tenant-context.js";

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
  return site?.name || "BeastLife";
};

export const abs = (path) => `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
