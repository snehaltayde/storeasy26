# P4 · DRILLS · Browser proof of the founder tasks on the harness, the runbook followed literally, and the owner checks (OVL-04, MIG-02, MIG-03, MIG-04, ED-05, MED-03, OVL-17)

Branch `cms/p4-drills`, cut from `08f4b7c` (`cms/phase-1` after batch 6). Plan: `docs/cms-reviews/P4-PLAN.md` (sections 0, 3, 5, 7 R4 "a runbook drill a non-developer can follow") and `P4-BATCHES.json` (batch 7). Phase 2 plan sections 0, 3 and 6 and the harness rules (`P1-HARNESS.md`) apply.

This is the author's own report. Reviewers should re-read the code and the results files.

**P4-FIX6 ran beside this item and had not merged when these drills ran.** Every drill here ran against this branch's tree (`08f4b7c` plus this item's drill and doc files), not the integrated tree. The `reverse` stage and the P4-REVERSE drill should be run again once FIX6 has merged (`node scripts/drills/p4/run.mjs reverse,reverse-drill,runbook`).

## Files

In the plan's list: `scripts/drills/p4/run.mjs` (new stages), `cutover.mjs`, `product.mjs` (the `product`, `collection` and `search-rename` stages), `routes.mjs`, `media.mjs`, `reverse.mjs`, `runbook.mjs` (all new), `lib.mjs` (shared helpers added), `local-tenants.mjs` (the batch 2 review fixes), `docs/cms-reviews/P4-CUTOVER-RUNBOOK.md` (wording and missing-step fixes found by the runbook drill only), `docs/cms-reviews/MANUAL-CHECKS.md`, this packet. `picker.mjs`, `editor.mjs`, `docs/cms-reviews/drills/P4-FIX3/fix3.mjs` and `docs/cms-reviews/drills/P4-REVERSE/drill.mjs` were run from `run.mjs` and not changed (each still runs as its own process).

Results: `docs/cms-reviews/drills/P4-DRILLS/` (results per stage, the run summary `results-run.json`, `runbook-steps.json`, screenshots, and `items/` with copies of the item drills' results). The item drills also rewrote their own results and screenshots in their folders (`P4-PICKER/`, `P4-EDITOR/`, `P4-FIX3/`, `P4-REVERSE/`, `P4-HARNESS/`), and the P3 item drills theirs (copies in `P3-DRILLS/items/`).

Not touched: `package.json`, `.github/`, `lib/` (no app code), `components/`, `app/`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, the files P4-FIX6 owns (`lib/migrate/*`, `scripts/migrate-documents.js`, `scripts/reverse-documents.js` and its tests), the untracked `docs/CMS_*.md` files, the two named `.claude/worktrees`. No migration, no dependency.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` and `pnpm build` (see Tests). Drills are not test suites (they need the harness and Chrome) |
| Browser verified | Yes, desktop Chrome (installed Chrome 156, headless, 1440 px) on the design harness (`next dev` on `localhost:6100`, sqld on 7100 to 7102, the restore-drill copy on 7103): every stage, see "The run" |
| Staging verified | **NOT DONE.** Nothing ran against a hosted store; `--hosted` was never passed; no Typesense (the SQL search and a spy client only); nothing written to Shopify |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

Phase 4 built the product and collection editor, the move to the new editor (cutover), the move back (reversal), the search reindex and the media archive, each proved by unit tests and a few item drills. This item proves the founder's tasks end to end in desktop Chrome on a store that was actually moved by the owner's command, follows the owner's runbook literally to find what only a developer would know, and gathers every owner check of phase 4 into `MANUAL-CHECKS.md`.

## Design

### The runner (`scripts/drills/p4/run.mjs`)

`node scripts/drills/p4/run.mjs [stage,stage…]` runs each stage on a fresh seed, one after the other, and writes `docs/cms-reviews/drills/P4-DRILLS/results-run[-<stages>].json`. Ports: `DESIGN_PORT`, `DESIGN_SQLD_PORT` (three in a row) and `COPY_SQLD_PORT` (default `DESIGN_SQLD_PORT + 3`) for the restore-drill copy; 3017 is refused. It sets `PLATFORM_CACHE_MS=1000` for the harness it starts, so a store's row pointed at a copy is seen within a second or two. `P4_DRILL_SCRATCH` names the folder for copies and reports (default: a new temporary folder).

- `seed`, `smoke`: P4-HARNESS's, unchanged.
- `cutover`, `product`, `collection`, `routes`, `media`, `reverse`, `search-rename`, `runbook`: this item's, in-process (`runDrill` per stage, results in `P4-DRILLS/`).
- `picker`, `editor`, `fix3`, `reverse-drill`, `p3`: the item drills (P4-PICKER, P4-EDITOR, P4-FIX3, P4-REVERSE) and the phase 3 item drills (`scripts/drills/p3/run.mjs items`, each reseeding `--p3`), each in its own process (they run on import and `runDrill` refuses a second harness); their results are copied to `P4-DRILLS/items/`.

### Shared helpers (`lib.mjs`)

`harnessContext()` (ports, local addresses, the harness env, the three operator commands), `copyDatabase`, `copyServer` (the second sqld), `rehearse`, `moveStore` (copy, rehearsal, dry run, the move, each a check), `movedP4Store(drill, name, { beforeMove })` (a fresh `--p4` store, an optional look or set-up on the old editor, then the move), `revokeAgency`, and the editor helpers from P4-EDITOR's drill (`publishHere`, `waitSaved`, `searchFor`, `pickInto`). Every address goes through `assertLocal` first.

`moveStore` rehearses once more when a rehearsal fails on the home page's hero alone (finding F2), and says so in the notes.

### The stages

- **cutover**: P4-CUTOVER's drill as a stage: the rehearsal on a copy (the store's own database untouched), the canaries in Chrome before and after (the same text, sections and templates), the shopper captures of every route compared, `--status`, `--abort` with nothing to stop, an old editor's save refused in plain words with nothing written, the old Storefront screen opening the editor.
- **product** (OVL-04, OVL-06, MED-03): on the moved store the founder opens a product from the editor's product list and gives it a new name, a description of its own (typed in the rich text surface), a library photo (the media picker), a badge, a template, a "goes well with" product and a module (Add a module, title and words), all through the form; publishes in the editor's panel. A fresh browser sees each on the product page, the card in search and on its collection, the cart (drawer and cart JSON, no `catalog_title`), the checkout's review step, the confirmation and the shopper's order page. A cash on delivery test order goes to `snehal@mediastic.in` and is cancelled at once (after a check that neither the store's row nor the harness env holds a Shopify domain, token or secret, or a Razorpay secret; no card details are ever entered). The console's order page shows the new name with "Shopify title: …, SKU: …" under it. Reset to Shopify on the name, description and photos, publish: the shopper sees Shopify's name and description again, search no longer finds the new name, and the order keeps the name it was bought under.
- **collection** (ED-12): a collection's pinned product (its last product, pinned first) and a different template, published; the shopper sees both.
- **routes** (ED-05): before the move, 13 old addresses open their old screens (no redirect). After it, the 11 fixed old screens open the editor on their own document; Catalog for a product and a collection, Upsells for a product, an old page, a missing page and `new` open where that thing is edited; the bare Catalog page stays with its product-list link (Bundles and Quiz); Publishing is Recently published; every Setup link opens a working screen and none points at an old editor; the Saved templates page lists both templates, "Make a page from this" opens a new unpublished draft, and `cms_templates` is unchanged.
- **media** (MED-03): before the move, through the old Catalog API and Publishing, a fresh photo goes into a product's module and is published, then taken out and published again: it is used only by the older version 3 release, which the move keeps. After the move: the reference index holds it as `release:<id>` only; "Where it's used" says "An earlier published version of your store"; Delete is refused in plain words (no "Delete anyway"), a forced delete too, and the file stays. Delete of the photo the moved product's module uses is refused with "Archive it instead". A fresh file: "Not used anywhere", Archive, "Show archived files", Unarchive.
- **reverse** (MIG-04): rename in the new editor, the reversal's dry run (names the product and its new name), the reversal, its message and `--status`; the shopper sees Shopify's name; the old screens open again; an old Storefront save (with the revision it loaded), an old Catalog save and an old publish go through and the shopper sees them; the move again (its dry run lists the edit that comes back); the shopper sees the renamed name and the old editor's announcement and badge; the old Storefront screen leads to the editor again.
- **search-rename** (OVL-17, owner answer OQ-1 (b)): a rename published in the browser; storefront search (the SQL path) finds the new name and not the whole old name; the product's `search_outbox` rows are done. Then, in the drill process only, a second rename is published in-process against the harness database (`withHarnessStore` and `withTenant`, no server call), with dummy Typesense values set in this process only (`localhost`, a port nothing listens on, checked, and a fake key) and a drill-only collection name on the in-process tenant object; `drainSearchOutbox({ client: spy })` upserts one document with the second name into that collection only, and every row is done. The harness server's Typesense values stay blank (`BLANKED_ENV`); no catalog sync runs. Undo twice in the browser (Publishing, Recently published): search finds the old name again and neither new one; the Undo's rows are done too.
- **runbook** (MIG-02, MIG-03, MIG-04): see "The runbook, followed literally".

## The runbook, followed literally

`runbook.mjs` follows `P4-CUTOVER-RUNBOOK.md` section by section on a fresh `--p4` store (`design`). Each command is the runbook's own file, run with the harness's env (never `.env.local`) and without `--hosted --confirm` or `--backup-ref`. What happened at each step is in `results-runbook.json` (checks and notes) and `runbook-steps.json` (the command as written, what ran, what needed developer knowledge, the fix).

Order: 0.1 the updates and the check; 3.1 `restore-drill.js --keep`; 3.2 `serve-copy` (new, below) in its own process; 3.3 the route list; 4 the dry run (Not ready: an agency has access), the agency's access revoked in Chrome on the Settings page, the dry run again (Ready to move, the digest); 5 the rehearsal (Result: passed); Ctrl-C on serve-copy (the row points back); the copy and its `-wal`/`-shm` deleted; **8 a deliberate stop in 'migrating'**: the move is started and its process killed right after its backfill (`runbook.mjs --crash-after backfilled`: the move's own test hook, `__cutoverTestHooks.afterStep`, in a wrapper process only; the command itself is unchanged), `--status` (plain words, which step finished, `--resume` or `--abort`), an old editor's save refused with nothing saved, the shopper still served, `--abort` (back on the old editor, `--status` says so, the old Storefront screen opens); the old rehearsal now refused ("The store changed since that rehearsal…"), so sections 3 to 5 again; 6 the move; 7.3 "Recorded." under "The store's look" and `theme_pin` in the store's row; `--status`; 7.1 the shopper canaries (home, a page, the journal, the product with modules and goes-well-with, the pinned collection, the cart); 7.2 the console's Editor link, home, a product and a collection open, Storefront, Catalog and Upsells lead to the editor; a rename in the new editor; 9 the reversal's dry run, the reversal, `--status`, the shopper sees Shopify's name on the page, in the collection and in search, the old Storefront screen works; then sections 3 to 6 again (the dry run lists the edit that comes back) and the shopper sees the new editor's name.

### Steps that needed developer knowledge, and the runbook fix for each

| Section | What a non-developer could not have known | Runbook fix |
|---|---|---|
| 0.1 | The code block lists `--all` and `--check --include-env` only; `pnpm migrate` (the env store) was only in the sentence above it, and the check fails with "the env store (_default): behind" without it | `pnpm migrate` added to the code block between them, with the failure it prevents |
| 0.3 and 8 | The runbook quoted "Your store is being updated. Try again in a few minutes."; an old editor's save now answers "This store is moving to the new editor right now, so nothing was saved. Make this change in the new editor once the move is done." | 0.3 and 8 quote the words the store says now |
| 3.2 | "Load the copy into a local sqld database, and point a local control-plane row at that sqld" had no command; a developer wrote both | New `node scripts/drills/p4/runbook.mjs serve-copy --copy restore-drill-X.db --tenant X`: loads the copy into its own local sqld (`COPY_SQLD_PORT`), points the harness's row for X at it, prints the `--db` address, and on Ctrl-C points the row back and stops. The runbook gives the command and when to press Ctrl-C. It still needs the store's row in the harness, which only a developer can copy today (said plainly in 3.2; owner check) |
| 4 | The dry run said "Settings > Team: remove the agency's access", but the agency is its own panel, "Agency access", further down the Settings page | Section 4 says where (Settings, Agency access, Revoke). The report's words are finding F3 |
| 8 → 6 | After `--abort`, the rehearsal made before the stop is refused (the stopped move left copied content in the new editor's tables); the runbook only said the next move takes the old editor's content again | Section 8: after `--abort`, start again from section 3 (a fresh copy, the dry run, the rehearsal), quoting the refusal |
| All | The package scripts load `.env.local` (the hosted control plane); `--hosted --confirm X` and `--backup-ref` are refused on local databases; the commands the tools print next carry `--env-file=.env.local`; on the harness the store and its copy share one row | New section "Practising on the local harness" |

Literal and fine, with no developer knowledge: 3.1 (restore-drill), 3.3 (the route list), 5 (the rehearsal), 6 (the move), 7 (post-checks), `--status` and `--abort`, all of section 9 (the reversal, its words and its message).

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Drill: every stage passes on the harness in desktop Chrome with screenshots under the size limits of P1-DRILLS-C | **DONE** (one known failure, finding F1) | "The run" below: every stage 0 failed. Screenshots go through `scripts/drill.js` `shoot` (palette PNG, at most 300 KB and 6000 px tall, P1-DRILLS-C); the largest is listed under "The run". The one KNOWN check (media: the refusal names the product) is finding F1, recorded as known so it can't pass silently; it is not this item's code |
| 2 | Drill: the p3 stages still pass after reseeding with --p3 | **DONE, with the P3 smoke's refs check as on the base** | the `p3` stage (`scripts/drills/p3/run.mjs items`, each drill reseeding `--p3`): see "The run". The one failing check is the P3 smoke's document refs check, failing the same way on the base (P4-HARNESS acceptance 3); the cause is confirmed below (Known limits) and `scripts/drills/p3/*` and `seed-design-documents.js` are not this item's to change |
| 3 | MANUAL-CHECKS.md lists every Owner check from every P4 packet, each with its packet link | **DONE** | Every phase 4 section has a `Packet: [P4-X.md](P4-X.md)` line (23 packets plus this one); the checks each packet listed that were missing were added (MEDIA, LIVEROW caps, HARNESS, SEARCH, OVL07, EDITOR, EQUIV, CUTOVER's full list in place of "no new checks", PROVISION, FIX4, FIX5, REVERSE), plus the batch-review items the brief named; "Phase 4, batch 7" has the one-list owner steps (each line linking its packets) and this item's own. Checked with a scratch script (each packet's Owner-checks lines against the file); FIX6's are to be added when it merges |
| 4 | Drill (runbook): the runbook is followed literally end to end on the harness, including a stop in 'migrating' recovered with --status and --abort; P4-DRILLS.md lists each step that needed developer knowledge and the runbook fix made for it | **DONE** | `results-runbook.json` and `runbook-steps.json`; the table above |

These are drills, not unit tests: what fails without this change is that the stages don't exist (`run.mjs` before this branch knows only `seed` and `smoke`).

## The run

Desktop Chrome 156 (headless), 1440 px, `next dev` on `localhost:6100`, sqld on 7100 to 7103, on this branch's last commit's code (`08f4b7c` plus this item; P4-FIX6 not merged).

**The in-process stages, one run** (`docs/cms-reviews/drills/P4-DRILLS/results-run.json`; the per-stage files beside it):

| Stage | Passed | Failed | Known | Seconds |
|---|---|---|---|---|
| seed (P4-HARNESS) | 35 | 0 | 0 | 9 |
| smoke (P4-HARNESS) | 16 | 0 | 0 | 25 |
| cutover | 22 | 0 | 0 | 95 |
| product | 29 | 0 | 0 | 73 |
| collection | 9 | 0 | 0 | 51 |
| routes | 17 | 0 | 0 | 122 |
| media | 16 | 0 | 1 (F1) | 57 |
| reverse | 24 | 0 | 0 | 101 |
| search-rename | 16 | 0 | 0 | 49 |
| runbook | 47 | 0 | 0 | 171 |

No rehearsal in this run needed the F2 retry. In earlier runs of the same code the retry fired three times (the `reverse` stage's second move, the `cutover` stage, the runbook's first rehearsal); each time the second rehearsal passed. Before the retry existed, the `cutover` stage failed on it once (7 checks, all following from the refused move).

**The item drills, one run** (`node scripts/drills/p4/run.mjs picker,editor,fix3,reverse-drill,p3`; copies in `items/`):

| Stage | Passed | Failed |
|---|---|---|
| picker (P4-PICKER) | 11 | 0 |
| editor (P4-EDITOR) | 14 | 0 |
| fix3 (P4-FIX3) | 5 | 0 |
| reverse-drill (P4-REVERSE) | 21 | 0 |
| p3: smoke (P3-HARNESS) | 25 | 1 (the refs check, as on the base) |
| p3: routes (P3-ROUTES) | 18 | 1: the harness didn't come up within 3 minutes on a restart mid-drill. Run again alone after clearing the 1.9 GB Next dev cache (`.next`): 31 passed, 0 failed (`items/p3/P3-ROUTES-results-routes.json` is that run) |
| p3: editor (P3-EDITOR) | 22 | 0 |
| p3: design (P3-DESIGN) | 26 | 0 |
| p3: rte (P3-RTE) | 46 | 0 |

The P3 results folders were put back to their committed state after the run (not this item's files); the copies are in `items/p3/`.

**Screenshots**: 48 in `P4-DRILLS/`, the largest 149 KB (`shopper-product-page-1440.png`), all under P1-DRILLS-C's 300 KB and 6000 px (`scripts/drill.js` `shoot`).

**The test order**: one per `product` run, cash on delivery, `snehal@mediastic.in`, cancelled at once (each run's notes give its id and the cancelled row). Nothing reaches Shopify: the stage checks the store's row and the harness env hold no Shopify domain, token or secret first.

## Findings (not this item's files; for the orchestrator)

- **F1 (founder-facing words, not a blocker by the rule: no data loss, nothing a shopper sees).** After a move every product and collection content document is labelled with its type ("Product content", "Collection content"): `lib/migrate/map-entities.js:296` sets `label: documentType(k.type).label`, and `lib/documents/service.js` `labelOf` keeps a live-row document's label forever. So on a moved store the media screen's "Where it's used" and its delete refusal say "Product content (draft)", "Product content (live)" without the product's name (the `media` stage's KNOWN check), and Publishing lists "Moved to the new editor Collection content" for each. A store made after the move (openEntityContent) gets the product's name. Fix: label by the product's or collection's name in the mapper, and relabel moved stores once.
- **F2 (a false rehearsal failure).** `lib/migrate/render-compare.js` `experimentsIn` finds the hero test's ping with a pattern over the raw page; Next streams that data in `self.__next_f.push` chunks and can split a chunk inside the ping. Seen once in the `reverse` stage's second move: the after-capture of `/` held `{"slug":"hero-promise","u"])</script><script>self.__next_f.push([1,"nit":"7084bba8-…"`, so the after side had no hero test, `hero-test-variant` was not applied and the rehearsal failed with three hero differences (the random hero pick); the same stage passed on the next run. It never lets a bad move through (it refuses), but the owner would see a failing rehearsal for no reason. Fix: join the flight chunks before matching. The drills rehearse once more when only the hero differs, and the runbook's harness section says so.
- **F3 (wording).** The dry run's agency line says "Settings > Team"; the panel is "Agency access" on the Settings page (`lib/migrate/report.js:185`).
- **Runbook 3.2 on a real store** needs the store's control-plane row in the harness (CUTOVER's known limit); serve-copy refuses an unknown id in plain words.

## Tests

| What | Result |
|---|---|
| `pnpm test` | 96 of 96 suites passed in 180.2 s (after the drills' last change). An earlier run failed `test:shopify-boundary` (SHOP-01: the drills built console addresses as `${base}/admin/…`, which the scan reads as an Admin REST call); they now use `consoleUrl(base, "/admin/…")` (`new URL`, `assertLocal`), the suite passes, and every stage was run again after that change |
| `pnpm build` | passes; its two warnings are the old ones (nothing in `app/`, `lib/` or `components/` changed) |
| `node scripts/drills/p4/lib.mjs --check` | 3 passed |
| `node scripts/drills/p4/local-tenants.mjs --out "<scratch>/lt test"`, then again with a `.DS_Store` in the folder | 22 passed both times; the `.DS_Store` stays; `results-local-tenants.json` untouched (git status clean for it). `prepareOutDir` on a folder holding only `.DS_Store`: accepted, nothing removed; on `.DS_Store` plus `notes.txt`: refused, both kept |

## Known limits

- **Drills ran on this branch, not with P4-FIX6** (see the top). Run `reverse`, `reverse-drill` and `runbook` again after FIX6 merges.
- **The P3 smoke's refs check** (22 "orphan" refs, P4-HARNESS acceptance 3) fails on the base too. Cause, confirmed: `seed-design-documents.js` `p3State` counts as orphans the refs of every version that is not `kind = 'published'`, and P4-MEDIA now writes refs for checkpoints and Undo-saved versions too (decision 6: every version kind is indexed); on a `--p3` store after the drills, a read of `document_refs` joined to `document_versions` found every non-published ref on `checkpoint` versions (22 versions, 56 refs) and none without a version row, so none is a real orphan. The fix is one line in `p3State` (count refs whose version is missing from `document_versions`, and compare every kind); `seed-design-documents.js` and `scripts/drills/p3/*` are not this item's. Owner check.
- **The stop in 'migrating' is a crash, not a real power cut**: the wrapper (`runbook.mjs --crash-after`) sets the move's own test hook (`__cutoverTestHooks.afterStep`) and kills its process after the backfill step. The command and its recovery are the real ones.
- **The sync pause is not drilled** (a catalog sync needs Shopify): staging only.
- **Search**: the harness has no Typesense; the browser part uses the SQL search, and the Typesense half is a spy client in the drill process (the brief's design). A real Typesense is an owner check.
- **The test order** is cash on delivery on the harness; nothing reaches Shopify (the stage refuses when the store's row or the env names a Shopify store or a payment secret) and the order is cancelled at once.
- **The old-banner page** (ED05's owner check) and **the unreadable live release** (FIX4's) were not drilled: NOT DONE, owner checks.
- **Next dev only, headless desktop Chrome at 1440 px, macOS.** Phone and Safari are owner checks. `next dev` needs the network for Google fonts, so the drills ran outside this session's sandbox (as P4-EQUIV recorded).
- **`serve-copy` lives in `runbook.mjs`** (this item's file) rather than a `scripts/` command with a package script: `package.json` is SCAFFOLD's. If the orchestrator wants `pnpm serve:copy`, that is a SCAFFOLD-owned change.
- **Run time**: the full run is about 12 (in-process stages) plus 9 (item drills) minutes; each moved-store stage does its own rehearsal and move (about a minute).

## Owner checks

All are in `MANUAL-CHECKS.md`, "Phase 4, batch 7":

- The one-list owner steps for phase 4 (migrations and the check; per tenant: dry run, rehearsal, move; hosted batch atomicity; OQ-14; Typesense tenants including `_default`; phone and Safari; theme_pin on hosted; webhook allowed differences; PITR; the quiet window and the founder warning; staff cart-offer publishing (OQ-6); a throwaway tenant on staging (OQ-4); CI sqld).
- Findings F1, F2 and F3: decide or assign.
- Runbook 3.2 on a real store: the store's row must be copied into the harness by a developer for now.
- The sync pause and Typesense: staging only.
- P4-FIX6's owner checks, once it merges.
- Optional: run the drills on your Mac.

## Commands

```
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 COPY_SQLD_PORT=7103 P4_DRILL_SCRATCH=<dir> node scripts/drills/p4/run.mjs
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 COPY_SQLD_PORT=7103 node scripts/drills/p4/run.mjs cutover,product,collection,routes,media,reverse,search-rename,runbook
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p4/run.mjs picker,editor,fix3,reverse-drill,p3
node scripts/drills/p4/runbook.mjs serve-copy --copy restore-drill-X.db --tenant X
node scripts/drills/p4/lib.mjs --check
pnpm test
pnpm build
```
