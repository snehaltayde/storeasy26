// P6-GEN-WRITE (revision 4 of the phase 6 plan, decisions 7 and 10): the one
// policy-page rule of a documents store, shared by "Before you open your
// store" (PUB-12, lib/documents/opening.js), the policy starters
// (lib/first-run/policy-start.js) and the onboarding checklist. No refusals
// here, and no DocumentError codes.
//
//   isPrivacySlug(slug)   /privacy/                 the rule lib/releases.js
//   isReturnsSlug(slug)   /terms|refund|return/     uses today
//   kindOfSlug(slug)      'privacy' | 'returns' | null (privacy wins when both match)
//   POLICY_KINDS          ['privacy', 'returns']
//   POLICY_STARTER_ACTOR  the actor a policy starter draft is written under
//   POLICY_STARTER_BY     its updated_by ('system:policy-starter'): a page
//                         whose last writer is this is a starter draft waiting
//                         for the founder's review. That column is the review
//                         mark (no schema change).
//   policyStatus(rows, setIds)  pure: { privacy: { state, doc }, returns: { state, doc } }
//   readPolicyRows()      Node: the page rows policyStatus reads, one SELECT
//
// THE REVIEW RULE (owner answers OQ-P6-2 and OQ-P6-3): a policy page counts
// when it is live, in the publish set, or a draft whose last writer is NOT the
// policy starter (the founder saved it, pressed "I've read it", or it is the
// founder's own text brought over by the cutover, 'system:cutover'). A starter
// draft never counts unless it is in the set.
import { libsql } from "../db.js";
import { notMigratedYet } from "../schema-shape.js";

export const POLICY_KINDS = Object.freeze(["privacy", "returns"]);
export const POLICY_STARTER_ACTOR = Object.freeze({ kind: "system", id: "policy-starter" });
export const POLICY_STARTER_BY = "system:policy-starter";

// The states, best first. COUNTING_STATES are the ones the review rule counts.
export const POLICY_STATES = Object.freeze(["live", "inSet", "saved", "starter", "missing"]);
export const COUNTING_STATES = Object.freeze(["live", "inSet", "saved"]);
export const policyCounts = (state) => COUNTING_STATES.includes(state);

const str = (s) => (typeof s === "string" ? s : "");
export const isPrivacySlug = (slug) => /privacy/.test(str(slug));
export const isReturnsSlug = (slug) => /terms|refund|return/.test(str(slug));
export function kindOfSlug(slug) {
  if (isPrivacySlug(slug)) return "privacy";
  if (isReturnsSlug(slug)) return "returns";
  return null;
}

function stateOf(row, inSet) {
  if (row.publishedVersionId) return "live";
  if (inSet.has(row.id)) return "inSet";
  if (row.updatedBy === POLICY_STARTER_BY) return "starter";
  return "saved";
}

// rows: page documents { id, type, slug, label, revision, draftHash,
// publishedVersionId, archivedAt, updatedBy, updatedAt }. Only type 'page',
// not archived, with a slug, counts. Per kind the best state wins; between
// pages in the same state, the most recently updated one (then the id, so
// the answer never depends on row order).
export function policyStatus(rows, setIds = []) {
  const inSet = new Set(Array.isArray(setIds) ? setIds.map(String) : []);
  const best = { privacy: null, returns: null };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.type !== "page" || row.archivedAt || typeof row.slug !== "string" || !row.slug) continue;
    const kind = kindOfSlug(row.slug);
    if (!kind) continue;
    const state = stateOf(row, inSet);
    const cur = best[kind];
    const rank = POLICY_STATES.indexOf(state);
    const curRank = cur ? POLICY_STATES.indexOf(cur.state) : Infinity;
    const newer = cur && (str(row.updatedAt) > str(cur.doc.updatedAt) || (str(row.updatedAt) === str(cur.doc.updatedAt) && String(row.id) > String(cur.doc.id)));
    if (!cur || rank < curRank || (rank === curRank && newer)) best[kind] = { state, doc: row };
  }
  const out = {};
  for (const k of POLICY_KINDS) out[k] = best[k] ?? { state: "missing", doc: null };
  return out;
}

// The rows policyStatus reads. listDocuments is not used (it leaves out
// updated_by, and its answer is pinned elsewhere). A store from before
// migration 0021 has no documents table: no pages.
export async function readPolicyRows() {
  let r;
  try {
    r = await libsql.execute(
      "SELECT id, type, slug, label, revision, draft_hash, published_version_id, archived_at, updated_by, updated_at FROM documents " +
        "WHERE type = 'page' AND archived_at IS NULL AND slug IS NOT NULL",
    );
  } catch (e) {
    if (notMigratedYet(e, { table: "documents" })) return [];
    throw e;
  }
  const s = (v) => (v == null ? null : String(v));
  return r.rows.map((d) => ({
    id: String(d.id),
    type: String(d.type),
    slug: s(d.slug),
    label: String(d.label),
    revision: Number(d.revision),
    draftHash: String(d.draft_hash),
    publishedVersionId: s(d.published_version_id),
    archivedAt: s(d.archived_at),
    updatedBy: s(d.updated_by),
    updatedAt: s(d.updated_at),
  }));
}
