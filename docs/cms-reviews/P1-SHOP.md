# P1-SHOP: Shopify boundary test, one scope list, dead link removed, test gate

Covers SHOP-01, SHOP-02, SHOP-03, SHOP-04 and SHOP-06 in
`docs/CMS_FULL_BUILD_SPEC.md` section 7.11. Branch `cms/p1-shop`, cut from 939d630.
This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, except one SHOP-02 acceptance item that needs OVL-03 (see below) |
| Locally tested | Yes. Exact commands and results below |
| Browser verified | NOT DONE. No browser or dev server in this batch |
| Staging verified | NOT DONE |
| Production enabled | NO. The workflow has never run on GitHub, and the hooks are deliberately off |

## What changed

- `scripts/test-shopify-boundary.js` (new, `test:shopify-boundary`): 41 checks.
- `lib/platform/oauth.js`: `OAUTH_SCOPES` is now the one list. `scripts/shopify-oauth.js`
  imports it and its own copy is gone.
- `components/cart/CartContext.js`: `checkoutUrl` and its `numericId` import removed.
- `lib/shopify-push.js`, `lib/order-cancel.js`: comments naming the free-text routes. No logic change.
- `scripts/run-tests.js` (new, `pnpm test`), `.github/workflows/test.yml` (new),
  `.githooks/pre-commit` (new), `.githooks/pre-merge-commit` (new),
  `scripts/enable-git-hooks.sh` (new, `pnpm hooks:enable`).
- `package.json`: `test`, `hooks:enable`, `test:shopify-boundary`, `test:offers`.
- `lib/cms/history.js` and `scripts/test-shopify-push.js`: flake fixes the gate needed (deviation 2).
  `scripts/test-cms-api.js`: one assertion that saves in a single millisecond (deviation 2).
- Docs: `docs/operations.md` (new section), `README.md`, `docs/platform-guide.md`, the `lib/ids.js` comment.

## Acceptance

### SHOP-01

| Item | Tag | Status | Evidence |
|---|---|---|---|
| Adding `productUpdate` anywhere in `lib`, `app`, `components` or `scripts` fails the test | unit | Pass, with one exception | Temporary break in each of the four directories, plus a comment-only mention in the spike: exit 1 each time (log below). Exception: a file that contains a NUL byte is skipped as binary, so `productUpdate` in it passes (tried, exit 0; see "Known limits") |
| Adding any other `write_*` scope fails the test | unit | Pass | `write_products` added to the list, and separately named in another file: exit 1 both times |
| There is one scope list in the codebase | unit | Pass | `SHOP-01: there is one scope list in the codebase` passes. A second `const SCOPES` in `scripts/shopify-oauth.js`: exit 1. A second list in another file: exit 1 when comma-separated, space-separated, multi-line, or mid-string, because any `read_*` word outside `lib/platform/oauth.js` is flagged unless it is one of two known mentions. The script was also run with no credentials to prove the import resolves (exit 1 with its normal missing-credentials message). Not covered: a third file that builds the authorize URL with `URLSearchParams` and scopes from an env var (see "Known limits") |
| Negative: a REST write to the Admin API is also caught | unit | Pass, with the limit below | `fetch(.../admin/api/2025-10/products/1.json, { method: 'PUT' })` in a temporary `lib` file: exit 1. A base URL with no trailing slash: exit 1, in a new file and in `lib/shopify-admin.js`. Any URL whose path starts at `/admin` fails too, unless it is one of three Shopify endpoints (`graphql.json`, `oauth/access_token`, `oauth/authorize`), or, with its origin in a variable, one of the app's own console pages. So `https://${d}/admin/${p}` with the path passed in, `https://${d}/admin/products/1` and `${base}/admin/${p}`: exit 1 each. In the two files allowed to send the Admin token, any new Admin URL or `fetch` is also a failure. A Shopify client library is refused too, because its REST calls carry no `/admin` URL in our source: any string naming `@shopify/...` or `shopify-api-node` in the scanned folders (so `import`, `require` and `import()`), and those names in `dependencies` or `devDependencies` of `package.json`. `@shopify/admin-api-client` with `c.put(...)`, `shopify-api-node` with `s.product.update(...)`, `@shopify/shopify-api` with `clients.Rest`, a `require`, a dynamic `import()`, and each name added to `package.json`: exit 1 each. See "Known limits" for the split-text cases |

### SHOP-02

| Item | Tag | Status | Evidence |
|---|---|---|---|
| A test with an overlaid title proves that no overlay string appears anywhere in the push payload | unit | **Partial. Stays open until OVL-03** | No overlay exists yet. The test seeds a `products`, a `variants` and a `product_images` row with a marker string in every text column except the ids (another check holds that list to `lib/schema.sql`, so a new text column there fails until it is seeded; a column added only by a tenant migration is not seen, see "Known limits"), runs the real `pushOrderToShopify` against a fake Shopify, and checks every query and variable for those strings and the order's. A temporary break that reads the catalog title from the `products` table into the draft failed with `CATALOG-TITLE-SENTINEL reached Shopify`. The hook is the `OVL-03 HOOK` comment and `seedOverlay()`. `OVERLAY-TITLE-SENTINEL` is already on the checked list, but nothing writes it yet, so today that one string proves nothing |
| Negative: a new key on a line item fails the test | unit | Pass, with the limit below | Exact key sets are asserted: paid lines `quantity, variantId`; gift lines `appliedDiscount, quantity, variantId`. Temporary `title` on a paid line and `customAttributes` on a gift line: exit 1 both times. A key behind a field the order does not have yet (`...(it.displayTitle ? { title: it.displayTitle } : {})`, and the same on a gift): exit 1, because the order is also run through `probeUnknownFields`. Not covered: a key behind a value test on a field the order already has, behind something outside the order, or only on a second line or a larger order (the fixtures have one paid line and one gift). See "Known limits" |

### SHOP-03

| Item | Tag | Status | Evidence |
|---|---|---|---|
| `checkoutUrl` is gone and all tests pass | unit | Pass | `pnpm test`: 41 of 41. Nothing called it before removal (`grep -rn checkoutUrl lib app components scripts` found only the definition). `pnpm build` NOT run (no secrets or servers in this batch), so see the drills below |
| Negative: a grep for Shopify `cart/` checkout URLs in `lib`, `app` and `components` finds nothing | unit | Pass, with the limit below | `SHOP-03: no Shopify cart or checkout link` passes. `checkoutUrl` put back temporarily: exit 1. A link joined by concatenation (`${base}/cart/` + p, base + '/cart/' + p): exit 1. The automated check misses some link shapes (`${d}/cart/c/${t}`, `${d}/checkouts/${id}` with no scheme; see "Known limits"). A plain `grep` finds neither shape in `lib`, `app` or `components` today, only this app's own `/checkout` paths |

### SHOP-04

| Item | Tag | Status | Evidence |
|---|---|---|---|
| The test lists every merchant text reaching Shopify: discount description, discount title, shipping title, note, tags, cancel staff note | unit | Pass | `MERCHANT_TEXT_ROUTES` and `CANCEL_STAFF_NOTE`. Each is proved by following a marker string: offer label, bundle title (through the real offer engine), store name, shipping label, order id, cancel reason. Each one reaches Shopify only by its named field |
| Negative: a new free-text field fails the test | unit | Pass, with the limit below | Every field of a full draft order is checked against a closed list, including empty arrays and objects, in two places: what `buildDraftOrderInput` returns, and what the fake Shopify received from the real push for a paid order and for a COD order. The sent draft must also equal the builder's, and the variables of the find, create and complete calls are compared exactly. Temporary `poNumber` on the draft: exit 1. `poNumber`, `sourceName: siteName()`, an extra `customAttributes` entry or changed note text added where the draft is sent: exit 1 each. An extra variable on the find, create or complete call: exit 1 each. Temporary `note` argument on `orderCancel`: exit 1. `poNumber` behind a field the order does not have yet: exit 1. A new send that reuses an allowed mutation also fails: a second identical `draftOrderCreate` or `orderCancel` document, a new export calling `createDraft`, a function that reads a `products` row and sends it through `createDraft`, and a new Shopify call in any file that holds a mutation document: exit 1 each. Not covered: the same limit as SHOP-02, a field added only behind a condition these orders do not reach, an extra variable on the cancel call behind an order field the test does not set, and anything sent by the follow-up query that runs only when Shopify refuses the cancel. See "Known limits" |

### SHOP-06

| Item | Tag | Status | Evidence |
|---|---|---|---|
| A failing `test-shopify-boundary` fails the check | unit | Pass locally | `pnpm test` with the suite failing: exit 1, `40 of 41 suites passed`, `Failed: test:shopify-boundary`. This is now also run by the suite: a copy of the real runner over a small package whose boundary suite fails must exit 1, and copies of the real hooks, in a throwaway git repo with a stand-in `pnpm` that exits 3, must stop a real `git commit` and a real `git merge` |
| Negative: adding `productUpdate` on a branch produces a failing check | manual drill | Pass locally, **not on GitHub** | Round 2: `productUpdate` in a temporary staged file, then `git -c core.hooksPath=.githooks ... commit`: hook ran, `Commit stopped`, `COMMIT EXIT 1`, HEAD unchanged. Round 3: the hook now also stops when a staged file differs from the file on disk, which round 2's hook missed (reproduced, below). The workflow itself has never run, because nothing here pushes |

## Proof that the tests can fail

Each break was applied, run, then reverted. The tree hash over `lib`, `app`,
`components`, `scripts`, `.githooks`, `.github` and `package.json` was identical
before and after, and the boundary suite passed again after the restore. For the rows
added after the first review, the check was `git diff | shasum` before and after. The
rows added after the second review were run on a plain copy of the tree outside the repo,
with a script that restored each file it changed.

| Temporary break | Command | Exit | Check that failed |
|---|---|---|---|
| `productUpdate` document in `lib/` | `node scripts/test-shopify-boundary.js` | 1 | Allowlist, name scan, document list |
| same in `app/` | same | 1 | same |
| same in `components/` | same | 1 | same |
| same in `scripts/` | same | 1 | same |
| `// productUpdate` comment in the spike | same | 1 | Name scan. The spike exception covers only `orderCreate` |
| `write_products` in `OAUTH_SCOPES` | same | 1 | Write scopes exact, write token scan |
| `"read_products,write_products"` in another file | same | 1 | Write token scan, one scope list |
| Second `const SCOPES` in `scripts/shopify-oauth.js` | same | 1 | One scope list |
| REST `PUT` to `/admin/api/2025-10/products/1.json` | same | 1 | No REST call |
| `title` on a paid line item | same | 1 | SHOP-02 line keys, snapshot content, real push; SHOP-04 known fields |
| `customAttributes` on a gift line | same | 1 | SHOP-02 gift keys, real push; SHOP-04 known fields |
| `poNumber: offerTitles` on the draft | same | 1 | SHOP-04 known fields (twice), merchant text routes |
| `note: "merchant text"` argument on `orderCancel` | same | 1 | SHOP-01 document list |
| Order title added to the draft note | same | 1 | SHOP-02 snapshot content, real push |
| Catalog title read from `products` into the draft | same | 1 | SHOP-02 real push: `CATALOG-TITLE-SENTINEL reached Shopify` |
| `checkoutUrl` put back | same | 1 | SHOP-03 |
| `productUpdate` in `lib/` | `pnpm test` | 1 | `40 of 41 suites passed`, `Failed: test:shopify-boundary` |
| `productUpdate` in `lib/` | `sh .githooks/pre-commit` | 1 | `Commit stopped: pnpm test failed` |
| `productUpdate` in a staged `lib/` file | `git -c core.hooksPath=.githooks ... commit` | 1 | Hook refused the commit. No commit made |
| `scripts/test-orphan-probe.js` with no script | `pnpm test` | 1 | `has no test:* script in package.json` |
| `test:shopify-boundary` removed from `package.json` | `pnpm test` | 1 | `test:shopify-boundary is missing` |
| `\|\| true` on `test:shopify-boundary` in `package.json` | `pnpm test` | 1 | `test:shopify-boundary must be exactly: ...` |
| `test:shopify-boundary` pointed at another file | `pnpm test` | 1 | same |
| Paid line `...(it.displayTitle ? { title: it.displayTitle } : {})` | `node scripts/test-shopify-boundary.js` | 1 | SHOP-02 and SHOP-04 unknown-field checks |
| Gift line `...(g.overlayTitle ? { title: g.overlayTitle } : {})` | same | 1 | same |
| Draft `...(order.merchant_note ? { poNumber: order.merchant_note } : {})` | same | 1 | same |
| Nested `it.overlay?.title` behind a key | same | 1 | same, through the list of unknown reads |
| `title: g.overlayTitle \|\| "Free gift"`, an unknown field inside a known value | same | 1 | same, through the list of unknown reads |
| Unknown field on `snap.shipping` and on `snap.address` | same | 1 each | same |
| New `presentmentTags: []`, `presentmentInfo: {}`, and `customAttributes: []` on a line | same | 1 each | SHOP-04 known fields; the line one also SHOP-02 line keys |
| Indented document, directive, `collectionAddProducts` (H1) | same | 1 | Allowlist, document list |
| Indented document, `mutation ${n}(...)`, `collectionAddProducts` (H2) | same | 1 | same |
| `lib/zz-probe.graphql` with a directive, `collectionReorderProducts` (H3) | same | 1 | same |
| Indented `mutation ${rest}`, and `mutation Foo($i: ID!) ${body}` | same | 1 each | same, as `<unreadable>` |
| REST `PUT` in `lib/shopify-admin.js`, base URL `.../admin/api` with no slash (R7) | same | 1 | No REST call, known URLs |
| `/admin/` + path in `lib/shopify-admin.js` (R6) | same | 1 | Known URLs |
| New `fetch(url)` in `lib/shopify-admin.js`, URL from elsewhere | same | 1 | Known URLs (fetch count) |
| New `fetch` in `lib/shopify-admin.js`, URL split as `'/adm' + 'in/'` | same | 1 | Known URLs (fetch count) |
| New Admin URL in the spike | same | 1 | Known URLs |
| `${base}/cart/` + p in `components`, base + '/cart/' + p in `lib` | same | 1 each | SHOP-03 |
| Workflow: `continue-on-error: true`, job `if: false`, step `if: false`, step commented out, `\|\| true`, `push` limited to one branch | same | 1 each | SHOP-06 |
| Hook: ends in `exit 0`, early `exit 0`, `pnpm test` commented out, a different command | same | 1 each | SHOP-06 |
| A suite that never ends, `TEST_SUITE_TIMEOUT_MS=3000` | `pnpm test` | 1 | `stopped after 3.0s without finishing`, 0 processes left over |
| At the send in `pushOrderToShopify`'s `createDraft`: `poNumber`, `sourceName: siteName()`, extra `customAttributes` entry, text added to the note, an attribute's value changed | `node scripts/test-shopify-boundary.js` | 1 each | Both SHOP-04 real push checks |
| Extra variable on the find, create and complete calls | same | 1 each | Both SHOP-04 real push checks |
| `products.handle`, `products.options`, `variants.selected_options`, `product_images.alt` appended to the note at the send | same | 1 each | SHOP-02 real push (the marker string), and both SHOP-04 real push checks |
| New text column in `products` in `lib/schema.sql` | same | 1 | SHOP-02 every text column seeded |
| Exported `adminHeaders` in `lib/shopify-admin.js`, new file calling `https://${d}/admin/${p}` with `products/${id}.json` passed in | same | 1 | No REST call |
| `https://${d}/admin/products/1` with caller headers | same | 1 | No REST call |
| `${base}/admin/${p}`, `${base}/admin/products`, `"https://" + d + "/admin/" + p` | same | 1 each | No REST call |
| A second scope list in a new file: `"read_products read_orders read_themes"`, multi-line, `'x,read_themes'`, `'unauthenticated_read_checkouts'`, and `read_themes` in a comment | same | 1 each | One scope list |
| Hook: `status=0` after `status=$?` | same | 1 | Hook behaviour |
| Hook: `pnpm test` inside `if false; then ... fi` with `status=0` first | same | 1 | Hook behaviour |
| Hook not executable | same | 1 | Hook behaviour |
| Workflow: `continue-on-error : true` (space before the colon) | same | 1 | SHOP-06 text check |
| Runner: ends in `process.exit(0)` | same | 1 | Runner fails a failing suite, stuck suite |
| Runner: `ok: true` for every suite | same | 1 | same |
| Runner: `\|\| true` on `test:orders` in `package.json` | same | 1 | SHOP-06 text check. The runner also refuses that command form, shown on its fixture |
| Runner: command check removed | same | 1 | Runner refuses a weakened command |
| Runner: suite file guard back to any script (`zz:helper`) | same | 1 | Runner refuses a suite no gated script runs. The fixture run showed `1 of 1 suites passed` with the guard back |
| Runner: `test:orders` added to `NOT_A_GATE` | same | 1 | SHOP-06 text check |
| Runner: no finish after the suite's process exits | same | 1 | Detached child check, after waiting the full 30s |
| The round 1 runner, with the new tests | same | 1 | Weakened command, detached child and stuck suite checks. Took 64s, because each detached child held it for the full 30s |

Round 3 rows. Each was run by a script that wrote the change, ran the suite and put the
exact bytes back; `git status` was clean afterwards. "Was" is the same break on the
round 2 suite, run first in this worktree.

| Temporary break | Command | Exit | Check that failed |
|---|---|---|---|
| A second identical `draftOrderCreate` document in `lib/shopify-push.js`, sending `product.description` and `product.title` | `node scripts/test-shopify-boundary.js` | 1 (was 0) | Document list, Shopify calls |
| A second identical `orderCancel` document in `lib/order-cancel.js`, sending `order.title` as the staff note | same | 1 (was 0) | same |
| `export const pushContent = (p, gql) => createDraft({ note: p.description, ... }, gql)` | same | 1 (was 0) | Draft helpers |
| `syncTitle`: reads a `products` row and sends `row.title` and `row.vendor` through `createDraft` | same | 1 (was 0) | Draft helpers |
| `export { createDraft }`; `export async function completeDraft`; a third `completeDraft` call; `const cd = createDraft` | same | 1 each (was 0) | Draft helpers |
| A second token mint, `adminGraphqlWithToken(t, MINT_MUTATION, { input: { title } })`, in `lib/shopify-admin.js` | same | 1 (was 0) | Shopify calls |
| A second `gql(CREATE_SUB, ...)`, and `adminGraphql(CREATE_SUB, ...)`, in `lib/platform/shopify-webhooks.js` | same | 1 each (was 1, by the admin payload check only) | Shopify calls, admin payload |
| `@shopify/admin-api-client` with `c.put(...)`, `shopify-api-node` with `s.product.update(...)`, `@shopify/shopify-api` with `clients.Rest`, `require("shopify-api-node")`, and ``import(`@shopify/admin-api-client`)`` in `components` | same | 1 each (was 0) | Client library |
| `@shopify/admin-api-client` in `dependencies`; `shopify-api-node` in `devDependencies` | same | 1 each (was 0) | Client library |
| `mutation { # }` with `collectionAddProducts(...)` on the next line; the same as a one-line string with `\n` written in it | same | 1 each (was 0) | Allowlist, document list, Shopify calls |
| `orderCancel(...) { job { id } } # }` with `collectionAddProducts(...)` on the next line; a `}` inside a string argument | same | 1 each (was 1) | same |
| Hook: the staged check turned off (`if false`) | same | 1 | Staged content, merge commit |
| Hook: the staged check moved after the `unset` line | same | 1 | Staged content (the `commit -a` case) |
| Hook: the staged check stops with `exit 0` | same | 1 | Hook text, staged content, merge commit |
| Merge hook: only `exit 0`; or runs `pre-commit` and then `exit 0` | same | 1 each | Merge commit |
| Changed `createDraft(buildDraftOrderInput(order), gql)` to add `poNumber` (control) | same | 1 | Both SHOP-04 real push checks |
| Staged `lib/zz-staged-probe.js` holding `productUpdate`, then removed from disk | `sh .githooks/pre-commit` | round 2 hook: `41 of 41 suites passed`, no stop. Round 3 hook: 1 | `Commit stopped: these files on disk differ from what is staged`, before any suite ran |
| `lib/cms/history.js` put back to its 939d630 version (ties broken by the random `id`) | `node scripts/test-cms-api.js` | 1 in 10 of 10 runs | The new same-millisecond assertion, or the older `newest kept` one |

## SHOP-06 findings

**Time.** `pnpm test` takes about 25 seconds here (25.1s and 27.0s on the final code).
About 7 seconds of that is the boundary suite, which now runs the real hook and runner.
That is far under the 2 minute limit, so the hook runs the same `pnpm test`, as the spec
asks. No fast subset was needed.

**No secrets or network: every suite qualifies.** All 41 suites passed with a
stripped environment (`env -i` with only `PATH`, `HOME`, `TZ=UTC`, `CI=true`) and
outbound network denied by `sandbox-exec`, except loopback. No suite needs
reporting as an exception. Those runs below are from before the second review. After it,
`pnpm test` was run again with network denied (exit 0, `41 of 41 suites passed in 27.0s`),
and the boundary suite with `CI=true TZ=UTC` (35 passed). The stripped-environment run and
the Node 24 run were not repeated, because the tool running this session refuses `env -i`.
The new checks need only `pnpm`, `git` and `sleep` on `PATH`.

- Node 26.0.0: exit 0, `41 of 41 suites passed in 22.5s`.
- Node 24.15.0: exit 0, `41 of 41 suites passed in 17.5s`.
- A preload logger recorded every non-loopback connect and DNS lookup. It recorded
  **none** in either run. Control: the same logger did record `example.com` when a
  script tried it, and the sandbox blocked that with `EPERM`.

**The workflow is unproven on Linux.** It has not run on GitHub. What was checked:
the YAML parses, 2006 relative and `@/` imports match the exact file case (Linux is
case-sensitive and this Mac is not), and the suites pass at `TZ=UTC`. It pins Node 26
to match the machine the baseline ran on. The repo does not state a production Node version.

## Deviations and differences from the spec

1. **`test:offers` added.** Section 8.15 names `test-offers` as a suite that must stay
   green, but `package.json` had no such script, so it was never in the count of 39.
   It passes. The gate now has 41 suites: the 39, plus `test:offers`, plus
   `test:shopify-boundary`. The runner also fails if no gated `test:*` script runs a
   `scripts/test-*.js`, or if a `test:*` command is not exactly `node scripts/<file>.js`.
2. **Two flaky suites fixed, outside the SHOP scope.** The baseline "all pass" was only
   sometimes true. A required check that fails at random would soon be bypassed, so
   these were fixed rather than left.
   - `test:cms-api` failed 12 of 40 runs: `newest kept expected 26, got 25`. Two history
     rows written in one millisecond were ordered by their random id, so the wrong one
     could be pruned or listed first. This is a real, if small, ordering bug in the code,
     not the test: a founder saving twice in one millisecond could lose the newer entry.
     `lib/cms/history.js` now breaks ties by `rowid`, which follows insert order (the table
     is not `WITHOUT ROWID`, and pruning removes the oldest rows, so a new row always gets
     the highest `rowid`). After the fix: 0 failures in 60 runs.
     Round 3: other branches cut from 939d630 still fail this way (1 of 15 there, 4 of 15 on
     another branch, as reported), because they do not have this fix. Re-checked here: the
     939d630 version of `lib/cms/history.js` failed 1 of 30 runs; this branch's 0 of 40.
     The suite now also saves 27 entries with the clock held still, so all of them share one
     millisecond. That makes the bug fail every run instead of at random: the 939d630 code
     failed 10 of 10, the fixed code passes.
   - `test:shopify-push` failed 2 of 20 full runs: a sweep in the same millisecond as
     the failure still sees the 1ms backoff. This was a test bug. The test now waits
     10ms, as another test in that file already did. After the fix: 0 failures in 100 runs,
     and 0 of 40 again in round 3.
   - Then the whole gate: 15 of 15 runs passed in round 1. Round 3 counts are under
     "Test results". A rarer flake could still exist.
3. **The hooks are present but OFF, as instructed for this batch.** So "runs as a required
   local check before each commit" is **not yet true**. It becomes true when the owner
   runs `pnpm hooks:enable` after the parallel sessions finish. `scripts/enable-git-hooks.sh`
   has only been syntax-checked (`sh -n`), never run. `core.hooksPath` was confirmed unset
   afterwards, in round 2 and again in round 3. In round 2 the hook was exercised in this
   repo with `git -c core.hooksPath=.githooks`, which applies to one call and writes no
   config. In round 3 the commit and merge cases run inside the suite, in a throwaway repo,
   so nothing here touches this repo's hook setting.
   `.githooks/pre-merge-commit` is new in round 3: git runs it instead of `pre-commit` when
   `git merge` makes a merge commit by itself, and it runs the same check.
4. **More checks than the spec asks for.** The test also locks every mutation document's
   file, exact arguments and count, as far as the parser can read them (see "Known
   limits"), the number of Shopify calls in each file that holds a document, the two draft
   helpers' call sites, and the two files allowed to send the Admin token header.
   Any Admin REST URL counts as a write, even a read, because the method cannot be read
   reliably from source. A future REST read therefore needs a deliberate change here.
   The two token files also have their Admin URLs and `fetch` count locked. The draft
   order test also fails on any read of a field the fixture lacks, even one that sends
   nothing new, so a new read must be added to `fullOrder()` on purpose.
5. **The spike has one more mutation than the spec's list.** `scripts/spike-order-push.js`
   also calls `orderCreate`. The exception covers that one name in that one file, and
   nothing may import the spike.
6. **One more field carries merchant-set text.** The spec's six routes do not include
   `customAttributes[].value`, which carries our order id (with the store's prefix) on
   `bl_order_id`, next to a fixed string, an amount and payment ids. It is order data. The
   test names it in `MERCHANT_TEXT_ROUTES` and the comment in `lib/shopify-push.js` names it
   too. That makes six fields on the draft, plus the cancel staff note: seven routes in all.
7. **`NEXT_PUBLIC_SHOPIFY_DOMAIN` is still in `.env.example`.** Nothing reads it now. It
   was left alone because this batch does not open `.env` files. The owner can delete that line.
8. **Two small differences from what the second review proposed.** The suite file guard
   counts only gated scripts, not `test:perf` as well, so a test file wired to `test:perf`
   also fails. And only one URL needed an exemption (`http://localhost:3017/admin/login`,
   printed by the design seed). The `http://rfN.test/api/admin/refs` URLs in `test-refs` have
   `/api` before `/admin`, and the scan looks only for paths that start at `/admin`. The scan
   also goes further than asked: it covers a URL whose origin is in a variable or joined with
   `+`, because this app builds its own console links that way and `${base}/admin/${p}` looks
   the same as they do. Those get a short list of console pages instead of a free pass.
9. **One difference from what the third review proposed.** It asked for `createDraft` and
   `completeDraft` to have exactly one call site each. `completeDraft` has two today, both in
   `pushOrderToShopify`: after a new draft is created, and for a leftover draft from a crashed
   attempt. So the lock is one call for `createDraft` and two for `completeDraft`, plus their
   definitions. `completeDraft` sends only a draft id and a true or false. The other parts of
   that finding were right and are fixed.

Spec citations for these five requirements were opened and matched the code at 939d630.
`main` is still 92 commits ahead of `origin` (`git rev-list --count origin/main..main`), so
a push-triggered workflow would not run today, as the spec says. One old comment was wrong: `lib/ids.js` said `draftOrderCreate` uses numeric ids, but the
push sends full ids. That comment is corrected.

## Known limits

What is deliberately left. "Tried" means the break was run against the final suite and
gave exit 0 (it passed when it should not have), unless the line says otherwise.

**Ways around the checks that need deliberately evasive code.** The scans read source
text, so they can be beaten on purpose. These are not chased:

- A mutation split across strings: `"muta" + "tion { ... }"`, the word `mutation` kept in
  its own constant and joined in with `${OP} { ... }`, and `${FRAGMENT}` followed by
  `mutation ${rest}` when nothing else in the string can be read (tried in round 2).
- A file that contains a NUL byte is skipped as binary, so a full `productUpdate` document
  after `// <NUL>` passes (tried).
- A `{` or `}` inside a string argument is counted as a brace. In a new file that still
  fails, as any new document does (tried, exit 1). Edited into a listed document, inside a nested field (`job { id(f: "}") }`), it ends the reading early and
  hides the fields after it, such as `collectionAddProducts` (tried in `lib/order-cancel.js`).
  No document here has a string argument today.
- A Shopify call through another name for the transport, such as `const send = gql` and then
  `send(CREATE_SUB, ...)` in `lib/platform/shopify-webhooks.js`, adds no counted call. Sent on
  every run, the admin payload check still fails it (tried, exit 1). Behind a tenant setting,
  it passes (tried).
- A client library named in pieces, such as `require("shopify-" + "api-node")` (tried). Only
  `@shopify/...` and `shopify-api-node` are checked, so another Shopify client package under
  a different name is not refused either. Its REST URL would still be caught if written out.
- REST, in a new file: `/admin` kept in a constant (`https://${d}${ADMIN}/products/1`),
  `new URL("/admin/products/1", base)`, and a console page with more joined on after it
  (`${base}/admin` + p) (tried in round 2). The token header check does not help with these if
  the header comes from a helper exported from `lib/shopify-admin.js`, because it looks only at
  which files contain the header's name. A relative `/admin/...` string on its own is not
  flagged, because the console's own links look like that.
- REST, in `lib/shopify-admin.js` and the spike: their exact Admin URLs and `fetch` count are
  locked. A new `fetch` fails even with a split URL, and changing an existing `fetch` to a
  variable also fails. A split URL picked at run time beside a known one, going through an
  existing `fetch`, would still pass.
- A read scope named in pieces (`"read_" + "themes"`) outside `lib/platform/oauth.js` (tried
  in round 2).

**Shapes the third review found that are left as they are.** No code has them today. Each
was reported by the reviewer with exit 0 and tried again here on the final suite, exit 0:

- SHOP-03: `${d}/cart/c/${t}` and `${d}/checkouts/${id}` with no scheme. The reviewer also
  reported `"https://" + d + "/checkouts/" + id` and `"https://" + d + "/cart"` (not re-tried).
  The SHOP-03 check is narrower than its name.
- SHOP-02 and SHOP-04: the fixtures have one paid line and one gift, and a small discount. A
  key added only on the second paid line, or a field added only when the discount is over
  1000, passes. The builder-level key checks look at `lineItems[0]` and `[1]`.
- One scope list: a third file that builds the authorize URL with `URLSearchParams` and takes
  its scopes from an env var names no scope word, so it passes. The granted scopes could then
  differ from `OAUTH_SCOPES`. Today only `lib/platform/oauth.js`, `scripts/shopify-oauth.js`
  and `scripts/test-platform-sync.js` name `/admin/oauth/authorize`.
- SHOP-02: "every text column" is held to `lib/schema.sql` only. A text column added by a
  tenant migration alone passes (`ALTER TABLE products ADD COLUMN seo_title TEXT` in a new
  migration). One exists already and is not seeded: `products.sync_generation`, a sync marker
  added by `migrations/tenant/0002_sync_runs.sql`.
- SHOP-04: the follow-up query in `lib/order-cancel.js` runs only when Shopify refuses the
  cancel, and the fake Shopify never refuses. Sending the typed reason there passes.
- Runner: the suite file guard sees only `.js`, so a `scripts/test-*.mjs` file would never
  run, with no warning (reported by the reviewer, not re-tried).
- The `fetch` count in the two token files counts the word, so a comment such as
  `// we fetch nothing new here` in `lib/shopify-admin.js` fails with a message about fetch
  calls (tried, exit 1). That is a false alarm, not a gap.

**Branches the test orders do not reach.**

- The real push checks read what was sent for the two orders they push. A field added where
  the draft is sent, behind a condition those orders do not reach, is missed (tried in round 3:
  `poNumber` only when the total is over 100000). The path that adopts a leftover draft is not
  run here, only in `test:shopify-push`. The text of the read query is not compared, only its
  variables.
- `probeUnknownFields` fires a branch only when it depends on a field the fixture lacks. A key
  behind a value test on a field the fixture has, such as
  `...(it.quantity > 50 ? { title: it.title } : {})`, is missed (tried in round 2). So is a key
  behind something outside the order, such as an env var or a tenant setting (tried in round 2).
- That probe covers `buildDraftOrderInput` only. The cancel call reads its order from the
  database, so an extra variable behind an unset order field is missed (tried in round 2). A
  field that is always sent is caught, because the cancel variables are compared exactly.

**What the document and name scans read.**

- A readable document is caught whatever its name, directives, indentation or `#` comments,
  including a `#` comment that holds a brace. A selection with no field in it, and a one-line
  string with `\n` written in it, read as `<unreadable>`, which fails. Not caught: the
  evasive cases above (a NUL byte, a brace inside a string argument, a document split across
  strings).
- A mutation name outside a document is caught only for the resources in `MUTATION_NAME`, and
  only when the name ends in a verb. `collectionAddProducts` in a comment is not flagged.
- `MUTATION_NAME` and `NOT_SCOPES` can flag an ordinary identifier, such as a local function
  that happens to be called `pageCreate`. None exists today on `cms/phase-1`, `cms/p1-gen03`,
  `cms/p1-med01` or `cms/p1-au05` (checked with `git grep` in round 2). If one appears, rename
  it, or for a `write_*` name add it to `NOT_SCOPES`. The same goes for `SEND_CALLS` and
  `DRAFT_HELPERS`: a comment that names `gql(` or `createDraft` in a locked file fails, and
  the message names the count to look at.
- The one-list check flags any `read_*` word in a production file other than
  `lib/platform/oauth.js`, except the two known mentions in `READ_SCOPE_MENTIONS`. Files named
  `scripts/test-*` are not checked, because tests name scopes on purpose. Write scopes are
  caught anywhere, tests included. An ordinary name such as `read_more` would be flagged.
- The boundary test skips its own file, and it scans only `lib`, `app`, `components` and
  `scripts`, as the requirement says. Root files such as `instrumentation.js` are not scanned.

**The gate and the hooks.**

- The suite runs copies of the real hooks, with a stand-in `pnpm`, in a throwaway git repo:
  a real `git commit` and a real `git merge`. It runs a copy of the real runner through the
  real `pnpm` over small throwaway packages. It does not run the hook into the real
  `pnpm test`, because the suite would call itself. That link is only run by hand (see "Test
  results").
- The hook compares tracked files only. An untracked file on disk is seen by the tests and is
  not part of the commit, so a commit whose tests pass only because of an untracked file still
  goes through.
- A commit of part of the work (`git add -p`, or `git commit <file>` with other changes on
  disk) is stopped, because what is on disk is not what is being committed. That is on
  purpose: commit the rest, or put it aside first.
- A fast-forward merge makes no commit, so no hook runs. A merge stopped by a conflict is
  finished with `git commit`, which runs `pre-commit` (from git's documentation, not tried).
  Git does not run `pre-commit` for `git rebase` or `git cherry-pick` (from git's
  documentation, not tried). `pre-merge-commit` needs git 2.24 or later. This Mac has 2.50.1.
- A runner edit that changes behaviour only for the real `package.json`, such as skipping a
  suite by name, is seen only by review, apart from the check that `NOT_A_GATE` is exactly
  `test:perf`.
- The workflow is only read as text, so it is the weakest of the three. The text check cannot
  see the workflow being turned off on GitHub, or a switch written in a form it does not know.
  Nothing here can see `git commit --no-verify` or the hooks not being enabled.
- `core.hooksPath` is shared by all worktrees. A worktree on a commit older than this one has
  no `.githooks` folder, and git then runs no hook there, with no warning.
- A suite that exits 0 and leaves a detached process behind passes, and that process keeps
  running. The runner waits 1 second for output after a suite's process has gone, so anything
  written later is lost.

## First review round

An independent reviewer reported three serious gaps and four smaller ones. Each was
reproduced on the unfixed tree before changing anything, and none was wrong. All are
fixed: keys hidden behind fields the fixture lacked (blocker), documents the mutation scan
could not read, REST calls with no trailing slash and calls inside the token files, the
wiring check, concatenated cart links, and empty containers. Each now has a row in the
table above. What these fixes do not cover is under "Known limits".

## Second review round

An independent reviewer reported one blocker, one major and six minor items. Each was checked
first, and all were right. The ones about what the suite misses were reproduced on the unfixed
code (exit 0 each). The time limit one was reproduced by running the round 1 runner under the
new tests, and the suite file guard one by putting its old line back (`1 of 1 suites passed`).
The comment one was checked by reading. All eight are fixed:

- **Blocker, SHOP-04:** the known-field checks read only the builder's return value, so a field
  added where the draft is sent passed. The real push is now checked on what was sent: paths,
  custom attribute keys, exact variables on all three calls, and equality with the builder's draft.
- **Major, SHOP-01:** a REST helper with the path passed in and the header exported from an
  allowed file passed. The earlier limit text, "Shopify refuses such a call without the token",
  was wrong for this case, because the token is sent. Any `/admin` path now counts.
- **Scope list:** any `read_*` word now counts, not only one at the start of a string.
- **Wiring:** the hook and runner are now run, not just read. The old test title, "nothing turns
  them off", claimed more than it proved and is renamed. Every `test:*` command must be exactly
  `node scripts/<file>.js`.
- **Time limit:** a detached child holding the output no longer hangs the gate.
- **Suite file guard:** a file wired to a non-test script no longer counts as run.
- **Catalog text:** every text column of the three catalog tables is seeded and checked.
- **Comments:** `lib/shopify-push.js` and `MERCHANT_TEXT_ROUTES` now name
  `customAttributes[].value` as a route.

## Third review round

An independent reviewer reported two major and eight minor items. Four of them, and one
flake reported separately, were in scope for this round. Each was checked against the code
first and reproduced before the fix (exit 0 on the round 2 suite, or the round 2 hook
passing). All five were right, with one correction (deviation 9):

- **Major, SHOP-02 and SHOP-04:** documents were compared as a set, so a second identical
  `draftOrderCreate` or `orderCancel` passed, and a new caller of `createDraft` added no
  document at all. Now each document is counted, each file that holds a document has a fixed
  number of Shopify calls, and `createDraft` and `completeDraft` must stay unexported with
  known call sites. The comment above `MUTATION_DOCUMENTS` and deviation 4 now say what is
  really locked.
- **Major, SHOP-01:** a Shopify client library makes REST writes that no scan could see. Any
  `@shopify/...` or `shopify-api-node` string in the scanned folders now fails, and so do those
  names in `dependencies` and `devDependencies`, also under another name (`npm:@shopify/...`).
- **Minor, SHOP-06:** the hook never read what was staged, and `git merge` ran no tracked hook.
  The hook now stops, before running anything, when a tracked file on disk differs from what
  is staged, and `.githooks/pre-merge-commit` runs the same check. The docs said "including
  changes that are not staged", which read as more than the hook did. They now say what
  happens. The round 2 line "The hook tests the files on disk, not only what is staged" is gone.
- **Minor, SHOP-01:** "A readable document is caught whatever its name, directives or
  indentation" was false for a `}` inside a `#` comment. The parser now skips `#` comments and
  reads a selection with no field as `<unreadable>`. The corrected sentence is in "Known
  limits", which also lists the NUL byte case, left as it is.
- **Flake:** `test:cms-api`, `newest kept expected 26, got 25`. The cause is a real ordering
  bug in `lib/cms/history.js`, fixed in the code on this branch in round 1 (deviation 2). The
  failures measured at 939d630 and on another branch are on code without that fix. A
  same-millisecond assertion now makes the bug fail every run if it comes back.

The other six minor items are left as they are and listed in "Known limits": the SHOP-03 link
shapes, the one-line fixtures, the authorize URL built with `URLSearchParams`, text columns
added only by migrations, the cancel follow-up query, and the runner guard that sees only
`.js` (with the `fetch` word count, which is a false alarm rather than a gap).

## Test results on the final tree

```
pnpm test:shopify-boundary    35 passed, 0 failed
pnpm test:shopify-push        13 passed, 0 failed
pnpm test:platform-sync       15 passed, 0 failed
pnpm test:sync-generations     8 passed, 0 failed
pnpm test:order-projection    14 passed, 0 failed
pnpm test:cms-api             20 passed, 0 failed
pnpm test:cms                 11 passed, 0 failed
pnpm test:offers              27 passed, 0 failed
pnpm test:storefront          15 passed, 0 failed
pnpm test:commerce            10 passed, 0 failed
pnpm test                     41 of 41 suites passed, exit 0
```

`pnpm test` runs every `test:*` suite except `test:perf`, which is a measurement.

## Still needs doing

**Browser drills (none done):**
- `components/cart/CartContext.js` changed. On the design harness: open a storefront page,
  add to cart, change quantity, remove, and check the drawer and checkout still work.
  Nothing else here has a screen.

**Manual drills (none done):**
- Run `pnpm build`. It was not run in this batch.
- Push a branch and watch `.github/workflows/test.yml` pass, then push one with
  `productUpdate` and watch it fail. This is the real test of the SHOP-06 negative.
- Run `pnpm hooks:enable` once the parallel sessions finish, then make one commit.
- Run `pnpm shopify:oauth` against a dev store to confirm the shared scope list in a real
  grant. Only the import was tested.
- When OVL-03 lands, finish the SHOP-02 overlay test at the `OVL-03 HOOK`.
