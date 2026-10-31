# S59b — Live unsaved-edit preview (audit slice 3: "editing a field updates a clearly identified preview state")

Scope: the Designer previewed the last SAVE; the audit wants in-progress
edits visible, clearly labeled, without compromising the publication
contract. This lands the smallest honest mechanism: a per-preview-session
CANDIDATE overlay rendered by the REAL storefront renderer.

## Design

- migrations/tenant/0016_preview_candidates.sql + lib/cms/candidates.js:
  one row per preview session, keyed by a sha-256 of the preview token (the
  raw token never lands in a table), value = the designer's unsaved blocks,
  24h TTL with opportunistic prune. Edge-safe (crypto.subtle + libsql HTTP).
- API: new one-op `{previewCandidate: {hero|announcement|home_sections} | null}`
  in lib/admin/cms-api.js — storefront.write (support stays read-only, the
  same-origin check applies), 409 NO_PREVIEW without a valid preview cookie,
  unknown block keys 400, values run through validateBlock and are stored
  NORMALIZED (the renderer meets exactly saved-draft shapes, sanitized HTML
  included), null clears. slog'd, not audited (ephemeral preview state).
- Resolver: contentSource (preview mode only) loads the session's candidate
  best-effort; resolvedHero/resolvedAnnouncement/resolvedHomeSections prefer
  candidate blocks (sections go through the same kind filter + S58 healing).
  Shoppers can never see one (no valid cookie → no row is even looked up);
  two concurrent editors' keystrokes stay isolated per session.
- Designer: a 700ms-debounced effect pushes the DIRTY blocks whenever they
  change (sequence-guarded against races), refreshes the frame on success,
  and pushes null when everything is clean again. The status line flips to
  "Preview shows your UNSAVED edits — nothing is saved yet" while a
  candidate is applied — the clearly identified preview state the audit
  requires. Mid-typing validation failures are silently skipped (the frame
  stays on the last good state; no error storm while a field is half-typed).

## Publication contract unchanged

snapshotContent reads the draft TABLES; the suite proves a candidate write
leaves the draft hash byte-identical — candidates can never leak into a
release, and publishing/review flows are untouched.

## Verification

- scripts/test-cms-api.js 20/20 — new: NO_PREVIEW 409; support 403 (gated
  before the token check); validated storage keyed by hash (raw token never
  stored) readable through getPreviewCandidate; session isolation; clear;
  unknown-key 400; invalid-value 422; snapshot hash untouched.
- content 19, releases 24, sections 15, cms 11, storefront 15, security 13,
  `pnpm build` ✓.
- Browser drill: PENDING with the S59 surface-designer drill (same harness
  window): type in the hero title → frame updates with the typed text and
  the UNSAVED label → Save → label returns to "last save" → close without
  saving → a fresh preview shows the saved draft.

## Boundaries

- Candidate scope is the home designer's three blocks; extending to other
  surfaces rides on the same CANDIDATE_BLOCKS whitelist when those surfaces
  gain composition.
- Each debounced push reloads the frame (full SSR) — honest rendering over
  DOM-patching; fine at editor cadence, revisit only if merchants complain.
