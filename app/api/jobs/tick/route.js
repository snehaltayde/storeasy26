import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runDueJobs, TICK_BUDGET_MS } from "@/lib/platform/worker";
import { queueStats, pruneQueues } from "@/lib/platform/jobs";
import { platformConfigured } from "@/lib/platform/control";
import { queueOnboardingSweep } from "@/lib/onboarding/snapshot";

// Queue tick (S29 / BE14): leases and executes due jobs — the durability
// backstop behind the after() fast paths. Vercel Hobby crons only run daily,
// so a FREE external scheduler invokes this ~every minute (GitHub Actions
// workflow in .github/workflows/jobs-tick.yml, or Upstash QStash):
//   GET/POST /api/jobs/tick?secret=<CRON_SECRET>
// Idempotent and safe to over-call: leasing is atomic, an empty queue is a
// no-op, and a crashed worker's lease simply expires back into the pool.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function tick(request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!platformConfigured()) {
    return NextResponse.json({ ok: true, skipped: "no control plane (legacy mode — sweeps own retries)" });
  }
  // line 8: one onboarding snapshot sweep per 10 minutes (deduplicated by key)
  await queueOnboardingSweep().catch(() => {});
  const limit = Number(request.nextUrl.searchParams.get("limit") || 25);
  // GEN-02: a budget inside maxDuration, so long jobs (catalog sync slices)
  // run too — last, and only as long as the tick has time left.
  const results = await runDueJobs({ limit, budgetMs: TICK_BUDGET_MS });
  if (Math.random() < 0.05) await pruneQueues().catch(() => {}); // occasional retention pass
  const stats = await queueStats();
  return NextResponse.json({
    ok: results.every((r) => r.ok !== false),
    ran: results.length,
    failed: results.filter((r) => r.ok === false).length,
    results: results.map((r) => ({ id: r.id, type: r.type, ok: r.ok, ...(r.dead ? { dead: true } : {}) })),
    queue: stats,
  });
}

export const GET = tick;
export const POST = tick;
