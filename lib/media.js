// Tenant media service (Session 38 / BE15). SERVER-ONLY (imports db).
//
// Pipeline: the console uploads through /api/admin/media (admin-session-authed,
// so every byte is tenant-bound — the blob lands in the resolving tenant's own
// DB and is served back only on that tenant's hosts). Validation is strict:
// mime allowlist, size caps, magic-byte sniffing (a .png that isn't a PNG is
// refused), and SVG goes through an allowlist sanitizer (scripts, event
// handlers, foreignObject and external references stripped). Derivatives are
// generated CLIENT-side (canvas resize in the uploader — no native image
// library exists on the edge/serverless runtime) and stored as variant rows.
// Files are immutable once written (content-addressed dedupe via sha256), so
// /api/media/<id> serves with a far-future cache.
import { db } from "./db.js";

export const MEDIA_MIME = {
  "image/png": { ext: "png", max: 1_500_000 },
  "image/jpeg": { ext: "jpg", max: 1_500_000 },
  "image/webp": { ext: "webp", max: 1_500_000 },
  "image/gif": { ext: "gif", max: 1_500_000 },
  "image/svg+xml": { ext: "svg", max: 300_000 },
};

export const mediaUrl = (id) => `/api/media/${id}`;

// ---- validation --------------------------------------------------------------

// Magic-byte sniffing: the declared mime must match what the bytes actually are.
export function sniffMime(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  const head = new TextDecoder().decode(b.slice(0, 1000)).trim().toLowerCase();
  if (head.includes("<svg") && !head.startsWith("<?php")) return "image/svg+xml";
  return null;
}

// SVG sanitizer: strip script/foreignObject (with content), every on* handler,
// javascript:/data:text hrefs and external references. Allowlist would be
// ideal but SVG's vocabulary is huge; this strips the executable surface and
// the document is then served with a restrictive Content-Security-Policy AND
// Content-Disposition stays inline-image only (no sniffing, no top-level nav
// risk beyond what <img> allows).
export function sanitizeSvg(text) {
  let s = String(text);
  // drop dangerous elements WITH their content
  for (const tag of ["script", "foreignObject", "iframe", "object", "embed", "animate", "set", "handler"]) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?(</${tag}\\s*>|/>)`, "gi"), "");
  }
  // strip event handlers and style attributes carrying url()
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // neutralize javascript:/data: in href / xlink:href / src; keep #fragment + relative/https images
  s = s.replace(/\s+(href|xlink:href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr, _q, v1, v2) => {
    const v = (v1 ?? v2 ?? "").trim().toLowerCase().replace(/[\s\u0000-\u001f]+/g, "");
    return v.startsWith("#") || v.startsWith("https://") || (v.startsWith("/") && !v.startsWith("//")) ? m : "";
  });
  return s;
}

export function validateUpload({ filename, mime, bytes }) {
  const errors = [];
  const spec = MEDIA_MIME[mime];
  if (!spec) errors.push(`type "${mime}" not allowed (png, jpeg, webp, gif, svg)`);
  if (spec && bytes.length > spec.max) errors.push(`file is ${Math.round(bytes.length / 1024)}KB — the limit for ${spec.ext} is ${Math.round(spec.max / 1024)}KB`);
  if (bytes.length === 0) errors.push("file is empty");
  if (spec && bytes.length) {
    const sniffed = sniffMime(bytes);
    if (sniffed !== mime) errors.push(`file content doesn't match its type (declared ${mime}, looks like ${sniffed || "unknown"})`);
  }
  const name = String(filename || "upload").replace(/[^\w.\- ]+/g, "").slice(0, 120) || "upload";
  return { ok: !errors.length, errors, filename: name };
}

// ---- storage -----------------------------------------------------------------

const medId = () => "med_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Store one file. Same content (sha256) + same variant → the existing row is
// returned (dedupe), so re-uploading is harmless. SVG text is sanitized HERE,
// before it ever hits the database.
export async function saveMedia({ filename, mime, bytes, alt = "", width = null, height = null, variant = null, parentId = null }) {
  let body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (mime === "image/svg+xml") body = new TextEncoder().encode(sanitizeSvg(new TextDecoder().decode(body)));
  const v = validateUpload({ filename, mime, bytes: body });
  if (!v.ok) {
    const err = new Error(v.errors.join(" · "));
    err.code = "MEDIA_INVALID";
    err.errors = v.errors;
    throw err;
  }
  const sha = await sha256Hex(body);
  const existing = await db
    .selectFrom("media")
    .select(["id", "filename", "mime", "size", "width", "height", "alt", "variant", "parent_id", "created_at"])
    .where("sha256", "=", sha)
    .where((eb) => (variant == null ? eb("variant", "is", null) : eb("variant", "=", variant)))
    .executeTakeFirst();
  if (existing) return { ...existing, deduped: true };

  const row = {
    id: medId(),
    filename: v.filename,
    mime,
    size: body.length,
    width: Number.isFinite(Number(width)) ? Number(width) : null,
    height: Number.isFinite(Number(height)) ? Number(height) : null,
    alt: String(alt || "").slice(0, 300),
    variant,
    parent_id: parentId,
    sha256: sha,
    created_at: new Date().toISOString(),
  };
  await db.insertInto("media").values({ ...row, data: body }).execute();
  return { ...row, deduped: false };
}

// Library listing (no blobs). Originals with their variants attached.
export async function listMedia() {
  const rows = await db
    .selectFrom("media")
    .select(["id", "filename", "mime", "size", "width", "height", "alt", "variant", "parent_id", "created_at"])
    .orderBy("created_at", "desc")
    .execute();
  const originals = rows.filter((r) => !r.parent_id).map((r) => ({ ...r, variants: [] }));
  const byId = new Map(originals.map((r) => [r.id, r]));
  for (const r of rows) if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).variants.push({ id: r.id, variant: r.variant, size: r.size, width: r.width, height: r.height });
  return originals;
}

export async function getMediaFile(id) {
  const row = await db.selectFrom("media").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
  return { ...row, data };
}

export async function setMediaAlt(id, alt) {
  const r = await db.updateTable("media").set({ alt: String(alt || "").slice(0, 300) }).where("id", "=", id).executeTakeFirst();
  if (Number(r?.numUpdatedRows ?? 0) === 0) throw new Error("media not found");
}

// ---- usage references (safe delete) ------------------------------------------

// Where is /api/media/<id> referenced? Scanned surfaces: draft blocks, draft
// pages, the LIVE release snapshot, and the tenant's brand/site config strings.
// Historical (non-live) releases are immutable and may reference deleted media
// — a rollback to one then shows broken images; the console warns about that.
export async function mediaUsage(id) {
  const needle = mediaUrl(id);
  const uses = [];
  try {
    const blocks = await db.selectFrom("cms_blocks").select(["key", "value"]).execute();
    for (const b of blocks) if (String(b.value).includes(needle)) uses.push({ where: `block:${b.key}` });
  } catch { /* pre-migration */ }
  try {
    const pages = await db.selectFrom("cms_pages").select(["slug", "sections"]).execute();
    for (const p of pages) if (String(p.sections).includes(needle)) uses.push({ where: `page:${p.slug}` });
  } catch { /* pre-migration */ }
  try {
    const state = await db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst();
    if (state?.live_release_id) {
      const rel = await db.selectFrom("releases").select(["id", "content"]).where("id", "=", state.live_release_id).executeTakeFirst();
      if (rel && String(rel.content).includes(needle)) uses.push({ where: `live release:${rel.id}` });
    }
  } catch { /* pre-migration */ }
  return uses;
}

// Delete an original and its variants. Refuses while referenced unless forced.
export async function deleteMedia(id, { force = false } = {}) {
  const uses = await mediaUsage(id);
  if (uses.length && !force) {
    const err = new Error(`still referenced by ${uses.map((u) => u.where).join(", ")}`);
    err.code = "MEDIA_IN_USE";
    err.usage = uses;
    throw err;
  }
  await db.deleteFrom("media").where((eb) => eb.or([eb("id", "=", id), eb("parent_id", "=", id)])).execute();
  return { deleted: id, usage: uses };
}
