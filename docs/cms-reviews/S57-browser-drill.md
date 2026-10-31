# S57 — Interactive browser drill (design harness) + defaults-id fix

Date: 2026-10-31. Harness: `pnpm dev:design` on :3017, file DBs
(.design-*.db), admin login via .design-env credentials. The storefront
route group ran with a TEMPORARY `runtime = "nodejs"` flip (edge + file
DBs don't mix); reverted to `"edge"` in this same commit. This packet
closes the "Browser: pending" items recorded in S54-3, S55-4/5 and
S56-templates.

## What was drilled, in the real browser

Designer (S54-3, S55-4/5):
- Load: tree (Hero, Announcement bar, Shop by collection, Fresh drops),
  PreviewBridge handshake → "Preview shows your last save".
- Click-to-select: clicking the hero inside the preview iframe selected it
  and rendered the full Hero inspector form.
- Edit → Save → refresh: hero title/highlight edited via inspector; status
  flipped to "Unsaved changes — hero"; Save showed the toast and the iframe
  refreshed to the new copy.
- Add section: registry menu listed all six kinds; Product rail added;
  CollectionPicker opened, search box + rows rendered, picking a row filled
  the handle (`bestsellers`); after Save the rail rendered real products
  (collection_products seeded in the harness DB for the drill).
- Tree → highlight: after the first sections save stamped durable sec_* ids,
  selecting "Featured products" in the tree outlined the section in the
  iframe and smooth-scrolled it into view (verified scrollY 194 → 2901).
- History: dialog listed one version per save; after a second save, loading
  the older version restored the old title INTO THE EDITOR as
  "Unsaved changes — sections" (nothing persisted until Save), then saved.

Publishing (S53-0B1):
- Diff chips rendered per item (hero edited, sections customized), each
  linking to its editor.
- Stale-hash drill: a draft was changed via the API behind the open review;
  Publish with the displayed hash → the designed banner "Drafts changed
  since you reviewed them — review the updated change list, then publish
  again" AND the chip list refreshed to include the new change. Publishing
  again with the fresh view succeeded (release 13a406dd6d17 live, prior
  release offered "Roll back to this").

API contracts (S53-0A1/0B1), probed via fetch from the authed console:
- Mixed payload `{getPage + block+value}` → 400 AMBIGUOUS_OPERATION.
- Revision-less block write → 428 REVISION_REQUIRED.

Surface templates (S56):
- Theme → Page templates card: PDP flipped to Editorial, saved as a draft
  (CAS toast); the PDP then rendered `data-pdp-template="editorial"` with
  the sticky buy bar, under the honest "Draft preview — this is NOT what
  shoppers see" banner. Collection flipped to Sidebar →
  `data-collection-template="sidebar"` with the product grid. Both reverted
  to platform defaults (reset) after the drill.

Pickers (S53-B2): CollectionPicker exercised in the Designer (above);
ProductPicker opened from Upsells → "Choose target products" with search by
title/handle/SKU, price, selection chips and an "Unavailable" status badge.
Upsells screen carries the S53 honest copy ("Saved as drafts — shoppers see
changes after you publish"). Placement publish-gating itself is covered by
scripts/test-content.js (19 checks) and was not re-drilled.

## Finding + fix shipped with this packet

`DEFAULT_HOME_SECTIONS` had no ids, so a FRESH tenant (no saved
home_sections row) rendered sections keyed `i-N` while the Designer tree
held id-less entries — tree→preview highlight was a silent no-op until the
first save stamped ids. Fix: the two defaults now carry stable ids
(`sec_defcollect`, `sec_defnew`, SECTION_ID_RE-shaped); validateBlock keeps
existing ids so the first save round-trips them. Suites re-run green:
test:sections 11, test:cms 11, test:cms-api 17, test:content 19,
test:releases 24, test:storefront 15.

## Honest boundaries

- Harness only (:3017, file DBs). Staging and production remain UNVERIFIED.
- The harness storefront ran on the Node runtime for the drill; the edge
  runtime is what deploys — storefront rendering on edge is verified on
  :3007 / Vercel, not here.
- Empty data states render nothing by design (a rail bound to an empty
  collection disappears for shoppers); the drill seeded junction rows to
  exercise the populated path.
