// P2-ATOM (PUB-02): the atomic document-release commit. Node console routes only.
//
// commitPublishBatch(build) writes one publish as ONE libsql.batch(stmts, "write"):
//   1. INSERT the version rows            … ON CONFLICT(id) DO NOTHING
//   2. INSERT the release row (published_at null) … ON CONFLICT(id) DO NOTHING
//   3. the guarded flip: UPDATE release_state … WHERE id = 1
//        AND (live_release_id IS :L OR live_release_id = :new)
//        AND EXISTS (the release row with this content_hash)
//        AND (count of this build's version rows) = :nv
//        AND (SELECT revision FROM documents WHERE id = :d) = :rev   (each document)
//   4. the abort: INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0
//      release_state has CHECK (id = 1), so a flip that matched nothing makes
//      this insert fail and the whole batch roll back (the GEN-02 pattern).
//   5. stamp releases.published_at
//   6. INSERT the publish_log rows        … ON CONFLICT(id) DO NOTHING
//   7. UPDATE documents SET published_version_id, published_hash
//
// Why ON CONFLICT(id) DO NOTHING and never INSERT OR IGNORE: OR IGNORE also
// swallows NOT NULL and CHECK failures, so a broken row would be skipped while
// the pointer flips. DO NOTHING absorbs only a repeated id (a resent batch). The
// flip also checks that the release row and every version row exist, so a row
// that is missing can never sit behind a live pointer.
//
// `OR live_release_id = :new` makes a resent batch (lib/db.js retries a batch
// on a lost answer) an idempotent success instead of a false loss.
//
// On any thrown error the outcome is unknown to us, so it is reconciled by
// re-reading the pointer, its list and this build's release row:
//   { ok }       the pointer is :new, or the live list holds this build's version
//                ids, or this build's release row exists (it is only ever written
//                together with the flip, so it proves the batch committed)
//   { lost }     nothing of this build is there: the guard missed (the pointer or a
//                revision moved), the database was busy or locked, or the transport
//                failed before the commit. Rebuilding from { pointer, list } is safe.
//   { failed }   the database refused a statement for another reason (a NOT NULL or
//                CHECK failure, a missing table). Nothing was written, and a rebuild
//                would fail the same way, so it is not reported as a race.
//   { unknown }  the re-read itself failed. The publish may or may not be live; the
//                caller must say so and must not rebuild.
//
// Never uses Kysely transaction() or client.transaction(): those would be new,
// unproven paths through the lib/db.js proxy. A batch is one Hrana request.
import { libsql } from "../db.js";
import { stableStringify, sha256Hex } from "../releases.js";
import { listCanonical, listVersionIds } from "./release-list.js";

const nowIso = () => new Date().toISOString();
const errText = (e) => `${e?.code || ""} ${e?.message || e} ${e?.cause?.message || ""}`;

// The abort statement's failure, as SQLite words it.
const isGuardAbort = (e) => /CHECK constraint failed/i.test(errText(e)) && /(id\s*=\s*1|release_state)/i.test(errText(e));
const isBusy = (e) => /SQLITE_BUSY|database is locked/i.test(errText(e));
// The database refused the statement itself; resending can't change that.
const isRefusal = (e) =>
  !isGuardAbort(e) &&
  !isBusy(e) &&
  /constraint failed|SQLITE_CONSTRAINT|SQLITE_MISMATCH|datatype mismatch|no such table|no such column|SQL_PARSE_ERROR|syntax error|versions are frozen|only checkpoint versions/i.test(errText(e));

const bodyText = (body) => (body == null ? null : typeof body === "string" ? body : stableStringify(body));

// The statements, in order. Exported for the suite, which asserts the order and
// the absence of INSERT OR IGNORE.
export async function publishStatements(build) {
  const now = build.now || nowIso();
  const content = build.canonical !== undefined ? build.canonical : listCanonical(build.list);
  const hash = "hash" in build ? build.hash : content == null ? null : await sha256Hex(content);
  const versions = build.versions || [];
  const docs = build.documents || [];
  const log = build.log || [];
  if (!build.releaseId) throw new Error("commitPublishBatch: the build has no release id");
  if (!docs.length) throw new Error("commitPublishBatch: the build names no documents");

  const stmts = [];
  for (const v of versions) {
    stmts.push({
      sql:
        "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, note, created_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      args: [v.id, v.document_id, v.kind ?? "published", bodyText(v.body), v.body_hash ?? null, v.schema_version ?? null, v.note ?? null, v.created_by ?? build.actor ?? null, v.created_at || now],
    });
  }
  stmts.push({
    sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(id) DO NOTHING",
    args: [build.releaseId, content, hash, build.note ?? null, build.actor ?? null, now],
  });

  const where = ["id = 1", "(live_release_id IS ? OR live_release_id = ?)", "EXISTS (SELECT 1 FROM releases WHERE id = ? AND content_hash = ?)"];
  const args = [build.releaseId, now, build.pointer ?? null, build.releaseId, build.releaseId, hash];
  if (versions.length) {
    where.push(`(SELECT count(*) FROM document_versions WHERE id IN (${versions.map(() => "?").join(", ")})) = ?`);
    args.push(...versions.map((v) => v.id), versions.length);
  }
  for (const d of docs) {
    where.push("(SELECT revision FROM documents WHERE id = ?) = ?");
    args.push(d.id, d.revision);
  }
  stmts.push({ sql: `UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE ${where.join(" AND ")}`, args });
  stmts.push({ sql: "INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0", args: [] });
  stmts.push({ sql: "UPDATE releases SET published_at = ? WHERE id = ? AND published_at IS NULL", args: [now, build.releaseId] });
  for (const l of log) {
    stmts.push({
      sql:
        "INSERT INTO publish_log (id, set_id, document_id, action, from_version_id, to_version_id, release_id, undoes_log_id, saved_version_id, actor, note, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      args: [
        l.id,
        "set_id" in l ? l.set_id : build.setId ?? null,
        l.document_id,
        l.action ?? "publish",
        l.from_version_id ?? null,
        l.to_version_id ?? null,
        "release_id" in l ? l.release_id : build.releaseId,
        l.undoes_log_id ?? null,
        l.saved_version_id ?? null,
        l.actor ?? build.actor ?? null,
        l.note ?? null,
        l.created_at || now,
      ],
    });
  }
  for (const d of docs) {
    stmts.push({
      sql: "UPDATE documents SET published_version_id = ?, published_hash = ? WHERE id = ?",
      args: [d.published_version_id ?? null, d.published_hash ?? null, d.id],
    });
  }
  return stmts;
}

// Re-read the live pointer, its list and this build's release row in one query.
async function readBack(client, releaseId) {
  const r = await client.execute({
    sql:
      "SELECT s.live_release_id AS live, r.content AS content, " +
      "(SELECT published_at FROM releases WHERE id = ?) AS ours_published, " +
      "(SELECT count(*) FROM releases WHERE id = ?) AS ours_present " +
      "FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1",
    args: [releaseId, releaseId],
  });
  const row = r.rows[0] || {};
  let list = null;
  try {
    list = row.content != null ? JSON.parse(String(row.content)) : null;
  } catch {
    list = null;
  }
  return { pointer: row.live ?? null, list, oursPresent: Number(row.ours_present || 0) > 0 };
}

export async function commitPublishBatch(build, { client = libsql } = {}) {
  const stmts = await publishStatements(build);
  try {
    await client.batch(stmts, "write");
    return { ok: true, outcome: "ok", releaseId: build.releaseId, reconciled: false };
  } catch (cause) {
    let back;
    try {
      back = await readBack(client, build.releaseId);
    } catch (readError) {
      return { unknown: true, outcome: "unknown", releaseId: build.releaseId, cause, readError };
    }
    const mine = (build.versions || []).map((v) => v.id);
    const live = new Set(listVersionIds(back.list));
    const listHasMine = mine.length > 0 && mine.every((id) => live.has(id));
    if (back.pointer === build.releaseId || listHasMine || back.oursPresent) {
      return { ok: true, outcome: "ok", releaseId: build.releaseId, reconciled: true, cause };
    }
    if (isRefusal(cause)) return { failed: true, outcome: "failed", releaseId: build.releaseId, pointer: back.pointer, cause };
    return { lost: true, outcome: "lost", releaseId: build.releaseId, pointer: back.pointer, list: back.list, busy: isBusy(cause), cause };
  }
}

export const __commitInternals = { isGuardAbort, isBusy, isRefusal };
