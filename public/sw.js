/* Storeasy PWA service worker — app-shell + runtime caching (S36: per-tenant
   branded /offline + /manifest.webmanifest are DYNAMIC routes precached at
   install, so each tenant origin caches its own branding). */
const VERSION = "v3";
const STATIC_CACHE = `storeasy-static-${VERSION}`;
const RUNTIME_CACHE = `storeasy-runtime-${VERSION}`;
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Page navigations: network-first, fall back to a cached offline shell.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline")));
    return;
  }

  // Build assets, icons and Shopify product imagery: stale-while-revalidate.
  const cacheable =
    url.pathname.startsWith("/_next/static") ||
    url.pathname.startsWith("/icons") ||
    url.hostname === "cdn.shopify.com";

  if (cacheable) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached || Response.error());
        return cached || network;
      }),
    );
  }
});
