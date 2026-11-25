import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { db } from "@/lib/db";
import { listAutomations, upsertAutomation, setAutomationEnabled, deleteAutomation, automationRuns, automationsDisabled, setAutomationsDisabled, runOne, retryRun, AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from "@/lib/automations";
import { tenantHandler } from "@/lib/tenant-request";

// Automations admin API (S49 / MC28). Rules can send messages, so writes
// need settings.write (admin+). Dry runs evaluate everything (conditions,
// consent, quiet hours, caps) against a real recent event and send NOTHING.
//   GET                       → rules + disabled flag + recent runs
//   POST {automation:{…}, id?, enabled}
//   POST {enable:{id, enabled}} | {remove:{id}}
//   POST {disable_all:{disabled}}      ← the kill switch
//   POST {dry_run:{id}} | {retry:{run}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({
    ok: true,
    disabled: await automationsDisabled(),
    automations: await listAutomations(),
    runs: await automationRuns({ limit: 30 }),
    triggers: AUTOMATION_TRIGGERS,
    actions: AUTOMATION_ACTIONS,
  });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.automation) {
      const saved = await upsertAutomation(body.automation, { id: body.id || null, enabled: !!body.enabled });
      await audit({ actor: auth.actor, action: "settings.write", resource: `automation:${saved.id}`, diff: { trigger: saved.trigger, action: saved.action.kind, enabled: saved.enabled } });
      return NextResponse.json({ ok: true, automation: saved });
    }
    if (body.enable) {
      const r = await setAutomationEnabled(String(body.enable.id || ""), !!body.enable.enabled);
      await audit({ actor: auth.actor, action: "settings.write", resource: `automation:${r.id}`, diff: { enabled: r.enabled } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.remove) {
      await deleteAutomation(String(body.remove.id || ""));
      await audit({ actor: auth.actor, action: "settings.write", resource: `automation:${body.remove.id}`, diff: { removed: true } });
      return NextResponse.json({ ok: true });
    }
    if (body.disable_all) {
      const r = await setAutomationsDisabled(!!body.disable_all.disabled);
      await audit({ actor: auth.actor, action: "settings.write", resource: "automations:disable_all", diff: r });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.dry_run) {
      const rule = (await listAutomations()).find((a) => a.id === String(body.dry_run.id || ""));
      if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });
      // a real recent order makes the dry run honest; none → clearly synthetic
      const order =
        (await db.selectFrom("orders").selectAll().orderBy("created_at", "desc").limit(1).executeTakeFirst()) ||
        { id: "SYNTHETIC-ORDER", total: 999, payment_method: "cod", email: "", snapshot: "{}" };
      const r = await runOne(rule, { key: `dry`, order }, { dryRun: true });
      return NextResponse.json({ ok: true, sample: order.id, ...r });
    }
    if (body.retry) {
      const run = String(body.retry.run || "");
      const r = await retryRun(run);
      await audit({ actor: auth.actor, action: "settings.write", resource: `automation_run:${run}`, diff: { retried: true, status: r.status } });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    if (e?.errors) return NextResponse.json({ error: String(e.message).slice(0, 300), errors: e.errors }, { status: 422 }); // the automation's own problems
    const infra = infraResponse(e, { route: "admin/automations" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
