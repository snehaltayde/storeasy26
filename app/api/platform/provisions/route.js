import { NextResponse, after } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { listProvisionRuns, runProvision, compensateProvision, getProvisionRun } from "@/lib/platform/provision";
import { resumeSignupRun, signupsForRuns } from "@/lib/platform/signup-provision";
import { runJobById } from "@/lib/platform/worker";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";

// Provisioning runs (S41 / OP04): step-state history, safe RESUME of failed
// runs (idempotent steps verify real state — no duplicate resources), and
// conservative compensation (deregisters what the run created; never deletes
// a database).
// Phase 1 line 2: each run carries `signup` ({ id, status, failureKind }) when a
// self-serve signup made it; resuming such a run makes the signup's job due
// (run in after()) instead of running inline, so the user and the owner
// membership are made too.
// Phase 1 line 9: a run for a store an operator created (source "operator")
// is treated the same way (its job sends the owner's invite); its `signup`
// carries source "operator" for the panel's "Created by Storeasy" badge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const JOB_SOURCES = ["signup", "operator"];

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const runs = await listProvisionRuns({ limit: 20 });
  const signups = await signupsForRuns(runs.filter((r) => JOB_SOURCES.includes(r.params?.source)).map((r) => r.id));
  return NextResponse.json({ ok: true, runs: runs.map((r) => (signups[r.id] ? { ...r, signup: signups[r.id] } : r)) });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "resume" && JOB_SOURCES.includes((await getProvisionRun(String(body.run || "")))?.params?.source)) {
      const q = await resumeSignupRun(String(body.run));
      if (q?.jobId) after(() => runJobById(q.jobId, { budgetMs: 50_000 }));
      slog("provision_resumed", { run: body.run, queued: Boolean(q?.jobId) });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.provision", resource: `run:${body.run}`, diff: { resumed: true, queued: Boolean(q?.jobId), signup: q?.signupId || null } });
      if (!q?.jobId) return NextResponse.json({ error: q?.lapsed ? "This signup has lapsed; the founder has to start again." : q?.already === "done" ? "This signup is already done." : "No signup uses this run." }, { status: 422 });
      return NextResponse.json({ ok: true, queued: true, signup: q.signupId });
    }
    if (body.action === "resume") {
      // dbToken may be re-supplied for adopted-db runs (tokens are never stored)
      const r = await runProvision({ dbToken: body.dbToken || null }, { resumeRunId: String(body.run || "") });
      slog("provision_resumed", { run: body.run, status: r.run.status });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.provision", resource: `run:${body.run}`, diff: { resumed: true, status: r.run.status } });
      return NextResponse.json({ ok: true, run: r.run, failedStep: r.failedStep || null, generated: r.generated || null });
    }
    if (body.action === "compensate") {
      const r = await compensateProvision(String(body.run || ""));
      slog("provision_compensate", { run: body.run });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.provision", resource: `run:${body.run}`, diff: { compensated: true } });
      return NextResponse.json({ ok: true, run: r.run, notes: r.notes });
    }
    return NextResponse.json({ error: "action must be resume or compensate" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
