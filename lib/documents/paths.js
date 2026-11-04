// P3-COMMIT (PUB-02, PUB-04): where a document lives on the store, and the
// link that shows it live. Pure and edge-safe: no imports at all.
//
//   livePath(type, meta)
//     home, and every singleton (header, footer, design, …)  "/"
//     page        "/about" or "/contact" for those two slugs, else
//                 "/policies/<slug>"
//     campaign    "/campaigns/<slug>"
//     journal     "/journal/<slug>"
//     anything else (a type with no address of its own)       "/"
//   liveExitUrl(path)
//     "/api/preview?exit=1&to=" + encodeURIComponent(path): the preview
//     switch's exit, which clears the preview cookie and lands on the live
//     page. It never carries a token. The route's destination() keeps only a
//     plain path on the store's own origin (P2-FIX4).
const OWN_ROUTE = new Set(["about", "contact"]);
const PREFIX = { page: "/policies/", campaign: "/campaigns/", journal: "/journal/" };

export function livePath(type, meta) {
  const prefix = Object.hasOwn(PREFIX, type) ? PREFIX[type] : null;
  const slug = meta && typeof meta.slug === "string" && meta.slug ? meta.slug : null;
  if (!prefix || !slug) return "/";
  if (type === "page" && OWN_ROUTE.has(slug)) return `/${slug}`;
  return `${prefix}${encodeURIComponent(slug)}`;
}

export const liveExitUrl = (path) => `/api/preview?exit=1&to=${encodeURIComponent(typeof path === "string" && path.startsWith("/") ? path : "/")}`;
