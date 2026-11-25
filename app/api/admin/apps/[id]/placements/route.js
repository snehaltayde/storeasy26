import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { appErrorAnswer } from "@/lib/plugins/installs";
import { PlacementError, listPlacements, updatePlacement } from "@/lib/plugins/placements";

// Where an installed app's blocks show on the storefront (Phase 4 line 2).
// [id] is the install id (pin_…).
//   GET  apps.read   → { installStatus, placements, previewPaths }
//   POST apps.manage, { block, slot } | { block, state: "off"|"live" } |
//        { block, settings: { key: value } } | { block, move: "up"|"down" }
//        → the same as GET, after the change (audited as apps.placement)
// A refusal is in plain words; a settings refusal is 422 with
// { errors: { field: message } }.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "This app isn't installed on your store. It may have been uninstalled.", code: "NOT_FOUND" };
const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const failure = (e) => {
  if (e instanceof PlacementError) return NextResponse.json({ error: e.message, code: e.code, ...(e.errors ? { errors: e.errors } : {}) }, { status: e.status });
  const f = appErrorAnswer(e, "admin/apps/[id]/placements");
  return NextResponse.json(f.body, { status: f.status });
};

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  try {
    const found = await listPlacements(String(id || ""));
    if (!found) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ ok: true, ...found });
  } catch (e) {
    return failure(e);
  }
});

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.block !== "string") {
    return NextResponse.json({ error: "Choose a block and one thing to change.", code: "BAD_REQUEST" }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await updatePlacement(String(id || ""), body, { actor: auth.actor })) });
  } catch (e) {
    return failure(e);
  }
});
