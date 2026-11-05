import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { describeFirstStore, generateFirstStore, FIRST_RUN_WORDS } from "@/lib/first-run/generate";
import { catalogSyncProgress } from "@/lib/platform/sync-jobs";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// P6-GEN (GEN-01, US-01, US-04): the first store, for the console's start page.
//   GET    what was made and whether it can be made now (describeFirstStore),
//          plus the catalog sync's progress (storefront.read)
//   POST   make it now (generateFirstStore, trigger 'console'): only someone
//          who can edit the store (storefront.write); anyone else gets 403 in
//          plain words. A store that isn't eligible answers 200 with ran:false,
//          its reason and plain words, and nothing written. `generated` is true
//          only when something was stored (the writer's `written`).
// It never publishes: the founder's first Publish opens the store.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const READ_ONLY_WORDS = FIRST_RUN_WORDS.cannot_edit;

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const firstRun = await describeFirstStore({ actor: auth.actor });
    const { view } = await catalogSyncProgress();
    return NextResponse.json({ ok: true, firstRun, sync: view });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/first-run", doing: "load" });
    if (infra) return NextResponse.json({ ok: false, ...infra.body }, { status: infra.status });
    slog("admin_first_run_failed", { op: "describe", error: String(e?.message || e).slice(0, 200) });
    return NextResponse.json({ ok: false, error: "We couldn't load your starting store just now. Reload the page to try again." }, { status: 500 });
  }
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  // a signed-in person whose role can't edit (support, a read-only grant):
  // plain words. A cross-origin or signed-out request keeps its own answer.
  if (!auth.ok) return NextResponse.json({ ok: false, ...(auth.status === 403 && auth.actor ? { reason: "cannot_edit", error: READ_ONLY_WORDS } : { error: auth.error }) }, { status: auth.status });
  try {
    const r = await generateFirstStore({ trigger: "console", actor: auth.actor });
    if (!r.ran) {
      if (r.reason === "cannot_edit") return NextResponse.json({ ok: false, reason: "cannot_edit", error: READ_ONLY_WORDS }, { status: 403 });
      return NextResponse.json({ ok: true, ran: false, generated: false, reason: r.reason, message: r.message });
    }
    if (r.written) await audit({ actor: auth.actor, action: "storefront.write", resource: "first-run", diff: { created: r.created, refilled: r.refilled, products: r.products, collections: r.collections } }); // best-effort, never throws
    return NextResponse.json({
      ok: true,
      ran: true,
      generated: Boolean(r.written),
      created: r.created,
      refilled: r.refilled,
      unchanged: r.unchanged,
      skipped: r.skipped,
      products: r.products,
      collections: r.collections,
      summary: r.summary,
    });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/first-run", doing: "save" });
    if (infra) return NextResponse.json({ ok: false, ...infra.body }, { status: infra.status });
    slog("admin_first_run_failed", { op: "generate", error: String(e?.message || e).slice(0, 200) });
    return NextResponse.json({ ok: false, error: "We couldn't make your starting store just now. Nothing was saved. Try again." }, { status: 500 });
  }
});
