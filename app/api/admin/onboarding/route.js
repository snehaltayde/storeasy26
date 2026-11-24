import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { onboardingFor, markTestOrder } from "@/lib/onboarding/service";
import { withTenant } from "@/lib/tenant-context";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Phase 1 line 3: the four onboarding steps (lib/onboarding/steps.js).
//   GET                              (storefront.read) → { ok, supported, open, current, doneCount, total, steps }
//   POST { step: "test_order", done } (settings.write) → the same, after the check-off is set or cleared
// The shop domain is in the connect step's facts only for roles with
// settings.read. Every role reads; a role's disabled actions carry the reason.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json({ ok: true, ...(await onboardingFor(auth.actor)) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/onboarding" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    throw e;
  }
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  if (body?.step !== "test_order") return NextResponse.json({ error: "Only the test order can be marked here." }, { status: 422 });
  try {
    const r = await markTestOrder(body.done !== false);
    slog("onboarding_step", { step: r.step, done: r.done });
    await audit({ actor: auth.actor, action: "settings.write", resource: `onboarding:${r.step}`, diff: { done: r.done } });
    return NextResponse.json({ ok: true, ...(await withTenant(r.tenant, () => onboardingFor(auth.actor))) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/onboarding" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
