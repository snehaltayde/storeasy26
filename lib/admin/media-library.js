// The media screen's paged library (docs/plans/phase-2.md, "Line 5").
// SERVER-ONLY (imports db). Served by GET /api/admin/media?view=library and
// the media page; lib/media.js listMedia and the old GET shape (MediaPicker,
// MediaAdmin) stay as they are.
//
// listLibrary({ q, type, archived, sort, cursor, limit }) -> { items, nextCursor, counts }
//   q: matches the file name or the alt text (case-insensitive, literal)
//   type: png | jpeg | webp | gif | svg (one mime each), or "" for all
//   archived: "active" (the default) | "archived" ("only" in a query string)
//   sort: newest (default) | oldest | name | size (largest first)
//   cursor: the nextCursor of the page before; limit: 1..50 (default 50)
//   counts: { active, archived } under the same q and type, so the tabs
//     say where a search has matches
// Originals only; each item carries its thumb variant's address. Blobs are
// never selected: every address is mediaUrl(), so a file kept in R2
// (migration 0027, storage_url) shows the same way. A store without
// migration 0025 (no archived_at) lists everything as active.
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";
import { mediaUrl } from "../media.js";

export const LIBRARY_TYPES = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" });
export const LIBRARY_SORTS = Object.freeze(["newest", "oldest", "name", "size"]);
export const LIBRARY_TABS = Object.freeze(["active", "archived"]);
export const LIBRARY_PAGE = 50;
const Q_MAX = 200;

// column and direction per sort; id breaks ties in the same direction
const ORDER = { newest: ["created_at", "DESC"], oldest: ["created_at", "ASC"], name: ["filename", "ASC"], size: ["size", "DESC"] };

export class LibraryQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "LibraryQueryError";
    this.status = 400;
    this.code = "INVALID_QUERY";
  }
}
const BAD = "This search couldn't be read, so nothing was listed. Clear the search and try again.";

const encodeCursor = (sort, key, id) => Buffer.from(JSON.stringify([sort, key, id])).toString("base64url");
function decodeCursor(cursor, sort) {
  if (!cursor) return null;
  try {
    const [s, key, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (s === sort && typeof id === "string" && (typeof key === "string" || typeof key === "number")) return { key, id };
  } catch {
    // falls through to the refusal
  }
  throw new LibraryQueryError(BAD);
}

// Validated input from a query string (or the page's own call).
export function libraryQuery(params = {}) {
  const get = (k) => (typeof params.get === "function" ? params.get(k) : params[k]) ?? "";
  const q = String(get("q")).trim();
  const type = String(get("type"));
  // the query string says archived=only (the console's GET ?archived=include
  // is the old list's); a caller in code says "archived"
  const raw = String(get("archived") || "active");
  const archived = raw === "only" ? "archived" : raw;
  const sort = String(get("sort") || "newest");
  const cursor = String(get("cursor"));
  if (q.length > Q_MAX || (type && !Object.hasOwn(LIBRARY_TYPES, type)) || !LIBRARY_TABS.includes(archived) || !LIBRARY_SORTS.includes(sort)) throw new LibraryQueryError(BAD);
  return { q, type, archived, sort, cursor: cursor || null };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function filters({ q, type }) {
  const where = ["parent_id IS NULL"];
  const args = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push("(filename LIKE ? ESCAPE '\\' OR coalesce(alt, '') LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  if (type) {
    where.push("mime = ?");
    args.push(LIBRARY_TYPES[type]);
  }
  return { where, args };
}

async function query({ q, type, archived, sort, cursor, limit }, hasArchive) {
  const { where, args } = filters({ q, type });
  const base = { where: [...where], args: [...args] };
  if (hasArchive) base.where.push(archived === "archived" ? "archived_at IS NOT NULL" : "archived_at IS NULL");
  else if (archived === "archived") base.where.push("0");
  const [col, dir] = ORDER[sort];
  const after = decodeCursor(cursor, sort);
  const page = { where: [...base.where], args: [...base.args] };
  if (after) {
    const op = dir === "DESC" ? "<" : ">";
    page.where.push(`(${col} ${op} ? OR (${col} = ? AND id ${op} ?))`);
    page.args.push(after.key, after.key, after.id);
  }
  const cols = `id, filename, mime, size, width, height, alt, created_at${hasArchive ? ", archived_at" : ""}`;
  const rows = (
    await libsql.execute({
      sql: `SELECT ${cols} FROM media WHERE ${page.where.join(" AND ")} ORDER BY ${col} ${dir}, id ${dir} LIMIT ?`,
      args: [...page.args, limit + 1],
    })
  ).rows;
  const counted = (
    await libsql.execute({
      sql: hasArchive
        ? `SELECT sum(archived_at IS NULL) AS active, sum(archived_at IS NOT NULL) AS archived FROM media WHERE ${where.join(" AND ")}`
        : `SELECT count(*) AS active, 0 AS archived FROM media WHERE ${where.join(" AND ")}`,
      args,
    })
  ).rows[0];
  return { rows, counted };
}

export async function listLibrary(input = {}) {
  const { q, type, archived, sort, cursor } = libraryQuery(input);
  const limit = Math.min(LIBRARY_PAGE, Math.max(1, Number(input.limit) || LIBRARY_PAGE));
  let res;
  try {
    res = await query({ q, type, archived, sort, cursor, limit }, true);
  } catch (e) {
    if (!notMigratedYet(e, { table: "media", columns: ["archived_at"] }) || /no such table/i.test(String(e?.message))) throw e;
    res = await query({ q, type, archived, sort, cursor, limit }, false);
  }
  const more = res.rows.length > limit;
  const page = res.rows.slice(0, limit);
  const thumbs = new Map();
  if (page.length) {
    const ids = page.map((r) => String(r.id));
    const t = await libsql.execute({
      sql: `SELECT id, parent_id FROM media WHERE variant = 'thumb' AND parent_id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
      args: ids,
    });
    for (const r of t.rows) if (!thumbs.has(String(r.parent_id))) thumbs.set(String(r.parent_id), String(r.id));
  }
  const num = (v) => (v == null ? null : Number(v));
  const items = page.map((r) => {
    const id = String(r.id);
    return {
      id,
      filename: String(r.filename ?? ""),
      mime: String(r.mime ?? ""),
      size: Number(r.size ?? 0),
      width: num(r.width),
      height: num(r.height),
      alt: String(r.alt ?? ""),
      created_at: String(r.created_at ?? ""),
      archived_at: r.archived_at == null ? null : String(r.archived_at),
      url: mediaUrl(id),
      thumbUrl: thumbs.has(id) ? mediaUrl(thumbs.get(id)) : mediaUrl(id),
    };
  });
  const last = page[page.length - 1];
  const [col] = ORDER[sort];
  return {
    items,
    nextCursor: more && last ? encodeCursor(sort, col === "size" ? Number(last[col]) : String(last[col]), String(last.id)) : null,
    counts: { active: Number(res.counted?.active ?? 0), archived: Number(res.counted?.archived ?? 0) },
  };
}
