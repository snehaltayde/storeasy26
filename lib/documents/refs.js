// P3-COMMIT (PUB-04, PUB-03; spec 8.2, plan decision 2): what a published
// document version refers to, as document_refs rows (migration 0023). Pure
// and edge-safe: no node: imports, no database call (the one statement is
// returned for the caller to run).
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
//         media        an image's media src
//         bundle, quiz a url link to /bundles/<x> or /quiz/<x>
//         offer        no setting refers to an offer yet; kept in the list so
//                      the type is fixed when one does (COM-03)
//
//   slugKey(family, slug) -> "slug:<family>:<slug>"
//
//   linkersStatement(documentId, slugKey)
//       -> one { sql, args }: the live documents whose published version
//       links to this document, by its id or by its slug key, as
//       [{ id, label }]. Joined on documents.published_version_id, so drafts,
//       earlier (superseded) versions, documents taken offline and archived
//       ones never count. The document itself is left out.
import { documentType, refsOf } from "../registry/index.js";
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
    case "media":
      return str(r.src) ? ["media", r.src] : null;
    default:
      return null;
  }
}

export function refRows(versionId, body) {
  if (typeof versionId !== "string" || !versionId) throw new Error("refRows: a version id is needed");
  if (!isObj(body)) return [];
  const found = [];
  for (const s of Array.isArray(body.sections) ? body.sections : []) if (isObj(s)) found.push(...refsOf(s));
  const t = documentType(body.type);
  const settings = isObj(body.settings) ? body.settings : {};
  for (const s of t?.settings || []) found.push(...refsOfSetting(s, settings[s.key]));
  const seen = new Set();
  const out = [];
  for (const r of found) {
    const row = rowOf(r);
    if (!row || !REF_TYPES.includes(row[0])) continue;
    const key = `${row[0]}\u0000${row[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ version_id: versionId, ref_type: row[0], ref_id: String(row[1]) });
  }
  out.sort((a, b) => (a.ref_type < b.ref_type ? -1 : a.ref_type > b.ref_type ? 1 : a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0));
  return out;
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
