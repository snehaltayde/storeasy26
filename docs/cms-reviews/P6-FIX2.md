# P6 · FIX2 · Batch 2 review findings (GEN-01, GEN-04, PUB-12)

Branch `cms/p6-fix2`, cut from `cms/phase-1` at `eee9f2d`. It fixes the "From review" lists of P6-OPEN-UI, P6-NAV, P6-FIX1 and P6-START-UI that the batch 3 brief gave to this item.

This is the author's own report. Reviewers should re-read the code.

## Files

All are in the item's list:
- `lib/first-run/generate.js`: words for a half-finished run, and `homeWritten` kept across both tries.
- `lib/content/resolve.js`: `closedSource(src)`, the closed-store rule, exported; `isStoreClosed()` uses it.
- `app/manifest.webmanifest/route.js`: uses `closedSource` instead of its own copy.
- `scripts/support/banned-copy.js`: the `#1` rule.
- `lib/documents/opening.js`: `opening:false` for a set of product and collection content alone.
- `scripts/test-first-run.js`, `scripts/test-copy.js`, `scripts/test-open-checks.js`, `scripts/test-console-fresh.js`, `scripts/test-editor-inspector.js`: the new tests.
- `docs/cms-reviews/P6-GEN.md`: the race note corrected. Also this packet.

`lib/first-run/plan.js`, `components/admin/editor/DocumentEditor.js`, `components/admin/editor/fields/DesignForm.js` and `app/(console)/admin/(authed)/dashboard/page.js` needed no change: their behaviour was already right, and only tests were missing.

Not touched: `.github/`, `package.json`, migrations (none), `lib/admin/onboarding.js`, `components/admin/SetupAdmin.js`, `scripts/test-provision.js`, `scripts/test-legacy-routes.js`, `scripts/test-design-doc.js` (P6-ONBOARD's), `components/admin/first-run/FirstRun.js`, `lib/documents/service.js`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No new dependency.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` 102 of 102 and `pnpm build` (see Tests) |
| Browser verified | NOT DONE. Every acceptance item is a unit item, and each is proved by a test that fails without the change. No shopper screen changed its look |
| Staging | NOT DONE (owner check) |

## What, why and design

### 1. A half-finished first run never says "nothing was saved"

**Why:** the generator writes the home first and the design second (P6-FIX1). When the design call lost its race twice, or the store left documents mode or opened between the two calls, the answer used the normal refusal words: "so nothing was saved" or "no starting store was made here". Both were false, because the home page had been written. The `homeWritten` field had no test (mutation R11 survived).

**Design:**
- A new `FIRST_RUN_HALF_WORDS` table, one sentence per reason that can come after the home was written: `race`, `migrating`, `legacy`, `live` and `catalog_not_confirmed`. Each starts "Your home page was made, but your colours were not", then says why. It ends with "Try again" where trying again can help (race, migrating, catalog) and says the honest thing where it can't (`live`: "Your live store hasn't changed."; `legacy`: "Try again from there.").
- `homeWritten` is now kept for the whole run, not per try. Before, a design race on the second try read the second try's home call, which found the home unchanged (`written: false`), so `homeWritten` came out false even though the first try had written it.
- The answer keeps its `reason` and carries `homeWritten: true`. When the home was not written, the words are today's, unchanged ("nothing was saved" is true there).
- `founder_started` keeps its own words even after a write, because the founder's home then stands and "it was left as it is" is true.

The console route passes `message` through as before. The start page (`FirstRun.js`, not this item's file) shows its own "We couldn't make your starting store. Try again." for a race, which is not false; see Known limits.

**P6-GEN.md:** the design-alone race is now marked "Narrowed by P6-FIX1, not closed", says which window is still open, and points to P6-FIX1.md's Known limit "Two writer calls, not one batch".

### 2. The manifest shares the closed-store rule

**Why:** the manifest route had its own copy of `isStoreClosed()`'s rule, and the founder-preview half of it had no test (mutation R1 survived).

**Design:** `closedSource(src)` in `lib/content/resolve.js` is the rule on a source already read: `mode === 'closed'`, or a documents-mode preview with no release. `isStoreClosed()` is now `closedSource(await contentSource())`, and the manifest route asks `closedSource` of the one source it already reads for the brand. So there is still one pointer read per call (test-perf-docs is unchanged), and the two can't drift apart. The function is pure, so it is safe in the edge runtime.

### 3. gridCollections: `listed` against `total`

Only a test (plan.js needed no change). A store whose "Beta" collection has 2 real products plus 3 membership rows for products that are gone: `readFirstRunCatalog` gives Beta `listed: 5, total: 2`, and Alpha `3, 3`. The live grid (`repo.getFeaturedCollections`) puts Beta first, and so do the summary at generation and the one the start page reads. Pure cases: `listed` wins over `total`, `total` is used only when `listed` is absent, and `listed: 0` is no card whatever `total` says.

### 4. The `#1` rule and words made of hex letters

**Why:** "#1bad", "#1add", "#1fab" and "#1dea" passed as 4 digit hex colours.

**Design:** after "#1", the part that follows counts as a colour only when it is:
- two hex digits (the 3 digit "#1ab"), or
- 3, 5 or 7 hex digits **with a digit among them** ("#1a2b", "#1e3a8a", "#1a2b3c4d"), or
- one letter repeated 3, 5 or 7 times ("#1fff", "#1eeeee", "#1aaaaaaa").

Anything else after "#1" is a claim: "#1bad", "#1Fab", "#1faced", "#1decade", "#1add-on", "#1ffff". Brief deviation: the brief says "unless it is a 3, 4, 6 or 8 digit hex colour", but "#1bad" *is* a 4 digit hex colour by its letters, so the rule can't be "any hex token". A letters-only part reads as a word, so it needs a digit or a repeated letter to count as a colour. This is a test-only scanner of shown text, never tokens, so flagging a rare letters-only colour such as "#1abc" in shopper copy costs nothing.

### 5. openingChecks on a set of product and collection content alone

**Why:** the editor already skips the read for such a set (P6-OPEN-UI), but `openingChecks` itself still answered `opening: true` with the whole report on a closed store. Publishing that set opens nothing (publish.js's `rowsOnly` rule), so any other caller would see a report that doesn't apply.

**Design:** `openingState` reads each set document's `type` with the columns it already reads (one statement, the same as before). When the set is not empty and every id is a live-row type (`isLiveRowType`: product_content, collection_content), the answer is `{ opening: false, items: [], offer: null }`, the same shape as the open-store answer that test-api-shapes already pins. A mixed set, an empty set, or a set with an unknown id still gets the report. publish.js calls `openingState` with `setItems` and only when the set is not rows-only, so this branch never runs there.

### 6. P6-NAV test gaps

Only tests:
- **test-console-fresh** (R7): a closed documents store with the brand step recorded and no starting store shows "Start your store". With `describeFirstStore`'s catalog read made to fail (only that statement), the dashboard keeps today's "Setup: x/y done" nudge, and goes back to "Start your store" once the failure ends. A new `sqlFails` op in the instance harness makes one statement fail by pattern, next to the existing `modeFails`.
- **test-editor-inspector** (R9): re-read 1 is held, the founder picks bun-q, the picks effect's late ids= row comes in, and re-read 1 merges it. The founder then takes bun-q out (and it is deleted). Re-read 2's list is exactly bun-a, bun-far and bun-g1, and bun-q is not counted as answered.
- **test-editor-inspector** (R3): `sameBrand` is false with an extra key on either side and true for the same keys in another order. A stored brand of forest plus `button_style` shows Reset ("(Forest)"), and Reset gives exactly forest.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| unit: half-finished generation words never say nothing was saved; homeWritten pinned | done | test-first-run "FIX2 (1, R11)" (the design loses its race on both tries: reason race, `homeWritten: true`, the half words, the home really written) and "FIX2 (1)" (mode changes between the calls: reason legacy, `homeWritten: true`, the half words). Mutation R11 (`homeWritten` never set) fails both. The old code fails both too: its words say "nothing was saved" / "no starting store was made", and its per-try `homeWritten` is false on the second try. A third test pins that a race the home itself loses still says "nothing was saved" with no `homeWritten`, and scans every half sentence for banned words |
| unit: the manifest uses the shared closed-store rule, founder preview pinned | done | test-first-run "FIX2 (2, R1)": a real founder preview session (`createPreviewSession`, the `_preview` cookie) of a closed store gets "Opening soon." while its source is `mode: 'live', preview: true`; after the first publish the preview gets the tagline. It also checks `closedSource` on six sources and that the route imports `closedSource` and has no copy. Mutation R1 (`closedSource` reduced to `mode === 'closed'`) fails it |
| unit: gridCollections listed vs total pinned | done | test-first-run "FIX2 (3, R9)". Mutation R9 (count `c.total`) fails it |
| unit: '#1bad' is a claim and '#1a2b3c' is not | done | test-copy "CLAIMS '#1' (P6-FIX2)". Without the banned-copy.js change it fails (58 passed, 1 failed) |
| unit: openingChecks answers opening:false for a rows-only set on a closed store | done | test-open-checks "openingChecks (P6-FIX2)": product content alone, collection content alone and both answer `opening:false, items: [], offer: null` on a closed store with checkout off; a mixed set, an empty set and an unknown id still get the report with the payment block; nothing is written. Taking the new line out, or changing `every` to `some`, fails it (28 passed, 1 failed) |
| unit: describeFirstStore throwing keeps the Setup nudge | done | test-console-fresh "P6-FIX2: when describeFirstStore throws…". Mutation R7 (`.catch(() => ({ generated: false }))`) fails it (26 passed, 1 failed) |
| unit: the bundleLate reset and sameBrand extra key are pinned | done | test-editor-inspector "P6-FIX2 (R9…)" and "P6-FIX2 (R3…)". Taking out `bundleLate.current = new Map()` fails R9, and `sameBrand` walking only the starting brand's keys fails R3 (69 passed, 1 failed each) |
| unit: pnpm test passes | done | 102 of 102 suites, exit 0 (205.0 s), CHECKOUT_MODE unset, on ports 6120 and 7120 to 7129 |

The mutations were run with `<scratch>/helpers/mut.py`, which applies one change, runs the suite and puts the file back.

## Tests

```
node scripts/test-first-run.js          # 45 passed
node scripts/test-copy.js               # 59 passed
node scripts/test-open-checks.js        # 29 passed
node scripts/test-console-fresh.js      # 27 passed
node scripts/test-editor-inspector.js   # 70 passed
TEST_PUBLISH_PORTS=7120,7121 TEST_PUBLISH_SERVICE_PORTS=7122,7123 TEST_PUBLISH_UNDO_PORTS=7124 \
  TEST_PRODUCT_CONTENT_PORTS=7125,7126 TEST_MIGRATE_MAP_SQLD_PORT=7127 MIGRATE_DOCUMENTS_TEST_PORTS=7128,7129 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120 SHOPIFY_OAUTH_PORT=6120 DESIGN_PORT=6120 env -u CHECKOUT_MODE pnpm test   # 102 of 102
env -u CHECKOUT_MODE pnpm build         # exit 0; only the existing next.config.mjs NFT trace warning
python3 <scratch>/helpers/mut.py <worktree> <file> <old> <new> <suite>   # one mutation
```

Every store was a local file database (`scripts/support/tenant-fixture.js`) or the suites' own sqld on my ports. Typesense was never configured. No tenant was moved to documents mode outside those local files, and nothing was written to Shopify. Nothing was left listening on 6120 or 7120 to 7129.

## Known limits

- **The design-alone race is narrowed, not closed** (unchanged; P6-FIX1.md "Two writer calls, not one batch"). A founder save between this run's home call and its design call still lets the design be written. Closing it needs a guard inside `createFirstRunDocuments` (lib/documents/service.js, not this item's file).
- **The start page's own words.** `FirstRun.js` keeps its own copy of the reason words (it can't import Node-only generate.js), including the race sentence "…so nothing was saved". It never shows that one for a POST answer: a race shows "We couldn't make your starting store. Try again." with a retry, which is true. A half-finished legacy, migrating or live answer makes the page read its state again, and it then shows that state. It does not show the new half sentences. FirstRun.js is not this item's file.
- **The `#1` rule** now flags a letters-only hex colour of 4, 6 or 8 digits that is not one repeated letter ("#1abc", "#1abcde"). It reads only shown text, never tokens, so this costs nothing in practice. It is still a pattern, not a dictionary.
- **openingChecks and an item with no row.** A set with an id that has no documents row is not rows-only, so it gets the report, as before.
- **publish.js's own call** to `openingState` (with `setItems`) does not read the set's types. It never needs to, because the publish only runs the opening rules for a set that is not rows-only.

## Owner checks

- **The half-finished words** (`FIRST_RUN_HALF_WORDS` in lib/first-run/generate.js): read them as a founder. They show only through `POST /api/admin/first-run`'s `message` today.
- **The `#1` rule's line** (letters only after "#1" is a claim unless one letter repeats): accept it, or ask for a word list instead.
- **The P6-NAV deviation** the review named: an open documents store with no brand step keeps today's nudge (it is not told to start). Still yours to confirm.
- **CI sqld download:** unchanged. Nothing under `.github/` was touched; its source and checksum still need your approval.
