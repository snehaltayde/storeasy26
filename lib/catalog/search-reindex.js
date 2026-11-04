// P4-SEARCH (OVL-17, minimal; owner answer OQ-1 (b); phase 4 plan decision
// 15): a published, undone or reset product name reaches Typesense search
// without waiting for a full sync. Node console routes, the job worker and the
// sync only (the Typesense SDK is loaded lazily, never on an edge path).
//
// The source is search_outbox (migration 0024): one row per product a live-row
// batch changed (publish, publishSet, Undo, undoSet, discardOrphanEdits, and
// later the cutover flip and the reversal), written INSIDE that batch, so a row
// exists exactly when the live row moved. A Reset changes only the draft; it
// reaches search with the publish that carries it, through the same row.
//
//   drainSearchOutbox({ client, limit, log })
//     For the current tenant. Reads up to `limit` pending rows (rowid,
//     product_id, handle), oldest first; reads their EFFECTIVE values with
//     lib/catalog/effective.js indexRows({ ids }); builds each document with
//     buildSearchDoc and upserts them (documents().import, action 'upsert');
//     deletes by the stored handle a product that no longer exists (or whose
//     handle moved); then marks done ONLY the rowids it read, so a row written
//     meanwhile stays pending. A row with no handle (a product that was
//     already gone when its row was written, as discardOrphanEdits writes it)
//     uses the handle an earlier row of that product stored; with none, it is
//     marked done and left to the next full sync, which rebuilds the
//     collection. It never drops or
//     recreates the collection, and it only ever addresses the current
//     tenant's productsCollection(). With Typesense not configured, or no
//     namespace for this tenant, it makes no client call and marks the rows
//     done (the storefront's SQL search reads the live rows directly).
//     A failure throws and leaves every row it read pending.
//       -> { read, upserted, deleted, done, skipped? }
//
//   kickSearchReindex({ client, log })
//     The fast path, after a publish-shaped answer has succeeded
//     (lib/admin/documents-api.js; CUTOVER and REVERSE call it too). It
//     enqueues a durable 'search_reindex' job (enqueueDurable) keyed
//     'search_reindex:' + tenantId() + ':' + the highest pending rowid, so two
//     kicks for the same pending rows coalesce while a later publish always
//     gets its own job (jobs.idempotency_key is unique for all time and done
//     jobs are kept for days). With no pending row nothing is enqueued. Then
//     it drains inline, awaited for at most SEARCH_REINDEX_TIMEOUT_MS (the
//     pattern of lib/documents/after-commit.js). A throw is logged
//     'search_reindex_failed', a timeout 'search_reindex_timeout'; neither
//     ever reaches the caller, because the publish is already live. Never
//     throws.
//
//   drainAll()                       the 'search_reindex' job's body
//                                    (lib/platform/worker.js): drains pass
//                                    after pass; a failure throws into the
//                                    job's backoff
//   settleAfterFullIndex({ upTo })   the full sync's half (lib/sync.js): marks
//                                    done the pending rows up to the rowid read
//                                    before the import read its products
//   settleWithoutSearch()            a tenant without Typesense: every pending
//                                    row is done (bounded growth)
//   pruneOutbox({ days })            removes done rows older than `days` (30)
//
// Failures are retried (the rows stay pending; 0024 is pinned, so there is no
// attempts column) by the job's backoff and, as the backstop, by every full
// sync. Nothing here writes to Shopify. A store from before 0024 has no
// outbox: every function here then does nothing.
import { libsql } from "../db.js";
import { slog } from "../log.js";
import { tenantId } from "../tenant-context.js";
import { notMigratedYet } from "../schema-shape.js";
import { typesenseConfigured, productsCollection, searchAdminClientForTest } from "../typesense-search.js";
import { indexRows } from "./effective.js";
import { buildSearchDoc } from "./search-doc.js";

export const SEARCH_REINDEX_JOB = "search_reindex";
export const SEARCH_REINDEX_TIMEOUT_MS = 2500;
export const OUTBOX_KEEP_DAYS = 30;
export const DRAIN_LIMIT_MAX = 1000; // indexRows reads at most 1000 rows at once
const DRAIN_PASSES = 20;
const MARK_CHUNK = 200;

const noop = () => {};
const nowIso = () => new Date().toISOString();
const noOutbox = (e) => notMigratedYet(e, { table: "search_outbox", columns: ["done_at"] });

// The admin client: the caller's, then a test's (setSearchAdminClientForTest),
// then the SDK's. The SDK (axios) is loaded only here, only when needed.
export async function searchAdminClient(client = null) {
  if (client) return client;
  const forTest = searchAdminClientForTest();
  if (forTest) return forTest;
  const { getAdminClient } = await import("../typesense.js");
  return getAdminClient();
}

// ---- the outbox ------------------------------------------------------------------------

// The oldest pending rows, or null when this store has no outbox yet.
async function pendingRows(limit) {
  try {
    const r = await libsql.execute({
      sql: "SELECT rowid AS rid, product_id, handle FROM search_outbox WHERE done_at IS NULL ORDER BY created_at, rowid LIMIT ?",
      args: [limit],
    });
    return r.rows.map((x) => ({ rid: Number(x.rid), productId: String(x.product_id), handle: x.handle == null ? null : String(x.handle) }));
  } catch (e) {
    if (noOutbox(e)) return null;
    throw e;
  }
}

// Marks exactly these rows done (a row already done is left as it is).
async function markDone(rowids, at = nowIso()) {
  let n = 0;
  for (let i = 0; i < rowids.length; i += MARK_CHUNK) {
    const chunk = rowids.slice(i, i + MARK_CHUNK);
    const r = await libsql.execute({ sql: `UPDATE search_outbox SET done_at = ? WHERE done_at IS NULL AND rowid IN (${chunk.map(() => "?").join(", ")})`, args: [at, ...chunk] });
    n += Number(r.rowsAffected || 0);
  }
  return n;
}

// The highest rowid of a PENDING row, or null (none, or no outbox).
export async function highestPendingRowid() {
  try {
    const r = await libsql.execute("SELECT max(rowid) AS top FROM search_outbox WHERE done_at IS NULL");
    const top = r.rows[0]?.top;
    return top == null ? null : Number(top);
  } catch (e) {
    if (noOutbox(e)) return null;
    throw e;
  }
}

// The highest rowid of ANY row, or null: what the full sync reads before its
// import reads the catalog. A row written after it has a higher rowid.
export async function highestOutboxRowid() {
  try {
    const r = await libsql.execute("SELECT max(rowid) AS top FROM search_outbox");
    const top = r.rows[0]?.top;
    return top == null ? null : Number(top);
  } catch (e) {
    if (noOutbox(e)) return null;
    throw e;
  }
}

// The full sync rebuilt the whole collection from what was live when it read
// the catalog: every pending row up to `upTo` is done. A row written during
// the import (a higher rowid) stays pending for the drain that follows.
export async function settleAfterFullIndex({ upTo, at = nowIso() } = {}) {
  if (upTo == null) return 0;
  try {
    const r = await libsql.execute({ sql: "UPDATE search_outbox SET done_at = ? WHERE done_at IS NULL AND rowid <= ?", args: [at, upTo] });
    return Number(r.rowsAffected || 0);
  } catch (e) {
    if (noOutbox(e)) return 0;
    throw e;
  }
}

// No Typesense for this tenant: nothing will ever read the rows, so they are
// done (the storefront's SQL search reads the live rows directly).
export async function settleWithoutSearch({ at = nowIso() } = {}) {
  try {
    const r = await libsql.execute({ sql: "UPDATE search_outbox SET done_at = ? WHERE done_at IS NULL", args: [at] });
    return Number(r.rowsAffected || 0);
  } catch (e) {
    if (noOutbox(e)) return 0;
    throw e;
  }
}

// Done rows older than `days` go (bounded growth). Pending rows never do.
export async function pruneOutbox({ days = OUTBOX_KEEP_DAYS, now = Date.now() } = {}) {
  const before = new Date(now - days * 86_400_000).toISOString();
  try {
    const r = await libsql.execute({ sql: "DELETE FROM search_outbox WHERE done_at IS NOT NULL AND done_at < ?", args: [before] });
    return Number(r.rowsAffected || 0);
  } catch (e) {
    if (noOutbox(e)) return 0;
    throw e;
  }
}

// ---- the drain -------------------------------------------------------------------------

const isNotFound = (e) => Number(e?.httpStatus) === 404 || e?.name === "ObjectNotFound";

// Handles some product in the catalog holds now (never deleted from search).
async function handlesInUse(handles) {
  if (!handles.length) return new Set();
  const r = await libsql.execute({ sql: `SELECT handle FROM products WHERE handle IN (${handles.map(() => "?").join(", ")})`, args: handles });
  return new Set(r.rows.map((x) => String(x.handle)));
}

// The last handle an outbox row stored for each of these products.
async function storedHandles(productIds) {
  const out = new Map();
  if (!productIds.length) return out;
  const r = await libsql.execute({
    sql: `SELECT product_id, handle FROM search_outbox WHERE handle IS NOT NULL AND product_id IN (${productIds.map(() => "?").join(", ")}) ORDER BY rowid`,
    args: productIds,
  });
  for (const row of r.rows) out.set(String(row.product_id), String(row.handle));
  return out;
}

export async function drainSearchOutbox({ client = null, limit = 100, log = noop } = {}) {
  const size = Math.max(1, Math.min(Number(limit) || 100, DRAIN_LIMIT_MAX));
  const rows = await pendingRows(size);
  if (rows == null) return { read: 0, upserted: 0, deleted: 0, done: 0, skipped: "no outbox" };
  if (!rows.length) return { read: 0, upserted: 0, deleted: 0, done: 0 };
  const rowids = rows.map((r) => r.rid);
  // no Typesense for this tenant: no client call at all
  if (!typesenseConfigured()) return { read: rows.length, upserted: 0, deleted: 0, done: await markDone(rowids), skipped: "not configured" };
  const collection = productsCollection();
  if (!collection) return { read: rows.length, upserted: 0, deleted: 0, done: await markDone(rowids), skipped: "no tenant namespace" };

  const c = await searchAdminClient(client);
  if (!c) throw new Error("search reindex: no Typesense admin client");
  const ids = [...new Set(rows.map((r) => r.productId))];
  const { rows: current } = await indexRows({ ids, limit: ids.length });
  const byId = new Map(current.map((r) => [r.id, r]));
  const docs = current.filter((r) => r.handle).map(buildSearchDoc);
  if (docs.length) {
    const results = await c.collections(collection).documents().import(docs, { action: "upsert" });
    const failed = (Array.isArray(results) ? results : []).filter((x) => x && x.success === false);
    if (failed.length) throw new Error(`search reindex: Typesense refused ${failed.length} of ${docs.length} documents: ${String(failed[0]?.error || "").slice(0, 120)}`);
  }
  // a product that is gone (or whose handle moved): its old entry, by the
  // handle the row stored. A row written when the product was already gone
  // (discardOrphanEdits) stored none: the handle an earlier row of the same
  // product stored is used; with none left (pruned), the next full sync
  // rebuilds. A handle some product holds now is never deleted.
  const stale = new Set();
  const noHandle = [...new Set(rows.filter((r) => !r.handle && !byId.has(r.productId)).map((r) => r.productId))];
  const earlier = await storedHandles(noHandle);
  for (const r of rows) {
    const now = byId.get(r.productId);
    const handle = r.handle || (!now ? earlier.get(r.productId) : null);
    if (!handle) continue;
    if (!now || now.handle !== handle) stale.add(handle);
  }
  const inUse = await handlesInUse([...stale]);
  const toDelete = [...stale].filter((h) => !inUse.has(h));
  for (const h of toDelete) {
    try {
      await c.collections(collection).documents(h).delete();
    } catch (e) {
      if (!isNotFound(e)) throw e; // already gone from search: done
    }
  }
  const done = await markDone(rowids);
  log(`  ✓ search: ${docs.length} updated, ${toDelete.length} removed (${collection})`);
  return { read: rows.length, upserted: docs.length, deleted: toDelete.length, done };
}

// The job's body: pass after pass until nothing is pending (bounded).
export async function drainAll({ client = null, limit = 100, log = noop } = {}) {
  const total = { read: 0, upserted: 0, deleted: 0, done: 0, passes: 0 };
  for (let i = 0; i < DRAIN_PASSES; i++) {
    const r = await drainSearchOutbox({ client, limit, log });
    total.passes++;
    for (const k of ["read", "upserted", "deleted", "done"]) total[k] += r[k] || 0;
    if (r.skipped) total.skipped = r.skipped;
    if (r.read < Math.max(1, Math.min(Number(limit) || 100, DRAIN_LIMIT_MAX))) break;
  }
  return total;
}

// ---- the fast path ---------------------------------------------------------------------

// Test seams: a shorter wait, and a stand-in for enqueueDurable
// ((type, payload, key) => Promise<{id, existed} | null>). Never set outside
// tests.
const kickHooks = { timeoutMs: null, enqueue: null };
export function setSearchReindexTestHooks({ timeoutMs = null, enqueue = null } = {}) {
  kickHooks.timeoutMs = timeoutMs;
  kickHooks.enqueue = enqueue;
}

const TIMED_OUT = Symbol("timed out");
function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const say = (evt, fields) => {
  try {
    slog(evt, fields);
  } catch {
    /* logging never breaks a publish */
  }
};
const errText = (e) => String(e?.message || e).slice(0, 300);

export const searchReindexKey = (top) => `${SEARCH_REINDEX_JOB}:${tenantId()}:${top}`;

// -> { queued, job, drained?, timedOut?, error? }. Never throws.
export async function kickSearchReindex({ client = null, log = noop } = {}) {
  const ms = kickHooks.timeoutMs ?? SEARCH_REINDEX_TIMEOUT_MS;
  const tenant = tenantId();
  let top;
  try {
    top = await highestPendingRowid();
  } catch (e) {
    say("search_reindex_failed", { tenant, stage: "read", error: errText(e) });
    return { queued: false, job: null, error: errText(e) };
  }
  if (top == null) return { queued: false, job: null };
  let job = null;
  try {
    const enqueue = kickHooks.enqueue || (await import("../platform/jobs.js")).enqueueDurable;
    const r = await withTimeout(Promise.resolve().then(() => enqueue(SEARCH_REINDEX_JOB, { upTo: top }, searchReindexKey(top))), ms);
    job = r === TIMED_OUT ? null : r || null;
    if (r === TIMED_OUT) say("search_reindex_timeout", { tenant, stage: "enqueue", ms });
  } catch (e) {
    say("search_reindex_failed", { tenant, stage: "enqueue", error: errText(e) });
  }
  const running = Promise.resolve().then(() => drainSearchOutbox({ client, log }));
  try {
    const r = await withTimeout(running, ms);
    if (r === TIMED_OUT) {
      // it may still finish; a later failure is logged, never thrown
      running.catch((e) => say("search_reindex_failed", { tenant, stage: "drain", late: true, error: errText(e) }));
      say("search_reindex_timeout", { tenant, stage: "drain", ms, job: job?.id ?? null });
      return { queued: !!job, job, timedOut: true };
    }
    return { queued: !!job, job, drained: r };
  } catch (e) {
    say("search_reindex_failed", { tenant, stage: "drain", job: job?.id ?? null, error: errText(e) });
    return { queued: !!job, job, error: errText(e) };
  }
}
