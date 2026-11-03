# P1 · GEN-02 · An honest first sync

Branch `cms/p1-gen02`, cut from `bdbe1a7`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:1941-1952`. Migration: `migrations/tenant/0020_sync_runs_resumable.sql` (the number reserved for GEN-02).

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. New suite `pnpm test:first-sync` (49 passed, 0 failed, 6 of 6 repeat runs green), `test:jobs` gained three cases (15 passed), and the whole gate `pnpm test`: 45 of 45 suites passed, 882 tests, 0 failures. `next build` passes. See Test results |
| Browser verified | **NOT DONE.** No dev server or browser was run for this item (no port was assigned). The card is rendered in the suite with `react-dom/server`; see the browser drills below |
| Staging verified | **NOT DONE.** Nothing ran against real Shopify, Turso over HTTP or a hosted tick |
| Production enabled | **NOT DONE.** Nothing pushed, deployed or migrated. Migration 0020 has run only on throwaway local file databases |

## The bugs, reproduced first

The new suite was written first and run against the untouched code at `bdbe1a7` (a scratch export of that commit with the suite copied in). Whole run: `4 passed, 39 failed`. The ones that show the reported bugs on the real code path:

```
✗ connecting Shopify queues the first sync, and the queue finishes it across ticks, none past 60 seconds
   the connect request itself was killed: expected truthy
✗ …and the next tick picks up at that cursor, not from zero, and finishes exactly
   run: expected "complete", got "running"
✗ a page write whose answer is lost and which the db layer retries: the page counts once
   sync failed: SQLITE_CONSTRAINT: UNIQUE constraint failed: product_images.id expected truthy
✗ a page write whose answer is lost and which the db layer does NOT retry: re-read, then carry on
   sync failed: socket hang up expected truthy
✗ a handle reused by a new Shopify product doesn't block the sync on the old row
   sync failed: SQLITE_CONSTRAINT: UNIQUE constraint failed: products.handle expected truthy
✗ one page is all or nothing: a bad row leaves the whole page unwritten and the position unmoved
   only page 1's rows: expected 30, got 40
✗ Shopify keeps failing on page 3: the console says so in plain words while it retries
   still running (the queue will retry): expected "running", got "failed"
```

What they mean, in order:

1. **A big first sync is killed and never finishes.** The connect callback ran the whole sync in its `after()`. With each Shopify page taking 7 simulated seconds, a 600-product catalog needs about 200 seconds, so the function was killed at 60. No job existed, so the ticks that followed did nothing, and the run sat at `running` for ever.
2. **A killed run is never resumed.** The old run recorded a cursor "for diagnostics" only. Nothing read it back.
3. **A write whose answer was lost failed the whole sync.** `bdbe1a7`'s `lib/db.js` retries a write after `fetch failed`. Images and variants were plain `INSERT`s, so the retry of a statement that had already committed hit `UNIQUE constraint failed: product_images.id`, and the sync failed. With the no-retry rule on `claude/gallant-keller-7d3213`, the same blip fails it with `socket hang up` instead.
4. **A reused handle blocked every later sync.** A product recreated in Shopify with the handle of one deleted upstream (webhook missed) failed `UNIQUE(handle)`, so the sync could never get past that row and the prune that would have removed the old row never ran.
5. **A page was not all or nothing.** A bad row on page 2 left ten of that page's products written.
6. **A failed page had no retry and no plain message.** The run failed at once with Shopify's raw text, and the console only showed a toast with it.

The other 33 failures were features that did not exist yet (no progress read, no retry, no `hasConfirmedSync`). The four that passed on the old code (prune after a failed products phase, no index on a failed run, a double write, the Storefront source) are kept as regression cover.

## What was built

**A sync is now a recorded run that moves one page at a time** (`lib/sync.js`):

```
products pages → collections pages (⇄ member pages) → prune → search index → complete
```

- **A step fetches one Shopify page and commits it in one batch** with the run's new position: products, images and variants (or collections and memberships) plus `UPDATE sync_runs SET cursor = …, pages_done = pages_done + 1`. So a runner killed anywhere leaves the run at its last committed page.
- **The commit is guarded.** The batch starts with an update that only matches if this runner still holds the run, at the phase and `pages_done` it read. If that matched nothing, the second statement (`INSERT INTO sync_runs (id) SELECT ? WHERE changes() = 0`) re-inserts the run's own id, the primary key refuses it, and the whole batch rolls back. A runner that lost its lease, or a retry of a batch that already committed, writes nothing.
- **After any write error the step re-reads the run** before deciding. If the run moved on by exactly this step under this runner's lease, the commit landed and only the answer was lost: carry on. If another runner owns it now, stop. Otherwise the error is real.
- **Every write is idempotent**: upserts, delete-then-insert of a product's images and variants inside the same batch, `ON CONFLICT DO UPDATE` on child rows, and memberships with `INSERT OR REPLACE … JOIN products` so only products in this database are linked (Admin collections list drafts too). A row that holds a product's handle under another id is removed first (deleted or renamed upstream).
- **Long collections don't make long steps.** A collection with more than 250 members becomes a "tail" (`sync_runs.member_tails`), drained 250 members per step in phase `members` before the next collections page. In the suite a 600-member collection is read over its collections page plus two member steps, and keeps Shopify's order.
- **Prune runs only in the `prune` step**, which only the last collections page (or last member page) can reach. Its guard requires `phase = 'prune'` in the database, so a partial generation can't reach the deletes even through a bug in the calling code (proved on a forged run). The rule is unchanged from S30: delete rows not stamped with this generation and not written since the run started. **Search indexing runs only after that**, in the `index` step, and only then is the run `complete`.
- **One runner at a time**: a lease on the run row (`lease_owner`, `lease_until`, 90 seconds, renewed by every commit). A killed runner frees the run within 90 seconds.
- **Resume keeps the run.** `sync_runs.cursor` is now read back as the products position; `collections_cursor` is the collections one. Paging is sorted by ID (Admin and Storefront), so a cursor stays valid across hours: under `UPDATED_AT` a product edited mid-sync jumps behind the cursor, is never seen and is then pruned.

**The queue gives the run time** (`lib/platform/sync-jobs.js`, `lib/platform/worker.js`, `lib/platform/jobs.js`):

- One job per run (`catalog_sync`, key `catalog_sync:<tenant>:<run>`). Each time it runs it does one slice, at most 40 seconds and never past the caller's deadline, then requeues itself (pending, due, fresh attempts, back of the line) until the run completes.
- `runDueJobs` takes a `budgetMs`. With one, long jobs are leased too, run after the others, see the deadline, and a job not reached in time is handed back with its attempt. Without one, long jobs are left alone, so a shopper route's `after()` (account, quiz) never picks up a sync slice. The tick route and the operator's "run due jobs" pass 50 seconds.
- A slice that fails after committing pages requeues after a minute with a fresh budget, so a flaky store still finishes. A slice that gets nothing in counts toward the five attempts. When the queue gives up, the run is marked failed (dead-letter hook), so the console shows a failure instead of "running" for ever. Errors no retry can fix (401, 403, 402, 404, 423, ACCESS_DENIED, no credentials, a changed Shopify source) fail the run at once.
- Three things give a running sync CPU time: the `after()` kick from whoever started it (about 45 seconds straight away), the tick (`/api/jobs/tick`, the durable path, OQ-19), and the console's status poll while the founder watches.

**The founder sees it** (`lib/admin/sync-view.js`, `components/admin/SyncProgress.js`):

- Progress reads from `sync_runs`: `running`, `retrying`, `stalled` (no progress and nobody on it for 30 minutes), `failed`, `complete`, or `none`. The view carries a headline, a detail line and, for trouble, a plain message. Shopify's count (`productsCount`, Admin only, exact counts only) gives "240 of 600 products so far"; without it, "240 products so far".
- The card polls `GET /api/admin/sync` every 3 seconds while a sync runs. It is on the dashboard, first, whenever the latest sync isn't complete, and on Settings ("Products from Shopify", which replaces "Catalog sync" and its toast). Failure shows the plain message, "Your store keeps everything already brought in.", and **Try again**, which resumes the same run from where it stopped. While the queue is retrying it says so, says when the next try is, and offers **Try again now**.
- Raw errors never reach the founder. `plainSyncError` maps them to sentences such as "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes." and "Shopify stopped letting Storeasy into your store. Contact support to link it again, then try again."

**For GEN-01**: `confirmedCatalogSync()` and `hasConfirmedSync()` in `lib/sync.js`. Yes only when the most recent run finished every page, the prune and the index. No, with the reason, for none, running, stalled and failed, and for a store whose products came in before runs were recorded.

**Files.** New: `migrations/tenant/0020_sync_runs_resumable.sql`, `lib/admin/sync-view.js`, `lib/platform/sync-jobs.js`, `components/admin/SyncProgress.js`, `scripts/test-first-sync.js`. Changed: `lib/sync.js` (rewritten around steps; webhook functions and `indexTypesense` kept), `lib/shopify-admin-catalog.js` and `lib/shopify.js` (one-page fetchers, ID order, `countProductsAdmin`, `fetchCollectionMembersPageAdmin`; the fetch-all functions now loop over them), `lib/platform/worker.js`, `lib/platform/jobs.js`, `lib/admin/onboarding.js`, the routes in the caller table plus `app/api/jobs/tick` and `app/api/platform/queues`, the dashboard and settings pages, `components/admin/SettingsAdmin.js`, `components/platform/PlatformAdmin.js`, `docs/onboarding.md`, `scripts/sync.js`, `scripts/tenant-sync.js`, `scripts/test-jobs.js`, `scripts/test-copy.js`, `package.json` (`test:first-sync`).

## How each caller now runs

| Caller | Before | Now |
|---|---|---|
| Connect callback (`app/api/connect/shopify/callback/route.js`) | Whole sync in a best-effort `after()`; big catalogs told to use the CLI | Records the run and queues its job **before** the response, kicks the first slice in `after()`; the tick and console finish it. Page copy: "Your products are on their way in. The store console shows how far along it is." |
| Console Sync now (`POST /api/admin/sync`, platform) | Whole sync inline, inside 60s | Starts the run (or joins the one under way), kicks a slice, answers 202 with progress. `{retry: true}` resumes a failed or stuck run. `{searchOnly: true}` still reindexes inline |
| Console progress (`GET /api/admin/sync`, new) | none | Progress from `sync_runs`; for a role that may run a sync, also gives a running sync its next slice after the response |
| Scheduled reconcile (`/api/jobs/sync-catalog`) | Whole sync per tenant inline, first 3 tenants by default | Queues a run for every active tenant (or the first `limit`), spends the rest of its 45 seconds on first slices, answers 202. A tenant with no Shopify link is reported, not crashed |
| Operator sync (`POST /api/platform/tenants/[id]`) | Whole sync inline | Queues, kicks, answers 202 `{queued, runId}`; the operator console's toast says so |
| CLI `pnpm tenant:sync <slug>` / `pnpm sync` | Whole sync in memory | Same page steps, run to the end in the process, no time limit. Joins a queued sync already under way instead of racing it |
| Legacy `_default` store (no control plane) | Whole sync inline | No queue: Sync now and the console poll each run an in-process slice (about 45 seconds) under the run's lease; any failure fails the run (no queue to retry) and the card offers Try again. `pnpm sync` as above |
| Webhooks (`applyWebhook`) | `writeProduct`/`writeCollection` as separate statements | Same functions, now one atomic batch each |

## Acceptance

Unless noted the command is `node scripts/test-first-sync.js`. A fake Shopify answers every Admin and Storefront query the real fetchers send, and throws on any other network call. A simulated clock gives each Shopify call a duration, and any invocation that runs past 60 simulated seconds is killed mid-call: its promise never resolves, nothing after it runs, leases stay held, exactly as when the platform ends a function. Routes are the real route files, called with real tenants, real sessions and real file databases; `after()` is captured so the suite runs it inside the same invocation.

### 1. A founder sees progress during a first sync of a large catalog

**Tag: unit (route) + rendered. Status: pass. Browser drills D1, D5 and D6 still needed.**
- `✓ the founder sees progress during it: running, N of 600, rising`. Between ticks of the 600-product sync, `GET /api/admin/sync` (as a support login) returned `running` with "N of 600 products so far", the total from Shopify's count, never going backwards, then `complete` with "600 products".
- `✓ running: headline, N of M, and a progress bar at the right value`: the card's markup, `role="progressbar"` with `aria-valuenow="40"` for 240 of 600.
- `✓ console poll: while the founder watches, each poll gives the sync its next slice (no tick needed)`.
- `✓ a support login reads progress but never gives the sync work`.
- Source guard: `✓ the dashboard shows the card while a sync isn't complete; settings uses it too`. The dashboard page itself was not rendered (it needs a request), so where the card sits is drill D1.

### 2. A failed sync shows a plain message and a retry

**Tag: unit (route) + rendered. Status: pass. Drills D2–D4.**
- `✓ Shopify keeps failing on page 3: the console says so in plain words while it retries`: state `retrying`, the exact message, `retryAt` set, Try again offered, no raw text (`500`, `GraphQL`, `HTTP`, `upstream`, `admin`).
- `✓ …after the queue gives up the run is failed, keeps its rows, and the console shows the plain message and a retry`: job `dead`, run `failed`, 60 rows kept, the stale row not pruned, headline "Your products didn't finish coming in".
- `✓ Try again resumes the same run at page 3 and finishes it, with no duplicates`: `POST {retry: true}` → 202 `resumed`, same run id, only pages at positions 60 and 90 fetched, counts exact, the stale row pruned only now.
- `✓ a refusal no retry can fix (401) fails the run at once, with a plain message about the link`.
- `✓ starting with no Shopify link answers with a plain message, not an internal one` (409).
- `✓ a flaky store that fails now and then still finishes: pages that got in reset the retry budget` (six failures, more than a job's five attempts).
- Rendered: `✓ failed: the plain message, kept rows, and a Try again button`, `✓ retrying: a warning, when it tries next, and Try again now`, `✓ stalled, none, complete, and a role that can't run a sync`.
- `✓ the card's own requests are the ones the route answers (Try again → resume)`: the card's `requestSync`/`readSync` helpers, through a stubbed `fetch`, into the real route.

### 3. A job killed mid-page resumes from the stored cursor, with no duplicate or pruned rows

**Tag: unit. Status: pass.**
- `✓ killed while fetching page 4: three pages kept with their position, nothing duplicated or pruned`: cursor = end of page 3, `products_fetched` 90, 91 rows (90 + the planted stale row), the stale row still there, product 0 (planted from an "older sync" with a retired variant) holding exactly its Shopify variants.
- `✓ …and the next tick picks up at that cursor, not from zero, and finishes exactly`: the first page fetched after the kill is at the stored cursor, no fetch from the start, pages 4 and 5 only, `products_fetched` 150 (not double-counted), every count exact, the stale row pruned after completion.
- `✓ killed after a page's write committed but before the answer: the next runner moves on to the next page`: pages fetched `[0, 30, 60, 90, 120]`, none twice.
- Merge note cover: `✓ a page write whose answer is lost and which the db layer retries: the page counts once` and `✓ …does NOT retry: re-read, then carry on`. The first uses this branch's `lib/db.js` (which retries `fetch failed`); the second uses an error it doesn't retry (`socket hang up`), which is how every unknown-outcome write behaves on `claude/gallant-keller-7d3213`.
- Both lost-answer tests run a single slice and require that same slice to finish (no waiting out its own lease). `✓ the old code path (pnpm sync) gets through a lost answer too`.
- `✓ one page is all or nothing`, `✓ one runner at a time`, `✓ a runner whose lease was taken over can't commit its stale page afterwards`, `✓ a stale runner's older copy of a page never wins over the runner that took the run over`, `✓ a variant row left under the wrong product can't block a page`, `✓ a handle reused by a new Shopify product doesn't block the sync on the old row`, `✓ writing the same product twice leaves exactly one copy`.

### 4. Negative: generation never runs on a failed or partial sync

**Tag: unit. Status: pass for the function GEN-01 will call. GEN-01 itself is not built, so nothing calls it yet.**
- `✓ no sync yet`, `✓ products from before runs were recorded`, `✓ partial (a slice that stopped part way)`, `✓ stalled`, `✓ failed`: each `confirmed: false` with its reason.
- `✓ complete: confirmed, with what it holds` and `✓ a newer sync that is failing or under way: not confirmed until it completes`.
- Pruning, which the spec ties to the same rule: `✓ a run failing in the products pages prunes nothing`, `✓ …in the collections pages (every product in) prunes nothing`, `✓ a run killed on its very last page prunes nothing`, `✓ the database itself refuses a prune for a run that isn't at its prune step (forged run)`, `✓ only the complete run prunes, and search indexing runs once, after the prune`, `✓ a failed inline run never indexes`.

### 5. Negative: a sync over the 60-second route limit still finishes

**Tag: unit. Status: pass in simulated time. Real hosted timing is a manual check (needs OQ-19).**
- `✓ connecting Shopify queues the first sync, and the queue finishes it across ticks, none past 60 seconds`: the real connect callback (state, HMAC, token exchange against the fake), then the real tick route. 600 products (one with 120 variants), 120 collections (one with 600 members, one with a draft product). The sync needed more than three route limits of Shopify time; it ran over the connect invocation plus several ticks; no invocation ran past 60 seconds and none was killed; every products page was fetched exactly once; every count is exact and the 600-member collection keeps Shopify's order.

### Every caller still works

`✓ manual: a second Sync now while one runs joins it (one run, one job)`, `✓ scheduled: …queues every active store and the tick finishes them`, `✓ operator: the platform console's sync queues and answers at once`, `✓ CLI (pnpm tenant:sync): runs to the end in one go, and joins a queued sync already under way`, `✓ legacy _default store (no control plane): Sync now and pnpm sync both run page by page in-process`, `✓ storefront-token stores page through the Storefront API the same way`. `test:sync-generations` (unchanged, 8 passed) still proves S30's generation rules through `runCatalogSync`, and `test:platform-sync` (unchanged, 15 passed) the webhook writes.

`node scripts/test-jobs.js` adds: `✓ long jobs (catalog_sync) only run for a caller with a budget, and after the others`, `✓ a job leased but not reached before the deadline is handed back with its attempt`, `✓ a handler that has more to do requeues its job: pending, due, fresh attempts, back of the line`.

## Merge notes

- **`claude/gallant-keller-7d3213` (`lib/db.js` stops retrying unknown-outcome writes).** Every sync write is inside a guarded batch, and the step reconciles by re-reading after any write error, so it is correct whether the batch is retried or not. Both behaviours are tested (see acceptance 3). That branch also edits `lib/platform/worker.js` (the Razorpay replay and a new `payment_confirm` handler). `git merge-tree --write-tree 84875f7 claude/gallant-keller-7d3213`: `worker.js` auto-merges with both handlers in. It reports three conflicts, `components/checkout/CheckoutFlow.js`, `package.json` and `scripts/test-shopify-push.js`, and the same three appear for `bdbe1a7` against that branch, so they come from batch A, not from GEN-02 (in `package.json` the clash is batch A's `test:offers` line; this branch's `test:first-sync` line merges cleanly). On a scratch export of that merge result, with `package.json` taken from this branch: `test:first-sync` 49/0, `test:jobs` 15/0, `test:sync-generations` 8/0, `test:platform-sync` 15/0, and that branch's own `test:db-retry` 17/0 and `test:payment-recovery` 20/0. Nothing was merged.
- **Deploy order: tenant migration 0020 before this code.** Without it, starting a sync fails (`sync_runs` has no `phase`) and the console shows the generic plain message. This branch ran no migration anywhere hosted.
- **Migration number**: 0020 only. 0018 and 0019 are reserved for OVL-06 and COM-03 and don't exist here; the runner applies files in name order, and 0020 doesn't depend on them.
- **Queue changes other work will see** (PUB-07, OVL-17): `runDueJobs({ budgetMs })`, `LONG_JOB_TYPES`, `requeueJob`, `releaseJob`, `makeJobDue`, `getJobByKey`, `leaseJobs({ excludeTypes })`, and a handler's second argument `{ deadline, now }`. Existing handlers ignore the new argument.

## Deviations from the spec

1. **Paging order is ID, for products and collections, Admin and Storefront** (was `UPDATED_AT` reversed, and `BEST_SELLING` on the Storefront API). Needed for a cursor that lives across ticks. Every product listing sorts explicitly (`lib/repo.js`), so storefront order doesn't change; the one unordered reader, `getProductHandles`, has no caller.
2. **Member tails are their own steps** (phase `members`, column `member_tails`). Not in the spec; without it one large collection could make a single step outrun its route.
3. **Reused handles are cleaned up in the page write** (the old row holding the handle is removed). Not in the spec, but a missed delete webhook plus a recreated product otherwise blocks every later sync.
4. **Webhook writes became atomic batches too** (`writeProduct`, `writeCollection`), since they share the statements.
5. **`hasConfirmedSync` is strict:** the most recent run must be complete. A newer sync under way or failed says no even when an earlier one finished. The owner may prefer "any complete run"; see manual check M9.
6. **Queue behaviour changed for everyone:** long jobs need a budget, run last, and are handed back unrun when time is up; a requeued job moves to the back of the line (its `created_at` is bumped, so `queueStats().oldest_pending_min` counts from the last requeue for sync jobs).
7. **Scheduled reconcile covers every active tenant by default** (was the first 3), because queueing is cheap. Answers 202.
8. **Founder copy changed:** Settings section "Catalog sync" → "Products from Shopify", setup step "Sync your catalog" → "Bring in your products" (its link now goes to Settings), the connect page's sync sentence, and the operator console's sync toast.
9. **`POST /api/admin/sync` rate limit 2 → 6 per minute**, so Try again and Sync now don't trip it.
10. **Two existing suites changed:** `scripts/test-copy.js` gained one stub for the new import in `SettingsAdmin`; `scripts/test-jobs.js` gained three cases. No existing assertion changed.
11. **The rendered tests compile the card with Next's SWC**, as AU-05 did, not the JSX runner spec 8.15 proposes (it doesn't exist yet). No new dependency.

## Known limits

- **The durable path needs a running tick (OQ-19).** With no tick configured and the console closed, a big first sync gets its first ~45 seconds after connect and then waits. It shows "running" for up to 30 minutes, then "stopped partway" with Try again. Opening the console while it runs keeps it moving (the poll), but a stalled card doesn't poll: the founder has to press Try again. Nothing was measured on a hosted runtime.
- **One step can still be slow: a products page of 30 products with very many variants.** Variant tails past 50 are still drained inside the page (one call per 100 extra variants). A page needing more than about 55 seconds of Shopify time is killed every time, and the run stalls. Member tails are split; variant tails are not.
- **Pages written before a failure are live.** The old code wrote nothing until it had the whole catalog in memory, so a failed sync changed nothing. Now each page is written as it arrives: new and changed products appear before the run finishes, and a long collection can show only its first members until its member pages are in. Nothing is pruned until completion, so nothing disappears early.
- **A resumed run keeps its original start.** A product deleted upstream after its page was copied stays until the next complete sync or its delete webhook; an edit made after its page was copied waits for its update webhook or the next sync. The window is the run's whole length, which can now be hours.
- **The handle cleanup can remove a fresh row in one race:** a webhook writing a new product with a handle in the seconds between a page's fetch and its commit, where that page holds an older product with the same handle. The next webhook or sync puts it back. Catalog overrides for a product id removed this way stay orphaned, as they do after a prune.
- **Storefront-token stores** still get only the first 250 members of a collection (no tail drain on that API), as before, and no "of N" total.
- **Atomicity is proven on the local file client only.** The guard relies on `libsql.batch` being one transaction and on `changes()` inside it; both hold in `@libsql/client`'s local client in the suite. Turso over HTTP is untested (spec 8.15 already flags `libsql.batch` as unproven through this wrapper).
- **`productsCount` and `sortKey: ID` against real Shopify are untested.** The fake answers the query shapes the code sends. If `productsCount` errors, progress shows "N products so far" with no total; nothing else depends on it.
- **The time model is simulated.** Pages "take" seconds in the suite; database writes take none. The budgets (40-second slice, 8-second minimum per page, 50-second tick, 45-second kick) leave about 10 seconds for writes and bookkeeping, not measured on Turso.
- **Runs from before this branch** (no `phase`) can't be continued. A request finds one still marked running and marks it failed with "an older sync stopped partway and can't be continued", then starts fresh.
- **An operator replaying a dead sync job** from the queue inspector doesn't resume its failed run (the job sees the run failed and completes). Try again, or Sync now, does.
- **The setup checklist's new hint text** has no test of its own (`test:provision` still checks the step's done flag). Drill D7 covers it.
- **Support and staff logins** see progress but their polls don't move a sync; only roles allowed `sync.run` (admin, owner) do.
- **Search** is still deleted and rebuilt in the final step, so search falls back to the database for those seconds, as before.
- **`next build` passes, with two warnings that are not from this branch:** both trace `lib/platform/migrate.js` through `app/api/platform/overview/route.js` ("the whole project was traced"), files GEN-02 doesn't touch. The build doesn't run the edge storefront against anything; GEN-02 changes no edge code (`lib/sync.js` stays free of `node:` APIs anyway).

## Browser drills still needed

Desktop Chrome on the design harness. The harness tenant (`design`, `.design-tenant.db`) has no Shopify link, so states are set by writing a `sync_runs` row directly (local file database only), for example with `sqlite3 .design-tenant.db`. Re-seed the harness first so migration 0020 is applied.

- **D1. Progress on the dashboard.** Insert a running run: `INSERT INTO sync_runs (id, status, phase, started_at, updated_at, products_fetched, products_total, lease_owner, lease_until, source, started_by) VALUES ('sync_drill', 'running', 'products', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 240, 600, 'drill', strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'), 'admin', 'connect');`. Open `/admin/dashboard`. Pass: the card is first on the page, reads "Bringing in your products from Shopify" and "240 of 600 products so far", the bar is at about 40%, no button. Screenshot at desktop width and at 375px (no sideways scroll).
- **D2. Failure and Try again.** `UPDATE sync_runs SET status='failed', error='Admin GraphQL HTTP 502: Bad Gateway', lease_owner=NULL, lease_until=NULL WHERE id='sync_drill';` and reload. Pass: "Your products didn't finish coming in", "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes.", "Your store keeps everything already brought in.", a Try again button, nothing raw (no 502, GraphQL). Press Try again: the harness has no Shopify link, so pass is a "Couldn't start" banner reading "Storeasy isn't linked to your Shopify store. Contact support to link it, then try again." and no raw text.
- **D3. Retrying.** `UPDATE sync_runs SET status='running', error='fetch failed', lease_owner=NULL, lease_until=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='sync_drill';`. Pass: a warning (amber) banner with the plain message and "Try again now".
- **D4. Stalled.** `UPDATE sync_runs SET error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id='sync_drill';`. Pass: "Bringing in your products stopped partway", "It stopped before finishing. Try again to pick up where it left off.", Try again.
- **D5. Settings card.** `/admin/settings`: the section nav says "Products from Shopify" and jumps to the card. With the D1 row the card shows progress; after `UPDATE sync_runs SET status='complete', phase='done', products=600, collections=120, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='sync_drill';` it shows "Your products are in", "600 products and 120 collections, brought in just now." and "Refresh from Shopify".
- **D6. Polling stops when done.** With the D1 row and the network panel open on the dashboard: `GET /api/admin/sync` about every 3 seconds. Mark the row complete (D5's update) without reloading. Pass: the card turns into "Your products are in" within a few seconds and the requests stop.
- **D7. Setup checklist.** With the D1 row, `/admin/setup`: the step reads "Bring in your products" with "Bringing in your products from Shopify: 240 products so far", and its link opens Settings at the card.
- **D8. Keyboard and screen reader basics.** Tab reaches Try again and Enter presses it; the progress bar has a label and `aria-valuenow`; the headline area is `aria-live="polite"`.
- **D9. Support login.** Sign in as a support member (or an operator under a support grant). Pass: the card shows, with no buttons.

## Manual checks for the owner

- **M1. Migration 0020 on each hosted tenant database, before deploying this code.** Your call and your command; nothing here ran it. Pass: each tenant's `schema_migrations` lists `0020_sync_runs_resumable`, and Settings shows the sync card instead of a generic error.
- **M2. OQ-19: a running tick.** Decide on the private staging deploy or wait for the hosting phase. Pass: on staging, a first sync of a store with 2,000+ products finishes with the console closed, through ticks alone.
- **M3. A real Shopify store, first connect, on staging.** A development store with over 1,000 products and a collection over 250 products. Pass: the dashboard shows "N of M" with M equal to Shopify's active product count, the sync completes, and product, variant and collection member counts match Shopify admin.
- **M4. `productsCount` and `sortKey: ID` on API 2025-10.** Pass: `sync_runs.products_total` is filled on the M3 run, and a product edited in Shopify while that sync runs is present (with its edit, through its webhook) afterwards.
- **M5. Kill on staging.** Redeploy or cancel the function mid-sync on staging. Pass: the next tick resumes at the stored cursor (no products page fetched twice in the logs), and counts are exact at the end. This is also the only check of batch atomicity and the `changes()` guard on Turso over HTTP.
- **M6. `after()` time on the hosting plan.** Pass: within a minute of connecting, `sync_runs.products_fetched` is above zero before any tick has run.
- **M7. A real phone and Safari.** The dashboard card at phone width in Safari. Pass: readable, no sideways scroll, Try again works.
- **M8. Founder wording, your decision.** "Bring in products", "Products from Shopify", and messages that say "Contact support to link it" (this assumes founders have a support channel; linking Shopify is operator-run today). Pass: you accept the words or give replacements.
- **M9. What GEN-01 counts as "confirmed", your decision.** Now: the most recent sync must be complete. Alternative: any complete sync, even if a newer one is running or failed. Pass: you pick one.
- **M10. Webhooks still keep products fresh on a real store.** Edit a product's title in Shopify. Pass: the storefront shows it within a minute (webhook writes are now one batch).

## Test results

Baseline before any change, `pnpm test` at `bdbe1a7`: `44 of 44 suites passed in 34.4s`.

Final, `pnpm test` on the committed code (`84875f7`): `45 of 45 suites passed in 36.3s`, exit 0. Then `node scripts/run-tests.js --verbose` for the counts (all 45 green again, 40.0s). Format is passed/failed:

```
test:orders 27/0            test:shipping 12/0          test:shopify-push 13/0
test:shopify-boundary 41/0  test:hardening 11/0         test:offers 27/0
test:offers-admin 8/0       test:events 16/0            test:tenancy 9/0
test:platform-sync 15/0     test:admin-console 9/0      test:cms-api 20/0
test:page-editor 53/0       test:refs 8/0               test:sections 15/0
test:cms 11/0               test:platform-ops 9/0       test:tenant-boundary 24/0
test:identity 22/0          test:authz 14/0             test:platform-core 15/0
test:jobs 15/0              test:sync-generations 8/0   test:first-sync 49/0
test:order-projection 14/0  test:commerce 10/0          test:privacy 11/0
test:security 19/0          test:content 19/0           test:releases 25/0
test:themes 10/0            test:storefront 15/0        test:surfaces 15/0
test:billing 14/0           test:provision 9/0          test:reporting 6/0
test:tenant-ops 9/0         test:marketing 4/0          test:customers 9/0
test:commerce-exp 18/0      test:growth 21/0            test:agency 16/0
test:w6 16/0                test:copy 52/0              test:media-upload 119/0
```

882 passed, 0 failed. `test:perf` was not run (a measurement, not a gate). `test:jobs` went from 12 to 15 (three new cases); `test:first-sync` is new. `node scripts/test-first-sync.js` alone, six times in a row: 49/0 every time. `pnpm exec next build`: compiled successfully, exit 0 (warnings above).

The reproduction run: `node scripts/test-first-sync.js` in a scratch export of `bdbe1a7` with the suite copied in: `4 passed, 39 failed` (see "The bugs, reproduced first").

## Mutation check

Scratch runner, not committed: each mutation is applied to the real file, `test-first-sync`, `test-jobs` and `test-sync-generations` run (240-second limit each; a hang counts as caught), and the file is restored. `git diff` was checked afterwards: no mutation left behind.

**Round 1: 40 mutations, 37 caught, 3 survived.**

Caught, with the first test that failed: no abort when the guard misses (forged prune); guard ignores the phase (forged prune); stop after the first products page, products always from page 1, skip member tails, slice ignores its deadline, requeue ignored, no after() kick, connect queues but doesn't kick, support poll nudges, member positions restart per page, prune after the first page (the >60s test); handle-clash cleanup removed (handle test); child rows as plain inserts (orphan variant test); long jobs leased without a budget, long jobs not last, release keeps the attempt, out-of-time jobs not handed back, requeue keeps attempts (`test-jobs`); no dead-letter hook, no retry on failure (the queue-gives-up test); nothing permanent (401 test); 5xx message changed, no retrying state, retry not noted on the run (retrying test); retry starts over (Try again test); confirmed on any finished run (failed test); progress doesn't reset the retry budget (flaky store test); poll never nudges (console poll test); lease always granted (one runner test); no products total (progress test); no stalled state (stalled test); no progress bar (rendered test); prune skipped (kill test's final prune); legacy has no in-process slice (legacy test); pre-run stores read as never synced (legacy rows test); lost runner not told (takeover test).

Survivors, and what was done:
1. **No reconcile after a lost answer.** The run still finished, because the next runner picked it up once the lost runner's lease ran out (90 seconds). Real cost, no test. The two lost-answer tests now run one slice and require that same slice to finish. Caught in round 2.
2. **Commit not fenced by the lease** (`lease_owner` dropped from the guard). The `pages_done` guard alone refused the stale runner in the existing takeover test, because the new runner had already finished. Added "a stale runner's older copy of a page never wins over the runner that took the run over": runner A holds an old title, B takes over with the new one, A tries to commit first. Caught in round 2.
3. **CLI doesn't join a queued run.** Equivalent: `runCatalogSync`'s own join check repeated what `requestCatalogSync` already does. The duplicate was removed from the code, and the CLI join test still passes.

**Round 2:** the two survivors re-run against the new tests: both caught. Round 1's 37 were not re-run after the test changes; the changes only added cases and narrowed the two lost-answer tests (their old form is kept as "the old code path (pnpm sync) gets through a lost answer too").

Not mutated: the setup checklist hint text, the operator console toast, the Settings section label and the connect page sentence (copy; drills D5, D7 and M8), and `countProductsAdmin`'s error path.
