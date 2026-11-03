import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { listJobs, listInbox, queueStats, replayJob, replayInbox } from "@/lib/platform/jobs";
import { runDueJobs, TICK_BUDGET_MS } from "@/lib/platform/worker";

// Queue & webhook inspector API (S29 / OP05). Metadata ONLY — raw webhook
// payloads can carry PII and are never serialized here; replay is scoped,
// audited (lib/platform/jobs.js) and idempotent (handlers tolerate re-runs;
// money paths change state once).
//   GET  ?status=&tenant=&limit=     → { stats, jobs, inbox }
//   POST {action:"replay", kind:"job"|"inbox", id}
//   POST {action:"tick"}             → drain due jobs now (operator button)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const p = request.nextUrl.searchParams;
  const [stats, jobs, inbox] = await Promise.all([
    queueStats(),
    listJobs({ status: p.get("status"), tenant: p.get("tenant"), limit: p.get("limit") || 50 }),
    listInbox({ status: p.get("status"), limit: p.get("limit") || 50 }),
  ]);
  return NextResponse.json({ ok: true, stats, jobs, inbox });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "replay" && body.kind === "job") {
      const ok = await replayJob(String(body.id || ""));
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    if (body.action === "replay" && body.kind === "inbox") {
      const ok = await replayInbox(String(body.id || ""));
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    if (body.action === "tick") {
      // same budget as the tick route, so catalog sync slices run too (GEN-02)
      const results = await runDueJobs({ limit: 25, budgetMs: TICK_BUDGET_MS });
      return NextResponse.json({ ok: true, ran: results.length, failed: results.filter((r) => r.ok === false).length });
    }
    return NextResponse.json({ error: "action must be replay|tick" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 400 });
  }
}
