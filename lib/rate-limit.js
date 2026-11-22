// Fixed-window rate limiter (Session 17 + Phase 1.2 distributed Upstash support).
// Edge- and Node-safe (zero node:* imports).
//
// - `rateLimit(request, opts)`      synchronous in-memory per-isolate limiter
// - `rateLimitAsync(request, opts)` distributed Upstash Redis REST pipeline when
//                                   UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN
//                                   are set; transparently falls back to in-memory
//                                   `rateLimit` when unset or on transient Redis error.
//
// Env knobs: RATE_LIMIT_DISABLED=1 (local scripting escape hatch),
// RATE_LIMIT_<NAME>=count to tune a route's per-minute budget.

import { tenantId } from "./tenant-context.js";

const buckets = new Map(); // key → { count, resetAt }
let lastSweep = 0;

function sweep(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}

export function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : request.headers.get("x-real-ip") || "local";
}

function build429(retryAfter, effective) {
  return new Response(
    JSON.stringify({ error: "Too many requests", retry_after_seconds: retryAfter }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(effective),
      },
    },
  );
}

function effectiveLimit(name, limit) {
  return Number(process.env[`RATE_LIMIT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || limit);
}

// Synchronous per-isolate limiter → null when allowed, or a 429 Response.
export function rateLimit(request, { name, limit, windowMs = 60_000 }) {
  if (process.env.RATE_LIMIT_DISABLED === "1") return null;
  const effective = effectiveLimit(name, limit);
  const now = Date.now();
  sweep(now);
  const key = `${name}:${tenantId()}:${clientIp(request)}`;
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count <= effective) return null;
  const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  return build429(retryAfter, effective);
}

export function isDistributedRateLimitConfigured(env = process.env) {
  return Boolean((env.UPSTASH_REDIS_REST_URL || "").trim() && (env.UPSTASH_REDIS_REST_TOKEN || "").trim());
}

// Distributed Edge-safe rate limiter backed by Upstash Redis REST pipeline,
// with transparent fallback to in-memory `rateLimit` when unconfigured or unreachable.
export async function rateLimitAsync(
  request,
  { name, limit, windowMs = 60_000, fetchImpl = fetch, env = process.env } = {},
) {
  if (env.RATE_LIMIT_DISABLED === "1") return null;
  const url = (env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = (env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) return rateLimit(request, { name, limit, windowMs });

  const effective = effectiveLimit(name, limit);
  const key = `rl:${name}:${tenantId()}:${clientIp(request)}`;

  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 800) : null;
  try {
    const res = await fetchImpl(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["PEXPIRE", key, String(windowMs), "NX"],
        ["PTTL", key],
      ]),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res.ok) return rateLimit(request, { name, limit, windowMs });
    const data = await res.json();
    const count = Number(data?.[0]?.result ?? 0);
    const pttl = Number(data?.[2]?.result ?? windowMs);
    if (!Number.isFinite(count) || count <= 0) return rateLimit(request, { name, limit, windowMs });
    if (count <= effective) return null;
    const retryAfter = Math.max(1, Math.ceil((pttl > 0 ? pttl : windowMs) / 1000));
    return build429(retryAfter, effective);
  } catch {
    // Fail open to per-isolate memory limiter so an Upstash hiccup never bricks checkout/login.
    return rateLimit(request, { name, limit, windowMs });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
