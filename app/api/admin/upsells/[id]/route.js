import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listPlacements, upsertPlacement, deletePlacement } from "@/lib/cms/placements";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

// PUT {enabled} — fast toggle (full edits go through POST /api/admin/upsells
// with the row id).
export const PUT = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "upsells.write");
  if (!auth.ok) return deny(auth);
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
    await audit({ actor: auth.actor, action: "upsells.write", resource: `placement:${id}`, diff: { enabled: body.enabled !== false } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});

export const DELETE = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "upsells.write");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  await deletePlacement(id);
  slog("placement_deleted", { id });
  await audit({ actor: auth.actor, action: "upsells.write", resource: `placement:${id}`, diff: { deleted: true } });
  return NextResponse.json({ ok: true });
});
