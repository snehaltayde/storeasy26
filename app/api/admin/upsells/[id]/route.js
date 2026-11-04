import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { listPlacements, upsertPlacement, deletePlacement } from "@/lib/cms/placements";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { legacyWritesRefusal } from "@/lib/cms-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
// P4-ED05 (after P4-GUARD): a deliberate refusal raised inside the write (the
// mode guard in the write's own batch) answers its own 4xx status and plain
// words, never the catch-all 422 (PUT) or a 500 (DELETE).
const refusalBody = (e) => ({ error: String(e.message).slice(0, 300), ...(e.code ? { code: e.code } : {}) });
const refusalStatus = (e) => (Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 409);

// PUT {enabled} — fast toggle (full edits go through POST /api/admin/upsells
// with the row id).
export const PUT = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "upsells.write");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  // P2-GUARD: a store on the new editor refuses this write (409 STORE_USES_DOCUMENTS)
  const refused = await legacyWritesRefusal({ route: "admin/upsells/[id]" });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
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
    if (e?.expose) return NextResponse.json(refusalBody(e), { status: refusalStatus(e) });
    const infra = infraResponse(e, { route: "admin/upsells/[id]" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});

export const DELETE = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "upsells.write");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  // P2-GUARD: a store on the new editor refuses this write (409 STORE_USES_DOCUMENTS)
  const refused = await legacyWritesRefusal({ route: "admin/upsells/[id]" });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
  try {
    await deletePlacement(id);
  } catch (e) {
    if (e?.expose) return NextResponse.json(refusalBody(e), { status: refusalStatus(e) });
    const infra = infraResponse(e, { route: "admin/upsells/[id]" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: "Something went wrong on our side, so nothing was deleted. Try again in a minute." }, { status: 500 });
  }
  slog("placement_deleted", { id });
  await audit({ actor: auth.actor, action: "upsells.write", resource: `placement:${id}`, diff: { deleted: true } });
  return NextResponse.json({ ok: true });
});
