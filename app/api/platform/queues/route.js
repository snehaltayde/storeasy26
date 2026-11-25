import { NextResponse } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
import { listJobs, listInbox, queueStats, replayJob, replayInbox, discardJob, discardInbox } from "@/lib/platform/jobs";
import { runDueJobs, TICK_BUDGET_MS } from "@/lib/platform/worker";
import { audit, operatorActor } from "@/lib/platform/audit";

// Queue & webhook inspector API (S29 / OP05). Metadata ONLY — raw webhook
// payloads can carry PII and are never serialized here; replay is scoped,
// audited (lib/platform/jobs.js) and idempotent (handlers tolerate re-runs;
// money paths change state once).
//   GET  ?status=&tenant=&limit=     → { stats, jobs, inbox }
//   POST {action:"replay", kind:"job"|"inbox", id}
//   POST {action:"discard", kind:"job"|"inbox", id}   (Phase 3 line 6: dead rows only)
//   POST {action:"tick"}             → drain due jobs now (operator button)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const p = request.nextUrl.searchParams;
  const [stats, jobs, inbox] = await Promise.all([
    queueStats(),
    listJobs({ status: p.get("status"), tenant: p.get("tenant"), limit: p.get("limit") || 50 }),
    listInbox({ status: p.get("status"), limit: p.get("limit") || 50 }),
  ]);
  return NextResponse.json({ ok: true, stats, jobs, inbox });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "replay" && body.kind === "job") {
      const ok = await replayJob(String(body.id || ""), { actor: operatorActor(auth.operator) });
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    if (body.action === "replay" && body.kind === "inbox") {
      const ok = await replayInbox(String(body.id || ""), { actor: operatorActor(auth.operator) });
      return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
    }
    if (body.action === "discard" && (body.kind === "job" || body.kind === "inbox")) {
      const discard = body.kind === "job" ? discardJob : discardInbox;
      const ok = await discard(String(body.id || ""), { actor: operatorActor(auth.operator) });
      return NextResponse.json(ok ? { ok } : { error: "Only a dead letter can be discarded, and this one isn't (or no longer exists)." }, { status: ok ? 200 : 404 });
    }
    if (body.action === "tick") {
      // same budget as the tick route, so catalog sync slices run too (GEN-02)
      const results = await runDueJobs({ limit: 25, budgetMs: TICK_BUDGET_MS });
      await audit({ actor: operatorActor(auth.operator), action: "queue.tick", resource: "queue:jobs", tenantId: null, diff: { ran: results.length, failed: results.filter((r) => r.ok === false).length } });
      return NextResponse.json({ ok: true, ran: results.length, failed: results.filter((r) => r.ok === false).length });
    }
    return NextResponse.json({ error: "action must be replay, discard or tick" }, { status: 400 });
  } catch (e) {
    // P3-G: no raw driver error in the answer; the scrubbed text goes to the log
    return operatorError(e, { words: "That queue action failed. Try again, and check the server log if it keeps failing.", status: 400, event: "queue_action_failed" });
  }
}
