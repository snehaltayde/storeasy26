// P4-CUTOVER (MIG-01, MED-03, OVL-02): the backfill, step c of the cutover.
// It writes what map.js mapped from the CURRENT legacy source, in chunks, every
// statement under migratingGuardStatement(run), and checks after each chunk
// that the rows are exactly the plan's. Edge-safe (no node: imports).
//
//   planBackfill(mapped, { at, actor })   the plan: one entry per chunk,
//                                         { kind, statements, expect } built
//                                         from what the database holds now
//   runBackfill(mapped, { runId, at, report, onChunk })
//                                         writes and verifies every chunk;
//                                         -> { counts, kept }
//   BackfillMismatch                      thrown when a chunk's rows aren't
//                                         the plan's (the run stops, the store
//                                         stays paused; --resume or --abort)
//
// What it writes (legacy wins: the legacy store is the source of truth while
// a store is on the old editor):
//   documents        an UPSERT per mapped document: draft and draft_hash from
//                    legacy. A row already there whose draft differs is first
//                    saved as a kept version (kind undo_saved, KEPT_NOTE below,
//                    a content-addressed id), only if its revision is still the
//                    one read, and the update is guarded by that revision too.
//                    A row whose draft is already the same is not touched (no
//                    revision bump), so a re-run writes nothing. An archived
//                    row is never brought back (archive is terminal, P3): the
//                    preconditions refuse a store where legacy still holds a
//                    page whose document was archived, and the chunk check
//                    stops if one appears.
//                    published_version_id and published_hash are NOT written
//                    here: the flip sets them (lib/migrate/flip.js).
//   versions         every mapped version (kind migrated) with
//                    ON CONFLICT(id) DO NOTHING: the ids are content-addressed
//                    (ids.js migratedVersion), so a conflict means the same body
//   document_refs    refRowsForBody of every version written here (the kept
//                    ones too), and release:<id> rows (releaseRefRows) of every
//                    retained release row, ON CONFLICT DO NOTHING
//   live rows        product_content_live and collection_content_live: an
//                    UPSERT of the legacy-derived columns only (modules, badge,
//                    pairs, pairs_title, layout_template; pinned,
//                    layout_template), built with liveRowFor (map-entities.js).
//                    title, description, gallery and display_* are never
//                    written here. A legacy store never reads these columns
//                    (entity content is read only from a v4 source), so they
//                    are invisible to shoppers until the flip.
//                    A live row whose entity the plan doesn't hold (left by an
//                    earlier aborted run, with content legacy no longer has)
//                    loses its legacy-derived columns: it is deleted when no
//                    overlay column is set, else only those columns are cleared.
// Never INSERT OR IGNORE: ON CONFLICT DO NOTHING absorbs only a repeated key,
// a broken row still fails the chunk.
import { libsql } from "../db.js";
import { migratingGuardStatement } from "../cms-mode.js";
import { stableStringify } from "../registry/index.js";
import { refRowsForBody, releaseRefRows, refInsertStatements } from "../documents/refs.js";
import { sha256Hex, bodyHash } from "./ids.js";
import { stepStatement } from "./runs.js";

export const KEPT_MOVE_NOTE = "Kept from before the move to the new editor";
export const ACTOR = "system:cutover";
export const DOC_CHUNK = 25;
export const VERSION_CHUNK = 40;
export const REF_CHUNK = 400;
export const RELEASE_CHUNK = 20;
export const LIVE_CHUNK = 50;

export const PRODUCT_LEGACY_COLUMNS = Object.freeze(["modules", "badge", "pairs", "pairs_title", "layout_template"]);
export const COLLECTION_LEGACY_COLUMNS = Object.freeze(["pinned", "layout_template"]);
export const PRODUCT_OVERLAY_COLUMNS = Object.freeze([
  "title",
  "description",
  "description_html",
  "featured_image",
  "featured_image_alt",
  "gallery",
  "seo_title",
  "seo_description",
  "og_image",
  "display_vendor",
  "display_type",
  "keep_variant_images",
  "layout_document_id",
]);

export class BackfillMismatch extends Error {
  constructor(chunk, problems) {
    super(`the copy of part ${chunk.index + 1} (${chunk.kind}) doesn't match the plan`);
    this.name = "BackfillMismatch";
    this.code = "BACKFILL_MISMATCH";
    this.chunk = { index: chunk.index, kind: chunk.kind };
    this.problems = problems.slice(0, 20);
  }
}

const marks = (n) => Array.from({ length: n }, () => "?").join(", ");
const chunked = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const rowsOf = async (sql, args) => (await libsql.execute({ sql, args })).rows;

// The id a kept draft gets: content-addressed in its own namespace, so the
// same kept body of the same document is one row however often a run repeats.
export async function keptVersionId(documentId, body) {
  return `ver_${(await sha256Hex(`kept:${documentId}:${await bodyHash(body)}`)).slice(0, 16)}`;
}

// What the database holds now for the mapped documents.
async function existingDocuments(ids) {
  const out = new Map();
  for (const part of chunked(ids, 200)) {
    for (const r of await rowsOf(`SELECT id, type, draft, draft_hash, revision, archived_at, slug, label FROM documents WHERE id IN (${marks(part.length)})`, part)) {
      out.set(String(r.id), { id: String(r.id), type: String(r.type), draft: String(r.draft), draftHash: String(r.draft_hash), revision: Number(r.revision), archived: r.archived_at != null, slug: r.slug == null ? null : String(r.slug), label: String(r.label) });
    }
  }
  return out;
}

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const docUpsert = (d, { at, existing }) => ({
  sql:
    "INSERT INTO documents (id, type, slug, entity_id, label, draft, draft_hash, revision, schema_version, published_version_id, published_hash, undone_version_id, archived_at, created_at, updated_at, updated_by) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET type = excluded.type, slug = excluded.slug, entity_id = excluded.entity_id, label = excluded.label, draft = excluded.draft, " +
    "draft_hash = excluded.draft_hash, schema_version = excluded.schema_version, revision = documents.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by " +
    "WHERE documents.revision = ? AND documents.archived_at IS NULL AND (documents.draft_hash IS NOT excluded.draft_hash OR documents.slug IS NOT excluded.slug " +
    "OR documents.label IS NOT excluded.label OR documents.type IS NOT excluded.type)",
  args: [d.id, d.type, d.slug ?? null, d.entityId ?? null, d.label, JSON.stringify(d.draft), d.draftHash, d.schemaVersion, at, at, ACTOR, existing ? existing.revision : 0],
});

const versionInsert = (v, at) => ({
  sql:
    "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  args: [v.id, v.document_id, v.kind, v.body, v.body_hash, v.schema_version, v.note ?? null, ACTOR, at],
});

// The kept version, only while the document still has the revision and draft
// that were read (an INSERT … SELECT … WHERE EXISTS).
const keptInsert = (k, at) => ({
  sql:
    "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at) " +
    "SELECT ?, ?, 'undo_saved', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM documents WHERE id = ? AND revision = ? AND draft_hash = ?) ON CONFLICT(id) DO NOTHING",
  args: [k.id, k.document_id, k.body, k.body_hash, k.schema_version, KEPT_MOVE_NOTE, ACTOR, at, k.document_id, k.revision, k.draftHash],
});

function liveUpsert(kind, row, publishedAt) {
  if (kind === "product") {
    const cols = ["product_id", "document_id", "version_id", ...PRODUCT_LEGACY_COLUMNS, "published_at"];
    const set = ["document_id", "version_id", ...PRODUCT_LEGACY_COLUMNS, "published_at"].map((c) => `${c} = excluded.${c}`);
    return {
      sql: `INSERT INTO product_content_live (${cols.join(", ")}) VALUES (${marks(cols.length)}) ON CONFLICT(product_id) DO UPDATE SET ${set.join(", ")}`,
      args: cols.map((c) => (c === "published_at" ? row.published_at ?? publishedAt : row[c] ?? null)),
    };
  }
  const cols = ["collection_id", "document_id", "version_id", ...COLLECTION_LEGACY_COLUMNS, "published_at"];
  const set = ["document_id", "version_id", ...COLLECTION_LEGACY_COLUMNS, "published_at"].map((c) => `${c} = excluded.${c}`);
  return {
    sql: `INSERT INTO collection_content_live (${cols.join(", ")}) VALUES (${marks(cols.length)}) ON CONFLICT(collection_id) DO UPDATE SET ${set.join(", ")}`,
    args: cols.map((c) => (c === "published_at" ? row.published_at ?? publishedAt : row[c] ?? null)),
  };
}

// Live rows the plan doesn't hold.
async function strayLiveRows(plan) {
  const products = new Set(plan.product.map((r) => r.product_id));
  const collections = new Set(plan.collection.map((r) => r.collection_id));
  const p = await rowsOf(`SELECT product_id, ${PRODUCT_OVERLAY_COLUMNS.join(", ")} FROM product_content_live ORDER BY product_id`, []);
  const c = await rowsOf("SELECT collection_id, layout_document_id FROM collection_content_live ORDER BY collection_id", []);
  return {
    product: p.filter((r) => !products.has(String(r.product_id))).map((r) => ({ id: String(r.product_id), overlay: PRODUCT_OVERLAY_COLUMNS.some((k) => r[k] != null) })),
    collection: c.filter((r) => !collections.has(String(r.collection_id))).map((r) => ({ id: String(r.collection_id), overlay: r.layout_document_id != null })),
  };
}

const strayStatement = (kind, s) => {
  const table = kind === "product" ? "product_content_live" : "collection_content_live";
  const key = kind === "product" ? "product_id" : "collection_id";
  const cols = kind === "product" ? PRODUCT_LEGACY_COLUMNS : COLLECTION_LEGACY_COLUMNS;
  if (!s.overlay) return { sql: `DELETE FROM ${table} WHERE ${key} = ?`, args: [s.id] };
  return { sql: `UPDATE ${table} SET ${cols.map((c) => `${c} = NULL`).join(", ")} WHERE ${key} = ?`, args: [s.id] };
};

/**
 * The plan: the chunks, in order, each { index, kind, statements, verify }.
 * Read-only (it reads what is there now to plan the kept versions, the
 * revision guards, the release refs and the stray live rows).
 */
export async function planBackfill(mapped, { at }) {
  const chunks = [];
  const add = (kind, statements, expect) => chunks.push({ index: chunks.length, kind, statements, expect });
  const schemaVersion = (d) => d.draft?.schema ?? 1;

  // 1. documents (and the kept versions of differing drafts)
  const docs = mapped.documents.map((d) => ({ ...d, schemaVersion: schemaVersion(d) }));
  const existing = await existingDocuments(docs.map((d) => d.id));
  const kept = [];
  const counts = { documents: docs.length, documentsNew: 0, documentsChanged: 0, documentsSame: 0, dirty: docs.filter((d) => d.dirty).length };
  for (const part of chunked(docs, DOC_CHUNK)) {
    const statements = [];
    const expect = { documents: [], kept: [] };
    for (const d of part) {
      const ex = existing.get(d.id) ?? null;
      if (!ex) counts.documentsNew++;
      else if (ex.draftHash !== d.draftHash || ex.slug !== (d.slug ?? null) || ex.label !== d.label || ex.type !== d.type) counts.documentsChanged++;
      else counts.documentsSame++;
      if (ex && ex.draftHash !== d.draftHash) {
        const body = parse(ex.draft);
        if (body && typeof body === "object") {
          const id = await keptVersionId(d.id, body);
          const k = { id, document_id: d.id, body: stableStringify(body), body_hash: await bodyHash(body), schema_version: d.schemaVersion, revision: ex.revision, draftHash: ex.draftHash, label: ex.label, type: d.type, slug: ex.slug };
          kept.push(k);
          statements.push(keptInsert(k, at));
          expect.kept.push({ id, document_id: d.id, body_hash: k.body_hash });
          for (const r of refRowsForBody(d.id, id, body)) (expect.keptRefs ??= []).push(r);
        }
      }
      statements.push(docUpsert(d, { at, existing: ex }));
      expect.documents.push({ id: d.id, draft_hash: d.draftHash, type: d.type, slug: d.slug ?? null });
    }
    if (expect.keptRefs?.length) statements.push(...refInsertStatements(expect.keptRefs));
    add("documents", statements, expect);
  }

  // 2. versions (kind migrated), with their refs
  const versions = [];
  for (const [id, v] of [...mapped.bodies.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v == null || v.body == null) throw new Error(`backfill: version ${id} has no body`);
    versions.push({ id, document_id: v.document_id, kind: "migrated", body: stableStringify(v.body), body_hash: await bodyHash(v.body), schema_version: v.schema_version ?? v.body.schema ?? 1, note: "Moved from the old editor", parsed: v.body });
  }
  for (const part of chunked(versions, VERSION_CHUNK)) {
    const refs = part.flatMap((v) => refRowsForBody(v.document_id, v.id, v.parsed));
    add("versions", [...part.map((v) => versionInsert(v, at)), ...refInsertStatements(refs)], { versions: part.map((v) => ({ id: v.id, document_id: v.document_id, body_hash: v.body_hash })), refs });
  }
  const refCount = versions.reduce((n, v) => n + refRowsForBody(v.document_id, v.id, v.parsed).length, 0) + kept.reduce((n, k) => n + refRowsForBody(k.document_id, k.id, parse(k.body)).length, 0);

  // 3. release:<id> rows for every retained release row
  const releaseIds = (await rowsOf("SELECT id FROM releases ORDER BY id", [])).map((r) => String(r.id));
  let releaseRefs = 0;
  for (const part of chunked(releaseIds, RELEASE_CHUNK)) {
    const rows = [];
    for (const r of await rowsOf(`SELECT id, content FROM releases WHERE id IN (${marks(part.length)}) ORDER BY id`, part)) rows.push(...releaseRefRows({ id: String(r.id), content: r.content }));
    releaseRefs += rows.length;
    if (rows.length) add("release refs", refInsertStatements(rows), { refs: rows });
  }

  // 4. live rows: the legacy-derived columns, and the stray rows
  const plan = { product: mapped.liveRows?.product ?? [], collection: mapped.liveRows?.collection ?? [] };
  const stray = await strayLiveRows(plan);
  for (const kind of ["product", "collection"]) {
    for (const part of chunked(plan[kind], LIVE_CHUNK)) add(`${kind} live rows`, part.map((r) => liveUpsert(kind, r, at)), { live: { kind, rows: part } });
  }
  const strays = [...stray.product.map((s) => ["product", s]), ...stray.collection.map((s) => ["collection", s])];
  if (strays.length) add("old live rows", strays.map(([k, s]) => strayStatement(k, s)), { stray: strays.map(([kind, s]) => ({ kind, ...s })) });

  return {
    chunks,
    kept: kept.map((k) => ({ id: k.id, document: k.document_id, type: k.type, slug: k.slug, label: k.label })),
    stray,
    counts: {
      ...counts,
      versions: versions.length,
      kept: kept.length,
      refs: refCount,
      releaseRefs,
      liveRows: { product: plan.product.length, collection: plan.collection.length },
      liveRowsCleared: strays.length,
    },
  };
}

// ---- verification ----------------------------------------------------------------------

async function refsPresent(rows) {
  const want = new Set(rows.map((r) => `${r.version_id}\u0000${r.ref_type}\u0000${r.ref_id}`));
  const versions = [...new Set(rows.map((r) => r.version_id))];
  const have = new Set();
  for (const part of chunked(versions, 200)) {
    for (const r of await rowsOf(`SELECT version_id, ref_type, ref_id FROM document_refs WHERE version_id IN (${marks(part.length)})`, part)) have.add(`${r.version_id}\u0000${r.ref_type}\u0000${r.ref_id}`);
  }
  return [...want].filter((k) => !have.has(k)).map((k) => `ref ${k.split("\u0000").join(" ")} is missing`);
}

const same = (a, b) => (a == null ? null : String(a)) === (b == null ? null : String(b));

export async function verifyChunk(chunk) {
  const e = chunk.expect;
  const problems = [];
  if (e.documents) {
    const ids = e.documents.map((d) => d.id);
    const got = new Map((await rowsOf(`SELECT id, draft_hash, type, slug, archived_at FROM documents WHERE id IN (${marks(ids.length)})`, ids)).map((r) => [String(r.id), r]));
    for (const d of e.documents) {
      const r = got.get(d.id);
      if (!r) problems.push(`document ${d.id} is missing`);
      else if (!same(r.draft_hash, d.draft_hash) || !same(r.type, d.type) || !same(r.slug, d.slug) || r.archived_at != null) problems.push(`document ${d.id} isn't the planned draft`);
    }
  }
  for (const list of [e.kept, e.versions]) {
    if (!list?.length) continue;
    const ids = list.map((v) => v.id);
    const got = new Map((await rowsOf(`SELECT id, document_id, body_hash FROM document_versions WHERE id IN (${marks(ids.length)})`, ids)).map((r) => [String(r.id), r]));
    for (const v of list) {
      const r = got.get(v.id);
      // a kept version is only written while the document still had the draft
      // that was read; the documents check above catches a document that moved
      if (!r) problems.push(`version ${v.id} is missing`);
      else if (!same(r.document_id, v.document_id) || !same(r.body_hash, v.body_hash)) problems.push(`version ${v.id} holds another body`);
    }
  }
  for (const refs of [e.refs, e.keptRefs]) if (refs?.length) problems.push(...(await refsPresent(refs)));
  if (e.live) {
    const { kind, rows } = e.live;
    const table = kind === "product" ? "product_content_live" : "collection_content_live";
    const key = kind === "product" ? "product_id" : "collection_id";
    const cols = ["document_id", "version_id", ...(kind === "product" ? PRODUCT_LEGACY_COLUMNS : COLLECTION_LEGACY_COLUMNS)];
    const ids = rows.map((r) => r[key]);
    const got = new Map((await rowsOf(`SELECT ${key} AS k, ${cols.join(", ")} FROM ${table} WHERE ${key} IN (${marks(ids.length)})`, ids)).map((r) => [String(r.k), r]));
    for (const row of rows) {
      const r = got.get(row[key]);
      if (!r) problems.push(`${kind} live row ${row[key]} is missing`);
      else for (const c of cols) if (!same(r[c], row[c])) problems.push(`${kind} live row ${row[key]}: ${c} isn't the planned value`);
    }
  }
  if (e.stray) {
    for (const s of e.stray) {
      const table = s.kind === "product" ? "product_content_live" : "collection_content_live";
      const key = s.kind === "product" ? "product_id" : "collection_id";
      const cols = s.kind === "product" ? PRODUCT_LEGACY_COLUMNS : COLLECTION_LEGACY_COLUMNS;
      const r = (await rowsOf(`SELECT ${cols.join(", ")} FROM ${table} WHERE ${key} = ?`, [s.id]))[0];
      if (r && (!s.overlay || cols.some((c) => r[c] != null))) problems.push(`old ${s.kind} live row ${s.id} is still there`);
    }
  }
  return problems;
}

/**
 * Write and verify every chunk. hooks.afterChunk(index) is a test seam
 * (a crash after a chunk).
 */
export async function runBackfill(mapped, { runId, at, report, hooks = null }) {
  const plan = await planBackfill(mapped, { at });
  for (const chunk of plan.chunks) {
    const stmts = [migratingGuardStatement(runId), ...chunk.statements, stepStatement(runId, `backfill:${chunk.index}`, { ...report, backfill: { chunks: plan.chunks.length, done: chunk.index + 1 } })];
    await libsql.batch(stmts, "write");
    const problems = await verifyChunk(chunk);
    if (problems.length) throw new BackfillMismatch(chunk, problems);
    if (hooks?.afterChunk) await hooks.afterChunk(chunk.index, plan.chunks.length);
  }
  return { counts: plan.counts, kept: plan.kept, chunks: plan.chunks.length, stray: plan.stray };
}
