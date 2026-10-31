# S60 — Candidate approvals bound to the draft hash

Scope: the audit's review model ("Release candidate: frozen effective
presentation … Reviewed festive launch ready to schedule"; approvals under
the editorial-roles slice). S53 already binds PUBLISHING to the reviewed
hash; this records the REVIEW itself with the same contract.

## Design

- migrations/tenant/0017_cms_approvals.sql + lib/cms/approvals.js: an
  approval row stores the candidate's content hash, the actor, an optional
  note, and the time. `approveCandidate({expectedHash})` refuses a stale
  hash with the same DRAFTS_CHANGED/409-with-fresh-view contract as publish
  — a reviewer can only bless exactly what they saw. `currentApproval()`
  returns the latest approval whose hash equals the CURRENT snapshot hash —
  any draft edit changes the hash, so a stale approval stops applying BY
  CONSTRUCTION; nothing has to remember to invalidate it. A pre-0017 tenant
  (missing table) reads as "no approval", never a 500.
- API: releases route action `approve` (storefront.publish — admin+; staff
  prepare, publishers bless), audited; the view now carries `approval`.
- Publishing screen: under the diff, the candidate shows "Approved by
  <actor> on <time> — any draft edit withdraws it" (with the hash prefix),
  or "Not approved" with an Approve button for publishers. v1 is a RECORD,
  not a gate — the UI says so plainly ("publishing still works"); making
  approval required is a one-line policy knob once the workflow proves out.

## Verification

- scripts/test-releases.js 25/25 — new: approval binds to the exact hash;
  a post-approval draft edit reads as NOT approved; approving with the
  stale hash → DRAFTS_CHANGED; re-approval of the new candidate applies.
- cms-api 20, authz 14, security 13, `pnpm build` ✓.
- Browser: the card renders from the same view wire as the drilled S53
  diff/publish flow; not separately drilled (pure additive UI on a drilled
  screen). Staging/production: UNVERIFIED; tenants need migration 0017.

## Follow-ups

- Policy knob: `require_approval` (config) blocking publish without a
  current approval — deliberate second step.
- Reviewer ROLE separation (approve without publish) belongs to the
  editorial-roles slice.
