// Canonical site origin (Session 16) — SEO metadata, sitemap, JSON-LD.
// NEXT_PUBLIC_SITE_URL is set per environment (prod / staging); Vercel's own
// URL and localhost are fallbacks so links are always absolute.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
  "http://localhost:3007"
).replace(/\/$/, "");

export const SITE_NAME = "BeastLife";

export const abs = (path) => `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
