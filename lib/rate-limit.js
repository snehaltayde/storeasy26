// In-memory fixed-window rate limiter (Session 17). Per-isolate on Vercel —
// bursts from one source land on warm instances, so this stops hammering and
// accidental loops without external infra; it is NOT a distributed quota (a
// determined attacker spread across instances needs an Upstash/KV limiter —
// documented in docs/operations.md). Edge- and Node-safe.
//
// Env knobs: RATE_LIMIT_DISABLED=1 (local scripting escape hatch),
// RATE_LIMIT_<NAME>=count to tune a route's per-minute budget.

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

// → null when allowed, or a 429 Response when over budget.
export function rateLimit(request, { name, limit, windowMs = 60_000 }) {
  if (process.env.RATE_LIMIT_DISABLED === "1") return null;
  const effective = Number(process.env[`RATE_LIMIT_${name.toUpperCase()}`] || limit);
  const now = Date.now();
  sweep(now);
  const key = `${name}:${clientIp(request)}`;
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count <= effective) return null;
  const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
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
