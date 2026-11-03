import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { saveMedia, listMedia, setMediaAlt, deleteMedia, mediaUsage, mediaUrl, MEDIA_MIME } from "@/lib/media";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Media library API (S38 / BE15 + MC12).
//   GET                      → library listing (originals + their variants)
//   POST multipart           → upload: `file` (original) + optional `thumb`
//                              (client-side canvas derivative) + alt/width/height
//   PATCH {id, alt}          → update alt text
//   DELETE {id, force?}      → delete; 409 + usage list while referenced
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shape = (m) => ({ ...m, url: mediaUrl(m.id) });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const media = (await listMedia()).map(shape);
  return NextResponse.json({ ok: true, media, limits: Object.fromEntries(Object.entries(MEDIA_MIME).map(([k, v]) => [k, v.max])) });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "no file" }, { status: 400 });
    const alt = String(form.get("alt") || "");
    const num = (k) => (form.get(k) != null && form.get(k) !== "" ? Number(form.get(k)) : null);

    const original = await saveMedia({
      filename: file.name,
      mime: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      alt,
      width: num("width"),
      height: num("height"),
    });

    // optional client-generated derivative (canvas resize in the console)
    const thumb = form.get("thumb");
    let thumbRow = null;
    if (thumb && typeof thumb.arrayBuffer === "function" && !original.deduped) {
      try {
        thumbRow = await saveMedia({
          filename: `thumb-${file.name}`,
          mime: thumb.type,
          bytes: new Uint8Array(await thumb.arrayBuffer()),
          alt,
          width: num("thumbWidth"),
          height: num("thumbHeight"),
          variant: "thumb",
          parentId: original.id,
        });
      } catch {
        thumbRow = null; // a bad derivative never fails the original upload
      }
    }

    slog("media_uploaded", { id: original.id, mime: original.mime, size: original.size, deduped: original.deduped });
    await audit({ actor: auth.actor, action: "storefront.write", resource: `media:${original.id}`, diff: { filename: original.filename, size: original.size, thumb: !!thumbRow } });
    return NextResponse.json({ ok: true, media: shape(original), thumb: thumbRow ? shape(thumbRow) : null });
  } catch (e) {
    if (e?.code === "MEDIA_INVALID") return NextResponse.json({ error: e.message, errors: e.errors }, { status: 422 });
    const infra = infraResponse(e, { route: "admin/media" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});

export const PATCH = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    await setMediaAlt(String(body.id || ""), body.alt);
    await audit({ actor: auth.actor, action: "storefront.write", resource: `media:${body.id}`, diff: { alt: true } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/media" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});

export const DELETE = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || "");
  try {
    const r = await deleteMedia(id, { force: body.force === true });
    slog("media_deleted", { id, forced: body.force === true });
    await audit({ actor: auth.actor, action: "storefront.write", resource: `media:${id}`, diff: { deleted: true, forced: body.force === true } });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    // the "still used on …" guard is the only way to the force-delete, so it comes first
    if (e?.code === "MEDIA_IN_USE") return NextResponse.json({ error: e.message, code: e.code, usage: e.usage }, { status: 409 });
    const infra = infraResponse(e, { route: "admin/media" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});

// usage preview for the console's delete confirmation
export const PUT = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({ ok: true, usage: await mediaUsage(String(body.id || "")) });
});
