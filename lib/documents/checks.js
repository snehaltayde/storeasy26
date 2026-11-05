// P3-CHECKS (PUB-03, PUB-05): the reference checks of a publish, and the
// words and actions every publish issue carries. Node console routes only
// (it reads the store's tables); the decoration part is pure.
//
//   referenceChecks({ items, list, journalBody })
//     -> { issues, targets: Map(issue -> {id, revision, draftHash, label}),
//          setBreaks: Set(issue) a section's link block whose page is in the
//          set, which classify() never inherits (P3-FIX3) }
//     items        [{ doc, body }]: the set's own documents and their
//                  validated bodies. ONLY these bodies are read: a problem in
//                  another document never blocks this one (PUB-03).
//     list         the live list M. The checks look at M2, M with the set
//                  applied: the set's own rows and slugs replace its
//                  documents' rows.
//     journalBody  async () -> the live journal index body (read only when a
//                  link or a redirect needs it)
//   Reads, each only when needed and each at most one statement:
//     documents    id, type, slug, label, revision, draft_hash, archived_at,
//                  published_version_id of the documents a link names that are
//                  not live in M2. Never a draft body.
//     collections  by handle, with the count of products in stock
//     products     by handle, with available
//     media        by id (/api/media/<id>)
//   What it reports:
//     blocks  a hand-placed link (a page link, or a url to /policies/<slug>,
//             /campaigns/<slug> or /journal/<slug>) to a page that is missing
//             or hidden from shoppers; a link to a collection or product that
//             is not in the store; a redirect_from equal to the page's own
//             address or one that sends shoppers round in a circle.
//             A link to an existing, non-archived document that isn't live
//             (never published, or taken offline) is LINKS_TO_UNPUBLISHED: it
//             blocks, and its target is offered to publish with this set.
//     warns   a deleted or sold-out product in a list; a product rail whose
//             collection is missing or has nothing in stock; an image whose
//             media row is gone (shoppers see the colour block); an old
//             address that a live page already uses (the page wins).
//   A code-default page slug (the brand store's own policy pages, while the
//   list still uses the code defaults) is a page: a link to it passes.
//   P3-FIX2: addresses are read the way the storefront reads them. A link
//   chosen by document id is built from the slug it stores, so a page
//   renamed since blocks (LINK_TARGET_MISSING, naming the new address)
//   unless its old address forwards to it. Only /journal/<slug> follows an
//   old address, and only when no page row or post (hidden or offline ones
//   included) holds that slug; a link to such a forwarded address passes.
//   Every row holds its slug for REDIRECT_SHADOWED, a hidden one included,
//   which leaves REDIRECT_LOOP unreachable today (kept as a guard). A link
//   block in a document's own settings (a menu item, the announcement bar's
//   link) whose link was already live is inherited (a warning), unless the
//   page it goes to is in the same set (the set may be what hides or renames
//   it): then it blocks. Its words name the menu or the bar (linkLead).
//
//   P5-CHECKS (COM-01, PUB-03): bundles picked in a section's settings (a
//   `bundle` setting, or an entry of a `bundle_list`). They never block.
//   One read, lib/commerce/bundle-read.js bundlesByIds (at most 3
//   statements for any number of bundles), and none when the set holds no
//   bundle. Words from lib/commerce/bundle-words.js, money in the bundle's
//   own currency.
//     BUNDLE_MISSING      the bundle was deleted
//     BUNDLE_DISABLED     it is turned off
//     BUNDLE_UNAVAILABLE  sold out, no saving, or not ready for the cart
//     BUNDLE_OVERLAP      an available bundle shares a product with another
//                         turned-on bundle (the cart may give another saving);
//                         never for a bundle that already has one of the above
//   The first three offer Remove (removeSection for a card, removeItem for
//   that one grid entry); the overlap only opens the field. A bundles read
//   that fails is logged and left out, like every other read here: it never
//   reports a bundle as deleted. /bundles/<slug> links are not checked.
//
//   P4-ED05 (D2): inherits a banner on a page, campaign or journal post
//             (SECTION_NOT_SHOWN, "Banners don't show on this kind of page
//             yet."): those routes don't render it; Remove is offered.
//
//   relevel(issues)   publish-mode adjustments of the validator's issues: a
//                     missing alt text only warns (PUB-03 "Warns: missing alt
//                     text"); the validator calls it REQUIRED in a draft.
//   decorate(issue, { body, target })
//                     the issue plus level ("blocks" | "warns" | "inherited"),
//                     anchor (fieldAnchor), where (issue-words) and actions:
//                       hideSection   {documentId, sectionId}   a block in a section
//                       removeSection {documentId, sectionId}   a structure block
//                                     in a section, or a reference warning
//                       removeItem    {documentId, sectionId?, field, index}
//                                     an entry of a list (a product, a menu
//                                     item, an old address)
//                       publishBoth   {documentId}              the unpublished
//                                     target of a link
//                       openField     {documentId, sectionId?, field?}
//                                     go to the field (when nothing else fits)
//                     Every issue has at least one action.
import { libsql } from "../db.js";
import { slog } from "../log.js";
import { issue } from "../cms/issues.js";
import { tenantId } from "../tenant-context.js";
import { isBrandTenant } from "../brand-tenants.js";
import { PAGES } from "../content/pages.js";
import { documentType, sectionType, refsOf, where, fieldAnchor } from "../registry/index.js";
import { refsOfSetting } from "../registry/settings.js";
import { notShownNotes, SECTION_NOT_SHOWN } from "../registry/sections.js";
import { issueClass, STRUCTURE } from "../registry/validate.js";
import { journalEntriesOf } from "./journal-index.js";
import { pageRow, redirectsOf } from "./build.js";
import { bundlesByIds } from "../commerce/bundle-read.js";
import { stateLine, overlapLine } from "../commerce/bundle-words.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const q = (s) => `“${s}”`;

// ---- codes ---------------------------------------------------------------------------

export const LINKS_TO_UNPUBLISHED = "LINKS_TO_UNPUBLISHED";
// Blocks.
export const LINK_TARGET_MISSING = "LINK_TARGET_MISSING";
export const LINK_TARGET_HIDDEN = "LINK_TARGET_HIDDEN";
export const LINK_COLLECTION_MISSING = "LINK_COLLECTION_MISSING";
export const LINK_PRODUCT_MISSING = "LINK_PRODUCT_MISSING";
export const REDIRECT_SELF = "REDIRECT_SELF";
export const REDIRECT_LOOP = "REDIRECT_LOOP";
// Warns.
export const COLLECTION_MISSING = "COLLECTION_MISSING";
export const COLLECTION_EMPTY = "COLLECTION_EMPTY";
export const PRODUCT_MISSING = "PRODUCT_MISSING";
export const PRODUCT_UNAVAILABLE = "PRODUCT_UNAVAILABLE";
export const MEDIA_MISSING = "MEDIA_MISSING";
export const REDIRECT_SHADOWED = "REDIRECT_SHADOWED";
// P5-CHECKS: bundles (warns, never blocks)
export const BUNDLE_MISSING = "BUNDLE_MISSING";
export const BUNDLE_DISABLED = "BUNDLE_DISABLED";
export const BUNDLE_UNAVAILABLE = "BUNDLE_UNAVAILABLE";
export const BUNDLE_OVERLAP = "BUNDLE_OVERLAP";

// Reference warnings that "Remove it" fixes (removeItem or removeSection).
const REMOVABLE_WARNINGS = new Set([COLLECTION_MISSING, COLLECTION_EMPTY, PRODUCT_MISSING, PRODUCT_UNAVAILABLE, MEDIA_MISSING, REDIRECT_SHADOWED, SECTION_NOT_SHOWN, BUNDLE_MISSING, BUNDLE_DISABLED, BUNDLE_UNAVAILABLE]);
// Blocks whose fix may be removing one entry of a list (a menu item, an old address).
const REMOVABLE_BLOCKS = new Set([LINK_TARGET_MISSING, LINK_TARGET_HIDDEN, LINK_COLLECTION_MISSING, LINK_PRODUCT_MISSING, LINKS_TO_UNPUBLISHED, REDIRECT_SELF, REDIRECT_LOOP]);

// ---- links -----------------------------------------------------------------------------

const FAMILY_OF_PREFIX = { policies: "page", campaigns: "campaign", journal: "journal" };
const PREFIX_OF_FAMILY = { page: "/policies/", campaign: "/campaigns/", journal: "/journal/" };

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// What a link ref points at: { page: {family, slug, document?} } or
// { catalog: "collection" | "product", handle } or null (nothing we check:
// an anchor, /collections, /search, a bundle).
export function linkTarget(r) {
  if (!isObj(r) || r.ref !== "link") return null;
  if (r.type === "collection" || r.type === "product") return typeof r.handle === "string" && r.handle ? { catalog: r.type, handle: r.handle } : null;
  if (r.type !== "page" && r.type !== "url") return null;
  const href = typeof r.href === "string" ? r.href : "";
  const path = href.split(/[?#]/, 1)[0];
  const m = /^\/(policies|campaigns|journal)\/([^/]+)\/?$/.exec(path);
  if (r.type === "page") {
    const document = typeof r.document === "string" && r.document ? r.document : null;
    if (m) return { page: { family: FAMILY_OF_PREFIX[m[1]], slug: decodeSafe(m[2]), document } };
    return document ? { page: { family: null, slug: typeof r.slug === "string" ? r.slug : null, document } } : null;
  }
  return m ? { page: { family: FAMILY_OF_PREFIX[m[1]], slug: decodeSafe(m[2]), document: null } } : null;
}

const mediaIdOf = (src) => {
  const m = typeof src === "string" ? /^\/api\/media\/([A-Za-z0-9_-]{1,120})(?:[?#]|$)/.exec(src) : null;
  return m ? m[1] : null;
};

// Every ref of a body, with where it is: [{ sectionId, ref }]. Sections and
// the document's own settings, through the registry (refsOf, refsOfSetting).
function refsOfBody(body) {
  const out = [];
  for (const s of Array.isArray(body?.sections) ? body.sections : []) {
    if (!isObj(s) || !sectionType(s.kind)) continue;
    for (const r of refsOf(s)) out.push({ sectionId: s.id, kind: s.kind, ref: r });
  }
  const t = documentType(body?.type);
  const settings = isObj(body?.settings) ? body.settings : {};
  for (const s of t?.settings || []) for (const r of refsOfSetting(s, settings[s.key])) out.push({ sectionId: null, kind: null, ref: r });
  return out;
}

// P3-FIX2: how a link's words start. A link in the document's own settings
// is the menu's or the bar's, not "this page"'s.
const SETTINGS_LEAD = { header: "Your header menu links to", footer: "Your footer menu links to", announcement: "Your announcement bar links to" };
export function linkLead(type, sectionId, otherwise) {
  return sectionId == null && Object.hasOwn(SETTINGS_LEAD, type) ? SETTINGS_LEAD[type] : otherwise;
}

// A link's identity for the inherited rule: where it sends shoppers.
const linkKey = (r) => JSON.stringify([r.type ?? null, r.href ?? null, r.family ?? null, r.slug ?? null, r.document ?? null, r.handle ?? null]);

// The last list index in a field path: "products.2" -> {field: "products",
// index: 2}; "items.0.children.1.link" -> {field: "items.0.children", index:
// 1}; "meta.redirect_from.3" -> {field: "meta.redirect_from", index: 3}.
export function listItemOf(field) {
  const parts = typeof field === "string" && field ? field.split(".") : [];
  for (let n = parts.length - 1; n > 0; n--) {
    if (/^\d+$/.test(parts[n])) return { field: parts.slice(0, n).join("."), index: Number(parts[n]) };
  }
  return null;
}

// ---- reads (each one statement, only when needed) -------------------------------------

const marks = (n) => Array.from({ length: n }, () => "?").join(", ");

async function guarded(what, fn) {
  try {
    return await fn();
  } catch (e) {
    // a check that can't read its table never stops a publish: it is logged,
    // and that check is left out
    slog("documents_publish_check_unreadable", { table: what, error: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

async function readDocumentRows(ids, slugs) {
  if (!ids.length && !slugs.length) return [];
  const where = [];
  const args = [];
  if (ids.length) {
    where.push(`id IN (${marks(ids.length)})`);
    args.push(...ids);
  }
  if (slugs.length) {
    where.push(`slug IN (${marks(slugs.length)})`);
    args.push(...slugs);
  }
  const r = await libsql.execute({ sql: `SELECT id, type, slug, label, revision, draft_hash, archived_at, published_version_id FROM documents WHERE ${where.join(" OR ")}`, args });
  return r.rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    slug: row.slug == null ? null : String(row.slug),
    label: String(row.label),
    revision: Number(row.revision),
    draftHash: String(row.draft_hash),
    archived: row.archived_at != null,
    publishedVersionId: row.published_version_id == null ? null : String(row.published_version_id),
  }));
}

async function readCollections(handles) {
  if (!handles.length) return new Map();
  const r = await libsql.execute({
    sql:
      "SELECT c.handle AS handle, (SELECT count(*) FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id = c.id AND p.available = 1) AS in_stock " +
      `FROM collections c WHERE c.handle IN (${marks(handles.length)})`,
    args: handles,
  });
  return new Map(r.rows.map((row) => [String(row.handle), { inStock: Number(row.in_stock || 0) }]));
}

async function readProducts(handles) {
  if (!handles.length) return new Map();
  const r = await libsql.execute({ sql: `SELECT handle, title, available FROM products WHERE handle IN (${marks(handles.length)})`, args: handles });
  return new Map(r.rows.map((row) => [String(row.handle), { title: String(row.title ?? row.handle), available: Number(row.available) === 1 }]));
}

async function readMedia(ids) {
  if (!ids.length) return new Set();
  const r = await libsql.execute({ sql: `SELECT id FROM media WHERE id IN (${marks(ids.length)})`, args: ids });
  return new Set(r.rows.map((row) => String(row.id)));
}

// The code-default pages a shopper can reach while the list uses them
// (lib/content/resolve.js v4ContentPage: the brand store only).
function codeDefaultSlugs(list) {
  if (list?.neutral === true || !isBrandTenant(tenantId())) return new Set();
  return new Set(Object.keys(PAGES));
}

// ---- the checks -------------------------------------------------------------------------

export async function referenceChecks({ items, list, journalBody = async () => null }) {
  const issues = [];
  const targets = new Map();
  const inSet = new Set(items.map((p) => p.doc.id));
  const valid = items.filter((p) => isObj(p.body) && p.body.type === p.doc.type);

  // what each body refers to
  const found = [];
  for (const p of valid) for (const r of refsOfBody(p.body)) found.push({ p, ...r });
  const pageLinks = [];
  const collections = new Set();
  const products = new Set();
  const media = new Set();
  const bundles = new Set();
  for (const f of found) {
    const r = f.ref;
    if (r.ref === "link") {
      const t = linkTarget(r);
      if (t?.page) pageLinks.push({ ...f, target: t.page });
      else if (t?.catalog === "collection") collections.add(t.handle);
      else if (t?.catalog === "product") products.add(t.handle);
    } else if (r.ref === "collection" && r.handle) collections.add(r.handle);
    else if (r.ref === "product" && r.handle) products.add(r.handle);
    else if (r.ref === "bundle" && typeof r.id === "string" && r.id) bundles.add(r.id);
    else if (r.ref === "media") {
      const id = mediaIdOf(r.src);
      if (id) media.add(id);
    }
  }
  const routeItems = valid.filter((p) => documentType(p.doc.type)?.route && isObj(p.body.meta));
  const withRedirects = routeItems.filter((p) => Array.isArray(p.body.meta.redirect_from) && p.body.meta.redirect_from.length);

  // M2: the live rows of every other document, plus the set's own
  const needJournal = pageLinks.some((l) => l.target.family === "journal" || l.target.family == null) || withRedirects.length > 0;
  const posts = needJournal ? journalEntriesOf(await journalBody()) : [];
  const rows = [];
  for (const row of list.pages || []) if (!inSet.has(row.document)) rows.push({ family: row.type || "page", slug: row.slug, document: row.document, enabled: row.enabled !== false, fromSet: false, label: typeof row.title === "string" ? row.title : null });
  for (const e of posts) if (!inSet.has(e.document)) rows.push({ family: "journal", slug: e.slug, document: e.document, enabled: e.enabled !== false, fromSet: false, label: typeof e.title === "string" ? e.title : null });
  for (const p of routeItems) {
    if (typeof p.body.meta.slug !== "string" || !p.body.meta.slug) continue;
    const enabled = p.doc.type === "journal" ? p.body.meta.enabled !== false : pageRow(p.doc.type, p.body).enabled;
    rows.push({ family: p.doc.type, slug: p.body.meta.slug, document: p.doc.id, enabled, fromSet: true, label: p.doc.label || p.body.meta.title || null });
  }
  const byKey = new Map();
  const byDoc = new Map();
  for (const row of rows) {
    const k = `${row.family}:${row.slug}`;
    if (!byKey.has(k) || (row.enabled && !byKey.get(k).enabled)) byKey.set(k, row);
    if (!byDoc.has(row.document)) byDoc.set(row.document, row);
  }
  const codeDefaults = codeDefaultSlugs(list);

  // P3-FIX2: what a shopper's address meets in M2, the way the storefront
  // reads it (lib/content/resolve.js v4ContentPage, resolvedSlugRedirect).
  // Every row counts, a hidden or offline one included: the storefront finds
  // a page row by its slug first (any family), then a journal post, and a
  // row that is switched off answers "not found". Only /journal/<slug>
  // follows an old address (app/(storefront)/journal/[slug]/page.js), and
  // only when no page row and no post holds that slug.
  const pageRowAt = new Map();
  const postAt = new Map();
  for (const row of rows) {
    const at = row.family === "journal" ? postAt : pageRowAt;
    if (!at.has(row.slug)) at.set(row.slug, row);
  }
  const m2Redirects = new Map();
  for (const x of list.redirects || []) if (!inSet.has(x.document) && !m2Redirects.has(x.from_slug)) m2Redirects.set(x.from_slug, x.to_slug);
  for (const p of routeItems) for (const x of redirectsOf(p.body)) if (!m2Redirects.has(x.from_slug)) m2Redirects.set(x.from_slug, x.to_slug);
  // The row a shopper who opens <family prefix><slug> sees, or null ("not
  // found"), following old addresses on the journal only.
  const landing = (family, slug) => {
    let cur = slug;
    for (let hop = 0; hop < 20 && typeof cur === "string" && cur; hop++) {
      const row = pageRowAt.get(cur) || postAt.get(cur) || null;
      if (row) return row.enabled && row.family === family ? row : null;
      if (family !== "journal") return null;
      cur = m2Redirects.get(cur);
    }
    return null;
  };

  // page links: decide what needs the documents table
  const decided = pageLinks.map((l) => {
    const t = l.target;
    // P3-FIX3: the row of the link's document id is trusted only when it is
    // live, or is at the link's own address and of its kind. A stale id whose
    // page is hidden or offline somewhere else says nothing about where the
    // link sends shoppers: the link's address decides.
    const byIdRow = t.document ? byDoc.get(t.document) || null : null;
    const idAtLink = byIdRow && (!t.family || !t.slug || (byIdRow.family === t.family && byIdRow.slug === t.slug));
    const row = (byIdRow && (byIdRow.enabled || idAtLink) ? byIdRow : null) || (t.family && t.slug ? byKey.get(`${t.family}:${t.slug}`) : null) || null;
    if (row && row.enabled) {
      // P3-FIX2: a link chosen by document id is built from the slug and
      // family it stores (registry/settings.js linkHref), not from the
      // document's address now. A page renamed since sends shoppers to its
      // old address, which only an old address on the journal forwards.
      const moved = t.document && row.document === t.document && t.family && t.slug && (row.family !== t.family || row.slug !== t.slug);
      if (moved && landing(t.family, t.slug)?.document !== row.document) return { l, verdict: "moved", row };
      return { l, verdict: "ok" };
    }
    if (row) return { l, verdict: row.fromSet ? "hidden" : "lookup", row };
    if (t.family === "page" && t.slug && codeDefaults.has(t.slug)) return { l, verdict: "ok" };
    // P3-FIX2: an old address that forwards shoppers to a live post (and, for
    // a link by id, to that same document) is fine
    const land = t.family && t.slug ? landing(t.family, t.slug) : null;
    if (land && (!t.document || land.document === t.document)) return { l, verdict: "ok" };
    return { l, verdict: "lookup", row: null };
  });
  const lookups = decided.filter((d) => d.verdict === "lookup");
  const ids = [...new Set(lookups.flatMap((d) => [d.row?.document, d.l.target.document]).filter(Boolean))];
  const slugs = [...new Set(lookups.filter((d) => !d.row && d.l.target.slug).map((d) => d.l.target.slug))];
  const docRows = lookups.length ? ((await guarded("documents", () => readDocumentRows(ids, slugs))) ?? null) : [];

  const hrefOf = (t) => (t.family && t.slug ? `${PREFIX_OF_FAMILY[t.family]}${t.slug}` : "a page");
  const add = (p, sectionId, field, code, severity, message) => {
    const i = issue({ documentId: p.doc.id, sectionId: sectionId ?? null, field: field ?? null, code, severity, message });
    issues.push(i);
    return i;
  };
  // P3-FIX2: a link block in the document's own settings (a menu item, the
  // announcement bar's link) whose link was already in the live version is
  // inherited, the way classify() treats an unchanged section: it warns and
  // doesn't stop publishing. An offline document has no live body, so
  // nothing in it is inherited.
  const liveLinks = new Map();
  const liveLinksOf = (p) => {
    if (!liveLinks.has(p.doc.id)) {
      const keys = new Set();
      if (isObj(p.liveBody) && p.liveBody.type === p.doc.type) for (const r of refsOfBody(p.liveBody)) if (r.sectionId == null && r.ref.ref === "link") keys.add(linkKey(r.ref));
      liveLinks.set(p.doc.id, keys);
    }
    return liveLinks.get(p.doc.id);
  };
  // P3-FIX2 fix 1: a link is inherited only when its target is outside the
  // set. When the set holds the page the link goes to (by document id, or by
  // an address one of the set's pages holds now, held when live, or forwarded
  // from), the problem may be this publish's own doing (the set hides or
  // renames that page), so it blocks.
  const setSlugs = new Set();
  for (const p of routeItems) {
    for (const b of [p.body, p.liveBody]) {
      if (!isObj(b) || b.type !== p.doc.type || !isObj(b.meta)) continue;
      if (typeof b.meta.slug === "string" && b.meta.slug) setSlugs.add(b.meta.slug);
      for (const x of redirectsOf(b)) setSlugs.add(x.from_slug);
    }
  }
  // P3-FIX3: two terms. A row found for the link that came from the set
  // (row.fromSet) was found either by the link's document id (so the id is
  // in the set) or by its address (so the address is a set page's address
  // now), so it needs no term of its own. The id term matters only for a
  // link by id whose address was already stale before this publish: it then
  // blocks rather than inherits (stricter, pinned by a test).
  const targetInSet = (t) => Boolean((t?.document && inSet.has(t.document)) || (t?.slug && setSlugs.has(t.slug)));
  // P3-FIX3: a link block in a section whose page is in the set. classify()
  // in publish.js never inherits these (an unchanged section's link can be
  // broken by the same set hiding or renaming its page).
  const setBreaks = new Set();
  const block = (p, sectionId, ref, code, message, t = null) => {
    if (sectionId == null && !targetInSet(t) && liveLinksOf(p).has(linkKey(ref))) {
      const i = { ...issue({ documentId: p.doc.id, sectionId: null, field: ref.field ?? null, code, severity: "warning", message: `${message} It was already live like this, so it doesn't stop publishing.` }), level: "inherited" };
      issues.push(i);
      return null;
    }
    const i = add(p, sectionId, ref.field, code, "error", message);
    if (sectionId != null && targetInSet(t)) setBreaks.add(i);
    return i;
  };

  for (const d of decided) {
    const { p, sectionId, ref } = d.l;
    const t = d.l.target;
    if (d.verdict === "ok") continue;
    const lead = linkLead(p.doc.type, sectionId, "This link goes to");
    if (d.verdict === "moved") {
      const now = `${PREFIX_OF_FAMILY[d.row.family] || "/"}${d.row.slug}`;
      const name = d.row.label ? `${q(d.row.label)}` : "That page";
      const forwardOnlyJournal = t.family !== "journal" && m2Redirects.has(t.slug) ? " Old addresses only forward shoppers on journal posts." : "";
      block(p, sectionId, ref, LINK_TARGET_MISSING, `${lead} ${hrefOf(t)}, but ${name} is at ${now} now, so shoppers who click it get “not found”.${forwardOnlyJournal} Choose the page again so the link uses its new address.`, t);
      continue;
    }
    if (d.verdict === "hidden") {
      block(p, sectionId, ref, LINK_TARGET_HIDDEN, `${lead} ${hrefOf(t)}, which is hidden from shoppers. Show that page, or link somewhere else.`, t);
      continue;
    }
    if (docRows === null) continue; // the documents table couldn't be read: left out (logged)
    // P3-FIX3: a document found by the link's id counts only when it is at
    // the link's own address and of its kind (the storefront builds the link
    // from the slug it stores): a stale id never offers the wrong page.
    const atLink = (r) => !t.family || !t.slug || (r.type === t.family && r.slug === t.slug);
    const pick = (r) => !r.archived && Boolean(documentType(r.type)?.route) && (d.row ? r.id === d.row.document : (t.document ? r.id === t.document && atLink(r) : false) || (t.family && r.type === t.family && r.slug === t.slug));
    const doc = docRows.find(pick) || null;
    if (doc && !inSet.has(doc.id) && (d.row ? doc.publishedVersionId == null : true)) {
      const i = block(p, sectionId, ref, LINKS_TO_UNPUBLISHED, `${linkLead(p.doc.type, sectionId, "This page links to")} ${doc.label}, which isn't published yet.`, t);
      if (i) targets.set(i, { id: doc.id, revision: doc.revision, draftHash: doc.draftHash, label: doc.label });
      continue;
    }
    if (d.row) block(p, sectionId, ref, LINK_TARGET_HIDDEN, `${lead} ${hrefOf(t)}, which is hidden from shoppers. Show that page, or link somewhere else.`, t);
    else block(p, sectionId, ref, LINK_TARGET_MISSING, `${lead} ${hrefOf(t)}, which isn't a page of your store. Choose another page, or remove the link.`, t);
  }

  // the catalog and the media library
  // P5-CHECKS: the bundles, in one read, only when the set picks one
  const [cols, prods, meds, buns] = await Promise.all([
    guarded("collections", () => readCollections([...collections])),
    guarded("products", () => readProducts([...products])),
    guarded("media", () => readMedia([...media])),
    bundles.size ? guarded("bundles", () => bundlesByIds([...bundles])) : null,
  ]);
  for (const f of found) {
    const { p, sectionId, ref: r } = f;
    if (r.ref === "link") {
      const t = linkTarget(r);
      if (t?.catalog === "collection" && cols && !cols.has(t.handle))
        add(p, sectionId, r.field, LINK_COLLECTION_MISSING, "error", `This link goes to the collection ${q(t.handle)}, which isn't in your store any more. Choose another collection, or remove the link.`);
      if (t?.catalog === "product" && prods && !prods.has(t.handle))
        add(p, sectionId, r.field, LINK_PRODUCT_MISSING, "error", `This link goes to the product ${q(t.handle)}, which isn't in your store any more. Choose another product, or remove the link.`);
      continue;
    }
    if (r.ref === "collection" && cols) {
      const c = cols.get(r.handle);
      const rail = f.kind === "product_rail";
      if (!c)
        add(p, sectionId, r.field, COLLECTION_MISSING, "warning", rail
          ? `This product rail shows the collection ${q(r.handle)}, which isn't in your store any more, so the rail shows nothing. Choose another collection, or remove the rail.`
          : `The collection ${q(r.handle)} isn't in your store any more, so it's left out. Remove it.`);
      else if (rail && c.inStock === 0)
        add(p, sectionId, r.field, COLLECTION_EMPTY, "warning", `The collection ${q(r.handle)} has nothing in stock right now, so this rail shows nothing. Choose another collection, or remove the rail.`);
      continue;
    }
    if (r.ref === "product" && prods) {
      const pr = prods.get(r.handle);
      if (!pr) add(p, sectionId, r.field, PRODUCT_MISSING, "warning", `The product ${q(r.handle)} isn't in your store any more, so it's left out. Remove it.`);
      else if (!pr.available) add(p, sectionId, r.field, PRODUCT_UNAVAILABLE, "warning", `${q(pr.title)} is sold out, so it's left out until it's back in stock. Remove it, or leave it for when it's back.`);
      continue;
    }
    if (r.ref === "media" && meds) {
      const id = mediaIdOf(r.src);
      if (id && !meds.has(id)) add(p, sectionId, r.field, MEDIA_MISSING, "warning", "This image was deleted from your library, so shoppers see a plain colour block instead. Choose another image.");
      continue;
    }
    if (r.ref === "bundle" && buns) bundleIssues(p, sectionId, r, buns.get(r.id), add);
  }

  // redirects (meta.redirect_from), against M2. P3-FIX2: every row holds its
  // slug, a hidden or offline one included, because the storefront lets any
  // page row or post at an address win over an old address
  // (resolvedSlugRedirect), and a hidden one then answers "not found".
  if (withRedirects.length) {
    const holderAt = (slug) => pageRowAt.get(slug) || postAt.get(slug) || null;
    const redirects = m2Redirects;
    for (const p of withRedirects) {
      const own = p.body.meta.slug;
      p.body.meta.redirect_from.forEach((from, j) => {
        if (typeof from !== "string") return;
        const field = `meta.redirect_from.${j}`;
        if (from === own) {
          add(p, null, field, REDIRECT_SELF, "error", `An old address is the same as this page's own address (${q(from)}), so it would send shoppers back to where they are. Remove it.`);
          return;
        }
        const holder = holderAt(from);
        if (holder && holder.document !== p.doc.id) {
          add(p, null, field, REDIRECT_SHADOWED, "warning", holder.enabled
            ? `The old address ${q(from)} is already a live page's own address, so shoppers who use it see that page, not this one. Remove it, or change that page's address.`
            : `The old address ${q(from)} is still the address of a page that's hidden from shoppers or offline, so shoppers who use it get “not found”, not this page. Remove it, or change that page's address.`);
          return;
        }
        // follow where shoppers would be sent; coming back to `from` is a loop
        let cur = from;
        for (let hop = 0; hop < 20; hop++) {
          const next = cur === from ? own : redirects.get(cur);
          if (next == null) break;
          if (next === from) {
            add(p, null, field, REDIRECT_LOOP, "error", `The old address ${q(from)} would send shoppers round in a circle between pages. Remove it.`);
            break;
          }
          if (holderAt(next)) break;
          cur = next;
        }
      });
    }
  }
  // P4-ED05 (D2): a banner on a page, campaign or journal post shows nowhere
  // on its route. It was made before the banner stopped being offered there,
  // so it publishes as it is, with this inherited note (and Remove).
  for (const p of valid) {
    for (const n of notShownNotes(p.body)) {
      issues.push({ ...issue({ documentId: p.doc.id, sectionId: n.sectionId, field: null, code: n.code, severity: "warning", message: n.message }), level: "inherited" });
    }
  }
  return { issues, targets, setBreaks };
}

// P5-CHECKS: what a picked bundle means for shoppers right now. `b` is the
// bundlesByIds entry (a deleted bundle reads as state 'missing'). The words
// are bundle-words' own, led by the bundle's name (its id once it is gone)
// and followed by what Remove takes away: this one entry of a grid, or the
// whole section for a card.
const BUNDLE_CODE_OF = { missing: BUNDLE_MISSING, disabled: BUNDLE_DISABLED, sold_out: BUNDLE_UNAVAILABLE, no_saving: BUNDLE_UNAVAILABLE, not_ready: BUNDLE_UNAVAILABLE };
function bundleIssues(p, sectionId, r, b, add) {
  if (!b) return;
  const name = q(b.state !== "missing" && typeof b.title === "string" && b.title ? b.title : r.id);
  const code = BUNDLE_CODE_OF[b.state];
  if (code) {
    const line = stateLine(b.state, b.reasons, { currency: b.currency ?? undefined });
    const goes = listItemOf(r.field) ? "Remove this bundle from the grid, and the rest of the grid stays." : "Removing it takes this whole section off the page.";
    add(p, sectionId, r.field, code, "warning", `${name}: ${line} ${goes}`);
  }
  // a turned-on bundle that shares a product with another turned-on bundle.
  // P5-FIX1 (orchestrator ruling 3): only for a bundle shoppers see with its
  // saving (state 'available'). A sold-out, not-ready or no-saving bundle
  // shows no saving the cart could differ from, and already has its own
  // BUNDLE_UNAVAILABLE; the overlap is never raised next to it.
  const others = Array.isArray(b.overlapsWith) ? b.overlapsWith : [];
  if (b.enabled && b.state === "available" && others.length) {
    const with_ = others.map((o) => q(typeof o?.title === "string" && o.title ? o.title : String(o?.id ?? ""))).join(", ");
    add(p, sectionId, r.field, BUNDLE_OVERLAP, "warning", `${name}: ${overlapLine()} It shares products with ${with_}.`);
  }
}

// ---- publish-mode adjustments ------------------------------------------------------------

// A missing alt text only warns at publish (PUB-03 "Warns: … missing alt
// text"). The validator reports it as REQUIRED on "<image>.alt".
const isAltMissing = (i) => i.code === "REQUIRED" && typeof i.field === "string" && /(^|\.)alt$/.test(i.field);
export function relevel(issues) {
  return issues.map((i) => (i.severity === "error" && isAltMissing(i) ? { ...i, severity: "warning" } : i));
}

// ---- words and actions ----------------------------------------------------------------------

const sectionOf = (body, id) => (isObj(body) && Array.isArray(body.sections) ? body.sections.find((s) => isObj(s) && s.id === id) || null : null);

// `structure`: the issue's validator class said structure (read with
// issueClass before any copy drops it), or the caller's own rule did.
export function actionsFor(i, { body = null, target = null, structure = false } = {}) {
  const out = [];
  const documentId = i.documentId;
  const sec = i.sectionId ? sectionOf(body, i.sectionId) : null;
  const decl = sec ? sectionType(sec.kind) : null;
  const item = listItemOf(i.field);
  const removeItem = () => out.push({ type: "removeItem", documentId, ...(i.sectionId ? { sectionId: i.sectionId } : {}), field: item.field, index: item.index });
  if (i.severity === "error") {
    if (target) out.push({ type: "publishBoth", documentId: target.id });
    if (i.sectionId && sec && decl && !decl.protected) out.push({ type: structure ? "removeSection" : "hideSection", documentId, sectionId: i.sectionId });
    else if (!i.sectionId && item && REMOVABLE_BLOCKS.has(i.code)) removeItem();
  } else if (REMOVABLE_WARNINGS.has(i.code) || (!i.sectionId && item && REMOVABLE_BLOCKS.has(i.code))) {
    // P3-FIX2: an inherited menu item block (a warning now) can still go
    if (item) removeItem();
    else if (i.sectionId && sec && decl && !decl.protected) out.push({ type: "removeSection", documentId, sectionId: i.sectionId });
  }
  if (!out.length) out.push({ type: "openField", documentId, ...(i.sectionId ? { sectionId: i.sectionId } : {}), ...(i.field ? { field: i.field } : {}) });
  return out;
}

// level: "blocks" for an error; "inherited" when classify() said the problem
// was already live like this (i.level), or for a design colour pair that is
// unchanged from live (BRAND_HARD_TO_READ: TOK-02 blocks only changed pairs);
// "warns" for the rest.
export function levelOf(i) {
  if (i.severity === "error") return "blocks";
  if (i.level === "inherited" || i.code === "BRAND_HARD_TO_READ") return "inherited";
  return "warns";
}

export function decorate(i, { body = null, target = null, structure = issueClass(i) === STRUCTURE } = {}) {
  return {
    documentId: i.documentId ?? null,
    sectionId: i.sectionId ?? null,
    blockId: i.blockId ?? null,
    field: i.field ?? null,
    code: i.code,
    severity: i.severity,
    message: i.message,
    autoFix: i.autoFix ?? null,
    level: levelOf(i),
    anchor: fieldAnchor(i),
    where: where(i, body),
    actions: actionsFor(i, { body, target, structure }),
  };
}
