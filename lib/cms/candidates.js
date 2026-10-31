// Live unsaved-edit preview candidates (S59 / audit slice 3). SERVER-ONLY,
// edge-safe (crypto.subtle + libsql HTTP).
//
// The Designer previews the SAVED draft; while the merchant types, it also
// pushes the UNSAVED blocks here, keyed to THEIR preview session (a sha-256
// of the preview token — the raw token never lands in a table). The
// storefront resolver overlays these blocks ONLY for the browser holding
// that cookie, so:
//   · shoppers can never see a candidate (no valid preview cookie, no row),
//   · two editors previewing at once don't see each other's keystrokes,
//   · publishing is untouched — snapshotContent reads the draft TABLES, and
//     a candidate dies with its preview session (24h prune) or on save/clear.
// Values are stored VALIDATED (the API runs validateBlock first), so the
// renderer meets exactly the shapes a saved draft would give it.
import { db } from "../db.js";

export const PREVIEW_COOKIE = "_preview";

// The home designer's editable blocks — the only keys a candidate may carry.
export const CANDIDATE_BLOCKS = ["hero", "announcement", "home_sections"];

const MAX_AGE_MS = 24 * 3600 * 1000;

async function tokenKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function setPreviewCandidate(token, blocks) {
  const row = { token_hash: await tokenKey(token), value: JSON.stringify({ blocks }), updated_at: new Date().toISOString() };
  await db
    .insertInto("cms_preview_candidates")
    .values(row)
    .onConflict((oc) => oc.column("token_hash").doUpdateSet({ value: row.value, updated_at: row.updated_at }))
    .execute();
  // opportunistic prune — candidates are per-session scratch, never precious
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  await db.deleteFrom("cms_preview_candidates").where("updated_at", "<", cutoff).execute().catch(() => {});
}

export async function clearPreviewCandidate(token) {
  await db.deleteFrom("cms_preview_candidates").where("token_hash", "=", await tokenKey(token)).execute();
}

// null = no candidate (or table missing / unreadable — the preview then
// simply shows the last save; a candidate is a convenience, never a 500).
export async function getPreviewCandidate(token) {
  try {
    const row = await db
      .selectFrom("cms_preview_candidates")
      .select(["value", "updated_at"])
      .where("token_hash", "=", await tokenKey(token))
      .executeTakeFirst();
    if (!row) return null;
    if (new Date(row.updated_at).getTime() < Date.now() - MAX_AGE_MS) return null;
    const parsed = JSON.parse(row.value);
    return parsed?.blocks && typeof parsed.blocks === "object" ? parsed.blocks : null;
  } catch {
    return null;
  }
}
