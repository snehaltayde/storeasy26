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
//
// P4-MEDIA (MED-03, plan decision 6):
//   - Usage on a store in documents mode reads the reference index
//     (document_refs, migration 0023) joined to document_versions, so a ref
//     of a checkpoint the prune removed never counts; plus a live scan of
//     every working draft (documents.draft), the brand and site settings, and
//     the release:<id> rows the cutover (or the reindex) wrote for old
//     releases. It never runs instr() over document_versions.body or
//     releases.content. A variant (thumb) counts for its original. A store in
//     documents mode without 0023 falls back to the full scan below. Every
//     other store keeps today's scan, unchanged (legacyMediaUsage).
//   - The documents path fails closed: any read it can't do throws, so a
//     delete never goes through on a scan that didn't run. The legacy scan
//     keeps its "pre-migration" catch blocks exactly as they were
//     (MANUAL-CHECKS "mediaUsage swallows read failures": the default
//     decision, recorded in docs/cms-reviews/P4-MEDIA.md).
//   - Delete: refused while the store is being moved to the new editor
//     (cms_state 'migrating'), forced or not, so nothing the move indexed
//     disappears before it finishes. In documents mode a file anything uses
//     is never deleted, forced or not. In legacy mode force keeps today's
//     meaning. The DELETE itself re-checks the mode (and in documents mode
//     the index and the drafts), so a move or a publish that lands between
//     the check and the delete deletes nothing.
//   - Archive (migration 0025, media.archived_at): archiveMedia /
//     unarchiveMedia. listMedia hides archived files unless asked;
//     /api/media/<id> (getMediaFile) still serves them, so nothing on the
//     store breaks. Every read and write here works on a store without the
//     column; archiving there is refused in plain words.
import { db, libsql } from "./db.js";
import { notMigratedYet } from "./schema-shape.js";
import { getCmsMode } from "./cms-mode.js";
import { tenantCfg } from "./tenant-context.js";
import { mediaIdsIn, RELEASE_PREFIX } from "./documents/refs.js";

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
  if (existing) {
    // P4-MEDIA: uploading an archived file again brings it back to the library
    await unarchiveQuietly(existing.id);
    return { ...existing, deduped: true };
  }

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
// P4-MEDIA: archived originals (and their variants) are left out unless
// includeArchived; each row then carries archived_at. A store without
// migration 0025 lists exactly as before.
const LIST_COLS = ["id", "filename", "mime", "size", "width", "height", "alt", "variant", "parent_id", "created_at"];
export async function listMedia({ includeArchived = false } = {}) {
  let rows;
  try {
    rows = await db
      .selectFrom("media")
      .select([...LIST_COLS, "archived_at"])
      .orderBy("created_at", "desc")
      .execute();
    if (!includeArchived) rows = rows.filter((r) => r.archived_at == null);
  } catch (e) {
    if (!notMigratedYet(e, { table: "media", columns: ["archived_at"] }) || /no such table/i.test(String(e?.message))) throw e;
    rows = await db.selectFrom("media").select(LIST_COLS).orderBy("created_at", "desc").execute();
  }
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

// ---- archive (P4-MEDIA, migration 0025) ----------------------------------------

export const ARCHIVE_UNAVAILABLE_MESSAGE = "Archiving files isn't available for your store yet, so nothing changed. Try again after your store's next update.";
export const MEDIA_GONE_MESSAGE = "This file is no longer in your library. Reload to see your files.";

class MediaError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "MediaError";
    this.status = status;
    this.code = code;
    this.expose = true;
    Object.assign(this, extra);
  }
}

async function setArchived(id, archived) {
  const at = archived ? new Date().toISOString() : null;
  let r;
  try {
    r = await libsql.execute({ sql: "UPDATE media SET archived_at = ? WHERE id = ?", args: [at, String(id ?? "")] });
  } catch (e) {
    if (notMigratedYet(e, { table: "media", columns: ["archived_at"] }) && !/no such table/i.test(String(e?.message))) {
      throw new MediaError(409, "MEDIA_ARCHIVE_UNAVAILABLE", ARCHIVE_UNAVAILABLE_MESSAGE);
    }
    throw e;
  }
  if (Number(r.rowsAffected ?? 0) === 0) throw new MediaError(404, "MEDIA_NOT_FOUND", MEDIA_GONE_MESSAGE);
  return { id: String(id), archived_at: at };
}
export const archiveMedia = (id) => setArchived(id, true);
export const unarchiveMedia = (id) => setArchived(id, false);

// An upload that dedupes onto an archived file brings it back. A store
// without 0025 has nothing archived: that is not a failure.
async function unarchiveQuietly(id) {
  try {
    await libsql.execute({ sql: "UPDATE media SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL", args: [id] });
  } catch (e) {
    if (!notMigratedYet(e, { table: "media", columns: ["archived_at"] })) throw e;
  }
}

// ---- usage references (safe delete) ------------------------------------------

// Where is /api/media/<id> referenced? Scanned surfaces: draft blocks, draft
// pages, the LIVE release snapshot, and the tenant's brand/site config strings.
// Historical (non-live) releases are immutable and may reference deleted media
// — a rollback to one then shows broken images; the console warns about that.
// S53 (0B-2): the scan covers the asset AND its derivatives, in drafts,
// product-module HTML, and EVERY retained release (scheduled + historical) —
// deleting an image a rollback target still referenced used to leave that
// release broken, and derivative URLs were never searched at all.
export async function mediaUsage(id) {
  return (await usageOf(id, await getCmsMode())).uses;
}

// { uses, path: "documents" | "scan", ids }: which reader answered, and the
// ids it looked for (the file and its variants; documents path only).
async function usageOf(id, mode) {
  if (mode === "documents") {
    const r = await documentsModeUsage(id);
    if (r) return { uses: r.uses, path: "documents", ids: r.ids };
  }
  return { uses: await legacyMediaUsage(id), path: "scan", ids: null };
}

// Today's scan, unchanged (P4-MEDIA): legacy stores, stores being moved, and
// documents stores without migration 0023.
async function legacyMediaUsage(id) {
  const needles = [mediaUrl(id)];
  try {
    const variants = await db.selectFrom("media").select("id").where("parent_id", "=", id).execute();
    for (const v of variants) needles.push(mediaUrl(v.id));
  } catch { /* pre-migration */ }
  const hit = (s) => needles.some((n) => String(s).includes(n));
  const uses = [];
  try {
    const blocks = await db.selectFrom("cms_blocks").select(["key", "value"]).execute();
    for (const b of blocks) if (hit(b.value)) uses.push({ where: `block:${b.key}` });
  } catch { /* pre-migration */ }
  try {
    const pages = await db.selectFrom("cms_pages").select(["slug", "sections"]).execute();
    for (const p of pages) if (hit(p.sections)) uses.push({ where: `page:${p.slug}` });
  } catch { /* pre-migration */ }
  try {
    const overrides = await db.selectFrom("product_overrides").select(["product_id", "modules"]).execute();
    for (const o of overrides) if (hit(o.modules)) uses.push({ where: `product modules:${o.product_id}` });
  } catch { /* pre-migration */ }
  try {
    const state = await db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst();
    const releases = await db.selectFrom("releases").select(["id", "content", "scheduled_for", "published_at"]).execute();
    for (const rel of releases) {
      if (!hit(rel.content)) continue;
      const label =
        rel.id === state?.live_release_id
          ? `live release:${rel.id}`
          : rel.scheduled_for && !rel.published_at
            ? `scheduled release:${rel.id}`
            : `retained release:${rel.id}`;
      uses.push({ where: label });
    }
  } catch { /* pre-migration */ }
  uses.push(...(await documentMediaUsage(needles)));
  return uses;
}

// P2-DOCS: documents mode keeps content in documents.draft and in
// document_versions.body, so the scan reads both. Each document is reported
// once per label:
//   "draft"          its working draft uses the image (archived documents are
//                    left out: their draft can't be edited or published)
//   "live"           the version shoppers see now (documents.published_version_id)
//   "older version"  any other kept version: a checkpoint, an Undo-saved,
//                    migrated or earlier published version, which Restore can
//                    bring back
// A store from before migration 0021 has neither table and reports nothing
// here. Any other read failure throws, so a delete is never let through on a
// scan that didn't run.
async function documentMediaUsage(needles) {
  const any = (col) => needles.map(() => `instr(${col}, ?) > 0`).join(" OR ");
  const uses = [];
  const seen = new Set();
  const add = (label, documentId, name, versionId = null) => {
    const key = `${label}:${documentId}`;
    if (seen.has(key)) return;
    seen.add(key);
    uses.push({ where: `${label}:${documentId}`, label, document: documentId, name, ...(versionId ? { version: versionId } : {}) });
  };
  let drafts;
  let versions;
  try {
    drafts = await libsql.execute({ sql: `SELECT id, label FROM documents WHERE archived_at IS NULL AND (${any("draft")}) ORDER BY id`, args: needles });
    versions = await libsql.execute({
      sql:
        "SELECT v.id AS id, v.document_id AS document_id, d.label AS label, (v.id = d.published_version_id) AS live FROM document_versions v " +
        `LEFT JOIN documents d ON d.id = v.document_id WHERE (${any("v.body")}) ORDER BY v.document_id, v.created_at DESC`,
      args: needles,
    });
  } catch (e) {
    if (notMigratedYet(e, { table: "documents" }) || notMigratedYet(e, { table: "document_versions" })) return [];
    throw e;
  }
  for (const r of drafts.rows) add("draft", String(r.id), String(r.label));
  for (const r of versions.rows) add(Number(r.live) === 1 ? "live" : "older version", String(r.document_id), r.label == null ? null : String(r.label), String(r.id));
  return uses;
}

// ---- documents mode (P4-MEDIA) ---------------------------------------------------

const marks = (n) => Array.from({ length: n }, () => "?").join(", ");
const releaseLabel = (rel, liveId) => (rel.id === liveId ? `live release:${rel.id}` : rel.scheduled_for && !rel.published_at ? `scheduled release:${rel.id}` : `retained release:${rel.id}`);
// the brand and site settings, as the store's own config holds them
export const CONFIG_USES = Object.freeze({ brand: "brand settings", site: "store settings" });

// null when the store has no document_refs table (before 0023): the caller
// falls back to the full scan. Every other failure throws.
async function documentsModeUsage(id) {
  const variants = await libsql.execute({ sql: "SELECT id FROM media WHERE parent_id = ?", args: [id] });
  const ids = [id, ...variants.rows.map((r) => String(r.id))];
  const needles = ids.map(mediaUrl);
  const inIds = marks(ids.length);
  let versions;
  try {
    versions = await libsql.execute({
      sql:
        "SELECT v.id AS id, v.document_id AS document_id, d.label AS label, (v.id = d.published_version_id) AS live FROM document_refs r " +
        "JOIN document_versions v ON v.id = r.version_id LEFT JOIN documents d ON d.id = v.document_id " +
        `WHERE r.ref_type = 'media' AND r.ref_id IN (${inIds}) GROUP BY v.id ORDER BY v.document_id, v.created_at DESC`,
      args: ids,
    });
  } catch (e) {
    if (notMigratedYet(e, { table: "document_refs" })) return null;
    throw e;
  }
  const uses = [];
  const seen = new Set();
  const add = (label, documentId, name, versionId = null) => {
    const key = `${label}:${documentId}`;
    if (seen.has(key)) return;
    seen.add(key);
    uses.push({ where: `${label}:${documentId}`, label, document: documentId, name, ...(versionId ? { version: versionId } : {}) });
  };
  // the working drafts, read live (one row per document)
  const any = needles.map(() => "instr(draft, ?) > 0").join(" OR ");
  const drafts = await libsql.execute({ sql: `SELECT id, label FROM documents WHERE archived_at IS NULL AND (${any}) ORDER BY id`, args: needles });
  for (const r of drafts.rows) add("draft", String(r.id), String(r.label));
  for (const r of versions.rows) add(Number(r.live) === 1 ? "live" : "older version", String(r.document_id), r.label == null ? null : String(r.label), String(r.id));
  // old releases, through their release:<id> rows (never their content)
  const rels = await libsql.execute({
    sql:
      "SELECT DISTINCT rel.id AS id, rel.scheduled_for AS scheduled_for, rel.published_at AS published_at, rel.created_at AS created_at, " +
      "(SELECT live_release_id FROM release_state WHERE id = 1) AS live_id FROM document_refs r JOIN releases rel ON rel.id = substr(r.version_id, ?) " +
      `WHERE substr(r.version_id, 1, ?) = ? AND r.ref_type = 'media' AND r.ref_id IN (${inIds}) ORDER BY rel.created_at, rel.id`,
    args: [RELEASE_PREFIX.length + 1, RELEASE_PREFIX.length, RELEASE_PREFIX, ...ids],
  });
  for (const r of rels.rows) uses.push({ where: releaseLabel({ id: String(r.id), scheduled_for: r.scheduled_for, published_at: r.published_at }, r.live_id == null ? null : String(r.live_id)), release: String(r.id) });
  // the store's brand and site settings, read live
  const want = new Set(ids);
  for (const [key, words] of Object.entries(CONFIG_USES)) {
    const v = tenantCfg(key, null, null);
    if (v == null) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (mediaIdsIn(text).some((m) => want.has(m))) uses.push({ where: words, config: key });
  }
  return { uses, ids };
}

// ---- delete -------------------------------------------------------------------------

export const MIGRATING_MESSAGE = "Your store is being updated to the new editor right now, so this file wasn't deleted. Try again once the update is done.";

const usedByWords = (uses) => {
  const parts = [];
  for (const u of uses) {
    if (u.document) parts.push(`${u.name || "a page"} (${u.label})`);
    else if (u.release) parts.push("an earlier published version of your store");
    else if (u.config) parts.push(`your ${u.where}`);
  }
  return [...new Set(parts)].join(", ");
};

function inUseError(uses, path) {
  const message = path === "documents" ? `This file is still used by ${usedByWords(uses)}, so it wasn't deleted. Remove it from there first.` : `still referenced by ${uses.map((u) => (u.document ? `${u.name || "a page"} (${u.label})` : u.where)).join(", ")}`;
  const err = new Error(message);
  err.code = "MEDIA_IN_USE";
  err.usage = uses;
  return err;
}
const migratingError = () => new MediaError(409, "STORE_MIGRATING", MIGRATING_MESSAGE);

// The DELETE, guarded inside its own statement: the mode must still be the
// one the usage was read under, and in documents mode nothing indexed and no
// draft may use the file by then. A store from before 0021 (no cms_state)
// deletes as it always did.
async function guardedDelete(id, mode, usage) {
  const where = ["(id = ? OR parent_id = ?)", "coalesce((SELECT mode FROM cms_state WHERE id = 1), 'legacy') = ?"];
  const args = [id, id, mode];
  if (usage.path === "documents") {
    const inIds = marks(usage.ids.length);
    where.push(`NOT EXISTS (SELECT 1 FROM document_refs r JOIN document_versions v ON v.id = r.version_id WHERE r.ref_type = 'media' AND r.ref_id IN (${inIds}))`);
    args.push(...usage.ids);
    where.push(`NOT EXISTS (SELECT 1 FROM document_refs r JOIN releases rel ON rel.id = substr(r.version_id, ?) WHERE substr(r.version_id, 1, ?) = ? AND r.ref_type = 'media' AND r.ref_id IN (${inIds}))`);
    args.push(RELEASE_PREFIX.length + 1, RELEASE_PREFIX.length, RELEASE_PREFIX, ...usage.ids);
    const needles = usage.ids.map(mediaUrl);
    where.push(`NOT EXISTS (SELECT 1 FROM documents WHERE archived_at IS NULL AND (${needles.map(() => "instr(draft, ?) > 0").join(" OR ")}))`);
    args.push(...needles);
  }
  try {
    const r = await libsql.execute({ sql: `DELETE FROM media WHERE ${where.join(" AND ")}`, args });
    return Number(r.rowsAffected ?? 0);
  } catch (e) {
    if (usage.path !== "documents" && notMigratedYet(e, { table: "cms_state" })) {
      await db.deleteFrom("media").where((eb) => eb.or([eb("id", "=", id), eb("parent_id", "=", id)])).execute();
      return null;
    }
    throw e;
  }
}

// Delete an original and its variants. Refuses while referenced unless forced.
// A use in a document (draft, live or older version) refuses even when forced:
// versions are frozen, so the image would stay missing on that page for good.
// P4-MEDIA: in documents mode every use refuses, forced or not (a retained
// version, a draft, the brand or site settings, an old release); while the
// store is being moved every delete refuses.
export async function deleteMedia(id, { force = false } = {}) {
  // a second try only when the mode moved between the check and the DELETE
  for (let attempt = 1; ; attempt++) {
    const mode = await getCmsMode();
    if (mode === "migrating") throw migratingError();
    const usage = await usageOf(id, mode);
    const uses = usage.uses;
    const inDocuments = uses.some((u) => u.document);
    const refused = usage.path === "documents" ? uses.length > 0 : uses.length && (!force || inDocuments);
    if (refused) throw inUseError(uses, usage.path);
    const n = await guardedDelete(id, mode, usage);
    if (n !== 0) return { deleted: id, usage: uses };
    // nothing deleted: the file was already gone (as before: answered as
    // deleted), or the guard held
    const still = await libsql.execute({ sql: "SELECT count(*) AS n FROM media WHERE id = ? OR parent_id = ?", args: [id, id] });
    if (Number(still.rows[0]?.n ?? 0) === 0) return { deleted: id, usage: uses };
    const now = await getCmsMode();
    if (now === "migrating") throw migratingError();
    if (now === mode || attempt >= 2) {
      const again = await usageOf(id, now);
      if (again.uses.length) throw inUseError(again.uses, again.path);
      if (attempt >= 2) throw new MediaError(409, "MEDIA_CHANGED", "This file changed while it was being deleted, so it wasn't deleted. Try again.");
    }
  }
}
