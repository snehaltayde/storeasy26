import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { listProvisionRuns, runProvision, compensateProvision } from "@/lib/platform/provision";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";

// Provisioning runs (S41 / OP04): step-state history, safe RESUME of failed
// runs (idempotent steps verify real state — no duplicate resources), and
// conservative compensation (deregisters what the run created; never deletes
// a database).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  return NextResponse.json({ ok: true, runs: await listProvisionRuns({ limit: 20 }) });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  try {
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
