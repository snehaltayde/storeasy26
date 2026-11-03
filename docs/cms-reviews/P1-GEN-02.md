# P1 · GEN-02 · An honest first sync

Branch `cms/p1-gen02`, cut from `bdbe1a7`. Spec: `docs/CMS_FULL_BUILD_SPEC.md:1941-1952`. Migration: `migrations/tenant/0020_sync_runs_resumable.sql` (the number reserved for GEN-02). First build `84875f7`, packet `e876643`, fix round 1 on top of those.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch, including fix round 1 |
| Locally tested | Yes. `pnpm test:first-sync` 72 passed, 0 failed (was 49), `test:jobs` 16/0, `test:platform-sync` 15/0, `test:sync-generations` 8/0. Whole gate `pnpm test`: 45 of 45 suites passed. `next build` passes. See Test results |
| Browser verified | **NOT DONE.** This round's brief assigned no port, so no dev server or browser ran. The card is rendered in the suite with `react-dom/server`. See the browser drills below |
| Staging verified | **NOT DONE.** Nothing ran against real Shopify, Turso over HTTP or a hosted tick |
| Production enabled | **NOT DONE.** Nothing pushed, deployed or migrated. Migration 0020 has run only on throwaway local file databases |

## Fix round 1

An independent reviewer found two blocking problems and eleven smaller items. I checked both blocking problems against the code, and the reviewer was right on both.

### Blocking 1: a failed or interrupted sync cut a live collection down to its first 250 members

**Checked.** `collectionStatements` in `lib/sync.js` ran `DELETE FROM collection_products WHERE collection_id = ?` and then inserted only the first 250 members. The rest came later, in `membersStep`. So between a collection's page and its member page, shoppers saw 250. If the member page never came in, the run failed and the collection stayed at 250. The console then said "Your store keeps everything already brought in.", which was false. The first packet's known limit, "Nothing is pruned until completion, so nothing disappears early", was also false for memberships.

**Reproduced.** I ran the final suite against a scratch export of `e876643` (the code before this round). The three membership cases each start from the same baseline: an existing store whose last sync is complete, one collection holding all 300 products, and all 300 members live.

```
✗ Shopify fails on the member page of a refresh: all 300 members stay live while it retries and after the run fails
   live members while the queue retries: expected 300, got 250
✗ between a collection's first page and its member page, shoppers still see every member
   interim live members: expected 300, got 250
✗ what Shopify dropped from a collection goes once the whole collection is read, not before
   the long one keeps its old members until its last page: expected 300, got 250
```

**Fixed.**
- Migration 0020 also adds `collection_products.sync_generation` and `collection_products.synced_at`. These record which run wrote a membership (or none, for a webhook) and when.
- A run's member rows go in stamped, beside the old ones. The old ones are removed only in the batch of the collection's **last** member page: rows this run didn't write and nothing has written since the run started. When a collection has no more members to read, that is its collections page; otherwise it is the final `membersStep`. This is the same rule the products prune has used since S30, applied per collection.
- A webhook refetch (`writeCollection`, which always holds every member) still replaces the collection's members in one batch, now with `synced_at`. A run's tidy-up therefore never undoes a webhook that landed mid-run.
- So "Your store keeps everything already brought in." is now true, and it stays. A refresh of a store that already had its products now says "Your store keeps everything it had, plus what came in." Known limits is corrected below.

**Tests** (`test:first-sync`, "an existing store's collections stay whole while a sync runs or fails"):
- `✓ Shopify fails on the member page of a refresh: all 300 members stay live while it retries and after the run fails` (503 on every `CollectionProducts` call until the queue gives up; the run ends `failed` with 300 live, and the short collection keeps 3).
- `✓ between a collection's first page and its member page, shoppers still see every member` (the slice is killed on the member page; 300 live in between, then 300 in Shopify's order).
- `✓ what Shopify dropped from a collection goes once the whole collection is read, not before` (a one-page collection is exact at once; the long one keeps its old members until its last page, then has 298).
- `✓ a webhook that rewrites a collection while a sync is reading it isn't undone by the sync's tidy-up`.
- `✓ a webhook refetch of a collection replaces its members: one Shopify dropped is gone at once`.

### Blocking 2: with no tick, a killed slice could not be recovered

**Checked.** `isDue` in `lib/platform/sync-jobs.js` only accepted `status = 'pending'`, and `ensureSyncJob`/`makeJobDue` only touched pending, done and dead jobs. A job whose slice the platform killed stays `leased` with an expired `lease_until`. It was never kicked, so the console poll did nothing and Try again answered 202 `resumed` and did nothing, even though `runJobById → leaseJobById` already takes over expired leases. Only the tick (`runDueJobs`) could finish it. Also confirmed: `adminGraphql` had no fetch timeout, so one Shopify call that never answered was enough to get a slice killed. The first packet's "a stalled card doesn't poll: the founder has to press Try again" and `docs/onboarding.md`'s "the store console, while it is open, carry it on" claimed recovery that didn't happen.

**Reproduced** (same scratch export):

```
✗ …once both leases lapse, one owner poll moves it forward
   the poll's slice ran (and was killed on its third page) expected truthy
✗ …and after sitting an hour (stalled), one Try again moves it forward and finishes it
   run: expected "complete", got "running"
```

and in `test:jobs`, `✗ makeJobDue takes over a job whose runner was killed (lease ran out), never one a live runner holds`.

**Fixed.**
- `isDue` also accepts a leased job whose lease ran out, so the owner's poll and Try again both call `runJobById`, which takes it over.
- On Try again (`runNow`), `makeJobDue` also resets such a job to pending with a fresh attempt budget. Two killed runners had used two attempts; the founder's Try again starts over at one. A job a live runner holds is still left alone.
- Each Admin API read during a sync now gives up after 15 seconds (`SYNC_TIMING.SHOPIFY_CALL_MS`), as a retryable error the console shows as "Shopify didn't answer…". Only the sync's reads set this: `adminGraphql(query, variables, { timeoutMs })`. Order push and token minting, which write, never time out. A page starts only with 8 seconds left before a deadline at most 50 seconds into its route, so a page whose first call hangs ends by about 57 seconds. A page that makes several slow calls (the first page's count, variant tails) can still run past the route (Known limits).

**Tests** (`test:first-sync`, "no tick: the console alone gets a killed sync going again"). No tick runs anywhere in this block; each case asserts it.
- `✓ a manual sync whose slice is killed mid-page: run at its last page, job left leased`.
- `✓ …once both leases lapse, one owner poll moves it forward` (60 → 120 products).
- `✓ …and after sitting an hour (stalled), one Try again moves it forward and finishes it` (complete, 150 products, the job's attempts back to 1).
- `✓ Try again now during a backoff runs the sync at once instead of waiting for it`.
- `✓ a Shopify call that never answers ends at the sync's own time limit, as a retry with a plain message`.
- `test:jobs`: `✓ makeJobDue takes over a job whose runner was killed (lease ran out), never one a live runner holds`.

The wording in this packet and in `docs/onboarding.md` now matches. A card that shows progress polls every 3 seconds, and once the killed runner's leases lapse (two to three minutes) a poll takes the sync over. A stalled card (30 minutes with nobody on it) stops polling, and Try again moves it.

### The smaller items

| Item | Done |
|---|---|
| Run-on sentence: "240 of 600 products so far Big stores…" | Fixed: `soFar()` ends with a full stop. The rendered test now checks the whole sentence `240 of 600 products so far. Big stores can take a while.`, and the failed detail `…so far. Your store keeps everything…` |
| Drill D7 wrong on the seeded harness (8 products, so the step is done) | Corrected below: remove the harness's products first |
| Surviving mutants with no test | A test each: Try again now during a backoff; collection handle clash; a shrinking image list; a pre-0020 run stuck `running`; `failSyncRun` respecting a live lease; an "at least N" count not shown as the total; the 404 message; the setup step done once a sync completes with no products; the last step's lost answer (`commit()`'s `complete` branch); Try again on a run from another API starting fresh; the busy requeue waiting for the other runner's lease. All 11 re-run as mutants: see Mutation check. I agree `index-guard-phase` is equivalent: `indexStep` is only dispatched when the run's phase is `index`, and `GUARD_WHERE` already checks that phase |
| A cursor Shopify rejects isn't permanent, and a failed run offers no "start fresh" | Not fixed. Known limits |
| `PERMANENT` matched 401/403/404/423 anywhere, even in a 5xx body | Fixed: when the error carries Shopify's HTTP status (`HTTP 503`, `(403):`), the status decides. `plainSyncError` reads the status first as well, so a 503 whose body says 401 reads "Shopify didn't answer" and is retried. Test: `✓ errors: a 404 has its own plain message; a 5xx whose body mentions 401 is retried, not final` |
| A primary "Bring in products" button for a store with no products and no Shopify link | Fixed: `catalogSyncStatus` reports `linked`, and the view has `canStart: false` without a link. The card then shows "Storeasy isn't linked to your Shopify store yet. Contact support to link it." with no button. "Refresh from Shopify" is hidden too. Try again on a failed run still shows (Known limits) |
| A failed scheduled refresh of an existing store shows a red "didn't finish coming in" card on the dashboard | Fixed: when an earlier run completed (`firstSync: false`), the view says "The latest refresh from Shopify didn't finish" (or "Refreshing your products stopped partway"), and the banner is amber, not red. The dashboard shows a refresh only when it failed or stopped. A running refresh shows on Settings, with the headline "Refreshing your products from Shopify" |
| `abortUnlessGuarded` could insert a stand-in run row if the run's row was gone | Fixed: the abort insert now also sets `kind` to NULL, which `NOT NULL` refuses whether or not the run's row exists. Reproduced first: a prune for a missing run deleted the stale row and left a stand-in `running` row. Test: `✓ a prune for a run whose row is gone writes nothing (no stand-in row, no deletes)` |
| `docs/platform-guide.md` stale | Updated: Settings tab, Shopify OAuth connect, and "Full sync & reconcile" (how a run moves, what gives it time, the 15-second read limit, the files) |
| Scheduled reconcile queues every active tenant by default; open when `CRON_SECRET` is unset | Unchanged (disclosed as deviation 7; the open endpoint predates this branch). Known limits |
| D9 (support login) not measured in a browser | Still a browser drill |

## The bugs, reproduced first (first build)

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
- **The commit is guarded.** The batch starts with an update that only matches if this runner still holds the run, at the phase and `pages_done` it read. If that matched nothing, the second statement (`INSERT INTO sync_runs (id, kind) SELECT ?, NULL WHERE changes() = 0`) inserts a row the table refuses (the run's id clashes with its primary key; a NULL `kind` breaks `NOT NULL` even if the run's row is gone), and the whole batch rolls back. A runner that lost its lease, or a retry of a batch that already committed, writes nothing.
- **After any write error the step re-reads the run** before deciding. If the run moved on by exactly this step under this runner's lease (or completed), the commit landed and only the answer was lost: carry on. If another runner owns it now, stop. Otherwise the error is real.
- **Every write is idempotent**: upserts, delete-then-insert of a product's images and variants inside the same batch, `ON CONFLICT DO UPDATE` on child rows, and memberships with `INSERT OR REPLACE … JOIN products`, so only products in this database are linked (Admin collections list drafts too). A row that holds a product's or collection's handle under another id is removed first (deleted or renamed upstream).
- **A collection's members are replaced only once all of them are read** (fix round 1). A run's membership rows are stamped with its id and time, added beside the old ones, and the old ones go in the batch of the collection's last member page (see Fix round 1).
- **Long collections don't make long steps.** A collection with more than 250 members becomes a "tail" (`sync_runs.member_tails`), drained 250 members per step in phase `members` before the next collections page. In the suite a 600-member collection is read over its collections page plus two member steps, and keeps Shopify's order.
- **Prune runs only in the `prune` step**, which only the last collections page (or last member page) can reach. Its guard requires `phase = 'prune'` in the database, so a partial generation can't reach the deletes even through a bug in the calling code (proved on a forged run). The rule is unchanged from S30: delete rows not stamped with this generation and not written since the run started. **Search indexing runs only after that**, in the `index` step, and only then is the run `complete`.
- **One runner at a time**: a lease on the run row (`lease_owner`, `lease_until`, 90 seconds, renewed by every commit). A killed runner frees the run within 90 seconds.
- **Resume keeps the run.** `sync_runs.cursor` is now read back as the products position; `collections_cursor` is the collections one. Paging is sorted by ID (Admin and Storefront), so a cursor stays valid across hours: under `UPDATED_AT` a product edited mid-sync jumps behind the cursor, is never seen and is then pruned.
- **One Admin API read never holds a slice for ever** (fix round 1): 15 seconds, then a retryable error.

**The queue gives the run time** (`lib/platform/sync-jobs.js`, `lib/platform/worker.js`, `lib/platform/jobs.js`):

- One job per run (`catalog_sync`, key `catalog_sync:<tenant>:<run>`). Each time it runs it does one slice, at most 40 seconds and never past the caller's deadline, then requeues itself (pending, due, fresh attempts, back of the line) until the run completes.
- `runDueJobs` takes a `budgetMs`. With one, long jobs are leased too, run after the others, see the deadline, and a job not reached in time is handed back with its attempt. Without one, long jobs are left alone, so a shopper route's `after()` (account, quiz) never picks up a sync slice. The tick route and the operator's "run due jobs" pass 50 seconds.
- A slice that fails after committing pages requeues after a minute with a fresh budget, so a flaky store still finishes. A slice that gets nothing in counts toward the five attempts. When the queue gives up, the run is marked failed (dead-letter hook), so the console shows a failure instead of "running" for ever. Errors no retry can fix fail the run at once: 401, 402, 403, 404 or 423 as Shopify's status, ACCESS_DENIED, no credentials, a changed Shopify source.
- Three things give a running sync CPU time: the `after()` kick from whoever started it (about 45 seconds straight away), the tick (`/api/jobs/tick`, the durable path, OQ-19), and the console's status poll while the card shows progress. Since fix round 1, a job whose runner was killed counts as due for the poll and for Try again once its lease lapses.

**The founder sees it** (`lib/admin/sync-view.js`, `components/admin/SyncProgress.js`):

- Progress reads from `sync_runs`: `running`, `retrying`, `stalled` (no progress and nobody on it for 30 minutes), `failed`, `complete`, or `none`. The view carries a headline, a detail line and, for trouble, a plain message. Shopify's count (`productsCount`, Admin only, exact counts only) gives "240 of 600 products so far."; without it, "240 products so far.".
- The card polls `GET /api/admin/sync` every 3 seconds while a sync runs or retries. On the dashboard it comes first while a store's first sync isn't complete, and for a refresh only when it failed or stopped. It is always on Settings ("Products from Shopify", which replaces "Catalog sync" and its toast). Failure shows the plain message, "Your store keeps everything already brought in." (a refresh: "…everything it had, plus what came in."), and **Try again**, which resumes the same run from where it stopped. While the queue is retrying the card says so, says when the next try is, and offers **Try again now**. A first sync's failure is red; a refresh's is amber.
- A store with no Shopify link is offered no start: "Storeasy isn't linked to your Shopify store yet. Contact support to link it."
- Raw errors never reach the founder. `plainSyncError` maps them to sentences such as "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes." and "Shopify stopped letting Storeasy into your store. Contact support to link it again, then try again."

**For GEN-01**: `confirmedCatalogSync()` and `hasConfirmedSync()` in `lib/sync.js`. Yes only when the most recent run finished every page, the prune and the index. No, with the reason, for none, running, stalled and failed, and for a store whose products came in before runs were recorded.

**Files.** New: `migrations/tenant/0020_sync_runs_resumable.sql`, `lib/admin/sync-view.js`, `lib/platform/sync-jobs.js`, `components/admin/SyncProgress.js`, `scripts/test-first-sync.js`. Changed: `lib/sync.js` (rewritten around steps; webhook functions and `indexTypesense` kept), `lib/shopify-admin-catalog.js` and `lib/shopify.js` (one-page fetchers, ID order, `countProductsAdmin`, `fetchCollectionMembersPageAdmin`; the fetch-all functions now loop over them), `lib/shopify-admin.js` (optional read timeout, fix round 1), `lib/platform/worker.js`, `lib/platform/jobs.js`, `lib/admin/onboarding.js`, the routes in the caller table plus `app/api/jobs/tick` and `app/api/platform/queues`, the dashboard and settings pages, `components/admin/SettingsAdmin.js`, `components/platform/PlatformAdmin.js`, `docs/onboarding.md`, `docs/platform-guide.md`, `scripts/sync.js`, `scripts/tenant-sync.js`, `scripts/test-jobs.js`, `scripts/test-copy.js`, `scripts/test-platform-sync.js` (setup only, fix round 1), `package.json` (`test:first-sync`).

## How each caller now runs

| Caller | Before | Now |
|---|---|---|
| Connect callback (`app/api/connect/shopify/callback/route.js`) | Whole sync in a best-effort `after()`; big catalogs told to use the CLI | Records the run and queues its job **before** the response, kicks the first slice in `after()`; the tick and console finish it. Page copy: "Your products are on their way in. The store console shows how far along it is." |
| Console Sync now (`POST /api/admin/sync`, platform) | Whole sync inline, inside 60s | Starts the run (or joins the one under way), kicks a slice, answers 202 with progress. `{retry: true}` resumes a failed or stuck run, including one whose runner was killed. `{searchOnly: true}` still reindexes inline |
| Console progress (`GET /api/admin/sync`, new) | none | Progress from `sync_runs`; for a role that may run a sync, also gives a running sync its next slice after the response, taking over from a killed runner once its lease lapses |
| Scheduled reconcile (`/api/jobs/sync-catalog`) | Whole sync per tenant inline, first 3 tenants by default | Queues a run for every active tenant (or the first `limit`), spends the rest of its 45 seconds on first slices, answers 202. A tenant with no Shopify link is reported, not crashed |
| Operator sync (`POST /api/platform/tenants/[id]`) | Whole sync inline | Queues, kicks, answers 202 `{queued, runId}`; the operator console's toast says so |
| CLI `pnpm tenant:sync <slug>` / `pnpm sync` | Whole sync in memory | Same page steps, run to the end in the process, no time limit. Joins a queued sync already under way instead of racing it |
| Legacy `_default` store (no control plane) | Whole sync inline | No queue: Sync now and the console poll each run an in-process slice (about 45 seconds) under the run's lease; any failure fails the run (no queue to retry) and the card offers Try again. `pnpm sync` as above |
| Webhooks (`applyWebhook`) | `writeProduct`/`writeCollection` as separate statements | Same functions, now one atomic batch each. A collection refetch stamps its memberships' `synced_at` (needs migration 0020) |

## Acceptance

Unless noted the command is `node scripts/test-first-sync.js`. A fake Shopify answers every Admin and Storefront query the real fetchers send, and throws on any other network call. A simulated clock gives each Shopify call a duration, and any invocation that runs past 60 simulated seconds is killed mid-call: its promise never resolves, nothing after it runs, leases stay held, exactly as when the platform ends a function. Routes are the real route files, called with real tenants, real sessions and real file databases; `after()` is captured so the suite runs it inside the same invocation.

### 1. A founder sees progress during a first sync of a large catalog

**Tag: unit (route) + rendered. Status: pass. Browser drills D1, D5 and D6 still needed.**
- `✓ the founder sees progress during it: running, N of 600, rising`. Between ticks of the 600-product sync, `GET /api/admin/sync` (as a support login) returned `running` with "N of 600 products so far.", the total from Shopify's count, never going backwards, then `complete` with "600 products".
- `✓ running: headline, N of M, and a progress bar at the right value`: the card's markup, the whole sentence "240 of 600 products so far. Big stores can take a while.", and `role="progressbar"` with `aria-valuenow="40"` for 240 of 600.
- `✓ console poll: while the founder watches, each poll gives the sync its next slice (no tick needed)`, and since fix round 1 `✓ …once both leases lapse, one owner poll moves it forward` (a killed slice, no tick).
- `✓ a support login reads progress but never gives the sync work`.
- `✓ an "at least N" product count is not shown as the total`.
- Source guard: `✓ the dashboard shows the card while a sync isn't complete; settings uses it too` (now also: a refresh only when it failed or stopped). The dashboard page itself was not rendered (it needs a request), so where the card sits is drill D1.

### 2. A failed sync shows a plain message and a retry

**Tag: unit (route) + rendered. Status: pass. Drills D2–D4, D10, D11.**
- `✓ Shopify keeps failing on page 3: the console says so in plain words while it retries`: state `retrying`, the exact message, `retryAt` set, Try again offered, no raw text (`500`, `GraphQL`, `HTTP`, `upstream`, `admin`).
- `✓ …after the queue gives up the run is failed, keeps its rows, and the console shows the plain message and a retry`: job `dead`, run `failed`, 60 rows kept, the stale row not pruned, headline "Your products didn't finish coming in".
- `✓ Try again resumes the same run at page 3 and finishes it, with no duplicates`: `POST {retry: true}` → 202 `resumed`, same run id, only pages at positions 60 and 90 fetched, counts exact, the stale row pruned only now.
- Fix round 1, no tick: `✓ …and after sitting an hour (stalled), one Try again moves it forward and finishes it` and `✓ Try again now during a backoff runs the sync at once instead of waiting for it`.
- `✓ a refusal no retry can fix (401) fails the run at once, with a plain message about the link`, `✓ errors: a 404 has its own plain message; a 5xx whose body mentions 401 is retried, not final`, `✓ a Shopify call that never answers ends at the sync's own time limit, as a retry with a plain message`.
- `✓ starting with no Shopify link answers with a plain message, not an internal one` (409), and `✓ a store with no Shopify link is not offered a start that can only fail`.
- `✓ a flaky store that fails now and then still finishes: pages that got in reset the retry budget` (six failures, more than a job's five attempts).
- `✓ Try again on a run from another Shopify API starts fresh instead of reusing its position`.
- Rendered: `✓ failed: the plain message, kept rows, and a Try again button`, `✓ retrying: a warning, when it tries next, and Try again now`, `✓ stalled, none, complete, and a role that can't run a sync`, `✓ a refresh of a store that already has its products warns instead of alarming`.
- `✓ the card's own requests are the ones the route answers (Try again → resume)`: the card's `requestSync`/`readSync` helpers, through a stubbed `fetch`, into the real route.

### 3. A job killed mid-page resumes from the stored cursor, with no duplicate or pruned rows

**Tag: unit. Status: pass.**
- `✓ killed while fetching page 4: three pages kept with their position, nothing duplicated or pruned`: cursor = end of page 3, `products_fetched` 90, 91 rows (90 + the planted stale row), the stale row still there, product 0 (planted from an "older sync" with a retired variant) holding exactly its Shopify variants.
- `✓ …and the next tick picks up at that cursor, not from zero, and finishes exactly`: the first page fetched after the kill is at the stored cursor, no fetch from the start, pages 4 and 5 only, `products_fetched` 150 (not double-counted), every count exact, the stale row pruned after completion.
- `✓ killed after a page's write committed but before the answer: the next runner moves on to the next page`: pages fetched `[0, 30, 60, 90, 120]`, none twice.
- No tick (fix round 1): the poll and Try again cases above resume the same run at its stored position.
- Nothing removed early (fix round 1): the five membership cases in Fix round 1. A collection is never cut down while a run reads it or after a run fails partway.
- Lost answers: `✓ a page write whose answer is lost and which the db layer retries: the page counts once`, `✓ …does NOT retry: re-read, then carry on`, `✓ the last step's answer lost: the same slice still reports the run complete`. The first uses this branch's `lib/db.js` (which retries `fetch failed`); the others use an error it doesn't retry (`socket hang up`), which is how every unknown-outcome write behaves on `claude/gallant-keller-7d3213`. `✓ the old code path (pnpm sync) gets through a lost answer too`.
- `✓ one page is all or nothing`, `✓ one runner at a time`, `✓ a runner whose lease was taken over can't commit its stale page afterwards`, `✓ a stale runner's older copy of a page never wins over the runner that took the run over`, `✓ a slice that finds another runner on the run waits for that runner's lease`, `✓ a variant row left under the wrong product can't block a page`, `✓ a handle reused by a new Shopify product doesn't block the sync on the old row`, `✓ a collection handle reused by a new Shopify collection doesn't block the sync on the old row`, `✓ a product whose image list shrinks keeps only Shopify's images`, `✓ writing the same product twice leaves exactly one copy`.

### 4. Negative: generation never runs on a failed or partial sync

**Tag: unit. Status: pass for the function GEN-01 will call. GEN-01 itself is not built, so nothing calls it yet.**
- `✓ no sync yet`, `✓ products from before runs were recorded`, `✓ partial (a slice that stopped part way)`, `✓ stalled`, `✓ failed`: each `confirmed: false` with its reason.
- `✓ complete: confirmed, with what it holds` and `✓ a newer sync that is failing or under way: not confirmed until it completes`.
- Pruning, which the spec ties to the same rule: `✓ a run failing in the products pages prunes nothing`, `✓ …in the collections pages (every product in) prunes nothing`, `✓ a run killed on its very last page prunes nothing`, `✓ the database itself refuses a prune for a run that isn't at its prune step (forged run)`, `✓ a prune for a run whose row is gone writes nothing (no stand-in row, no deletes)`, `✓ only the complete run prunes, and search indexing runs once, after the prune`, `✓ a failed inline run never indexes`.
- `✓ the queue giving up never fails a run a live runner still holds`, `✓ a sync from before resumable runs, stuck at running, is closed off and a fresh one starts`.

### 5. Negative: a sync over the 60-second route limit still finishes

**Tag: unit. Status: pass in simulated time. Real hosted timing is a manual check (needs OQ-19).**
- `✓ connecting Shopify queues the first sync, and the queue finishes it across ticks, none past 60 seconds`: the real connect callback (state, HMAC, token exchange against the fake), then the real tick route. 600 products (one with 120 variants), 120 collections (one with 600 members, one with a draft product). The sync needed more than three route limits of Shopify time; it ran over the connect invocation plus several ticks; no invocation ran past 60 seconds and none was killed; every products page was fetched exactly once; every count is exact and the 600-member collection keeps Shopify's order.
- Without a tick (fix round 1): the "no tick" block finishes a 150-product sync through one poll and one Try again after two kills.

### Every caller still works

`✓ manual: a second Sync now while one runs joins it (one run, one job)`, `✓ scheduled: …queues every active store and the tick finishes them`, `✓ operator: the platform console's sync queues and answers at once`, `✓ CLI (pnpm tenant:sync): runs to the end in one go, and joins a queued sync already under way`, `✓ legacy _default store (no control plane): Sync now and pnpm sync both run page by page in-process`, `✓ storefront-token stores page through the Storefront API the same way`, `✓ the setup step counts as done once a sync completes, even when Shopify has no products`. `test:sync-generations` (unchanged, 8 passed) still proves S30's generation rules through `runCatalogSync`, and `test:platform-sync` (15 passed; setup now applies the migration ledger, assertions unchanged) the webhook writes.

`node scripts/test-jobs.js` adds: `✓ long jobs (catalog_sync) only run for a caller with a budget, and after the others`, `✓ a job leased but not reached before the deadline is handed back with its attempt`, `✓ a handler that has more to do requeues its job: pending, due, fresh attempts, back of the line`, `✓ makeJobDue takes over a job whose runner was killed (lease ran out), never one a live runner holds`.

## Merge notes

- **`claude/gallant-keller-7d3213` (`lib/db.js` stops retrying unknown-outcome writes).** Every sync write is inside a guarded batch, and the step reconciles by re-reading after any write error, so it is correct whether the batch is retried or not. Both behaviours are tested (see acceptance 3). That branch also edits `lib/platform/worker.js` (the Razorpay replay and a new `payment_confirm` handler). In the first build, `git merge-tree --write-tree 84875f7 claude/gallant-keller-7d3213` auto-merged `worker.js` with both handlers in and reported three conflicts (`components/checkout/CheckoutFlow.js`, `package.json`, `scripts/test-shopify-push.js`), the same three as `bdbe1a7` against that branch, so they come from batch A. Fix round 1 doesn't touch `worker.js`, `package.json` or `lib/db.js`; the merge check was not re-run for this round. Nothing was merged.
- **Deploy order: tenant migration 0020 before this code, now for webhooks too.** Without it, starting a sync fails (`sync_runs` has no `phase`) and the console shows the generic plain message. Since fix round 1, a collections webhook also writes `collection_products.sync_generation`/`synced_at`, so without 0020 those webhooks fail and go to the queue's retries, then the dead-letter list. Product webhooks don't depend on it. This branch ran no migration anywhere hosted.
- **0020 was edited in fix round 1** (two `ALTER TABLE collection_products` lines). It never ran on a hosted database. The runner checksum-locks applied files, so a local database that applied the first version (a design harness seeded from `84875f7`, or a leftover test file) fails with "edited after being applied". Re-seed the harness (`node scripts/dev-design.js seed`) or delete the local file.
- **Migration number**: 0020 only. 0018 and 0019 are reserved for OVL-06 and COM-03 and don't exist here; the runner applies files in name order, and 0020 doesn't depend on them.
- **Queue changes other work will see** (PUB-07, OVL-17): `runDueJobs({ budgetMs })`, `LONG_JOB_TYPES`, `requeueJob`, `releaseJob`, `makeJobDue` (since fix round 1 it also takes over a job whose lease lapsed), `getJobByKey`, `leaseJobs({ excludeTypes })`, and a handler's second argument `{ deadline, now }`. Existing handlers ignore the new argument.
- **`adminGraphql(query, variables, { timeoutMs })`** gained an optional third argument. Existing callers pass two and are unchanged.

## Deviations from the spec

1. **Paging order is ID, for products and collections, Admin and Storefront** (was `UPDATED_AT` reversed, and `BEST_SELLING` on the Storefront API). Needed for a cursor that lives across ticks. Every product listing sorts explicitly (`lib/repo.js`), so storefront order doesn't change; the one unordered reader, `getProductHandles`, has no caller.
2. **Member tails are their own steps** (phase `members`, column `member_tails`). Not in the spec; without it one large collection could make a single step outrun its route.
3. **Reused handles are cleaned up in the page write** (the old row holding the handle is removed). Not in the spec, but a missed delete webhook plus a recreated product otherwise blocks every later sync.
4. **Webhook writes became atomic batches too** (`writeProduct`, `writeCollection`), since they share the statements.
5. **`hasConfirmedSync` is strict:** the most recent run must be complete. A newer sync under way or failed says no even when an earlier one finished. The owner may prefer "any complete run"; see manual check M9.
6. **Queue behaviour changed for everyone:** long jobs need a budget, run last, and are handed back unrun when time is up; a requeued job moves to the back of the line (its `created_at` is bumped, so `queueStats().oldest_pending_min` counts from the last requeue for sync jobs). Fix round 1: `makeJobDue` also takes over a job whose lease lapsed.
7. **Scheduled reconcile covers every active tenant by default** (was the first 3), because queueing is cheap. Answers 202.
8. **Founder copy changed:** Settings section "Catalog sync" → "Products from Shopify", setup step "Sync your catalog" → "Bring in your products" (its link now goes to Settings), the connect page's sync sentence, and the operator console's sync toast. Fix round 1 added the refresh wording ("Refreshing your products from Shopify", "The latest refresh from Shopify didn't finish", "…everything it had, plus what came in.") and the no-link sentence.
9. **`POST /api/admin/sync` rate limit 2 → 6 per minute**, so Try again and Sync now don't trip it.
10. **Existing suites changed:** `scripts/test-copy.js` gained one stub for the new import in `SettingsAdmin`; `scripts/test-jobs.js` gained four cases; `scripts/test-platform-sync.js` now applies the tenant migration ledger on top of the raw schema, like `test-cms` and `test-content` do. No existing assertion changed.
11. **The rendered tests compile the card with Next's SWC**, as AU-05 did, not the JSX runner spec 8.15 proposes (it doesn't exist yet). No new dependency.
12. **Fix round 1: memberships carry `sync_generation` and `synced_at`** (migration 0020), so a run replaces a collection's members only once it has read all of them.
13. **Fix round 1: the dashboard shows a refresh of a store that already has its products only when it failed or stopped.** A first sync shows in every state, as before. Settings shows every state.
14. **Fix round 1: Admin API reads during a sync give up after 15 seconds.** Not in the spec.

## Known limits

- **The durable path needs a running tick (OQ-19).** With no tick configured and the console closed, a big first sync gets its first ~45 seconds after connect and then waits. When the founder opens the console, the card polls while the run reads as running or retrying, and each poll moves it. A slice the platform cut off is taken over once its leases lapse, two to three minutes. After 30 minutes with nobody on it, the run reads "stopped partway", the card stops polling, and Try again moves it. This was proved in the suite with no tick, and not on a hosted runtime. With a scheduler calling `/api/jobs/sync-catalog` but no tick, a big existing store will show "Refreshing your products stopped partway" (amber) after each scheduled refresh until someone presses Try again.
- **One step can still be slow: a products page of 30 products with very many variants.** Variant tails past 50 are still drained inside the page (one call per 100 extra variants). A page needing more than about 55 seconds of Shopify time is killed every time it is tried, so the run never gets past it, however often a poll, Try again or the tick picks it up. The 15-second read limit bounds each call, not the page. Member tails are split; variant tails are not.
- **Pages written before a failure are live, and nothing is removed until it has been read in full.** The old code wrote nothing until it had the whole catalog in memory, so a failed sync changed nothing. Now each page is written as it arrives, so new and changed products appear before the run finishes. Nothing goes early. Products and collections are pruned only after a complete run. A collection's members are removed only in the batch of its last member page. So while a long collection is being read, and after a run fails partway through it, shoppers see its old members plus the new ones: a product Shopify dropped from it stays listed, and positions mix old and new order. That lasts until its last page or the next complete run, or until the collection's own webhook replaces it.
- **A resumed run keeps its original start.** A product deleted upstream after its page was copied stays until the next complete sync or its delete webhook; an edit made after its page was copied waits for its update webhook or the next sync. The window is the run's whole length, which can now be hours.
- **The handle cleanup can remove a fresh row in one race:** a webhook writing a new product with a handle in the seconds between a page's fetch and its commit, where that page holds an older product with the same handle. The next webhook or sync puts it back. Catalog overrides for a product id removed this way stay orphaned, as they do after a prune.
- **A cursor Shopify rejects is not treated as final.** Try again resumes the same cursor, and a failed run's card offers no "start fresh" (`canStart` is false while the latest run failed), so a cursor Shopify refused would fail the same way each time. Starting fresh then needs `pnpm tenant:sync` after marking the run failed, or support. This is theoretical: Shopify's ID-sorted cursors don't expire, and I don't know the exact error text Shopify would send.
- **Try again still shows on a failed sync after the store's Shopify link is removed.** Pressing it answers "Couldn't start: Storeasy isn't linked to your Shopify store. Contact support…". Only the start buttons ("Bring in products", "Refresh from Shopify") are hidden without a link.
- **The 15-second read limit is a guess.** An Admin page that legitimately takes longer now fails and retries instead of finishing, and every retry would fail the same way. Real page times are untested (M11). Storefront-token stores have no read limit: `lib/shopify.js` is shared with the edge storefront and was left alone.
- **Storefront-token stores** still get only the first 250 members of a collection (no tail drain on that API), as before, and no "of N" total.
- **Atomicity is proven on the local file client only.** The guard relies on `libsql.batch` being one transaction and on `changes()` inside it; both hold in `@libsql/client`'s local client in the suite. Turso over HTTP is untested (spec 8.15 already flags `libsql.batch` as unproven through this wrapper).
- **`productsCount` and `sortKey: ID` against real Shopify are untested.** The fake answers the query shapes the code sends. If `productsCount` errors, progress shows "N products so far." with no total; nothing else depends on it.
- **The time model is simulated.** Pages "take" seconds in the suite; database writes take none. The budgets (40-second slice, 8-second minimum per page, 15-second read limit, 50-second tick, 45-second kick) leave a few seconds for writes and bookkeeping, not measured on Turso.
- **Runs from before this branch** (no `phase`) can't be continued. A request finds one still marked running and marks it failed with "an older sync stopped partway and can't be continued", then starts fresh (now tested).
- **An operator replaying a dead sync job** from the queue inspector doesn't resume its failed run (the job sees the run failed and completes). Try again, or Sync now, does.
- **The setup checklist's hint text** has no test of its own for the in-progress wording. The done-on-complete flag is now tested. Drill D7 covers the wording.
- **Support and staff logins** see progress but their polls don't move a sync; only roles allowed `sync.run` (admin, owner) do.
- **Search** is still deleted and rebuilt in the final step, so search falls back to the database for those seconds, as before.
- **The scheduled reconcile is open when `CRON_SECRET` is unset** (true before this branch), and it now queues every active tenant by default (deviation 7).
- **Equivalent mutant left:** with one clock, a membership's `synced_at` alone separates a run's rows from older ones, so dropping the run stamp changes no test. The stamp stays because it guards the run's own rows if two invocations' clocks disagree, the same reason products carry both.
- **`next build` passes, with one warning that is not from this branch:** it traces `lib/platform/migrate.js` through `app/api/platform/overview/route.js` ("the whole project was traced"), a file GEN-02 doesn't touch. The build doesn't run the edge storefront against anything. GEN-02 changes no edge code; `lib/sync.js` stays free of `node:` APIs and uses only `AbortSignal.timeout`, a web standard.

### From review

Non-blocking findings from the independent reviews, added at merge. The first eleven came from the first review and are answered in "Fix round 1" above (the table "The smaller items"); they are kept here so the list is complete. The rest came from the review of fix round 1 and are still open.

**First review (answered in "Fix round 1").**
- **Run-on sentence in every products-phase card**: "240 of 600 products so far Big stores can take a while." (`soFar()` had no full stop; the test checked only part of the sentence). Fix round 1 says it is fixed and the whole sentence is tested.
- **Drill D7 was wrong on the seeded harness**, which has 8 products, so the step is already done and has no Open link. With the products removed it reads as described and Open lands on the card. Fix round 1 corrected the drill.
- **Mutants with no test**, in code that works: Try again now during a backoff, the collection handle clash cleanup, a shrinking image list, a pre-0020 run stuck "running", `failSyncRun` and a live lease, an "at least" count used as the total, the 404 message, the setup step's done flag, `commit()`'s lost-answer branch, the retry source check, and the busy requeue wait. Fix round 1 says each now has a test.
- **A cursor Shopify rejects is not treated as final**, and a failed run's card offers no "start fresh". Not fixed; already in Known limits. Theoretical, since Shopify's ID cursors don't expire.
- **Permanent-error matching read 401/403/404/423 anywhere in the text**, even in a 5xx body. Fix round 1 says the HTTP status now decides.
- **A store with no products and no Shopify link was shown a "Bring in products" button** that could only answer "Couldn't start". Fix round 1 says the button is hidden without a link.
- **A failed scheduled refresh of an existing store showed a red "didn't finish coming in" card.** Fix round 1 says it now reads as a refresh, in amber.
- **`abortUnlessGuarded` could insert a stand-in run row** if the run's row was gone (needs 50 newer runs during one run). Fix round 1 says the insert is now always refused.
- **`docs/platform-guide.md` described the old inline sync.** Fix round 1 says it is updated.
- **The scheduled sync queues every active tenant by default (was 3)**, and the endpoint is open when `CRON_SECRET` is unset, as before this branch. Unchanged; already in Known limits.
- **D9 (support login) was not checked in a browser.** The unit and rendered tests cover it. Still a browser drill.

**Review of fix round 1 (still open).**
- **An important line has no test.** If a collection's old members are cleaned up on every member page instead of only the last (`lib/sync.js:666`, `page.hasNextPage ? [] :` changed to always clean up), no test fails. The suite's only long collection has 300 members, so it has one member page. With that change and a 600-member collection, a refresh that failed on the second member page left only 500 of the 600 members live, which is the original blocking problem coming back. The real code keeps all 600 live throughout. Suggested test: a collection of 600 or more members, Shopify answering 503 at the second member page, and the live count still 600 after the run fails.
- **Another surviving mutant:** the cleanup on a collections page uses the run's start time (`lib/sync.js:269`, passed at `:638`). Using the page's own time instead fails no test. It only matters in a narrow race, where a webhook writes a one-page collection after the run started but before its collections page.
- **Equivalent survivors.** Treating every leased job as lapsed is still safe, because the SQL that takes a job refuses a live lease. Ignoring `sync_generation` in the cleanup, or not stamping run rows with it, makes no difference while one clock writes everything, as the packet says.
- **Removing the sync read time limit is caught only by a timeout.** `test-first-sync` then hangs until the test runner's per-suite timeout stops it; no named test fails.
- **A long collection's order can be mixed during and after a failed refresh.** It holds its old members plus the new ones, with positions from two orderings, and members Shopify removed stay listed until a later complete sync or a collection webhook. Shoppers never see fewer products. This matches the new copy "Your store keeps everything it had, plus what came in." Already in Known limits.
- **Tenant migration 0020 must run before this code is deployed**, because collection webhooks now write `collection_products.sync_generation` and `synced_at`. Already in Merge notes.
- **Not run in that review:** `next build` and browser drills. No storefront edge module imports anything new: `lib/sync.js` and `lib/admin/sync-view.js` are imported only by Node routes.

## Browser drills still needed

Desktop Chrome on the design harness. The harness tenant (`design`, `.design-tenant.db`) has no Shopify link and no sync runs, and it has 8 products. Each state is set by writing a `sync_runs` row directly (local file database only), for example with `sqlite3 .design-tenant.db`. Re-seed the harness first (`node scripts/dev-design.js seed`), so migration 0020 as it now stands is applied. A harness seeded from the first GEN-02 commit refuses to start with a checksum error until it is re-seeded.

- **D1. Progress on the dashboard.** Insert a running run: `INSERT INTO sync_runs (id, status, phase, started_at, updated_at, products_fetched, products_total, lease_owner, lease_until, source, started_by) VALUES ('sync_drill', 'running', 'products', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 240, 600, 'drill', strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'), 'admin', 'connect');`. Open `/admin/dashboard`. Pass: the card is first on the page and reads "Bringing in your products from Shopify" and "240 of 600 products so far. Big stores can take a while. You can keep using the console." (with the full stop after "so far"). The bar is at about 40%, and there is no button. Screenshot at desktop width and at 375px (no sideways scroll).
- **D2. Failure and Try again.** `UPDATE sync_runs SET status='failed', error='Admin GraphQL HTTP 502: Bad Gateway', lease_owner=NULL, lease_until=NULL WHERE id='sync_drill';` and reload. Pass: "Your products didn't finish coming in" in a red banner, "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes.", "240 of 600 products so far. Your store keeps everything already brought in.", a Try again button, nothing raw (no 502, GraphQL). Press Try again: the harness has no Shopify link, so pass is a "Couldn't start" banner reading "Storeasy isn't linked to your Shopify store. Contact support to link it, then try again." and no raw text.
- **D3. Retrying.** `UPDATE sync_runs SET status='running', error='fetch failed', lease_owner=NULL, lease_until=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='sync_drill';`. Pass: a warning (amber) banner with the plain message and "Try again now".
- **D4. Stalled.** `UPDATE sync_runs SET error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id='sync_drill';`. Pass: "Bringing in your products stopped partway", "It stopped before finishing. Try again to pick up where it left off.", Try again. In the network panel, no `GET /api/admin/sync` repeats (a stalled card doesn't poll).
- **D5. Settings card.** `/admin/settings`: the section nav says "Products from Shopify" and jumps to the card. With the D1 row the card shows progress. After `UPDATE sync_runs SET status='complete', phase='done', products=600, collections=120, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='sync_drill';` it shows "Your products are in" and "600 products and 120 collections, brought in just now.". Pass also needs **no** "Refresh from Shopify" button, because the harness has no Shopify link (fix round 1).
- **D6. Polling stops when done.** With the D1 row and the network panel open on the dashboard: `GET /api/admin/sync` about every 3 seconds. Mark the row complete (D5's update) without reloading. Pass: the card turns into "Your products are in" within a few seconds and the requests stop.
- **D7. Setup checklist (corrected).** The harness's 8 products mark the step done, so first `DELETE FROM variants; DELETE FROM product_images; DELETE FROM collection_products; DELETE FROM products;` (local harness file only; re-seed afterwards), and insert the D1 row. Open `/admin/setup`. Pass: the step reads "Bring in your products" with "Bringing in your products from Shopify: 240 products so far", not done. Its link opens `/admin/settings#catalog-sync` and lands on the card.
- **D8. Keyboard and screen reader basics.** Tab reaches Try again and Enter presses it; the progress bar has a label and `aria-valuenow`; the headline area is `aria-live="polite"`.
- **D9. Support login.** Sign in as a support member (or an operator under a support grant). Pass: the card shows, with no buttons, and its polls don't move a running sync (`sync_runs.products_fetched` unchanged).
- **D10. A store with no Shopify link and no products (fix round 1).** `DELETE FROM sync_runs;` and the D7 deletes. Open `/admin/dashboard`. Pass: the card reads "Your products aren't in yet" and "Storeasy isn't linked to your Shopify store yet. Contact support to link it.", with **no** button.
- **D11. A failed refresh of an existing store (fix round 1).** Re-seed, then insert a complete run and a newer failed one: `INSERT INTO sync_runs (id, status, phase, started_at, finished_at, products, collections) VALUES ('sync_old', 'complete', 'done', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), 8, 3);` and `INSERT INTO sync_runs (id, status, phase, started_at, updated_at, products_fetched, error, source, started_by) VALUES ('sync_new', 'failed', 'collections', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 8, 'Admin GraphQL HTTP 503', 'admin', 'scheduled');`. Pass: the dashboard card reads "The latest refresh from Shopify didn't finish" with an **amber** banner (not red), "Your store keeps everything it had, plus what came in.", and Try again.
- **D12. A running refresh stays off the dashboard (fix round 1).** After D11, `UPDATE sync_runs SET status='running', error=NULL, phase='products', products_total=8, lease_owner='drill', lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes') WHERE id='sync_new';`. Pass: `/admin/dashboard` shows no sync card; `/admin/settings` shows "Refreshing your products from Shopify".

## Manual checks for the owner

- **M1. Migration 0020 on each hosted tenant database, before deploying this code.** Your call and your command; nothing here ran it. It now also adds two columns to `collection_products`, and collection webhooks need them. Pass: each tenant's `schema_migrations` lists `0020_sync_runs_resumable`, `PRAGMA table_info(collection_products)` lists `sync_generation` and `synced_at`, and Settings shows the sync card instead of a generic error.
- **M2. OQ-19: a running tick.** Decide on the private staging deploy or wait for the hosting phase. Pass: on staging, a first sync of a store with 2,000+ products finishes with the console closed, through ticks alone.
- **M3. A real Shopify store, first connect, on staging.** A development store with over 1,000 products and a collection over 250 products. Pass: the dashboard shows "N of M" with M equal to Shopify's active product count, the sync completes, and product, variant and collection member counts match Shopify admin.
- **M4. `productsCount` and `sortKey: ID` on API 2025-10.** Pass: `sync_runs.products_total` is filled on the M3 run, and a product edited in Shopify while that sync runs is present (with its edit, through its webhook) afterwards.
- **M5. Kill on staging, with and without a tick.** Redeploy or cancel the function mid-sync on staging. Pass with a tick: the next tick resumes at the stored cursor (no products page fetched twice in the logs), and counts are exact at the end. Pass with the tick off and the dashboard open: progress starts moving again within about three minutes. This is also the only check of batch atomicity and the `changes()` guard on Turso over HTTP.
- **M6. `after()` time on the hosting plan.** Pass: within a minute of connecting, `sync_runs.products_fetched` is above zero before any tick has run.
- **M7. A real phone and Safari.** The dashboard card at phone width in Safari. Pass: readable, no sideways scroll, Try again works.
- **M8. Founder wording, your decision.** "Bring in products", "Products from Shopify", "Refreshing your products from Shopify", "The latest refresh from Shopify didn't finish", "Your store keeps everything it had, plus what came in.", and messages that say "Contact support to link it" (this assumes founders have a support channel; linking Shopify is operator-run today). Also: the dashboard now hides a running refresh of a store that already has its products. Pass: you accept the words and the dashboard rule, or give replacements.
- **M9. What GEN-01 counts as "confirmed", your decision.** Now: the most recent sync must be complete. Alternative: any complete sync, even if a newer one is running or failed. Pass: you pick one.
- **M10. Webhooks still keep products fresh on a real store.** Edit a product's title in Shopify, and remove a product from a collection. Pass: the storefront shows both within a minute (webhook writes are now one batch, and a collection refetch replaces its members).
- **M11. Admin API page times on a real store (fix round 1).** During the M3 sync, look at the gaps between `sync_runs.updated_at` values, or the slice logs. Pass: every products page comes back well under 15 seconds, and the run shows no "Shopify didn't answer" retry on a healthy store.
- **M12. A long collection during a refresh on a real store (fix round 1).** During a refresh of the M3 store, open the over-250 collection on the storefront while the sync is on its collections pages. Pass: it never shows fewer products than before the refresh.

## Test results

Baseline before any change, `pnpm test` at `bdbe1a7`: `44 of 44 suites passed in 34.4s`. Baseline at the start of fix round 1 (`e876643`): `45 of 45 suites passed in 39.7s`.

Fix round 1, final: `pnpm test` gave `45 of 45 suites passed`, exit 0. Then `node scripts/run-tests.js --verbose` for the counts (all 45 green again, 42.7s). Format is passed/failed:

```
test:orders 27/0            test:shipping 12/0          test:shopify-push 13/0
test:shopify-boundary 41/0  test:hardening 11/0         test:offers 27/0
test:offers-admin 8/0       test:events 16/0            test:tenancy 9/0
test:platform-sync 15/0     test:admin-console 9/0      test:cms-api 20/0
test:page-editor 53/0       test:refs 8/0               test:sections 15/0
test:cms 11/0               test:platform-ops 9/0       test:tenant-boundary 24/0
test:identity 22/0          test:authz 14/0             test:platform-core 15/0
test:jobs 16/0              test:sync-generations 8/0   test:first-sync 72/0
test:order-projection 14/0  test:commerce 10/0          test:privacy 11/0
test:security 19/0          test:content 19/0           test:releases 25/0
test:themes 10/0            test:storefront 15/0        test:surfaces 15/0
test:billing 14/0           test:provision 9/0          test:reporting 6/0
test:tenant-ops 9/0         test:marketing 4/0          test:customers 9/0
test:commerce-exp 18/0      test:growth 21/0            test:agency 16/0
test:w6 16/0                test:copy 52/0              test:media-upload 119/0
```

906 passed, 0 failed (first build: 882). `test:first-sync` went from 49 to 72 and `test:jobs` from 15 to 16.

`test:perf` was not run (a measurement, not a gate). `node scripts/test-first-sync.js` alone, three times in a row: 72/0 each time. `pnpm exec next build`: compiled successfully, exit 0, one warning (above).

Reproduction runs, each a scratch export of the commit with the final suites copied in:
- First build, `bdbe1a7`: `4 passed, 39 failed` (see "The bugs, reproduced first").
- Fix round 1, `e876643`: `test:first-sync` `60 passed, 12 failed`. The failures were the five quoted in Fix round 1, plus the phantom prune row, the 5xx-with-401 error, the missing read limit, the run-on sentence, the start button with no link, the red refresh, and the dashboard rule. `test:jobs` `15 passed, 1 failed` (the `makeJobDue` case).

## Mutation check

Scratch runner, not committed. Each mutation is applied to the real file, the listed suites run (240-second limit each; a hang counts as caught), and the file is restored. `git diff` was checked afterwards: no mutation left behind.

**First build, round 1: 40 mutations, 37 caught, 3 survived.**

Caught, with the first test that failed: no abort when the guard misses (forged prune); guard ignores the phase (forged prune); stop after the first products page, products always from page 1, skip member tails, slice ignores its deadline, requeue ignored, no after() kick, connect queues but doesn't kick, support poll nudges, member positions restart per page, prune after the first page (the >60s test); handle-clash cleanup removed (handle test); child rows as plain inserts (orphan variant test); long jobs leased without a budget, long jobs not last, release keeps the attempt, out-of-time jobs not handed back, requeue keeps attempts (`test-jobs`); no dead-letter hook, no retry on failure (the queue-gives-up test); nothing permanent (401 test); 5xx message changed, no retrying state, retry not noted on the run (retrying test); retry starts over (Try again test); confirmed on any finished run (failed test); progress doesn't reset the retry budget (flaky store test); poll never nudges (console poll test); lease always granted (one runner test); no products total (progress test); no stalled state (stalled test); no progress bar (rendered test); prune skipped (kill test's final prune); legacy has no in-process slice (legacy test); pre-run stores read as never synced (legacy rows test); lost runner not told (takeover test).

Survivors, and what was done:
1. **No reconcile after a lost answer.** The run still finished, because the next runner picked it up once the lost runner's lease ran out (90 seconds). Real cost, no test. The two lost-answer tests now run one slice and require that same slice to finish. Caught in round 2.
2. **Commit not fenced by the lease** (`lease_owner` dropped from the guard). The `pages_done` guard alone refused the stale runner in the existing takeover test, because the new runner had already finished. Added "a stale runner's older copy of a page never wins over the runner that took the run over". Caught in round 2.
3. **CLI doesn't join a queued run.** Equivalent: `runCatalogSync`'s own join check repeated what `requestCatalogSync` already does. The duplicate was removed from the code, and the CLI join test still passes.

**First build, round 2:** the two survivors re-run against the new tests: both caught.

**Fix round 1: 23 mutations of the new code, then the reviewer's 11 survivors.**

New code, first pass: 21 of 23 caught.
- Memberships: the run deletes all members first; the tail ignored (cleanup at the collections page for a long collection); no cleanup at the last member page; cleanup ignores webhook time; no cleanup at the collections page (caught: a member from an earlier sync stays in the short collection). All caught by the membership block.
- Leases: `isDue` without lapsed leases (poll test); `runNow` without lapsed leases (stalled Try again test, through the attempts check); `makeJobDue` without lapsed leases, and `makeJobDue` taking a live lease (`test-jobs`).
- Smaller items: abort insert by id only (missing-run prune); permanent ignoring the status, and plain message ignoring a 5xx status (errors test); read limit not passed by the sync, and not sent by `adminGraphql` (stall test, as a hang); no full stop in `soFar` (rendered running test); `linked` ignored in the view, `linked` always true in the status, and a start button despite no link (no-link test); refresh tone always red, and refresh headline unchanged (refresh test); dashboard showing every state (source guard).
- Survivors: (a) **the webhook refetch no longer replacing members**: real, no test. Added `✓ a webhook refetch of a collection replaces its members: one Shopify dropped is gone at once`; caught on re-run. (b) **Members not stamped with the run**: equivalent with one clock (see Known limits); left.

The membership cases were then made independent (each starts from its own complete baseline). On re-run, the run-deletes-all-first, no-collections-page-cleanup and webhook mutants were caught again, and the stamp mutant still survived.

Reviewer's survivors, against the new tests: **11 of 11 caught.** `runNow` ignored on Try again (stalled Try again test, through the attempts check); collection handle-clash cleanup removed (collection handle test); image delete removed (shrinking image test); pre-0020 auto-fail removed (pre-0020 test); `failSyncRun` ignoring a live lease (queue-gives-up test); an "at least" count used as the total ("at least N" test); 404 message removed (errors test); setup step done only with products (setup step test); `commit()`'s `complete` branch removed (last step's lost answer test); retry source check removed (other-API test); busy requeue without `runAfter` (other-runner test).

Not mutated: the setup checklist's in-progress hint text, the operator console toast, the Settings section label and the connect page sentence (copy; drills D5, D7 and M8), and `countProductsAdmin`'s error path.
