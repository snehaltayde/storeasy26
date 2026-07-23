import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ga4Configured, metaConfigured } from "@/lib/tracking";
import { razorpayConfigured, webhookConfigured } from "@/lib/razorpay";
import { errorStats } from "@/lib/errors";

// Health check (Session 17): dependency latencies + queue depths + config
// flags in one place. 200 ok / 200 degraded (non-core issue) / 503 when the
// core store is down — point an uptime monitor here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET() {
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
  const degraded =
    !typesense.ok || !orderQueue.ok || orderQueue.dead > 0 || (eventQueue.ok && eventQueue.dead > 0);
  const status = core ? (degraded ? "degraded" : "ok") : "down";

  return NextResponse.json(
    {
      status,
      at: new Date().toISOString(),
      checks: { turso, typesense, order_queue: orderQueue, event_queue: eventQueue, errors },
      configured: {
        razorpay: razorpayConfigured(),
        razorpay_webhook: webhookConfigured(),
        shopify: Boolean(process.env.SHOPIFY_ADMIN_TOKEN),
        ga4: ga4Configured(),
        meta: metaConfigured(),
        alerts: Boolean(process.env.ALERT_WEBHOOK_URL),
      },
    },
    { status: core ? 200 : 503 },
  );
}
