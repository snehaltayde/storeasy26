# P4-FIX5: the batch 5 review findings no other batch 6 item owns

Branch `cms/p4-fix5`, cut from `5e5ef30` (`cms/phase-1` after batch 5 and its review notes). Plan: `docs/cms-reviews/P4-PLAN.md` and `P4-BATCHES.json` (item P4-FIX5). Requirements: ED-05, OVL-01, MIG-04. Migrations owned: none. The findings come from the "From review" lists in `P4-FIX3.md`, `P4-FIX4.md` and `P4-PROVISION.md`.

This is the author's own report. Reviewers should re-read the code.

Files changed:
- Code: `components/admin/editor/DocumentEditor.js`, `lib/platform/provision.js`, `components/admin/offerFormModel.js`, `components/admin/OfferForm.js`.
- Tests: `scripts/test-product-editor.js`, `scripts/test-editor-shell.js`, `scripts/test-legacy-routes.js`, `scripts/test-provision.js`, `scripts/test-offer-form.js`.
- Docs: this packet.

In the plan's list but not changed: `app/api/admin/catalog/route.js`. Its code was already right; the review asked only for tests, which are in `test-legacy-routes`.

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `editorModel.js`, `ProductForm.js`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`.

Safety: only file databases and the suites' own local `sqld` (ports 7120 to 7129, all stopped) were used. No store was moved to documents mode except file-database test stores. `--hosted` was never passed. The `turso` CLI was never run: the new tests replace it with a stub through a test seam. No Typesense was reached (the suites blank its settings or use a spy). Nothing was written to Shopify. No dev server was started (port 6120 was given to the suites only). No test order was placed by this item.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. See "Tests" for the `pnpm test` and `pnpm build` results |
| Browser verified | **NOT DONE.** Every acceptance item is a unit test that fails without the change (see the table). No desktop Chrome drill was run on the design harness. Owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso, a real `turso` CLI or a real Typesense |
| Production enabled | **NOT DONE.** Nothing was pushed, merged or deployed |

## What and why

- **Editor (P4-FIX3 review).** `openEntry` had no sequence guard. If a founder went from product A to B to C quickly and B's document answered after C's, the store held B while the page was on C. P4-FIX3 made that safe (the form is held back), but the screen then stayed on "Opening C…" until a reload. Also, four things P4-FIX3 did were not pinned by any test: the actions bar and the Earlier versions panel are hidden during a switch, and the "Show all of Shopify's description" details is there.
- **Catalog route (P4-FIX4 review).** Two lines no test protected: the single-product fallback when the published override or template read fails, and `mapLimited`'s batch index (the fixtures had fewer than 8 rows, so a broken index would mislabel "customized" and pin counts on bigger stores with no test noticing).
- **Provisioning (P4-PROVISION review).** An adopted `--db-url` that points at another registered store's empty database could still be moved to documents mode under a new id, which would close that other store to shoppers. And `createDbViaCli` matched the database name as a substring of `turso db list`, so provisioning `shop` while `shop2` exists skipped the create.
- **Offer ids.** The "200 new ids" test flaked once (199 distinct): a 6-hex random ending collided. In real use a clash would make the create route refuse the new offer.

## Design

### (1) Editor (`DocumentEditor.js`)

- New `openSeq` ref beside `productSeq`. `openEntry` takes `mine = ++openSeq.current` first. After `getDocument` answers, and again after `adopt` finishes, it returns without touching anything when a later `openEntry` has started. So only the latest entry's answer is adopted, and `load`, the selection and the switch note are only set for it.
- Nothing else changed. The other two `adopt` callers (`onReplaced` and the reload after a newer version) only re-adopt the document that is already open.

### (2) Catalog route

No code change. New tests:
- A helper turns a live table into a view whose key fails on every row, so each read of it throws (not "no such table", which reads as no row). With `product_content_live` failing, `GET ?product=<id>` answers 200 with the product, empty override, no template, `published: "unavailable"` and the plain note, and logs `catalog_published_unreadable` with part `product`.
- A fixture with 12 more products and 12 more collections. Published content sits only on rows past the first batch of 8 (products 10 and 12, collection 11). The test checks each product's `customized` flag and each collection's pin count belong to that row.

### (3) Provisioning (`lib/platform/provision.js`)

- **Shared database.** The `content_mode` step now also asks `listTenants()` whether another registered tenant (any status) already has this database address. If so the store keeps the old editor, with the plain reason `CONTENT_MODE_REASONS.sharedDb`: "Another registered store already uses this database, so this store keeps the old editor and the other store is left as it is." The order of checks is: a run from before the step, then a store already registered under this id, then the shared database, then the existing fresh or unused-database statement.
- `sameDbAddress(a, b)` compares two addresses after trimming spaces and trailing slashes, putting the scheme and host in lower case, and dropping a file address's leading `./`. Empty addresses never match.
- **Exact name match.** `listedDbNames(output)` reads the first column of each line of `turso db list` (the `NAME` header and blank lines skipped). `createDbViaCli` creates the database only when its exact name is not in that set.
- **Test seam.** `setTursoRunnerForTest(fn)` replaces the CLI call. Production never sets it.

### (4) Offer ids (`offerFormModel.js`, `OfferForm.js`)

- `newOfferId(offer, { names, suffix, taken })`. `taken` is the store's existing offer ids (an array or a Set). If the id is taken, it retries with the next 6-hex ending (`abcdef` → `abcdf0`, wrapping at `ffffff`) until it is free. Stepping instead of drawing a new random ending keeps the id the same on every render of the form for the same offer, so the example cart is not worked out again for nothing.
- `OfferForm` passes `offers.map((o) => o.id)` (the list `OffersAdmin` already hands it) as `taken`.
- The model test no longer uses random endings: it feeds fixed endings that repeat on purpose, so it is deterministic and also proves the retry.

## Acceptance

| Acceptance item | Status | Evidence |
|---|---|---|
| unit: an out-of-order product answer never leaves the editor stuck; actions and Earlier versions hidden during a switch | DONE | `test-product-editor`: "unit (P4-FIX5): A to B to C with B's document answering after C's…". It fails with `DocumentEditor.js` from `5e5ef30` (stuck on "Opening Gamma…"). `test-editor-shell`: "P4-FIX5 rendered: during a switch … the actions bar and the Earlier versions panel are hidden". It fails when `{state && !staleEntity && actions}` is changed to `{state && actions}`, and again when the same is done to the versions panel. The "Show all of Shopify's description" check, added to the P4-FIX3 description test, fails when the `details` is removed from `ProductForm.js` |
| unit: single-product catalog fallback and mapLimited past 8 items are pinned | DONE | `test-legacy-routes`: "P4-FIX5: catalog route: one product (?product=) …" fails when the `.catch((e) => unavailable(e, "product"))` is removed. "P4-FIX5: catalog route: with more than 8 products and collections …" fails when `out[i + j] = done[j]` is changed to `out[j] = done[j]` |
| unit: provisioning refuses a db_url another tenant uses; 'shop' never matches 'shop2' in the stubbed turso list | DONE | `test-provision`: "unit (P4-FIX5): provisioning never moves a database another registered store already uses…" fails with the shared-database check removed. "unit (P4-FIX5): createTenantDatabase through a stubbed turso CLI…" fails when the exact match is put back to `listing.includes(name)` (run with the stub in place; the real CLI was never run) |
| unit: newOfferId never repeats an existing id; the offer-form test is deterministic | DONE | `test-offer-form`: "the model: new ids never collide…" now uses fixed, repeating endings and fails with the `5e5ef30` model. "P4-FIX5: the form's new id is never one the store's offers already use" fixes the form's random ending to `abcdef`, gives the form an offer with that id and checks the POST carries `…-abcdf0`. It fails with `OfferForm.js` from `5e5ef30` |
| unit: pnpm test passes | DONE | See "Tests" |

## Tests

- `test-product-editor`: 29 passed (1 new test, 1 test extended).
- `test-editor-shell`: 32 passed (1 new).
- `test-legacy-routes`: 29 passed (2 new).
- `test-provision`: 32 passed (2 new).
- `test-offer-form`: 62 passed (1 new, 1 rewritten).
- `pnpm test`: 96 of 96 suites passed in 182.0 s (ports 6120, 7120 to 7129).
- `pnpm build`: passes (exit 0; its 2 existing Turbopack warnings).

## Known limits

- `sameDbAddress` compares spellings, not databases. Two different addresses for one database (for example a Turso `libsql://` URL and its `https://` form, or an absolute and a relative path to the same file) are not seen as the same. A store adopted that way could still move. Such a database still has to pass the existing guards (no editor content, and no products, collections, customers or orders when the run did not create it).
- The shared-database check reads the tenant list once, before the guarded UPDATE. Two provisioning runs on the same database at the same moment could both pass it. Provisioning is an operator action run one at a time.
- Provisioning still registers the second store on the shared database (as before this item). Only the move to the new editor is refused.
- `listedDbNames` assumes the database name is the first column of `turso db list`, as in today's CLI. If a future CLI changes that layout, the name is not found and a create is tried; Turso then refuses an existing name, so the run fails in the open rather than adopting the wrong database.
- The offer id retry steps through endings in order. Ids stay unpredictable only through the first random ending. They are not secrets.
- The "Show all" test checks the details' summary and its full text, not that it opens in a browser.

From review:

- Editor: the second openSeq guard (the one after `await adopt(...)` in openEntry, components/admin/editor/DocumentEditor.js) has no test. If I remove it, test-product-editor still passes 28/28. It matters in this case: B's document has answered and B's store is still opening when the founder clicks C. B's code then sets the editor to ready and clears pickRef, selection, focus and the switch note. So a pick that opened C can lose its selected section and its focus. The fix itself is correct; it just isn't pinned by a test. Only the first guard is (removing it fails 1 test).
- Provisioning: sameDbAddress (lib/platform/provision.js) treats only spelling changes of one URL as the same database. It misses the same Turso database written as libsql:// and as https://, the same URL with a different ?authToken= query, and a file database written as a relative path and as an absolute path. Data is still protected when the other store holds content: a database this run did not create still goes through the requireNoStoreData check. But if the other store's database is still empty and legacy, the new tenant could move it to documents. That is a small gap for a later item.
- Provisioning: the shared-database check only keeps the new store on the old editor. The run still finishes 'done' and registers a second tenant on the same database. This is what the brief asked for ('refuse moving to documents mode'), but an operator may expect provisioning to stop. Consider an owner check or a later refusal.
- Provisioning: setTursoRunnerForTest is exported from production code (lib/platform/provision.js). It is server-only and not reachable over HTTP, so it is not a security hole, but it is a test seam that lives in the shipped module.
- Catalog route: the brief says '?handle=', but the route reads '?product=' (a product gid). The new test covers ?product=, which is correct. It forces only the product_content_live read to fail. The surface-template read falls under the same .catch, but it is not made to fail on its own. When I removed the .catch, the test failed, so the fallback is pinned.
- Verified: pnpm test passed 96 of 96 suites in 183.6 s on ports 6320 and 7320 to 7329. I mutated 9 key lines and checked whether the tests catch each one. Caught: the first openSeq guard, the shared-database check, the substring turso match (`includes`), the './' normalisation, the newOfferId clash loop, OfferForm not passing the taken ids, mapLimited's batch index (`out[j]` in place of `out[i + j]`), and the dropped single-product .catch. Survived: only the second openSeq guard (see the first finding). applyContentMode never writes cms_state for a legacy outcome, so the other store on a shared database is left untouched. The changed client files (offerFormModel, OfferForm, DocumentEditor) use no node: APIs, and provision.js was already node-only. The real turso CLI was never run, and nothing was sent to Shopify. The worktree is removed and none of my ports are still listening.

## From review

(empty until reviewed)

## Owner checks

- **Desktop Chrome on the design harness:** open product A, then click B and quickly C in the product list on a slow connection (DevTools throttling). The editor ends on C's form, never on "Opening C…". While "Opening …" shows, there are no Publish, Discard or Earlier versions controls.
- **Staging, before the next provisioning:** provision a throwaway tenant whose name is a prefix of an existing database's name (for example `shop` beside `shop2`) and check the summary says it was created; then offboard it.
- **CI:** the `sqld` download in `.github/` still needs your approval of its source and checksum. Nothing under `.github/` was changed.

## Commands

```
node scripts/test-product-editor.js
node scripts/test-editor-shell.js
node scripts/test-legacy-routes.js
node scripts/test-provision.js
node scripts/test-offer-form.js
PORT=6120 DESIGN_PORT=6120 DESIGN_SQLD_PORT=7120 SHOPIFY_OAUTH_PORT=7127 TEST_PUBLISH_PORTS=7121,7122 TEST_PUBLISH_SERVICE_PORTS=7123,7124 TEST_PUBLISH_UNDO_PORTS=7125 TEST_PRODUCT_CONTENT_PORTS=7126,7128 TEST_MIGRATE_MAP_SQLD_PORT=7129 MIGRATE_DOCUMENTS_TEST_PORTS=7121,7122 pnpm test
pnpm build
```
