import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { buildChecklist, markManualStep } from "@/lib/admin/onboarding";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Onboarding checklist API (S41 / MC02).
//   GET            → derived checklist (+ manual check-offs)
//   POST {step, done?} → mark/unmark a MANUAL step (launch is gated server-side)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, ...(await buildChecklist()) });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    const r = await markManualStep(String(body.step || ""), { done: body.done !== false });
    slog("onboarding_step", { step: r.step, done: r.done });
    await audit({ actor: auth.actor, action: "settings.write", resource: `onboarding:${r.step}`, diff: { done: r.done } });
    return NextResponse.json({ ok: true, ...(await buildChecklist()) });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
