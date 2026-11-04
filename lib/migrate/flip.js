// P4-CUTOVER (MIG-03, OVL-17): the flip, step e of the cutover. ONE batch,
// under migratingGuardStatement(run), so the pointer, the mode and everything
// the new editor reads move together or not at all. Edge-safe (no node:
// imports).
//
//   flipStatements(ctx) -> [statement]
//     ctx: { runId, mapped, liveAtLock, at, report, outboxProducts, extra }
//   In order:
//     1. migratingGuardStatement(run): the store is still migrating and this
//        run is still open
//     2. the v4 release (rel_mig_<hash of the list>), ON CONFLICT(id) DO NOTHING
//        (none for a store that isn't open yet: nothing is published)
//     3. the pointer flip, guarded on the pointer still being the live release
//        read at the lock (liveAtLock, NULL for "no release"), on the release
//        row holding this list, and on every version the list names being
//        there with the right document and body; then the abort (an INSERT of
//        release_state id 2 when that matched nothing: CHECK (id = 1) rolls the
//        whole batch back). A store that isn't open yet keeps no pointer, and
//        the same guard checks it is still NULL.
//     4. releases.published_at
//     5. publish_log: one 'migrated' row per published document (ids from the
//        release, the document, the version and the lock time, so a resent
//        batch adds nothing), ON CONFLICT(id) DO NOTHING
//     6. documents.published_version_id and published_hash, for every mapped
//        document (NULL when nothing of it is published); undone_version_id
//        cleared. P4-FIX6: also NULL for every document a move after a
//        reversal leaves out of what goes live (mapped.notLive, backfill.js
//        applyRestore), guarded on the version it held, so the editor shows
//        it as not published instead of "published" while shoppers get a 404
//     7. `extra`: statements a caller adds: P4-REVERSE's re-cutover restores
//        the overlay columns here (restoreStatements below), never earlier
//     8. search_outbox: one row per product whose live row the backfill wrote
//        or cleared (reason 'cutover')
//     9. cms_state: mode 'documents', cutover_release_id = liveAtLock
//    10. the run row: step 'flipped', with its report
import { migratingGuardStatement } from "../cms-mode.js";
import { listCanonical, listHash, listVersionIds } from "../documents/release-list.js";
import { sha256Hex, bodyHash } from "./ids.js";
import { stepStatement } from "./runs.js";
import { ACTOR, RESTORE_LIVE_COLUMNS } from "./backfill.js";

export const FLIP_NOTE = "Moved to the new editor";
export const OUTBOX_REASON = "cutover";

export async function flipIds(mapped, { liveAtLock, at }) {
  const seed = `${mapped.releaseId ?? "none"}|${liveAtLock ?? "none"}|${at}`;
  const setId = `set_mig_${(await sha256Hex(`set|${seed}`)).slice(0, 16)}`;
  const logId = async (docId, versionId) => `log_mig_${(await sha256Hex(`log|${seed}|${docId}|${versionId}`)).slice(0, 16)}`;
  return { setId, logId };
}

export async function flipStatements({ runId, mapped, liveAtLock = null, at, report, outboxProducts = [], extra = [] }) {
  const stmts = [migratingGuardStatement(runId)];
  const list = mapped.list;
  if (list) {
    const content = listCanonical(list);
    const hash = await listHash(list);
    const versionIds = [...new Set(listVersionIds(list))];
    // every version the list names (a journal post through its index) is a
    // version this mapping wrote
    const owned = versionIds.map((id) => [id, mapped.bodies.get(id)]).filter(([, v]) => v);
    if (owned.length !== versionIds.length) throw new Error("flip: the list names a version the mapping doesn't hold");
    stmts.push({
      sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(id) DO NOTHING",
      args: [mapped.releaseId, content, hash, FLIP_NOTE, ACTOR, at],
    });
    const counted = [];
    for (const [id, v] of owned) counted.push([id, v.document_id, await bodyHash(v.body)]);
    stmts.push({
      sql:
        "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1 AND live_release_id IS ? " +
        "AND EXISTS (SELECT 1 FROM releases WHERE id = ? AND content_hash = ?) " +
        (counted.length ? `AND (SELECT count(*) FROM document_versions WHERE ${counted.map(() => "(id = ? AND document_id = ? AND body_hash = ?)").join(" OR ")}) = ?` : ""),
      args: [mapped.releaseId, at, liveAtLock, mapped.releaseId, hash, ...counted.flat(), ...(counted.length ? [counted.length] : [])],
    });
  } else {
    stmts.push({ sql: "UPDATE release_state SET updated_at = updated_at WHERE id = 1 AND live_release_id IS ?", args: [liveAtLock] });
  }
  stmts.push({ sql: "INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0", args: [] });
  if (list) stmts.push({ sql: "UPDATE releases SET published_at = ? WHERE id = ? AND published_at IS NULL", args: [at, mapped.releaseId] });

  const { setId, logId } = await flipIds(mapped, { liveAtLock, at });
  let log = 0;
  for (const d of mapped.documents) {
    if (!d.published) continue;
    const entity = d.type === "product_content" || d.type === "collection_content";
    stmts.push({
      sql:
        "INSERT INTO publish_log (id, set_id, document_id, action, from_version_id, to_version_id, release_id, undoes_log_id, saved_version_id, actor, note, created_at) " +
        "VALUES (?, ?, ?, 'migrated', NULL, ?, ?, NULL, NULL, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      args: [await logId(d.id, d.published.versionId), setId, d.id, d.published.versionId, entity ? null : mapped.releaseId, ACTOR, FLIP_NOTE, at],
    });
    log++;
  }
  for (const d of mapped.documents) {
    stmts.push({
      sql: "UPDATE documents SET published_version_id = ?, published_hash = ?, undone_version_id = NULL WHERE id = ?",
      args: [d.published?.versionId ?? null, d.published ? d.publishedHash : null, d.id],
    });
  }
  for (const d of notLiveStatements(mapped.notLive)) stmts.push(d);
  stmts.push(...extra);
  const products = [...new Set(outboxProducts)].sort();
  for (const id of products) {
    stmts.push({
      sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) SELECT ?, (SELECT handle FROM products WHERE id = ?), ?, ?, NULL",
      args: [id, id, OUTBOX_REASON, at],
    });
  }
  stmts.push({
    sql: "UPDATE cms_state SET mode = 'documents', cutover_release_id = ?, updated_at = ? WHERE id = 1 AND mode = 'migrating'",
    args: [liveAtLock, at],
  });
  stmts.push(stepStatement(runId, "flipped", report));
  return { statements: stmts, counts: { log, outbox: products.length }, setId };
}

// After a flip batch threw: did it commit (the answer was lost), or not?
export async function flipLanded(client, { runId, mapped }) {
  const r = await client.execute({
    sql:
      "SELECT (SELECT mode FROM cms_state WHERE id = 1) AS mode, (SELECT live_release_id FROM release_state WHERE id = 1) AS live, " +
      "(SELECT step FROM cms_migration_runs WHERE id = ?) AS step",
    args: [runId],
  });
  const row = r.rows[0] || {};
  const pointerOk = mapped.list ? row.live === mapped.releaseId : true;
  return { landed: row.mode === "documents" && row.step === "flipped" && pointerOk, mode: row.mode == null ? null : String(row.mode), live: row.live ?? null, step: row.step ?? null };
}


// P4-REVERSE (MIG-04, OQ-9 default): the overlay columns a move after a
// reversal brings back (backfill.js applyRestore), written ONLY here, in the
// flip batch: one UPDATE per product, on the live row the backfill wrote with
// the restored version (so it can't land on another row), then the abort
// (release_state id 2, CHECK (id = 1)) when that UPDATE matched nothing, so a
// restore never goes missing quietly: the whole switch rolls back instead.
export function restoreStatements(restored = []) {
  const out = [];
  for (const r of restored) {
    const cols = RESTORE_LIVE_COLUMNS;
    out.push({
      sql: `UPDATE product_content_live SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE product_id = ? AND version_id = ?`,
      args: [...cols.map((c) => r.columns[c] ?? null), r.productId, r.versionId],
    });
    out.push({ sql: "INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0", args: [] });
  }
  return out;
}

// P4-FIX6: the documents a move after a reversal doesn't put live (a page made
// and published in the new editor, which the old editor never had) lose their
// published version, in the flip batch only, so the editor shows them as not
// published. Guarded on the version each held when the move was planned
// (nothing can publish while the store is paused, so it still holds it).
export function notLiveStatements(notLive = []) {
  return (notLive || []).map((d) => ({
    sql: "UPDATE documents SET published_version_id = NULL, published_hash = NULL, undone_version_id = NULL WHERE id = ? AND published_version_id IS ?",
    args: [d.id, d.versionId ?? null],
  }));
}
