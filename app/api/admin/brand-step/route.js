import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { infraResponse } from "@/lib/infra-response";
import { validationBody } from "@/lib/cms/issues";
import { captureError } from "@/lib/errors";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { readBrandStep, saveBrandStep } from "@/lib/first-run/brand-step";

// P6-BRAND (GEN-04, US-01): the brand step of "Start your store".
//   GET   storefront.read   { ok, brandStep, palettes: [{ id, label, brand }],
//                           current: { paletteId, logo, description },
//                           design: { id, revision } | null, storeOpen,
//                           canEditDescription, descriptionMax }
//   POST  storefront.write  { paletteId, logo?: { media, alt? } | null,
//                           description?, revision? } or { skip: true }
//                           -> { ok, skipped, design, liveNow, afterPublish,
//                           storeOpen, brandStep }
// A changed description also needs settings.write (lib/first-run/brand-step.js).
// Never publishes. Refusals keep their status and plain words; a stale
// revision is 409 DOCUMENT_CHANGED with the current document, as the
// documents API answers it; a database failure is a 5xx with a code.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "admin/brand-step";
const refusal = (e) => ({ error: String(e.message).slice(0, 300), ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) });

export const GET = tenantHandler(async (request) => {
  try {
    const auth = await requireAdmin(request, "storefront.read");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    return NextResponse.json({ ok: true, ...(await readBrandStep({ actor: auth.actor })) });
  } catch (e) {
    if (e?.expose) return NextResponse.json(refusal(e), { status: e.status });
    const infra = infraResponse(e, { route: ROUTE, doing: "load" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    await captureError({ source: ROUTE, error: e });
    return NextResponse.json({ error: "Something went wrong on our side, so this couldn't load. Try again, and contact support if it keeps happening.", code: "INTERNAL" }, { status: 500 });
  }
});

export const POST = tenantHandler(async (request) => {
  try {
    // requireAdmin covers the CSRF origin check for write actions
    const auth = await requireAdmin(request, "storefront.write");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const body = await request.json().catch(() => undefined);
    const r = await saveBrandStep(body, auth.actor);
    slog("brand_step_saved", { skipped: r.skipped, palette: r.brandStep?.paletteId ?? null, design: r.design?.revision ?? null, live_now: r.liveNow, after_publish: r.afterPublish });
    await audit({
      actor: auth.actor,
      action: r.liveNow.length ? "settings.write" : "storefront.write",
      resource: "brand-step",
      diff: { skipped: r.skipped, paletteId: r.brandStep?.paletteId ?? null, design: r.design, liveNow: r.liveNow, afterPublish: r.afterPublish },
    }); // best-effort, never throws
    return NextResponse.json(r);
  } catch (e) {
    if (e?.expose) return NextResponse.json(refusal(e), { status: e.status });
    if (e?.issues) return NextResponse.json(validationBody(e.issues), { status: 422 });
    const infra = infraResponse(e, { route: ROUTE, doing: "save" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    await captureError({ source: ROUTE, error: e });
    return NextResponse.json({ error: "Something went wrong on our side, so nothing was saved. Try again, and contact support if it keeps happening.", code: "INTERNAL" }, { status: 500 });
  }
});
