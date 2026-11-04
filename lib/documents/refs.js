// P3-COMMIT (PUB-04, PUB-03; spec 8.2, plan decision 2): what a published
// document version refers to, as document_refs rows (migration 0023). Pure
// and edge-safe: no node: imports and no database import. The statements are
// returned for the caller to run; reindexTenant (P4-MEDIA) runs on a client
// it is handed.
//
//   refRows(versionId, body)
//       -> [{ version_id, ref_type, ref_id }], unique, in a stable order.
//       From every section (registry refsOf) and from the document's own
//       settings (header and footer menus, the announcement link, the
//       collections page lists). ref_type is one of REF_TYPES:
//         document     a page link: the linked document's id when the link
//                      carries one (link.document), else
//                      "slug:<family>:<slug>" (slugKey). A plain url link to
//                      /about, /contact, /policies/x, /campaigns/x or
//                      /journal/x counts the same way.
//         collection   a collection link, picker or list entry, by handle
//         product      a product link, picker or list entry, by handle
//         media        an image's media id (P4-MEDIA: never the src)
//         bundle       P5-SETTING: a bundle chosen in a section (setting
//                      kinds bundle and bundle_list), by the bundle's id;
//                      and a url link to /bundles/<slug>, by its slug. So
//                      one bundle can have two rows: block refs are keyed
//                      by id, link refs by slug (a known limit: nothing
//                      joins the two, and a renamed slug is not followed)
//         quiz         a url link to /quiz/<x>
//         offer        no setting refers to an offer yet; kept in the list so
//                      the type is fixed when one does (COM-03)
//
//   slugKey(family, slug) -> "slug:<family>:<slug>"
//
// P4-MEDIA (MED-03, plan decision 6):
//   - media: ref_id is the media id (med_…), never the raw src. The src
//     /api/media/<id>, relative or absolute on any host, with or without a
//     query string, gives <id> (mediaIdOf). An image that isn't in the
//     library (another site's address) gives no row: there is no file of
//     ours to protect. A variant (thumb) is stored under its own id and
//     folded to its parent when usage is read (lib/media.js).
//   - images and links written inside rich text, FAQ answers and paragraphs
//     count (refsOfSetting with { text: true }).
//   - a regex belt over the whole canonical body adds every /api/media/<id>
//     the registry didn't see: an unknown section kind, a carried legacy
//     kind, a block, a field no setting declares. So the registry's media set
//     is always a subset of the belt's.
//
//   mediaIdOf(src)            "/api/media/med_x?w=400" -> "med_x", else null
//   mediaIdsIn(text)          every media id the belt finds in a text, unique,
//                             in order
//   refRowsForBody(documentId, versionId, body)
//                             refRows for a body given as an object or as its
//                             stored JSON text (a text that isn't JSON still
//                             gets the belt's rows). For CUTOVER's backfill
//                             and the reindex.
//   releaseRefRows(releaseRow)
//                             { id, content } -> the "release:<id>" media rows
//                             of an old release (a regex over its content)
//   RELEASE_PREFIX            "release:"
//   reindexTenant(client, { releases, dryRun })
//                             re-extracts every document_versions row into
//                             document_refs, rewrites media rows stored by src
//                             to the id form, and with releases writes the
//                             release:<id> rows of every releases row. Takes
//                             a @libsql/client (or anything with execute and
//                             batch); idempotent. scripts/reindex-document-
//                             refs.js is its command.
//
//   linkersStatement(documentId, slugKey)
//       -> one { sql, args }: the live documents whose published version
//       links to this document, by its id or by its slug key, as
//       [{ id, label }]. Joined on documents.published_version_id, so drafts,
//       earlier (superseded) versions, documents taken offline and archived
//       ones never count. The document itself is left out.
import { documentType, sectionType, stableStringify } from "../registry/index.js";
import { refsOfSetting } from "../registry/settings.js";

export const REF_TYPES = Object.freeze(["document", "collection", "product", "media", "bundle", "offer", "quiz"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() ? v : null);

export const slugKey = (family, slug) => `slug:${family}:${slug}`;

// A storefront path, as the document or catalog thing it opens.
function fromHref(href) {
  const h = str(href);
  if (!h || !h.startsWith("/")) return null;
  const path = h.split(/[?#]/, 1)[0];
  const m = /^\/([a-z]+)(?:\/([^/]+))?\/?$/.exec(path);
  if (!m) return null;
  const [, head, rest] = m;
  const tail = rest ? decodeSafe(rest) : null;
  if (!rest && (head === "about" || head === "contact")) return ["document", slugKey("page", head)];
  if (!tail) return null;
  switch (head) {
    case "policies":
      return ["document", slugKey("page", tail)];
    case "campaigns":
      return ["document", slugKey("campaign", tail)];
    case "journal":
      return ["document", slugKey("journal", tail)];
    case "collections":
      return ["collection", tail];
    case "products":
      return ["product", tail];
    case "bundles":
      return ["bundle", tail];
    case "quiz":
      return ["quiz", tail];
    default:
      return null;
  }
}
function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// One registry ref ({ field, ref, … }) as [ref_type, ref_id], or null.
function rowOf(r) {
  if (!isObj(r)) return null;
  switch (r.ref) {
    case "link":
      if (r.type === "page") {
        if (str(r.document)) return ["document", r.document];
        // the registry's ref leaves the family out; its href carries it
        // ("/policies/<slug>", "/campaigns/<slug>", "/journal/<slug>")
        if (str(r.slug) && str(r.family)) return ["document", slugKey(r.family, r.slug)];
        return fromHref(r.href);
      }
      if (r.type === "collection" || r.type === "product") return str(r.handle) ? [r.type, r.handle] : null;
      if (r.type === "url") return fromHref(r.href);
      return null;
    case "collection":
    case "product":
      return str(r.handle) ? [r.ref, r.handle] : null;
    // P5-SETTING: a bundle setting, by id (a /bundles/<slug> link stays
    // keyed by slug, through fromHref)
    case "bundle":
      return str(r.id) ? ["bundle", r.id] : null;
    case "media": {
      const id = mediaIdOf(r.src);
      return id ? ["media", id] : null;
    }
    default:
      return null;
  }
}

// ---- media ids (P4-MEDIA) ---------------------------------------------------------------

export const RELEASE_PREFIX = "release:";
const MEDIA_ID = "[A-Za-z0-9_-]{1,120}";
// a src: the path itself, or a full address on any host (http, https or //)
const MEDIA_SRC = new RegExp(`^(?:(?:https?:)?//[^/?#\\s]+)?/api/media/(${MEDIA_ID})`, "i");
const MEDIA_BELT = new RegExp(`/api/media/(${MEDIA_ID})`, "g");

export function mediaIdOf(src) {
  if (typeof src !== "string") return null;
  const m = MEDIA_SRC.exec(src.trim());
  return m ? m[1] : null;
}

export function mediaIdsIn(text) {
  if (typeof text !== "string" || !text.includes("/api/media/")) return [];
  const out = new Set();
  for (const m of text.matchAll(MEDIA_BELT)) out.add(m[1]);
  return [...out];
}

// What a section refers to, with text refs: the registry's refsOf with
// { text: true } on every declared setting, plus the kind's own refs.
function sectionRefs(section) {
  const d = sectionType(section?.kind);
  if (!d) return [];
  const settings = isObj(section.settings) ? section.settings : {};
  const out = [];
  for (const s of d.settings) out.push(...refsOfSetting(s, settings[s.key], s.key, { text: true }));
  for (const extra of d.refs(section) || []) out.push(extra);
  return out;
}

const byRow = (a, b) => (a.ref_type < b.ref_type ? -1 : a.ref_type > b.ref_type ? 1 : a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0);

function rowsOf(versionId, pairs) {
  const seen = new Set();
  const out = [];
  for (const row of pairs) {
    if (!row || !REF_TYPES.includes(row[0])) continue;
    const key = `${row[0]}\u0000${row[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ version_id: versionId, ref_type: row[0], ref_id: String(row[1]) });
  }
  return out.sort(byRow);
}

export function refRows(versionId, body) {
  if (typeof versionId !== "string" || !versionId) throw new Error("refRows: a version id is needed");
  if (!isObj(body)) return [];
  const found = [];
  for (const s of Array.isArray(body.sections) ? body.sections : []) if (isObj(s)) found.push(...sectionRefs(s));
  const t = documentType(body.type);
  const settings = isObj(body.settings) ? body.settings : {};
  for (const s of t?.settings || []) found.push(...refsOfSetting(s, settings[s.key], s.key, { text: true }));
  const pairs = found.map(rowOf);
  // the belt: every /api/media/<id> anywhere in the body
  for (const id of mediaIdsIn(stableStringify(body))) pairs.push(["media", id]);
  return rowsOf(versionId, pairs);
}

export function refRowsForBody(documentId, versionId, body) {
  if (typeof documentId !== "string" || !documentId) throw new Error("refRowsForBody: a document id is needed");
  if (typeof versionId !== "string" || !versionId) throw new Error("refRowsForBody: a version id is needed");
  if (typeof body !== "string") return refRows(versionId, body);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (isObj(parsed)) return refRows(versionId, parsed);
  return rowsOf(versionId, mediaIdsIn(body).map((id) => ["media", id]));
}

export function releaseRefRows(releaseRow) {
  const id = releaseRow?.id;
  if (typeof id !== "string" || !id) throw new Error("releaseRefRows: a release id is needed");
  const content = releaseRow.content == null ? "" : typeof releaseRow.content === "string" ? releaseRow.content : String(releaseRow.content);
  return rowsOf(`${RELEASE_PREFIX}${id}`, mediaIdsIn(content).map((m) => ["media", m]));
}

// ---- the reindex (P4-MEDIA) ------------------------------------------------------------

const CHUNK = 200;
const marks = (n) => Array.from({ length: n }, () => "?").join(", ");
const keyOf = (r) => `${r.version_id}\u0000${r.ref_type}\u0000${r.ref_id}`;

// INSERT … ON CONFLICT DO NOTHING, never INSERT OR IGNORE (commit.js): only a
// repeated key is absorbed, a broken row still fails.
export function refInsertStatements(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    out.push({
      sql: `INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`,
      args: chunk.flatMap((r) => [r.version_id, r.ref_type, r.ref_id]),
    });
  }
  return out;
}

async function existingRefs(client, versionIds) {
  if (!versionIds.length) return [];
  const r = await client.execute({ sql: `SELECT version_id, ref_type, ref_id FROM document_refs WHERE version_id IN (${marks(versionIds.length)})`, args: versionIds });
  return r.rows.map((x) => ({ version_id: String(x.version_id), ref_type: String(x.ref_type), ref_id: String(x.ref_id) }));
}

// One chunk: the wanted rows of these owners against what is stored. A media
// row stored by its src (an id never holds "/") is replaced by the id form.
async function syncChunk(client, ownerIds, wanted, dryRun, report) {
  const have = await existingRefs(client, ownerIds);
  const srcForm = have.filter((r) => r.ref_type === "media" && r.ref_id.includes("/"));
  const kept = new Set(have.filter((r) => !srcForm.includes(r)).map(keyOf));
  const missing = wanted.filter((r) => !kept.has(keyOf(r)));
  report.rewritten += srcForm.length;
  report.added += missing.length;
  if (dryRun || (!srcForm.length && !missing.length)) return;
  const stmts = [];
  if (srcForm.length) {
    stmts.push({
      sql: `DELETE FROM document_refs WHERE ref_type = 'media' AND instr(ref_id, '/') > 0 AND version_id IN (${marks(ownerIds.length)})`,
      args: ownerIds,
    });
  }
  stmts.push(...refInsertStatements(missing));
  await client.batch(stmts, "write");
}

export async function reindexTenant(client, { releases = false, dryRun = false } = {}) {
  if (!client || typeof client.execute !== "function" || typeof client.batch !== "function") throw new Error("reindexTenant: a database client is needed");
  const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('document_refs', 'document_versions', 'releases')");
  const tables = new Set(t.rows.map((r) => String(r.name)));
  if (!tables.has("document_refs")) {
    const e = new Error("This store's database is missing the reference table (migration 0023). Run the tenant migrations first.");
    e.code = "REFS_TABLE_MISSING";
    throw e;
  }
  const report = { dryRun: !!dryRun, versions: 0, releases: 0, added: 0, rewritten: 0 };
  if (tables.has("document_versions")) {
    for (let after = -1; ; ) {
      const r = await client.execute({ sql: "SELECT rowid AS rid, id, document_id, body FROM document_versions WHERE rowid > ? ORDER BY rowid LIMIT ?", args: [after, CHUNK] });
      if (!r.rows.length) break;
      const ids = [];
      const wanted = [];
      for (const v of r.rows) {
        ids.push(String(v.id));
        wanted.push(...refRowsForBody(String(v.document_id), String(v.id), v.body == null ? "" : String(v.body)));
      }
      await syncChunk(client, ids, wanted, dryRun, report);
      report.versions += r.rows.length;
      after = Number(r.rows[r.rows.length - 1].rid);
    }
  }
  if (releases && tables.has("releases")) {
    for (let after = -1; ; ) {
      const r = await client.execute({ sql: "SELECT rowid AS rid, id, content FROM releases WHERE rowid > ? ORDER BY rowid LIMIT ?", args: [after, CHUNK] });
      if (!r.rows.length) break;
      const owners = [];
      const wanted = [];
      for (const rel of r.rows) {
        owners.push(`${RELEASE_PREFIX}${String(rel.id)}`);
        wanted.push(...releaseRefRows({ id: String(rel.id), content: rel.content == null ? "" : String(rel.content) }));
      }
      await syncChunk(client, owners, wanted, dryRun, report);
      report.releases += r.rows.length;
      after = Number(r.rows[r.rows.length - 1].rid);
    }
  }
  return report;
}

export function linkersStatement(documentId, key = null) {
  if (typeof documentId !== "string" || !documentId) throw new Error("linkersStatement: a document id is needed");
  return {
    sql:
      "SELECT DISTINCT d.id AS id, d.label AS label FROM document_refs r JOIN documents d ON r.version_id = d.published_version_id " +
      "WHERE r.ref_type = 'document' AND r.ref_id IN (?, ?) AND d.id <> ? AND d.archived_at IS NULL ORDER BY d.label, d.id",
    args: [documentId, key ?? documentId, documentId],
  };
}
