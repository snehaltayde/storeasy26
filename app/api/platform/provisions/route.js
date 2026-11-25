import { NextResponse, after } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
import { listProvisionRuns, runProvision, compensateProvision, getProvisionRun, provisionRunView } from "@/lib/platform/provision";
import { resumeSignupRun, signupsForRuns } from "@/lib/platform/signup-provision";
import { runJobById } from "@/lib/platform/worker";
import { audit, operatorActor } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { getTenant } from "@/lib/platform/control";

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
// Phase 3 line 6: runs go out through provisionRunView (no params, no refs:
// no founder email, no database address); the one secret a response carries
// is a resumed run's generated console password, shown once.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JOB_SOURCES = ["signup", "operator"];

async function runTenant(runId) {
  const id = (await getProvisionRun(runId).catch(() => null))?.params?.id;
  return id ? getTenant(String(id)).catch(() => null) : null;
}

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const runs = await listProvisionRuns({ limit: 20 });
  const signups = await signupsForRuns(runs.filter((r) => JOB_SOURCES.includes(r.params?.source)).map((r) => r.id));
  return NextResponse.json({ ok: true, runs: runs.map((r) => ({ ...provisionRunView(r), ...(signups[r.id] ? { signup: signups[r.id] } : {}) })) });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  let tenant = null; // the run's store, so its address and token are scrubbed from a failure
  try {
    tenant = await runTenant(String(body.run || ""));
    if (body.action === "resume" && JOB_SOURCES.includes((await getProvisionRun(String(body.run || "")))?.params?.source)) {
      const q = await resumeSignupRun(String(body.run));
      if (q?.jobId) after(() => runJobById(q.jobId, { budgetMs: 50_000 }));
      slog("provision_resumed", { run: body.run, queued: Boolean(q?.jobId) });
      await audit({ actor: operatorActor(auth.operator), action: "tenant.provision", resource: `run:${body.run}`, diff: { resumed: true, queued: Boolean(q?.jobId), signup: q?.signupId || null } });
      if (!q?.jobId) return NextResponse.json({ error: q?.lapsed ? "This signup has lapsed; the founder has to start again." : q?.already === "done" ? "This signup is already done." : "No signup uses this run." }, { status: 422 });
      return NextResponse.json({ ok: true, queued: true, signup: q.signupId });
    }
    if (body.action === "resume") {
      // dbToken may be re-supplied for adopted-db runs (tokens are never stored)
      const r = await runProvision({ dbToken: body.dbToken || null }, { resumeRunId: String(body.run || "") });
      slog("provision_resumed", { run: body.run, status: r.run.status });
      await audit({ actor: operatorActor(auth.operator), action: "tenant.provision", resource: `run:${body.run}`, diff: { resumed: true, status: r.run.status } });
      return NextResponse.json({ ok: true, run: provisionRunView(r.run), failedStep: r.failedStep || null, generated: r.generated?.admin_password ? { admin_password: r.generated.admin_password } : null });
    }
    if (body.action === "compensate") {
      const r = await compensateProvision(String(body.run || ""));
      slog("provision_compensate", { run: body.run });
      await audit({ actor: operatorActor(auth.operator), action: "tenant.provision", resource: `run:${body.run}`, diff: { compensated: true } });
      return NextResponse.json({ ok: true, run: provisionRunView(r.run), notes: r.notes });
    }
    return NextResponse.json({ error: "action must be resume or compensate" }, { status: 400 });
  } catch (e) {
    return operatorError(e, { tenant, words: "That run didn't resume or compensate. Check its steps, then try again.", event: "provision_action_failed" });
  }
}
