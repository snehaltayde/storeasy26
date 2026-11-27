// Which images skip Next's image optimizer (P1-IMAGES). Pure, no imports, so
// it runs on the edge, in the browser and in plain-node tests.
//
// Library photos live at /api/media/<id>, and that route answers only for the
// store whose host asked (lib/tenant-request.js, tenantHandler). Next's
// self-hosted optimizer (/_next/image) fetches a local url through a made-up
// request with no headers at all (next/dist/server/image-optimizer.js,
// fetchInternalImage), so there is no Host, the store can't be told, and the
// route answers 404. The optimizer then reports 400 "isn't a valid image".
//
// It must stay that way: the optimizer's cache key is only (url, width,
// quality, type), with no host. If the route answered a host-less request,
// the first store to show /api/media/med_x would fill a cache entry that any
// other store's host could read back through /_next/image?url=/api/media/med_x.
//
// So a library photo goes to the browser as its own same-origin url. The
// browser sends the real Host, the route picks the store, and the far-future
// immutable cache still applies. On Vercel this also keeps library photos out
// of Vercel's image service, whose fetch of a local url we don't control.
const LIBRARY_PREFIX = "/api/media/";

export function imageSrcPath(src) {
  if (typeof src === "string") return src;
  // a static import ({ src, width, height }) or anything else next/image takes
  if (src && typeof src === "object" && typeof src.src === "string") return src.src;
  return "";
}

export function isLibraryMedia(src) {
  return imageSrcPath(src).trimStart().startsWith(LIBRARY_PREFIX);
}

// Whether Next's optimizer can fetch this image: only the Shopify CDN is in
// next.config.mjs's images.remotePatterns. Any other https photo answers 400
// ("url" parameter is not allowed) from /_next/image (and from Vercel's image
// service), and a relative path other than a library photo is fetched with no
// Host, so the store route answers 404. A component that takes a founder's
// image from anywhere sends those unoptimized, as their own url (P2-SECTIONS).
const OPTIMIZABLE_PREFIX = "https://cdn.shopify.com/";

export function isOptimizable(src) {
  return imageSrcPath(src).trim().startsWith(OPTIMIZABLE_PREFIX);
}

// Shopify's CDN resizes and re-encodes (WebP/AVIF by the browser's Accept) on
// its own edge: ?width=N. Sending Shopify photos straight there skips a hop
// through /_next/image, which on Vercel re-fetched and re-encoded the full
// original on every cache miss (1-4 s on a product grid). 2026-11-27.
export function shopifyLoader({ src, width }) {
  const u = new URL(imageSrcPath(src).trim());
  u.searchParams.set("width", String(width));
  return u.toString();
}
