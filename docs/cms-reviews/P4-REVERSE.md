# P4 · REVERSE · Moving a store back to the old editor, and moving it again (MIG-04, OVL-17)

Branch `cms/p4-reverse`, cut from `5e5ef30` (`cms/phase-1` with batch 5 merged). Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 5, 7, 15; sections 0, 3, 5 and 6, OQ-9) and `P4-BATCHES.json`. Requirements: MIG-04 (the reversal, and the re-cutover rule "restores overlays from document versions"), OVL-17 (outbox rows at the reversal, the reindex kick). Also the P4-CUTOVER review items assigned to this batch.

This is the author's own report. Reviewers should re-read the code.

## Files

In the plan's list: `lib/migrate/reverse.js` (new), `lib/migrate/backfill.js`, `lib/migrate/flip.js`, `lib/migrate/cutover.js`, `lib/migrate/report.js`, `scripts/reverse-documents.js` (replaces SCAFFOLD's stub), `scripts/migrate-documents.js` (one change, see "The rehearsal command"), `scripts/test-migrate-reverse.js` (replaces SCAFFOLD's placeholder; no `package.json` change), `docs/cms-reviews/P4-CUTOVER-RUNBOOK.md`, `docs/cms-reviews/P4-CUTOVER.md` (two Known-limits lines), this packet. `scripts/test-migrate-documents.js` is in the list and was not changed (the CUTOVER review's tests went into this item's suite, part 7).

Beyond the list (see Known limits): `docs/cms-reviews/drills/P4-REVERSE/` (the drill script, its results JSON and four screenshots).

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `lib/migrate/map.js`, `map-entities.js`, `check.js`, `runs.js`, `state.js`, `preconditions.js`, `allowed-differences.js`, the untracked `docs/CMS_*.md` files, the two named `.claude/worktrees`. No migration. No new dependency. Nothing under `lib/migrate/` uses a `node:` API, and no storefront route imports it.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 184.9 s. `test:migrate-reverse` 14 passed, 0 failed (about 3 s, file databases only). `test:migrate-documents` 58 passed. `pnpm build` passes (one try failed fetching a Google font, a network flake; the retry passed; its one warning is the old `next.config.mjs` NFT trace) |
| Browser verified | Yes, on the design harness in desktop Chrome (`next dev` on `localhost:6100`, sqld on 7100 to 7103, seeded `--p4`): move, rename, move back, move again; 21 passed, 0 failed (`docs/cms-reviews/drills/P4-REVERSE/results-reverse.json`) |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. `--hosted` was never passed. Every real reversal is an owner step (runbook section 9) |
| Production enabled | **NOT DONE.** Nothing pushed or merged; no real or hosted store moved |

## What and why

MIG-04: a store moved to the new editor must be able to go back to the old editor, with nothing the new editor wrote left for shoppers to read, the old editors working at once, and the founder told plainly what no longer shows. And a store that goes back must be able to move again later without losing the product edits made in the new editor (OQ-9's default). The owner's runbook needs the steps, the stuck-run recovery and a message for the founder.

## Design

### The reversal (`lib/migrate/reverse.js`)

**The plan** (`reversalPlan`, read only): the release to go back to (`cms_state.cutover_release_id`, or NULL for a store that had no release), every live product and collection row, and what was edited in the new editor that won't show any more:
- per product, the overlay columns its live row sets (name, description, photos, product type and brand shown, photos per option, seo), plus "extras" when the live row's legacy-derived columns (sections, badge, pairs, layout) differ from what the move put live (the document's `migrated` log row's version, through `liveRowFor`);
- per collection, pins or layout that differ from what the move put live;
- every other document published in the new editor since the move (`publish_log` rows that are not `migrated`, from the cutover's flip time), named with `report.js plainName`;
- unpublished drafts changed since the move (not the old editor's drafts the move carried over, which the old editor still holds: `updated_by` is not the cutover's and `updated_at` is after the flip).

Names come from the catalog (Shopify's product and collection titles). The digest (`planDigest`) covers ids, fields and values, not the catalog names, so a webhook renaming a product while the store is paused doesn't stop the reversal; the report prints the names read at the time.

**Preconditions**, before anything is written, each a plain refusal: the store is on the new editor (`ALREADY_LEGACY`, `UNKNOWN_MODE`), no run holds it (`OPEN_RUN` for a paused reversal, `BUSY` for a move), it was moved there by the cutover tool (`NEVER_MOVED`: a store made on the new editor after P4-PROVISION has no old content to go back to, and putting it on the old editor's empty drafts would show shoppers an empty store), the ledger holds 0021 to 0025, the release to go back to is still stored and is an old-editor release (`TARGET_MISSING`, `TARGET_NEW_EDITOR`), the hosted rule (`preconditions.js hostedRefusal`: `--hosted --confirm <id> --backup-ref <iso>`), and the digest of the reversal dry run the owner read (`NO_DIGEST`, `STALE_DIGEST`).

**Step 1, one batch:** `documentsGuardStatement()`, `cms_state` → `migrating`, the run row (kind `reverse`, step `locked`, the plan and its digest in the report). From here every live-row publish, Undo and discard aborts in its own batch (LIVEROW's documents guard); old writers still refuse (legacy guard). A lost answer is found by reading the run row back.

**Under the pause:** the plan is read again; its digest must be the dry run's (`CHANGED`, the store goes back to the new editor in one batch under `migratingGuardStatement(run)`, run `stopped`).

**Step 2, ONE batch under `migratingGuardStatement(run)`** (`reverseStatements`): every `product_content_live` and `collection_content_live` row copied into `content_live_reversed` (`json_object` of every column, under the run's id); one `search_outbox` row (reason `reverse`) per product row; both live tables emptied; the pointer moved to the release from before the move (guarded on that release still existing, then the `release_state` id 2 abort when nothing matched) or to NULL; `cms_state` → `legacy`; the run finished (`done`, step `reversed`). A failed batch is read back (landed = success). A crash before this batch leaves the store on the new editor, paused, live rows intact (`--resume` or `--abort`); after it, a complete old-editor store.

**Search:** `kickSearchReindex()` (P4-SEARCH), best effort, reported. The outbox rows were written in step 2, so a failure only delays search until the job retries or the next full sync.

**Step 3, the look:** `config.theme_pin` and its stamp `theme_pin_at` are removed in one targeted control-plane statement (`json_remove`), so `kits.js themePinOf` reads the old `config.theme` again (the legacy pin), then read back (one retry) and reported (`reset`, `env` for the env store, or `failed`). The tenant cache is refreshed.

**`--resume`:** finishes a paused reversal; on a store a finished reversal left with search or the look failed, it does those two again. **`--abort`:** only between step 1 and step 2: one batch under `migratingGuardStatement(run)`, mode back to `documents`, run `aborted`. After step 2 it refuses (`AFTER_REVERSAL`: already back on the old editor). **`--status`:** read only, plain words.

### Moving again after a reversal (`backfill.js`, `flip.js`, `cutover.js`, `report.js`)

OQ-9's default, applied only when the store has a finished reversal (a first move restores nothing):
- `recutoverPlan`: for every product content document, the overlay settings (title, description, photos, brand and type shown, photos per option) of its **latest published version** (`documents.published_version_id`, which nothing on the old editor moves), and every document's published version as it stands.
- `applyRestore`: each restored product's mapped draft and published body get those settings merged in, so the editor shows them and the next publish keeps them; the published body gets a new content-addressed version, its refs and its live row. A product the old editor holds nothing for gets its existing document back (empty body plus the overlay). Then `keptPublished`: every document whose content was published in the new editor and differs from what goes live now (kept as older versions, never republished, counted).
- `cutover.js mapForRun` and `report.js dryRun` both apply it, so the dry run's digest is the move's.
- The backfill is unchanged: it writes only the legacy-derived live columns, so a shopper on the old editor never sees a restored name early.
- `flip.js restoreStatements`: the restored overlay columns are written ONLY in the flip batch, one UPDATE per product on the live row with the restored version, then the `release_state` id 2 abort if it matched nothing (a restore never goes missing quietly). A rehearsal leaves them out (so its page comparison stays exact) and says so.
- The dry run gains two sections, only on such a store: "Edits that come back at the move" (by product name: `“Micronised Creatine”: new name (“Drill Renamed Bestseller”).`) and "Published in the new editor before, kept as older versions". The move's report prints "Edits that came back" and the kept list.

### The rehearsal command (`scripts/migrate-documents.js`)

The drill found that the command's `--rehearsal-run` never passed on a store with a running hero test: P4-FIX4 made `hero-test-variant` match the hero by the slug that `--make-routes` writes into `routes.json`, but the command's capture didn't pass that slug on (`captureRoutes(…, { heroExperiments })`). It now reads it with `migrate-render.mjs readHeroExperiments(routesFile)`. The first drill run failed at "the rehearsal on a copy passes" with exactly the hero's three text differences; with the change it passes.

### The P4-CUTOVER review items (`cutover.js`)

- A failed `agency_grants` read after the lock now stops with its own words: "We couldn't read who else has access to this store just now, so it went back to the old editor and nothing else changed. Try again in a few minutes…" (`RECHECK_AGENCY_UNREAD`), checked before the source-hash comparison.
- A store whose `cms_state` row is missing is refused before anything is written: "This store's record of which editor it uses is missing, so the move didn't start and nothing was changed…" (`NO_MODE_ROW`).
- P4-CUTOVER.md and the runbook (step 6) now say plainly that the source-hash recheck does not cover brand or theme edits made on the control plane during the move.

## Acceptance, with evidence

"Fails without" names a mutation from the table under Tests (each one change, the suite run, the file restored).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Unit (test-migrate-reverse): after reversal shoppers see Shopify values (effective reads raw), product and collection live rows sit in content_live_reversed and nowhere else, search_outbox has a row per affected product and a spy drain indexes Shopify's titles for them, the pointer equals cutover_release_id (NULL case covered), mode is legacy and old editors save at once | **DONE** | Part 1, two cases: two products renamed (one with extras, one without; description and brand too), then the reversal with a spy Typesense client and dummy localhost values: `Eff.byIds` and `Eff.productPage` give Shopify's name and brand; both live tables empty; `content_live_reversed` holds exactly the rows that were live (compared column by column), under the run; one `reverse` outbox row per product row, all drained, and the spy's last upsert for each handle carries Shopify's title, only to this store's collection; pointer `rel_fixture_v3` = `cutover_release_id`; mode legacy; `Store.setBlock` saves at once. The NULL case: a `--store-open` store moved with no release goes back with the pointer NULL. Fails without: R1, R2, R3 |
| 2 | Unit: a hook that publishes a product title between step 1 and step 2 is refused in-batch; a crash injected between steps leaves either the documents store intact or the legacy store complete | **DONE** | Part 2: a product-name publish whose pre-check passed on the new editor runs step 1 of the reversal from its `beforeCommit` hook (the race): its batch is refused (409, the "moving" words), nothing live, no outbox row; `--resume` finishes and the name is in no live row and no copy. A crash before step 2: live rows, pointer and copies equal to before, still paused, shoppers still see the new name; `--resume` finishes. A crash after step 2: legacy, the old pointer, no live row, copies and outbox rows written together; `--resume` does search and the look; a new reversal is refused. The release vanishing under the pause: stopped, back on the new editor, live rows untouched. Fails without: R4 (11 cases), R15 |
| 3 | Unit: the report counts documents-mode publishes, overlay fields and drafts that do not flow back | **DONE** | Part 3: 3 documents published since the move (two products and the announcement bar), 3 publishes, 3 product edits on 2 products, 1 unpublished draft (the 10 drafts the move carried over from the old editor are not counted: they are still in the old editor's tables); the dry run, the report and the founder message say so in plain words. Fails without: R11 |
| 4 | Unit: re-cutover after reversal restores the overlay titles from document versions, shows them only after the flip, and publishes no other documents-mode content (counted as kept versions) | **DONE** | Part 6: two products renamed (one with photos too) and the announcement published in the new editor; reversal; the move again: right before the flip (hook) shoppers still see Shopify's names and the backfilled live rows hold no title or gallery; after it both names and the photo are back, the editor's draft carries the name, and the live row is the document's published version; the announcement live is the old editor's, the new-editor text is an older version, counted in the report. A store reversed with nothing edited restores nothing; a store never reversed never restores. Fails without: R5, R6, R12, R13 |
| 5 | Unit: theme_pin is reset and reported | **DONE** | Part 4: a store with a kit, moved (pin written); a failed control-plane write is reported ("Couldn't be set back."), `--status` says the last steps didn't finish, `--resume` resets it: no `theme_pin` or `theme_pin_at` key, `themePinOf(config)` is the old `config.theme`, reported `{kit: glow, version: 2}`, "Set back to the old editor's look." Fails without: R7 |
| 6 | Drill (harness): cut over, rename a product, reverse, see the Shopify title, re-cut over, see the renamed title | **DONE** | `docs/cms-reviews/drills/P4-REVERSE/drill.mjs`, 21 passed, 0 failed: the `--p4` store; a copy in a second local sqld and a real `--rehearsal-run` (passed), the dry run, the move; the owner signs in and renames "Micronised Creatine" to "Drill Renamed Bestseller" through the editor's documents API (open, save, publish); Chrome at 1440 px shows the new name; the reversal's dry run names it (`“Micronised Creatine”: new name (“Drill Renamed Bestseller”)`), the reversal (with its digest) prints the founder message; the store is legacy on the release from before the move, live rows copied aside; Chrome shows "Micronised Creatine"; `--status` says it is back; a fresh copy and rehearsal of the reversed store pass, the dry run lists the edit that comes back, the move; Chrome shows "Drill Renamed Bestseller". Screenshots: `product-legacy-before-1440.png`, `product-renamed-in-new-editor-1440.png`, `product-after-reversal-1440.png`, `product-after-second-move-1440.png`. The first run failed at the first rehearsal (the hero fix above) |
| 7 | Unit: the reversal report lists each affected product by name with the edits that no longer show; the re-cutover dry run lists by name the edits that will come back | **DONE** | Part 3: `“<product>”: new name (“Protein Bar Max”), description, extra sections, badge, products shown together or layout.` and `“<product>”: product type shown.` in the dry run, the reversal report and the founder message, plain words checked above Details. Part 6: `“<product>”: new name (“Back Again Extras”), photos.` and `new name (“Back Again Plain”).` under "Edits that come back at the move", and the announcement under "Published in the new editor before, kept as older versions". Fails without: R6, R12 |
| 8 | Unit: reverse --status prints the run's step in plain words; --abort after step 1 returns the store to documents mode with publishing working; --abort after step 2 refuses | **DONE** | Part 5: "Your store is being moved back to the old editor. Started: 2026-11-05 10:00 UTC, 12 minutes ago. Done so far: the store was paused for going back…", with `--resume` and `--abort`, read only; the move tool's status names the reversal too. `--abort`: documents, run `aborted`, a product publish goes live. After step 2: refused, "already back on the old editor". Nothing under way: "nothing to stop". Through the command too (part 5, the CLI case). Fails without: R8 |
| 9 | unit: a failed agency read after the lock and a missing cms_state row each stop with their own words | **DONE** | Part 7: the control-plane client fails the `agency_grants` read only after the lock: stopped with `RECHECK_AGENCY_UNREAD`, "couldn't read … Try again", not "changed since the dry run", back on the old editor. A store with no `cms_state` row: refused `NO_MODE_ROW` with its words, no run and no row written. Fails without: R9, R10 |

## Tests

| What | Result |
|---|---|
| `node scripts/test-migrate-reverse.js` | 14 passed, 0 failed (about 3 s) |
| `node scripts/test-migrate-documents.js` | 58 passed, 0 failed (sqld and proxy on 7101-7102) |
| `pnpm test` | 96 of 96 suites passed in 184.9 s (final run, after every change here) |
| `pnpm build` | passes; one warning, the old `next.config.mjs` NFT trace |
| Drill | 21 passed, 0 failed |

Mutations (`…/scratchpad/p4-b6/P4-REVERSE/mut/run.py`). Every one failed at least one case:

| # | Mutation | Failed |
|---|---|---|
| R1 | step 2 keeps the product live rows | 4 cases (part 1 both, the crash case, the re-move) |
| R2 | no outbox rows at the reversal | part 1, the crash case |
| R3 | the pointer not moved back | 4 cases |
| R4 | step 1 doesn't pause the store | 11 cases, the in-batch publish case among them |
| R5 | the backfill writes the overlay title and gallery | the re-move case ("the backfill wrote no overlay column") |
| R6 | no restore at a move after a reversal | the re-move case |
| R7 | theme_pin not removed | the look case, the crash case |
| R8 | abort leaves the store paused | the abort case, the vanished-release case |
| R9 | no agency words | part 7 |
| R10 | no missing-row refusal | part 7 |
| R11 | drafts counted from before the move | the report case |
| R12 | published content not counted as kept | the re-move case |
| R13 | the flip writes no restored columns | the re-move case |
| R14 | a store that started on the new editor not refused | the refusals case |
| R15 | no recheck under the pause | the vanished-release case |

## Known limits

- **A file beyond the plan's list: `docs/cms-reviews/drills/P4-REVERSE/`** (the drill script, its results JSON and four screenshots), as P4-CUTOVER did. DRILLS (batch 7) may move the script into `scripts/drills/p4/`.
- **The reversal has a dry-run digest but no rehearsal.** Plan section 0 asks reversal for a matching digest and a passing rehearsal. The reversal goes back to the exact release that was live before the move, and the old editor's tables can't change while a store is on the new editor (every old writer refuses in its own batch), so what shoppers get back is what they had before the move; the dry run names everything that stops showing. The owner check "after the reversal, the canaries look as before the move" covers the rest.
- **The rehearsal of a move after a reversal leaves the returning product edits out** of the copy's switch, so its page comparison stays exact; the dry run lists them by name, the unit test proves they come back, and the runbook asks the owner to check those products by hand after the move.
- **Everything else published in the new editor stays as older versions** (OQ-9 default): pages, the home page, the design, collection pins, and product extras published there don't go live again at the next move (legacy wins); they are counted and named in both reports.
- **A page deleted (archived) in the new editor makes the next move refuse** (`ARCHIVED_DOCUMENT`, P4-CUTOVER): archive is terminal. Its words tell the founder to delete it in the old editor too. Not changed here.
- **Unpublished drafts made in the new editor stay there**; at the next move they are saved as "kept" older versions and the old editor's drafts win.
- **Files used only by new-editor versions** still count as used after the reversal (their refs stay), which is the safe direction for media delete.
- **A restored product that left Shopify** gets its live row back with the overlay; shoppers never see it (the effective read joins the catalog).
- **The look on the env store (`_default`)** has no control-plane row: reported "Not needed for this store."
- **The control-plane writes (the look, the search job) are not in the store's batch**, as for the move: a failure is reported and redone by `--resume`.
- **Hosted batch atomicity** is proven on file databases and sqld only; the staging check is an owner step (runbook step 0.3).

From review:

- Plan rule not met (needs an owner or orchestrator decision): P4-PLAN.md section 0, line 42, says 'Cutover and reversal also need --backup-ref, a matching dry-run digest and a passing rehearsal report.' reverseDocuments() asks for a digest but no rehearsal. The builder raised this openly under Known limits and in the report, and the item brief only repeats the '--hosted --confirm --backup-ref rule'. Before the first real reversal, someone has to accept this change to the plan or add a rehearsal step.
- Test gap on a guard that matters (code is right, suite does not check it): removing the in-batch abort after the pointer move in reverseStatements() (`INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0`) still passes all 14 tests. The suite's 'release disappears' case is caught earlier by the digest recheck. My test removed the release inside the step 2 window (beforeReverse hook). With the guard, it stops with TARGET_MISSING and the store stays intact on the new editor. Without it, the mutated code leaves the store on the old editor with its pointer still on the new editor's release. Please add that case.
- Test gap: removing migratingGuardStatement(runId) from step 2 (reverseStatements), from the abort/unlock batch (unlockBatch), or documentsGuardStatement from the lock batch (lockBatch) still passes all 14 tests. All three guards are in the code as the brief asks, but no test runs an --abort or a second run against step 2 at the same moment. The builder's 'fails without R4' evidence covers the publish batch's own guard, not the lock batch's guard.
- Test gap: part 6 cannot tell 'restore from the latest published version' apart from 'restore from the draft'. A mutation that reads d.draft instead of the published version body passes all 14 tests. I checked the real code with my own case: published 'Pub Name' plus a newer unpublished draft 'Draft Only Name', then reverse, then move again. Shoppers see 'Pub Name', and the draft is kept as an older version. So the code is right, but this should be a unit test.
- Untested pieces in the move-again path: removing the per-product abort in flip.js restoreStatements, the `p.kind === 'migrated'` skip in applyRestore's kept-versions count, and the 'gallery' entry in the reversal report's OVERLAY_EDITS all pass the suite. Restoring the edits in the rehearsal too, against the stated design, also passes.
- Editor shows a page as published when shoppers can't see it: a page created and published in the new editor, then reversed, then moved again, keeps documents.published_version_id and published_hash equal to its draft, but it is not in the new live release (it is correctly counted as kept). So the editor shows it as published with nothing to publish, while shoppers get a 404. Publishing it again does make it live. Shoppers see nothing wrong. Suggest setting such unmapped documents' published_version_id to NULL in the flip, or warning the founder by name.
- Report wording: the reversal dry run says '1 unpublished draft stays in the new editor', but after the next move that draft is replaced by the old editor's draft and survives only as a kept older version. The Known limits say this, but the founder-facing line could say so plainly.
- A product deleted from Shopify while reversed gets its live row back with the new-editor title at the next move (the old LIVEROW change refuses to publish such products). Shoppers never see it, as the Known limits say. Noted only.
- No unit test covers the fix to scripts/migrate-documents.js (heroExperiments passed to captureRoutes); only the drill exercises it. The builder said so in the report.

## From review

- **Batch 5 (P4-CUTOVER), assigned here:** the agency read failing after the lock now has its own words; the missing `cms_state` row is refused with its own words before anything is written; the source-hash limit for control-plane brand and theme edits is in P4-CUTOVER.md and the runbook. Tested in part 7 (R9, R10).

## Owner checks

- **Staging, before the first real reversal:** move a staging store, rename a product, run the reversal from the runbook (section 9): the product shows Shopify's name on its page, in collections and in search; the old editors save; the platform console shows the old kit.
- **Typesense stores (`_default` included):** after a reversal, search shows Shopify's names within a few minutes (the reindex job and the tick must run); after the next move, the restored names.
- **The founder message:** read the report's "A message you can pass on" with the founder; confirm the wording.
- **OQ-9:** the default (product names, descriptions, photos, brand and type shown come back at the next move; everything else published in the new editor stays as older versions). OK?
- **PITR:** record `--backup-ref` just before each real reversal, as for the move.
- **CI:** the sqld download in `.github/` still needs the owner's approval of its source and checksum (nothing under `.github/` changed).
- **Phone and Safari:** not run (desktop Chrome only).

## Commands

```
node scripts/test-migrate-reverse.js               # pnpm test:migrate-reverse
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 COPY_SQLD_PORT=7103 PLATFORM_CACHE_MS=1000 \
  node docs/cms-reviews/drills/P4-REVERSE/drill.mjs
pnpm test
pnpm build
```
