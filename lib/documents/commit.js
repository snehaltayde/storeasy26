// P2-ATOM (PUB-02): the atomic document-release commit. Node console routes only.
//
// commitPublishBatch(build) writes one publish as ONE libsql.batch(stmts, "write"):
//   1. INSERT the version rows            … ON CONFLICT(id) DO NOTHING
//   2. INSERT the release row (published_at null) … ON CONFLICT(id) DO NOTHING
//   3. the guarded flip: UPDATE release_state … WHERE id = 1
//        AND (live_release_id IS :L OR live_release_id = :new)
//        AND EXISTS (the release row with this content_hash)
//        AND (count of version rows whose id, document_id AND body_hash are
//             this build's) = :nv
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
//   { ok }       the pointer is :new with this build's list hash, or the live list
//                holds this build's versions in this build's slots (same document,
//                same version, same hash), or this build's release row exists with
//                this build's hash (it is only ever written together with the flip,
//                so it proves the batch committed)
//   { lost }     nothing of this build is there: the guard missed (the pointer or a
//                revision moved), the database was busy or locked, or the transport
//                failed before the commit. Rebuilding from { pointer, list } is safe.
//   { failed }   not a race, so a rebuild would fail the same way. `code` says why:
//                BAD_BUILD          the build itself is malformed (checked before any
//                                   database call; nothing is sent)
//                MISSING_DOCUMENT   a document the build names is not in `documents`
//                VERSION_ID_CLASH   a version id of this build already belongs to a
//                                   row with another document or another body
//                RELEASE_ID_CLASH   the release id already belongs to another list
//                DB_REFUSED         the database refused a statement (NOT NULL,
//                                   CHECK, a missing table, the frozen triggers)
//   { unknown }  the re-read itself failed. The publish may or may not be live; the
//                caller must say so and must not rebuild.
//
// Never uses Kysely transaction() or client.transaction(): those would be new,
// unproven paths through the lib/db.js proxy. A batch is one Hrana request.
import { libsql } from "../db.js";
import { stableStringify, sha256Hex } from "../releases.js";
import { isV4List, listCanonical, listSlots } from "./release-list.js";

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

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" && v.trim() !== "" && v === v.trim();
const isOptStr = (v) => v === undefined || v === null || typeof v === "string";

// P2-HARDEN: a malformed build is the caller's bug, not a race. It is found here,
// before any database call, and reported as { failed, code: "BAD_BUILD" }, so the
// publish service never rebuilds it and never tells the founder "someone else
// published". Bodies, the list hash and the log's own fields are left to the
// database on purpose: its NOT NULL and CHECK refusals are the tested last line.
export function buildProblems(build) {
  const p = [];
  if (!isObj(build)) return ["the build is not an object"];
  if (!isId(build.releaseId)) p.push("releaseId must be a non-empty string");
  if (!(build.pointer === undefined || build.pointer === null || isId(build.pointer))) p.push("pointer must be a release id or null");
  if (build.canonical !== undefined) {
    if (!(build.canonical === null || typeof build.canonical === "string")) p.push("canonical must be a string");
  } else if (!isV4List(build.list)) p.push("list must be a version 4 release list");
  if ("hash" in build && !(build.hash === null || typeof build.hash === "string")) p.push("hash must be a string");
  if (!isOptStr(build.setId)) p.push("setId must be a string");
  if (!isOptStr(build.now)) p.push("now must be a string");

  if (!Array.isArray(build.documents) || build.documents.length === 0) p.push("documents must name at least one document");
  else {
    const seen = new Set();
    build.documents.forEach((d, i) => {
      if (!isObj(d)) return p.push(`documents[${i}] is not an object`);
      if (!isId(d.id)) p.push(`documents[${i}].id must be a non-empty string`);
      else if (seen.has(d.id)) p.push(`documents[${i}].id ${d.id} is named twice`);
      else seen.add(d.id);
      if (!Number.isSafeInteger(d.revision) || d.revision < 0) p.push(`documents[${i}].revision must be a whole number, got ${d.revision === undefined ? "undefined" : JSON.stringify(d.revision)}`);
      if (!isOptStr(d.published_version_id)) p.push(`documents[${i}].published_version_id must be a string or null`);
      if (!isOptStr(d.published_hash)) p.push(`documents[${i}].published_hash must be a string or null`);
    });
  }

  if (build.versions !== undefined && !Array.isArray(build.versions)) p.push("versions must be a list");
  else {
    const seen = new Set();
    (build.versions || []).forEach((v, i) => {
      if (!isObj(v)) return p.push(`versions[${i}] is not an object`);
      if (!isId(v.id)) p.push(`versions[${i}].id must be a non-empty string`);
      else if (seen.has(v.id)) p.push(`versions[${i}].id ${v.id} is used twice`);
      else seen.add(v.id);
      if (!isId(v.document_id)) p.push(`versions[${i}].document_id must be a non-empty string`);
      if (!isId(v.body_hash)) p.push(`versions[${i}].body_hash must be a non-empty string`);
    });
  }

  if (build.log !== undefined && !Array.isArray(build.log)) p.push("log must be a list");
  else {
    const seen = new Set();
    (build.log || []).forEach((l, i) => {
      if (!isObj(l)) return p.push(`log[${i}] is not an object`);
      if (!isId(l.id)) p.push(`log[${i}].id must be a non-empty string`);
      else if (seen.has(l.id)) p.push(`log[${i}].id ${l.id} is used twice`);
      else seen.add(l.id);
    });
  }
  return p;
}

// Every value the database will see must be one it can store. Anything else
// (undefined, an object, NaN) is a caller bug that would otherwise surface as a
// thrown TypeError inside client.batch and be read as a race.
function argProblems(stmts) {
  const p = [];
  stmts.forEach((s, i) =>
    s.args.forEach((a, j) => {
      const fine = a === null || typeof a === "string" || typeof a === "bigint" || typeof a === "boolean" || (typeof a === "number" && Number.isFinite(a)) || a instanceof Uint8Array;
      if (!fine) p.push(`statement ${i} argument ${j} is ${a === undefined ? "undefined" : typeof a}`);
    }),
  );
  return p;
}

class BadBuildError extends Error {
  constructor(problems) {
    super(`commitPublishBatch: bad build: ${problems.join("; ")}`);
    this.code = "BAD_BUILD";
    this.problems = problems;
  }
}

async function prepare(build) {
  const first = buildProblems(build);
  if (first.length) throw new BadBuildError(first);
  const now = build.now || nowIso();
  const content = build.canonical !== undefined ? build.canonical : listCanonical(build.list);
  const hash = "hash" in build ? build.hash : content == null ? null : await sha256Hex(content);
  const versions = build.versions || [];
  const docs = build.documents;
  const log = build.log || [];

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
    // P2-HARDEN: count only rows that are this build's, by id AND document AND
    // body. A row kept by ON CONFLICT(id) DO NOTHING that belongs to another
    // document or holds another body does not count, so the flip misses.
    where.push(`(SELECT count(*) FROM document_versions WHERE ${versions.map(() => "(id = ? AND document_id = ? AND body_hash = ?)").join(" OR ")}) = ?`);
    for (const v of versions) args.push(v.id, v.document_id, v.body_hash);
    args.push(versions.length);
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
        l.document_id ?? null,
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
  const second = argProblems(stmts);
  if (second.length) throw new BadBuildError(second);
  let list = build.list;
  if (list === undefined && typeof content === "string") {
    try {
      list = JSON.parse(content);
    } catch {
      list = null;
    }
  }
  return { stmts, hash, list };
}

// The statements, in order. Exported for the suite, which asserts the order and
// the absence of INSERT OR IGNORE. Throws (code BAD_BUILD) on a malformed build.
export async function publishStatements(build) {
  return (await prepare(build)).stmts;
}

// Re-read, in one query: the live pointer, its list and hash; this build's
// release row and its hash; how many of this build's version ids exist, and how
// many of those are really this build's (same document, same body); and which
// of the named documents exist.
async function readBack(client, build, hash) {
  const versions = build.versions || [];
  const docs = build.documents;
  const cols = [
    "s.live_release_id AS live",
    "r.content AS content",
    "r.content_hash AS live_hash",
    "(SELECT content_hash FROM releases WHERE id = ?) AS ours_hash",
    "(SELECT count(*) FROM releases WHERE id = ?) AS ours_rows",
  ];
  const args = [build.releaseId, build.releaseId];
  if (versions.length) {
    cols.push(`(SELECT count(*) FROM document_versions WHERE id IN (${versions.map(() => "?").join(", ")})) AS ver_rows`);
    args.push(...versions.map((v) => v.id));
    cols.push(`(SELECT count(*) FROM document_versions WHERE ${versions.map(() => "(id = ? AND document_id = ? AND body_hash = ?)").join(" OR ")}) AS ver_mine`);
    for (const v of versions) args.push(v.id, v.document_id, v.body_hash);
  }
  cols.push(`(SELECT json_group_array(id) FROM documents WHERE id IN (${docs.map(() => "?").join(", ")})) AS docs_present`);
  args.push(...docs.map((d) => d.id));
  const r = await client.execute({ sql: `SELECT ${cols.join(", ")} FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1`, args });
  const row = r.rows[0] || {};
  let list = null;
  try {
    list = row.content != null ? JSON.parse(String(row.content)) : null;
  } catch {
    list = null;
  }
  let present = [];
  try {
    present = JSON.parse(String(row.docs_present ?? "[]"));
  } catch {
    present = [];
  }
  const oursRows = Number(row.ours_rows || 0);
  const oursHash = row.ours_hash == null ? null : String(row.ours_hash);
  return {
    pointer: row.live ?? null,
    list,
    liveHash: row.live_hash == null ? null : String(row.live_hash),
    // This build's release row, with this build's list. It is only ever written
    // in the same batch as the flip, so it proves the batch committed.
    oursPresent: oursRows > 0 && hash != null && oursHash === hash,
    releaseClash: oursRows > 0 && (hash == null || oursHash !== hash),
    versionClash: Number(row.ver_rows || 0) > Number(row.ver_mine || 0),
    missingDocuments: docs.map((d) => d.id).filter((id) => !present.includes(id)),
  };
}

// Every slot this build's list gives one of this build's versions is still the
// same {version, hash} in the live list.
function liveListHoldsMine(buildList, liveList, versions) {
  if (!versions.length) return false;
  const live = new Map(listSlots(liveList));
  const ours = listSlots(buildList);
  return versions.every((v) => {
    const slots = ours.filter(([, e]) => e.version === v.id);
    return slots.length > 0 && slots.every(([k, e]) => live.get(k)?.version === e.version && live.get(k)?.hash === e.hash);
  });
}

export async function commitPublishBatch(build, { client = libsql } = {}) {
  let prepared;
  try {
    prepared = await prepare(build);
  } catch (e) {
    if (e?.code === "BAD_BUILD") return { failed: true, outcome: "failed", code: "BAD_BUILD", releaseId: build?.releaseId ?? null, problems: e.problems, cause: e };
    throw e;
  }
  const { stmts, hash, list: buildList } = prepared;
  try {
    await client.batch(stmts, "write");
    return { ok: true, outcome: "ok", releaseId: build.releaseId, reconciled: false };
  } catch (cause) {
    let back;
    try {
      back = await readBack(client, build, hash);
    } catch (readError) {
      return { unknown: true, outcome: "unknown", releaseId: build.releaseId, cause, readError };
    }
    const versions = build.versions || [];
    const pointerIsOurs = back.pointer === build.releaseId && hash != null && back.liveHash === hash;
    if (pointerIsOurs || back.oursPresent || liveListHoldsMine(buildList, back.list, versions)) {
      return { ok: true, outcome: "ok", releaseId: build.releaseId, reconciled: true, cause };
    }
    const failed = (code, extra = {}) => ({ failed: true, outcome: "failed", code, releaseId: build.releaseId, pointer: back.pointer, cause, ...extra });
    if (back.versionClash) return failed("VERSION_ID_CLASH");
    if (back.releaseClash) return failed("RELEASE_ID_CLASH");
    if (back.missingDocuments.length) return failed("MISSING_DOCUMENT", { missing: back.missingDocuments });
    if (isRefusal(cause)) return failed("DB_REFUSED");
    return { lost: true, outcome: "lost", releaseId: build.releaseId, pointer: back.pointer, list: back.list, busy: isBusy(cause), cause };
  }
}

export const __commitInternals = { isGuardAbort, isBusy, isRefusal, buildProblems, liveListHoldsMine };
