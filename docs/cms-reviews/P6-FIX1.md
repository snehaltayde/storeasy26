# P6 · FIX1 · Batch 1 review findings no other batch 2 item owns (GEN-01, GEN-04, PUB-12)

Branch `cms/p6-fix1`, cut from `cms/phase-1` at `dd9ff01`. That base holds every batch 1 merge (P6-FIXTURE, P6-PALETTE, P6-LOGO-REG, P6-GEN-WRITE) and the batch 1 items whose reviews this fixes (P6-GEN, P6-BRAND, P6-OPEN, P6-POLICY-START, P6-LOGO-RENDER).

This is the author's own report. Reviewers should re-read the code.

## Files

All are in the item's list:
- `lib/first-run/plan.js`: the grapheme cut, and `gridCollections` for the summary.
- `lib/first-run/generate.js`: the home-first writer calls, the `listed` count, and a test-only seam.
- `app/manifest.webmanifest/route.js`: a neutral description while the store is closed.
- `scripts/support/banned-copy.js`: the `#1` rule.
- `lib/content/templates.js`: `returnsSentence` for negative, zero and fractional windows, plus `NO_RETURNS` and `acceptsReturns`.
- `lib/first-run/policy-start.js`: ALREADY_SAVED words.
- `scripts/test-first-run.js`, `scripts/test-copy.js`, `scripts/test-policy-start.js`, `scripts/test-open-checks.js`: the new tests.
- `docs/cms-reviews/P6-GEN-01.md` and `docs/cms-reviews/P6-GEN.md`: corrections. Also this packet.

`lib/documents/publish.js`, `lib/documents/opening.js` and `app/api/admin/policy-start/route.js` needed no code change: their behaviour was already right, and only tests were missing.

Not touched: `.github/`, `package.json`, migrations (none), `lib/documents/service.js` (P6-GEN-WRITE's), every file another batch 2 item owns, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No new dependency.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` 102 of 102 and `pnpm build` (see Tests) |
| Browser verified | NOT DONE. Every acceptance item is proved by a unit test that fails without the change. The two shopper-facing fixes (the cut and the manifest) are also owner checks on a real phone (below) |
| Staging | NOT DONE (owner check) |

## What, why and design

### 1. A cut never splits a character (shopper-facing)

**Why:** `cutWords` cut by UTF-16 code units when no space was within the limit. An emoji at the cut left half a surrogate pair, which a shopper sees as a broken character. Example: the store name 'A' + 40 tea emoji gave a 60-character hero title ending in `\ud83c`.

**Design:** the word-boundary cut is kept. A space is one code unit and is never inside a surrogate pair, so a cut just before one is always whole. The hard cut now takes the longest run of whole graphemes whose length in code units is at most the limit:
- graphemes come from `Intl.Segmenter` (Node and the edge runtime have it), else `Array.from` (code points);
- the limit still counts code units, as the validator and every `<= 60` check do.

This applies to the hero title (60), the alt text (300) and rail titles (50). plan.js stays pure and edge-safe, with no Node import, and the suite's static scan still passes.

### 2. The manifest is neutral while the store is closed (shopper-facing)

**Why:** `/manifest.webmanifest` answered `description: siteTagline()` even on a closed store. That leaked the description the founder typed in the brand step before opening. The leak was already there, but the brand step made it more likely.

**Design:**
- While closed, the description is "Opening soon.", the same words as the closed metadata in `app/(storefront)/layout.js`. The name stays, because the closed page shows it too.
- "Closed" is `isStoreClosed()`'s own rule: `mode === 'closed'`, or a documents-mode preview with no release.
- That rule is read from the one `contentSource()` the brand already comes from. It is not a second `isStoreClosed()` call, because a route handler runs outside React's `cache()`. A second call would cost a second pointer read, and `test-perf-docs` pins one read per call.
- The test checks that `isStoreClosed()` and the manifest agree on a closed store and on an open one.

### 3. The summary names the grid's own collections

**Why:** `summarizeFirstStore` listed in-stock collections, most stocked first. The live grid reads `repo.getFeaturedCollections`, which takes every collection with at least one product (sold-out ones included), sorts by product count, then by title, and stops at the limit. So the summary could name different collections from the grid.

**Design:**
- `gridCollections(collections, limit)` in plan.js uses that same rule: count > 0, most products first, then title in code point order (SQLite's binary order).
- The count is a new `listed` field from `readFirstRunCatalog`. It counts membership rows as getFeaturedCollections does, with no join to products, and falls back to `total`.
- Rails, the subtitle and the hero image keep their in-stock rules.
- P6-GEN-01.md's line about the summary was wrong and is corrected.

### 4. Generator test gaps, and the race closed

**Tests:** each mutation the review listed now fails a test (table below).

**The race:** the checks are read before the writer reads its rows. A founder save to `doc_home` in that gap made the writer skip the home and still write `doc_design` alone. `service.js` is not this item's file, so the fix is in generate.js:
- **Home first.** The writer is called with the home alone. If the writer skips the home, the run stops with **nothing written**, not even the design. The reason comes from the checks read again: `founder_started`, or `home_left_for_founder` on the sync trigger.
- **A save after the writer's read.** A founder save that lands after the writer read the home makes the home's guarded INSERT or UPDATE change no row. That batch aborts with FIRST_RUN_RACE, and the retry sees the founder's home.
- **Then the design,** in a second writer call. Each call is still the one writer, all or none.
- **The seam.** `firstRunGenerateHooks.afterChecks` is a test-only seam in generate.js (never set in production), placed in the gap between the checks and the writer.

With this change G18 (an empty body accepted at any revision) can no longer write the design through `generateFirstStore`. It is still caught, because `describeFirstStore` would call that home eligible. The test checks both.

### 5. Banned copy

**`#1` rule:** after `#1`, only a digit (`#10 pack`, `#123456`) or a whole hex colour token of 3, 4, 6 or 8 digits is let through. So `#1Best`, `#1Brand`, `#1 brand`, `#1f` and `#1abcdefgh` are claims, and `#1a2b3c`, `#1e3a8a`, `#1ab` and `#1a2b3c4d` are not. "#1 brand" was already a claim before this change; it is now pinned.

**B3** (blanking the catalog words) and **B4** (reading only the shown text props) are pinned with inputs that would hit without them:
- B3: a product called "Organic cotton tee" and a store called "Award winners candle co";
- B4: "Award-winning", "Clinically proven" and "guaranteed" in keys the registry does not declare, "organic-certified" in a link, and "best-sellers" in a handle and an image link.

### 6. Policy starters

**Returns sentence:** it now says what `lib/returns.js` does. `returnEligibility` refuses once the order is more than `windowDays` old, and fractions count.

| The number given | The sentence |
|---|---|
| 0 or below | `NO_RETURNS`: "We don't accept returns on orders." |
| A fraction above 1 | Rounded **down** to whole days (10.5 says 10 days), so the page never promises more than the engine gives |
| Below 1 | Whole hours rounded down (0.5 says 12 hours). Under one hour gives NO_RETURNS |
| 1 to 365 | That many days, as before |
| Over 365, not finite, or not a number | The sentence with no number, as before |

`returnsWindowDays()` itself turns 0, a missing value and anything that is not a number into its default (14), so a store whose setting is 0 gets "14 days". The test runs both the starter and the engine for -3, -0.5, 0, "abc", 10.5, 0.5 and 10. The FAQ template leaves out its "Start a return" line when no returns are taken.

**ALREADY_SAVED:** it says "by you" only when the page's last writer is this actor (`actorString`). Another merchant or `system:cutover` gets: "This page was already saved, so it already counts as reviewed. Open it in the editor to read it."

**The route's 503:** the code was already right. A fault-injection test pins it: SQLITE_BUSY on the tenant's `documents` reads answers 503 DATABASE_UNAVAILABLE with `retryable: true`, for both start and markRead, with nothing written. With infraResponse taken out, the answer would be 500 INTERNAL.

### 7. Opening

Tests only. Both review mutations now fail:
- **Rule d's mixed case:** a saved privacy draft not in the set plus a missing returns page gives `offer: null`, while the report's own offer does add the privacy draft.
- **`closedStoreOrder` on a store with a release but no live pointer:** an order after the first release does not count, and an order before it does.

## Acceptance, with evidence

Every new test was run against a mutation of the code it guards: one change at a time with `/private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p6-b2/P6-FIX1/tools/mutate.py`, with the file restored after each run. Every mutation below failed its named test.

| # | Acceptance item | State | Evidence (test, and the mutation that fails it) |
|---|---|---|---|
| 1 | No lone surrogate in a cut hero title or alt | DONE | test-first-run "FIX1 (1): a cut never splits a character…" ('A' + 40 tea emoji gives 'A' + 29 emoji, 59 units; an alt of 'B' + 200 emoji is cut whole; a ZWJ family is never split; publish validation 0 errors). M1: the old `s.slice(0, max)` cut fails it |
| 1 | The manifest has a neutral description while closed | DONE | test-first-run "FIX1 (2): the manifest of a closed store…" (the real route through tenantHandler: closed gives "Opening soon." and no tagline word anywhere in the JSON, with isStoreClosed() true; after publish it gives the tagline, with isStoreClosed() false). M2: `description: siteTagline()` fails it |
| 2 | The first-store summary names the grid's collections | DONE | test-first-run "FIX1 (3): the summary names the collections the live grid shows…": a store synced by the real runCatalogSync with "Zeta big" (10 products, all sold out), "Alpha" (3), "Beta" and "Gamma" (2 each). `Repo.getFeaturedCollections` gives [Zeta big, Alpha, Beta, Gamma], and so do the generator's summary and describeFirstStore's. M3: the old `stockedCollections` summary fails it |
| 2 | Each surviving generator mutation (incl. G18) fails a test | DONE | https check (M4a), hero cut on a long name (M4b), top-collection image order (M4c), alt fallback (M4d), null-count filter (M4e), archived as founder (M4f), the FIRST_RUN_RACE retry (M4g, also fails the gap test), describe.noCollections (M4h), G18 (M4i). Each fails its "FIX1 (4)" test in test-first-run |
| 2 | doc_design is never written alone after a founder save in the gap | DONE | test-first-run "FIX1 (4): a founder save between the checks and the writer never lets doc_design be written alone…". Three cases: a save in the checks-to-writer gap on an absent home; the same on a generator-owned home; and a save inside the writer's batch gap. Each answers founder_started, with only the founder's home and no doc_design. M4j (the design call made even when the home was skipped, which is the old single-call behaviour) fails it |
| 3 | B3/B4 pinned | DONE | test-copy "scanDocumentText (B3)…" (M5b, blanking removed, fails) and "documentTexts (B4)…" (M5c, scanning every string in the body, and M5d, reading undeclared string settings, each fail) |
| 3 | '#1Best' is a claim and '#1a2b3c' is not | DONE | test-copy "CLAIMS '#1': '#1Best', '#1Brand' and '#1 brand' are claims…". M5a, the old rule `#\s?1(?![0-9a-f])`, fails it |
| 3 | Negative or fractional return days match the engine | DONE | test-policy-start "returnsSentence: … 0 or below says no returns; a fraction is rounded down…" and "P6-FIX1: for a negative, zero, fractional or odd returns_window_days, the returns starter says what lib/returns.js does…" (starter text and `returnEligibility` for -3, -0.5, 0, 'abc', 10.5, 0.5, 10). M6a (the old sentence) and M6b (rounding up) fail both |
| 3 | ALREADY_SAVED never says 'by you' wrongly | DONE | test-policy-start "P6-FIX1: ALREADY_SAVED says 'by you' only when this actor wrote the page last…" (another merchant, `system:cutover`, then the same person as owner and as staff). M6c (always "by you") fails it |
| 3 | The policy route answers 503 on a database fault | DONE | test-policy-start "P6-FIX1: a database fault inside the work answers a retryable 503…" (SQLITE_BUSY injected on the tenant client's documents reads; the fault is reached; 503 DATABASE_UNAVAILABLE, retryable, no SQLite words, nothing written). M6d (infraResponse removed) fails it |
| 4 | Rule d's mixed case and closedStoreOrder with releases are pinned | DONE | test-open-checks "FIX1 d. a founder-saved privacy draft not in the set plus a missing returns page…" (M7a, always the report's offer, fails) and "FIX1 test_order: on a store with a release but no live pointer…" (M7b, `<` flipped to `>`, fails) |
| 5 | pnpm test passes | DONE | "102 of 102 suites passed in 243.7s", exit 0 (below) |

## Tests

- `pnpm test`, run with my ports and `CHECKOUT_MODE` unset:

  ```
  TEST_PUBLISH_PORTS=7160,7161 TEST_PUBLISH_SERVICE_PORTS=7162,7163 TEST_PUBLISH_UNDO_PORTS=7164 \
    TEST_PRODUCT_CONTENT_PORTS=7165,7166 TEST_MIGRATE_MAP_SQLD_PORT=7167 MIGRATE_DOCUMENTS_TEST_PORTS=7168,7169 \
    MIGRATE_DOCUMENTS_TEST_WEB_PORT=6160 DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 env -u CHECKOUT_MODE pnpm test
  ```

  Result: **102 of 102 suites passed** in 243.7 s, exit 0. That includes test-perf-docs (the manifest's one pointer read per call), test-release-readers (the closed manifest's neutral brand) and test-failure-matrix (the route walks).
- `env -u CHECKOUT_MODE pnpm build`: exit 0, with `/manifest.webmanifest` dynamic. Its one Turbopack warning is the existing NFT trace through `lib/platform/provision.js` and `app/api/platform/tenants/route.js`, which this item doesn't touch.
- Per-suite counts:

  | Suite | Passed now | Passed before |
  |---|---|---|
  | `node scripts/test-first-run.js` | 40 | 29 |
  | `node scripts/test-copy.js` | 58 | 55 |
  | `node scripts/test-policy-start.js` | 30 | 27 |
  | `node scripts/test-open-checks.js` | 28 | 26 |

- Two existing test-policy-start tests changed their expectations on purpose. -3 and 0 now give the no-returns sentence and 10.5 gives "10 days", where before all three gave the no-number sentence. The `templatesFor` test now uses 'x', 400 and NaN for the no-number case.
- Nothing was left listening on 6160 or 7160 to 7169.

## Known limits

- **Two writer calls, not one batch.** If the home's call writes and the design's call then fails (the database stops answering), the store has a generated home and no design until the next run creates it. P6-OPEN's design rule already handles that state: with `checkOpening`, the first publish makes and offers the slate design. A founder save in the milliseconds between the two calls still lets the design be written, but only right after this run wrote the home itself, never for a home the founder had already started. Making it one batch again needs a guard inside `createFirstRunDocuments` (lib/documents/service.js, P6-GEN-WRITE's file).
- **Grid order versus SQLite:** `gridCollections` sorts titles by code point. That is SQLite's BINARY order for valid UTF-8. getFeaturedCollections also groups by (handle, title, image, image_alt), so two collections with all four the same would be one card there and two here. Shopify handles are unique, so this cannot happen in practice.
- **Under one hour** (a setting such as 0.01 day): the page says no returns are taken, while the engine accepts a return for a few minutes. That promises less than the engine gives, never more.
- **Over 365 days** keeps the sentence with no number, as before. The engine uses the number.
- **Not in this item's brief, so left as reported:**
  - the lone-"stars" rule being looser for every repo-copy scan;
  - the privacy template's "within 30 days" and "cookie settings" sentences (an OQ-25 legal-review item);
  - isReturnsSlug matching slugs such as "returning-customers";
  - the worker's generator call having no time box;
  - the P6-BRAND, P6-OPEN and P6-LOGO-RENDER items owned by other batch 2 items.
- The manifest keeps the store name while closed (as the closed page does), and its colours are whatever `resolvedBrand` gives a closed store (the neutral brand, pinned by test-release-readers).

## Owner checks

- **The grapheme cut on real screens:** on a phone and in desktop Safari, give a store a long name made of emoji or of a script with combining marks (for example Devanagari), with no spaces, then generate. The hero title and the image's alt should end on a whole character.
- **The closed manifest:** on a closed hosted store, open `/manifest.webmanifest` directly. It should say "Opening soon." and not the brand-step description. After the first publish it should show the description.
- **The returns starter on a store with an odd setting** (OQ-25 legal review): a negative `returns_window_days` makes the starter say "We don't accept returns on orders." Confirm that wording, and that rounding 10.5 down to "10 days" is acceptable.
- **The new ALREADY_SAVED words** (shown once P6-OPEN-UI and P6-ONBOARD use markPolicyRead): "This page was already saved, so it already counts as reviewed. Open it in the editor to read it."
- **CI sqld download:** unchanged. The approval of its source and checksum is still the owner's. Nothing under `.github/` was touched.

## Commands

```
node scripts/test-first-run.js
node scripts/test-copy.js
node scripts/test-policy-start.js
node scripts/test-open-checks.js
pnpm test
pnpm build
```
