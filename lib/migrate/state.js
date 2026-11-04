// P4-MAPPER (MIG-01, MIG-03): which row of the spec 8.11 state table a legacy
// store is in, and what the backfill's published versions come from.
//
//   classifyState({ mode, live, pendingSchedules, storeOpen })   pure
//     mode              cms_state.mode ('legacy' when the table is missing)
//     live              { state: 'live', release: { id, v } } | { state: 'none' }
//                       | { state: 'error', error }   (getLiveReleaseState's shape)
//     pendingSchedules  [{ id, scheduled_for }]: releases waiting to flip
//     storeOpen         true | false | undefined: the operator's flag
//                       (--store-open / --not-launched). Only a store with no
//                       release needs it, and it is never guessed.
//   -> { state, published, refusals, notes }
//     state       one of STATES (below)
//     published   where the published versions come from:
//                   'release'          the live release (v2, v3)
//                   'release+tables'   the live v1 release, plus the live tables
//                                      for what v1 never froze (overrides,
//                                      pins, placements, redirects)
//                   'drafts'           the draft tables (no release, open)
//                   'none'             nothing (no release, not launched)
//                   null               refused: no mapping of published versions
//     refusals    [{ code, ... }] the state's own refusals (more are added by
//                 map.js: approvals, agency grants, slug collisions, …)
//     notes       [{ code, ... }] facts worth printing, never blocking
//
//   readTenantState()   the inputs above, read inside the tenant's context
//                       (withTenant). Read-only: SELECTs only.
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";
import { getLiveReleaseState, LEGACY_RELEASE_VERSIONS, DOCUMENTS_RELEASE_VERSION } from "../releases.js";

export const STATES = Object.freeze([
  "live_v1",
  "live_v2",
  "live_v3",
  "no_release_open",
  "no_release_not_launched",
  "no_release_unconfirmed",
  "pending_schedule",
  "live_read_error",
  "already_documents",
  "migrating",
  "live_v4_on_legacy",
]);

export const NEEDS_FLAG = "needs --store-open or --not-launched";

export function classifyState({ mode = "legacy", live, pendingSchedules = [], storeOpen } = {}) {
  const refusals = [];
  const notes = [];
  const out = (state, published) => ({ state, published, refusals, notes });

  if (mode === "documents") {
    refusals.push({ code: "ALREADY_DOCUMENTS" });
    return out("already_documents", null);
  }
  if (mode === "migrating") {
    refusals.push({ code: "MIGRATING" });
    return out("migrating", null);
  }
  if (mode !== "legacy") {
    refusals.push({ code: "UNKNOWN_MODE", mode: String(mode).slice(0, 40) });
    return out("live_read_error", null);
  }
  // A pending schedule is refused first: it would later flip an old whole-site
  // snapshot over the new content (spec 8.11 step 5).
  if (pendingSchedules.length) {
    refusals.push({ code: "PENDING_SCHEDULE", releases: pendingSchedules.map((r) => ({ id: r.id, at: r.scheduled_for })) });
    return out("pending_schedule", null);
  }
  if (!live || live.state === "error") {
    refusals.push({ code: "LIVE_READ_ERROR", error: String(live?.error ?? "unreadable").slice(0, 200) });
    return out("live_read_error", null);
  }
  if (live.state === "live") {
    const v = live.release?.v;
    if (storeOpen !== undefined) notes.push({ code: "FLAG_IGNORED", storeOpen: !!storeOpen });
    if (v === 1) return out("live_v1", "release+tables");
    if (v === 2) return out("live_v2", "release");
    if (v === 3) return out("live_v3", "release");
    if (v === DOCUMENTS_RELEASE_VERSION) {
      refusals.push({ code: "LIVE_V4_ON_LEGACY", release: live.release.id });
      return out("live_v4_on_legacy", null);
    }
    refusals.push({ code: "LIVE_READ_ERROR", error: `release version ${JSON.stringify(v)} can't be read`, versions: LEGACY_RELEASE_VERSIONS });
    return out("live_read_error", null);
  }
  // no release: the operator says whether shoppers can see the store today
  if (storeOpen === true) return out("no_release_open", "drafts");
  if (storeOpen === false) return out("no_release_not_launched", "none");
  refusals.push({ code: "NEEDS_FLAG", message: NEEDS_FLAG });
  return out("no_release_unconfirmed", null);
}

const rowsOrEmpty = async (sql, args = [], table) => {
  try {
    return (await libsql.execute({ sql, args })).rows;
  } catch (e) {
    if (notMigratedYet(e, { table })) return [];
    throw e;
  }
};

// The mode, the live release and the pending schedules, read in the tenant's
// context. Read-only.
export async function readTenantState() {
  let mode = "legacy";
  const m = await rowsOrEmpty("SELECT mode, cutover_release_id FROM cms_state WHERE id = 1", [], "cms_state");
  if (m[0]?.mode != null) mode = String(m[0].mode);
  const live = await getLiveReleaseState();
  const pending = await rowsOrEmpty(
    "SELECT r.id, r.scheduled_for FROM releases r WHERE r.scheduled_for IS NOT NULL AND r.published_at IS NULL " +
      "AND r.id IS NOT (SELECT live_release_id FROM release_state WHERE id = 1) ORDER BY r.scheduled_for, r.id",
    [],
    "releases",
  );
  return {
    mode,
    live,
    pendingSchedules: pending.map((r) => ({ id: String(r.id), scheduled_for: String(r.scheduled_for) })),
  };
}
