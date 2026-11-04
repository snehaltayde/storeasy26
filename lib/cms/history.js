// Draft revision history (S55 / audit slice 5). SERVER-ONLY. Appended by the
// CMS API handler after successful console saves; capped per (kind, key) at
// write time. Restore is deliberately NOT a direct write: the console loads a
// historical value into the editor as an unsaved change, and the ordinary
// save path (validation + CAS + a new history entry) takes it from there.
import { sql } from "kysely";
import { db } from "../db.js";
import { runLegacyBatch } from "../cms-mode.js";

export const HISTORY_KEEP = 20;

const hisId = () => "his_" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

export async function appendHistory({ kind, key, value, revision = null, actor = null }) {
  try {
    const now = new Date().toISOString();
    // P4-GUARD (MIG-03): history rows trail the legacy writes, so they carry
    // the same guard. A store that left legacy just now gets no entry (and,
    // as for any failed append, the save it trails is not failed by it).
    await runLegacyBatch([db.insertInto("cms_history").values({ id: hisId(), kind, key, value: JSON.stringify(value ?? null), revision, actor, created_at: now })]);
    // prune beyond the cap (newest first; two saves in one millisecond are told
    // apart by rowid, which follows insert order, since ids are random)
    const rows = await db
      .selectFrom("cms_history")
      .select("id")
      .where("kind", "=", kind)
      .where("key", "=", key)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    const excess = rows.slice(HISTORY_KEEP).map((r) => r.id);
    if (excess.length) await runLegacyBatch([db.deleteFrom("cms_history").where("id", "in", excess)]);
  } catch {
    // pre-migration tenant (table absent) — history is best-effort, a failed
    // append must never fail the save it trails
  }
}

export async function listHistory(kind, key, { limit = HISTORY_KEEP } = {}) {
  try {
    const rows = await db
      .selectFrom("cms_history")
      .selectAll()
      .where("kind", "=", kind)
      .where("key", "=", key)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .limit(Math.min(limit, HISTORY_KEEP))
      .execute();
    return rows.map((r) => {
      let value = null;
      try {
        value = JSON.parse(r.value);
      } catch {
        /* unreadable entry stays null */
      }
      return { id: r.id, kind: r.kind, key: r.key, value, revision: r.revision ?? null, actor: r.actor || null, created_at: r.created_at };
    });
  } catch {
    return []; // pre-migration tenant
  }
}
