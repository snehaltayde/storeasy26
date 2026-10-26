import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listPlacements, upsertPlacement, deletePlacement } from "@/lib/cms/placements";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// PUT {enabled} — fast toggle (full edits go through POST /api/admin/upsells
// with the row id).
export const PUT = tenantHandler(async (request, { params }) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const row = (await listPlacements()).find((p) => p.id === id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await upsertPlacement({
      id,
      kind: row.kind,
      sourceProductId: row.source_product_id,
      targetProductIds: row.target_product_ids,
      title: row.title,
      enabled: body.enabled !== false,
      position: row.position,
    });
    slog("placement_toggled", { id, enabled: body.enabled !== false });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});

export const DELETE = tenantHandler(async (request, { params }) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const { id } = await params;
  await deletePlacement(id);
  slog("placement_deleted", { id });
  return NextResponse.json({ ok: true });
});
