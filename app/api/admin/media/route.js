import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { saveMedia, listMedia, setMediaAlt, deleteMedia, mediaUsage, mediaUrl, archiveMedia, unarchiveMedia, MEDIA_MIME } from "@/lib/media";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { listLibrary } from "@/lib/admin/media-library";

// Media library API (S38 / BE15 + MC12).
//   GET ?view=library&q&type&archived&sort&cursor
//                            → Phase 2 line 5: one page (50) of originals for
//                              the media screen, { items, nextCursor, counts }
//                              (lib/admin/media-library.js); 400 INVALID_QUERY
//   GET                      → library listing (originals + their variants);
//                              P4-MEDIA: archived files are left out unless
//                              ?archived=include
//   POST multipart           → upload: `file` (original) + optional `thumb`
//                              (client-side canvas derivative) + alt/width/height
//   PATCH {id, alt}          → update alt text
//   PATCH {id, archived}     → P4-MEDIA: archive (true) or bring back (false);
//                              409 MEDIA_ARCHIVE_UNAVAILABLE on a store without
//                              migration 0025, 404 MEDIA_NOT_FOUND
//   DELETE {id}              → delete; 409 + usage list while referenced
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shape = (m) => ({ ...m, url: mediaUrl(m.id) });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const params = new URL(request.url, "http://local").searchParams;
  if (params.get("view") === "library") {
    try {
      return NextResponse.json({ ok: true, ...(await listLibrary(params)) });
    } catch (e) {
      if (e?.name === "LibraryQueryError") return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      const infra = infraResponse(e, { route: "admin/media", doing: "load" });
      if (infra) return NextResponse.json(infra.body, { status: infra.status });
      throw e;
    }
  }
  const includeArchived = params.get("archived") === "include";
  const media = (await listMedia({ includeArchived })).map(shape);
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
    if (typeof body.archived === "boolean") {
      const r = await (body.archived ? archiveMedia : unarchiveMedia)(String(body.id || ""));
      slog(body.archived ? "media_archived" : "media_unarchived", { id: r.id });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `media:${r.id}`, diff: { archived: body.archived } });
      return NextResponse.json({ ok: true, id: r.id, archived_at: r.archived_at });
    }
    await setMediaAlt(String(body.id || ""), body.alt);
    await audit({ actor: auth.actor, action: "storefront.write", resource: `media:${body.id}`, diff: { alt: true } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    // P4-MEDIA: a deliberate refusal in plain words (archive unavailable, gone)
    if (e?.name === "MediaError") return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
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
    const r = await deleteMedia(id);
    slog("media_deleted", { id });
    await audit({ actor: auth.actor, action: "storefront.write", resource: `media:${id}`, diff: { deleted: true } });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    // the "still used on …" guard is the only way to the force-delete, so it comes first
    if (e?.code === "MEDIA_IN_USE") return NextResponse.json({ error: e.message, code: e.code, usage: e.usage }, { status: 409 });
    // P4-MEDIA: the file changed while it was being deleted (MEDIA_CHANGED)
    if (e?.name === "MediaError") return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
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
  try {
    return NextResponse.json({ ok: true, usage: await mediaUsage(String(body.id || "")) });
  } catch (e) {
    // P2-DOCFIX: the document scan fails closed (it throws when it can't read
    // the documents tables), so a read failure here is ours: a 5xx with a code
    const infra = infraResponse(e, { route: "admin/media", doing: "load" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    slog("api_internal_failure", { route: "admin/media", error: String(e?.message || e).slice(0, 300) });
    return NextResponse.json({ error: "Something went wrong on our side, so this couldn't load. Try again, and contact support if it keeps happening.", code: "INTERNAL_ERROR" }, { status: 500 });
  }
});
