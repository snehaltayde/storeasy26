import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listExperiments, upsertExperiment, startExperiment, setExperimentStatus, analyzeExperiment, adoptVariant } from "@/lib/experiments";
import { tenantHandler } from "@/lib/tenant-request";

// Experiments admin API (S47 / BE22 + MC18). The analysis endpoint is the
// ONLY reader of results, and it blocks winner interpretation while running
// (no peeking), on insufficient samples, or under sample-ratio mismatch —
// returning the reasons instead. Adoption writes a CMS DRAFT; publishing
// stays with the Releases tab and its permission.
//   GET                     → experiments list
//   GET ?analyze=<slug>     → analysis (cells, SRM, blocks, verdict)
//   POST {experiment:{…}}   → create/update a DRAFT (frozen once started)
//   POST {start|pause|complete:{slug}}
//   POST {adopt:{slug, variant}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const slug = new URL(request.url).searchParams.get("analyze");
  if (slug) {
    const a = await analyzeExperiment(slug);
    if (!a) return NextResponse.json({ error: "experiment not found" }, { status: 404 });
    return NextResponse.json({ ok: true, analysis: a });
  }
  return NextResponse.json({ ok: true, experiments: await listExperiments() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.experiment) {
      const saved = await upsertExperiment(body.experiment);
      await audit({ actor: auth.actor, action: "storefront.write", resource: `experiment:${saved.slug}`, diff: { variants: saved.variants.length } });
      return NextResponse.json({ ok: true, experiment: saved });
    }
    if (body.start) {
      const r = await startExperiment(String(body.start.slug || ""));
      await audit({ actor: auth.actor, action: "storefront.write", resource: `experiment:${r.slug}`, diff: { status: "running" } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.pause || body.complete) {
      const slug = String((body.pause || body.complete).slug || "");
      const r = await setExperimentStatus(slug, body.pause ? "paused" : "completed");
      await audit({ actor: auth.actor, action: "storefront.write", resource: `experiment:${slug}`, diff: { status: r.status } });
      return NextResponse.json({ ok: true, ...r });
    }
    if (body.adopt) {
      const r = await adoptVariant(String(body.adopt.slug || ""), String(body.adopt.variant || ""));
      await audit({ actor: auth.actor, action: "storefront.write", resource: `experiment:${r.slug}`, diff: { adopted: r.adopted } });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/experiments" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), ...(e.errors ? { errors: e.errors } : {}) }, { status: 422 });
  }
});
