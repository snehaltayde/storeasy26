// Tenant-scoped tagged storefront cache (Phase 1.2).
// 100% Edge-safe (no node:* imports). Wraps Next.js unstable_cache / revalidateTag
// with strict `tenant:<tenantId>:<scope>` tags so cache entries can NEVER leak
// across tenants and invalidate cleanly on publish, undo, and catalog sync.
//
// Outside a Next.js incremental-cache request context (unit tests, CLI scripts,
// background workers), cachedTenantRead executes `fn()` directly and
// invalidateTenantCache is a safe no-op.

import { tenantId } from "./tenant-context.js";

export const CACHE_NAMESPACES = Object.freeze(["release", "catalog", "settings", "theme", "plugins"]);

export function tenantTag(scope, tid = tenantId()) {
  const safeTenant = String(tid || "_default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeScope = String(scope || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `tenant:${safeTenant}:${safeScope}`;
}

let nextCachePromise = null;
async function loadNextCache() {
  if (!nextCachePromise) {
    nextCachePromise = import("next/cache").catch(() => null);
  }
  return nextCachePromise;
}

// Test seam: observe tag invalidations in unit tests without needing a Next runtime.
const hooks = { onInvalidate: null };
export function __setCacheTestHooks({ onInvalidate = null } = {}) {
  hooks.onInvalidate = onInvalidate;
}

/**
 * Cache a pure tenant-scoped read behind Next's Data Cache when running inside
 * Next.js, tagged with `tenant:<id>:<scope>`. Always passes through directly
 * when STOREASY_CACHE_DISABLED=1 or outside Next's incremental-cache context.
 */
export async function cachedTenantRead(scope, keyParts, fn, { revalidate = 60, tags = [], tid = tenantId() } = {}) {
  if (process.env.STOREASY_CACHE_DISABLED === "1") return fn();
  const nextCache = await loadNextCache();
  if (!nextCache || typeof nextCache.unstable_cache !== "function") return fn();

  const allTags = Array.from(new Set([tenantTag(scope, tid), ...tags.map((t) => tenantTag(t, tid))]));
  const parts = Array.isArray(keyParts) ? keyParts.map(String) : [String(keyParts ?? "default")];
  const wrapped = nextCache.unstable_cache(fn, ["storeasy", String(tid || "_default"), scope, ...parts], {
    tags: allTags,
    revalidate,
  });
  try {
    return await wrapped();
  } catch (e) {
    // Outside a Next incremental-cache store (CLI / direct route invocation in tests),
    // unstable_cache throws "incrementalCache missing" — fall back transparently.
    if (/incrementalCache|Invariant:/i.test(String(e?.message || e))) return fn();
    throw e;
  }
}

/**
 * Invalidate one or more tenant-scoped cache tags. Best-effort: never throws
 * outside a Next.js server context (CLI / tests / workers).
 */
export async function invalidateTenantCache(scopes, tid = tenantId()) {
  const list = (Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean);
  const tags = list.map((s) => tenantTag(s, tid));
  if (hooks.onInvalidate) {
    for (const tag of tags) hooks.onInvalidate(tag);
  }
  const nextCache = await loadNextCache();
  if (!nextCache || typeof nextCache.revalidateTag !== "function") return tags;
  for (const tag of tags) {
    try {
      nextCache.revalidateTag(tag, "max");
    } catch {
      // No-op outside Next request lifecycle (e.g. CLI scripts or tests)
    }
  }
  return tags;
}
