import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listPlacements, upsertPlacement, resolveHandles } from "@/lib/cms/placements";
import { db } from "@/lib/db";
import { sql } from "kysely";
import { liveTableReady } from "@/lib/catalog/effective";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { legacyWritesRefusal, getCmsMode } from "@/lib/cms-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// P4-ED05 (after P4-GUARD): a deliberate refusal raised inside the write (the
// mode guard in the write's own batch) answers its own 4xx status and plain
// words, before the catch-all 422.
const refusalBody = (e) => ({ error: String(e.message).slice(0, 300), ...(e.code ? { code: e.code } : {}) });
const refusalStatus = (e) => (Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 409);

// Console speaks HANDLES; storage speaks gids — translate both ways here.
// S39 (MC15): targets carry availability so the console PREVIEWS what will
// actually render (sold-out/deleted targets are skipped on the storefront).
// P4-SEARCH (OVL-05): each target also carries the PUBLISHED name shoppers see
// (title: product_content_live over Shopify's, never a draft) and Shopify's
// own name (shopify_title) only when it differs. The picker the form uses is
// /api/admin/refs, which searches on the published name too.
async function listWithHandles() {
  const rows = await listPlacements();
  const ids = [...new Set(rows.flatMap((r) => [r.source_product_id, ...r.target_product_ids]).filter(Boolean))];
  const products = new Map();
  if (ids.length) {
    const live = await liveTableReady();
    const prods = await db
      .selectFrom("products as p")
      .$call((q) => (live ? q.leftJoin("product_content_live as c", "c.product_id", "p.id") : q))
      .select(["p.id", "p.handle", "p.available"])
      .select(sql.raw(live ? "COALESCE(c.title, p.title)" : "p.title").as("title"))
      .select(sql.raw("p.title").as("shopify_title"))
      .where("p.id", "in", ids)
      .execute();
    for (const p of prods) products.set(p.id, { handle: p.handle, available: !!p.available, title: p.title, shopify_title: p.shopify_title });
  }
  const info = (id) => {
    const p = products.get(id);
    if (!p) return { handle: "(missing)", state: "missing" };
    return { handle: p.handle, state: p.available ? "ok" : "soldout", title: p.title, ...(p.shopify_title !== p.title ? { shopify_title: p.shopify_title } : {}) };
  };
  return rows.map((r) => ({
    ...r,
    source_handle: r.source_product_id ? info(r.source_product_id).handle : null,
    target_handles: r.target_product_ids.map((id) => info(id).handle),
    targets: r.target_product_ids.map(info),
  }));
}

// P4-FIX4 (ED-05, spec 8.13): on a documents store the placements table is
// frozen (pairs live on each product's document, the cart's offer in the cart
// document), so the old list would show content from before the move. The
// GET refuses there in plain words (409 STORE_USES_DOCUMENTS) and reads
// nothing; the old upsells screen redirects to the editor before it calls
// this. A mode that can't be read is a 5xx, never the frozen list. Legacy and
// migrating stores answer as before.
const UPSELLS_IN_EDITOR = "This store now uses the new editor, so its upsells are there: a product's pairs on that product, and the cart's offer in the cart. Open them in the editor.";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "upsells.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let mode;
  try {
    mode = await getCmsMode();
  } catch (e) {
    slog("upsells_mode_unreadable", { error: String(e?.message || e).slice(0, 300) });
    return NextResponse.json({ error: "We couldn't check which editor this store uses, so the upsells didn't load. Try again in a minute.", code: "CMS_MODE_UNAVAILABLE", retryable: true }, { status: 503 });
  }
  if (mode === "documents") return NextResponse.json({ error: UPSELLS_IN_EDITOR, code: "STORE_USES_DOCUMENTS" }, { status: 409 });
  return NextResponse.json({ ok: true, placements: await listWithHandles() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "upsells.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  // P2-GUARD: a store on the new editor refuses this write (409 STORE_USES_DOCUMENTS)
  const refused = await legacyWritesRefusal({ route: "admin/upsells" });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
  try {
    const targets = await resolveHandles(body.targetHandles || []);
    if (targets.missing.length)
      return NextResponse.json({ error: `Unknown product handle(s): ${targets.missing.join(", ")}` }, { status: 422 });
    let sourceProductId = null;
    if (body.kind === "pdp_pairs") {
      const src = await resolveHandles([body.sourceHandle || ""]);
      if (!src.ids.length)
        return NextResponse.json({ error: `Unknown source handle "${body.sourceHandle || ""}"` }, { status: 422 });
      sourceProductId = src.ids[0];
    }
    // S39 (MC15, quirk #6): an EDIT keeps the placement's current enabled
    // state unless the request says otherwise — saving a disabled placement
    // no longer silently re-enables it.
    let enabled = body.enabled !== false;
    if (body.id && !("enabled" in body)) {
      const existing = (await listPlacements()).find((p) => p.id === body.id);
      if (existing) enabled = existing.enabled;
    }
    const id = await upsertPlacement({
      id: body.id || undefined,
      kind: body.kind,
      sourceProductId,
      targetProductIds: targets.ids,
      title: body.title,
      enabled,
      position: body.position || 0,
    });
    slog("placement_saved", { id, kind: body.kind });
    await audit({ actor: auth.actor, action: "upsells.write", resource: `placement:${id}`, diff: { kind: body.kind } });
    return NextResponse.json({ ok: true, id, placements: await listWithHandles() });
  } catch (e) {
    if (e?.expose) return NextResponse.json(refusalBody(e), { status: refusalStatus(e) });
    const infra = infraResponse(e, { route: "admin/upsells" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});
