// Candidate approvals (S60 / audit: review the EXACT candidate). SERVER-ONLY.
//
// An approval blesses one draft candidate by its content hash — the same
// hash S53 binds publishing to. Any draft edit changes the hash, so a stale
// approval stops applying by construction; nothing has to remember to
// invalidate it. v1 is informational: the Publishing screen shows whether
// THIS candidate was approved, and by whom; publishing records but does not
// require it (enforcement is a later policy knob).
import { db } from "../db.js";
import { snapshotContent } from "../releases.js";

export class ApprovalStaleError extends Error {
  constructor(current) {
    super("Drafts changed since you reviewed them");
    this.code = "DRAFTS_CHANGED";
    this.currentHash = current;
  }
}

// Approve the candidate the reviewer SAW: expectedHash must equal the fresh
// snapshot hash, or the drafts moved between review and approval.
export async function approveCandidate({ expectedHash, actor, note = "" }) {
  const snap = await snapshotContent();
  if (!expectedHash || expectedHash !== snap.hash) throw new ApprovalStaleError(snap.hash);
  const row = {
    draft_hash: snap.hash,
    actor: String(actor || "unknown"),
    note: String(note || "").slice(0, 300),
    created_at: new Date().toISOString(),
  };
  await db.insertInto("cms_approvals").values(row).execute();
  return { ...row };
}

// The latest approval of the CURRENT candidate — null when the drafts have
// moved since (or nothing was ever approved). Missing table (pre-0017
// tenant) reads as "no approval", never a 500.
export async function currentApproval() {
  const snap = await snapshotContent();
  try {
    const row = await db
      .selectFrom("cms_approvals")
      .select(["draft_hash", "actor", "note", "created_at"])
      .where("draft_hash", "=", snap.hash)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row || null;
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return null;
    throw e;
  }
}
