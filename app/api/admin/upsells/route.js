import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listPlacements, upsertPlacement, resolveHandles } from "@/lib/cms/placements";
import { db } from "@/lib/db";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// Console speaks HANDLES; storage speaks gids — translate both ways here.
async function listWithHandles() {
  const rows = await listPlacements();
  const ids = [...new Set(rows.flatMap((r) => [r.source_product_id, ...r.target_product_ids]).filter(Boolean))];
  const handles = new Map();
  if (ids.length) {
    const prods = await db.selectFrom("products").select(["id", "handle"]).where("id", "in", ids).execute();
    for (const p of prods) handles.set(p.id, p.handle);
  }
  return rows.map((r) => ({
    ...r,
    source_handle: r.source_product_id ? handles.get(r.source_product_id) || "(missing)" : null,
    target_handles: r.target_product_ids.map((id) => handles.get(id) || "(missing)"),
  }));
}

export const GET = tenantHandler(async (request) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  return NextResponse.json({ ok: true, placements: await listWithHandles() });
});

export const POST = tenantHandler(async (request) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
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
    const id = await upsertPlacement({
      id: body.id || undefined,
      kind: body.kind,
      sourceProductId,
      targetProductIds: targets.ids,
      title: body.title,
      enabled: body.enabled !== false,
      position: body.position || 0,
    });
    slog("placement_saved", { id, kind: body.kind });
    return NextResponse.json({ ok: true, id, placements: await listWithHandles() });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});
