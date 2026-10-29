// Draft revision history (S55 / audit slice 5). SERVER-ONLY. Appended by the
// CMS API handler after successful console saves; capped per (kind, key) at
// write time. Restore is deliberately NOT a direct write: the console loads a
// historical value into the editor as an unsaved change, and the ordinary
// save path (validation + CAS + a new history entry) takes it from there.
import { db } from "../db.js";

export const HISTORY_KEEP = 20;

const hisId = () => "his_" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

export async function appendHistory({ kind, key, value, revision = null, actor = null }) {
  try {
    const now = new Date().toISOString();
    await db
      .insertInto("cms_history")
      .values({ id: hisId(), kind, key, value: JSON.stringify(value ?? null), revision, actor, created_at: now })
      .execute();
    // prune beyond the cap (id in created_at order; ties broken by id)
    const rows = await db
      .selectFrom("cms_history")
      .select("id")
      .where("kind", "=", kind)
      .where("key", "=", key)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const excess = rows.slice(HISTORY_KEEP).map((r) => r.id);
    if (excess.length) await db.deleteFrom("cms_history").where("id", "in", excess).execute();
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
      .orderBy("id", "desc")
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
