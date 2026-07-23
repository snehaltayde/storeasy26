import { db } from "./db.js";
import { sendAlert } from "./alerts.js";

// First-party error tracking (Session 17). One row per distinct error
// (fingerprint = source + name + message + top stack frame), count bumped on
// repeats, ONE alert per fingerprint per ALERT_EVERY window. Edge-safe (no
// node:crypto) and guaranteed never to throw — an error tracker that crashes
// the request it's observing is worse than none.
//
// Sentry later: create the project, then forward from captureError (or drop in
// @sentry/nextjs alongside); this sink and its alerting stay either way.

const ALERT_EVERY_MS = () => Number(process.env.ERRORS_ALERT_EVERY_MS || 60 * 60_000);

// FNV-1a — tiny, runtime-agnostic, stable.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const topFrame = (stack) =>
  String(stack || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("at ")) || "";

export function errorFingerprint({ source, name, message, stack }) {
  const norm = String(message || "")
    .replace(/BL-[A-F0-9]{8}/g, "BL-*") // don't split one bug into per-order rows
    .replace(/\b\d+\b/g, "#") // nor into per-amount/per-count rows
    .slice(0, 300);
  return fnv1a(`${source}|${name || ""}|${norm}|${topFrame(stack)}`);
}

export async function captureError({ source = "server", error, url = null, digest = null, extra = null }) {
  try {
    const name = error?.name || "Error";
    const message = String(error?.message || error || "unknown").slice(0, 500);
    const stack = String(error?.stack || "").slice(0, 2048);
    const fingerprint = errorFingerprint({ source, name, message, stack });
    const now = new Date().toISOString();

    const res = await db
      .insertInto("app_errors")
      .values({
        fingerprint,
        source,
        name,
        message,
        stack,
        url,
        digest,
        count: 1,
        first_seen: now,
        last_seen: now,
      })
      .onConflict((oc) =>
        oc.column("fingerprint").doUpdateSet((eb) => ({
          count: eb(eb.ref("app_errors.count"), "+", 1),
          last_seen: now,
          url: url ?? eb.ref("app_errors.url"),
          digest: digest ?? eb.ref("app_errors.digest"),
        })),
      )
      .executeTakeFirst();

    const row = await db
      .selectFrom("app_errors")
      .select(["id", "count", "last_alerted_at"])
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();
    if (!row) return { fingerprint };

    const isNew = Number(res?.numInsertedOrUpdatedRows ?? 0) > 0 && row.count === 1;
    const due =
      !row.last_alerted_at || Date.now() - new Date(row.last_alerted_at).getTime() > ALERT_EVERY_MS();
    if (isNew || due) {
      await db.updateTable("app_errors").set({ last_alerted_at: now }).where("id", "=", row.id).execute();
      await sendAlert(`App error [${source}] ${name}: ${message.slice(0, 140)}`, {
        fingerprint,
        count: row.count,
        url: url || undefined,
        digest: digest || undefined,
        ...(extra || {}),
      });
    }
    return { fingerprint, count: row.count };
  } catch (e) {
    // last resort: the tracker itself must never take a request down
    console.error(`[errors] capture failed: ${e?.message || e}`);
    return { failed: true };
  }
}

// Recent-errors view for the health endpoint / ops.
export async function errorStats({ sinceHours = 24 } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600e3).toISOString();
  const rows = await db
    .selectFrom("app_errors")
    .select(["source", "name", "message", "count", "last_seen"])
    .where("last_seen", ">=", since)
    .orderBy("last_seen", "desc")
    .limit(10)
    .execute();
  return { recent: rows, distinct: rows.length };
}
