import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ga4Configured, metaConfigured } from "@/lib/tracking";
import { razorpayConfigured, webhookConfigured } from "@/lib/razorpay";
import { errorStats } from "@/lib/errors";
import { forEachActiveTenant, aggregateHealth } from "@/lib/platform/ops";
import { tenantOwnSecret, currentTenant } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";
import { platformConfigured } from "@/lib/platform/control";

// Health check (Session 17): dependency latencies + queue depths + config
// flags in one place. 200 ok / 200 degraded (non-core issue) / 503 when the
// core store is down — point an uptime monitor here.
// Session 24: `?all=1&secret=<CRON_SECRET>` runs the SAME checks for every
// active tenant and rolls them up worst-of — one probe watches the platform.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const withTimeout = (p, ms = 3000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);

async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await withTimeout(fn());
    return { ok: true, ms: Date.now() - t0, ...(value && typeof value === "object" ? value : {}) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 120) };
  }
}

// The full check set for the ACTIVE tenant context.
async function tenantHealth() {
  const [turso, typesense, orderQueue, eventQueue, errors] = await Promise.all([
    timed(async () => {
      await db.selectFrom("products").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    }),
    timed(async () => {
      const host = process.env.TYPESENSE_HOST;
      if (!host) return { skipped: "not configured" };
      const res = await fetch(
        `${process.env.TYPESENSE_PROTOCOL || "https"}://${host}:${process.env.TYPESENSE_PORT || 443}/health`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }),
    timed(async () => {
      const rows = await db
        .selectFrom("orders")
        .select(["status", "sync_attempts", "updated_at", "created_at"])
        .where("status", "in", ["paid", "cod_pending", "syncing_shopify", "sync_failed"])
        .execute();
      const max = Number(process.env.SHOPIFY_SYNC_MAX_ATTEMPTS || 5);
      const dead = rows.filter((r) => r.status === "sync_failed" && r.sync_attempts >= max);
      const times = rows
        .map((r) => new Date(r.updated_at || r.created_at || Date.now()).getTime())
        .filter((t) => Number.isFinite(t));
      const oldest = times.length ? Math.max(0, Math.round((Date.now() - Math.min(...times)) / 60000)) : 0;
      return { pending: rows.length - dead.length, dead: dead.length, oldest_pending_min: oldest };
    }),
    timed(async () => {
      const pending = await db
        .selectFrom("events")
        .select(({ fn }) => fn.countAll().as("n"))
        .where("status", "=", "pending")
        .executeTakeFirst();
      const dead = await db
        .selectFrom("events")
        .select(({ fn }) => fn.countAll().as("n"))
        .where("status", "=", "dead")
        .executeTakeFirst();
      return { pending: Number(pending.n), dead: Number(dead.n) };
    }),
    timed(() => errorStats({ sinceHours: 24 }).then((s) => ({ distinct_24h: s.distinct }))),
  ]);

  const core = turso.ok;
  // S38 (BE05): an unreachable OPTIONAL Typesense no longer degrades health —
  // /api/search transparently serves from SQL, which is the supported engine.
  const degraded = !orderQueue.ok || orderQueue.dead > 0 || (eventQueue.ok && eventQueue.dead > 0);
  const status = core ? (degraded ? "degraded" : "ok") : "down";

  return {
    status,
    at: new Date().toISOString(),
    // S38 (BE05 decision): SQL over the local catalog IS the supported search
    // engine; Typesense is an optional env-configured upgrade. This names the
    // engine actually serving /api/search right now.
    search: {
      engine: !typesense.skipped && typesense.ok ? "typesense" : "database",
      typesense_configured: !typesense.skipped,
      ...(typesense.skipped || typesense.ok ? {} : { note: "typesense configured but unreachable — SQL fallback serving" }),
    },
    checks: { turso, typesense, order_queue: orderQueue, event_queue: eventQueue, errors },
    configured: {
      razorpay: razorpayConfigured(),
      razorpay_webhook: webhookConfigured(),
      shopify: Boolean(tenantOwnSecret("shopify_admin_token", "SHOPIFY_ADMIN_TOKEN")),
      ga4: ga4Configured(),
      meta: metaConfigured(),
      alerts: Boolean(process.env.ALERT_WEBHOOK_URL),
    },
  };
}

function rollupAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}` || request.nextUrl.searchParams.get("secret") === secret;
}

// allowUnresolved: the ?all=1 rollup is called on the deployment/platform host
// (not a tenant domain) by monitoring. The single-tenant check stays fail-closed
// by hand: platform mode + no resolved tenant → 404 TENANT_UNKNOWN.
export const GET = tenantHandler(
  async (request) => {
    if (request.nextUrl.searchParams.get("all") === "1") {
      if (!rollupAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const results = await forEachActiveTenant(tenantHealth);
      const rollup = aggregateHealth(results);
      // S29 (BE19): platform queue health rides the rollup — dead letters or a
      // stale pending backlog degrade the platform even when every tenant is ok.
      let queue = null;
      if (platformConfigured()) {
        const { queueStats } = await import("@/lib/platform/jobs");
        queue = await queueStats().catch(() => null);
        if (queue && rollup.status === "ok" && (queue.jobs.dead > 0 || queue.inbox.dead > 0 || queue.jobs.oldest_pending_min > 60)) {
          rollup.status = "degraded";
        }
      }
      return NextResponse.json(
        { ...rollup, ...(queue ? { queue } : {}), at: new Date().toISOString() },
        { status: rollup.status === "down" ? 503 : 200 },
      );
    }
    if (platformConfigured() && !currentTenant()) {
      return NextResponse.json({ error: "Store not found", code: "TENANT_UNKNOWN" }, { status: 404 });
    }
    const body = await tenantHealth();
    return NextResponse.json(body, { status: body.status === "down" ? 503 : 200 });
  },
  { allowUnresolved: true },
);
