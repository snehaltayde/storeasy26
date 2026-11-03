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
| Production enabled | NO. The workflow has never run on GitHub, and the hook is deliberately off |

## What changed

- `scripts/test-shopify-boundary.js` (new, `test:shopify-boundary`): 23 checks.
- `lib/platform/oauth.js`: `OAUTH_SCOPES` is now the one list. `scripts/shopify-oauth.js`
  imports it and its own copy is gone.
- `components/cart/CartContext.js`: `checkoutUrl` and its `numericId` import removed.
- `lib/shopify-push.js`, `lib/order-cancel.js`: comments naming the free-text routes. No logic change.
- `scripts/run-tests.js` (new, `pnpm test`), `.github/workflows/test.yml` (new),
  `.githooks/pre-commit` (new), `scripts/enable-git-hooks.sh` (new, `pnpm hooks:enable`).
- `package.json`: `test`, `hooks:enable`, `test:shopify-boundary`, `test:offers`.
- `lib/cms/history.js` and `scripts/test-shopify-push.js`: flake fixes the gate needed (deviation 2).
- Docs: `docs/operations.md` (new section), `README.md`, `docs/platform-guide.md`, the `lib/ids.js` comment.

## Acceptance

### SHOP-01

| Item | Tag | Status | Evidence |
|---|---|---|---|
| Adding `productUpdate` anywhere in `lib`, `app`, `components` or `scripts` fails the test | unit | Pass | Temporary break in each of the four directories, plus a comment-only mention in the spike: exit 1 each time (log below) |
| Adding any other `write_*` scope fails the test | unit | Pass | `write_products` added to the list, and separately named in another file: exit 1 both times |
| There is one scope list in the codebase | unit | Pass | `SHOP-01: there is one scope list in the codebase` passes. A second `const SCOPES` in `scripts/shopify-oauth.js`: exit 1. The script was also run with no credentials to prove the import resolves (exit 1 with its normal missing-credentials message) |
| Negative: a REST write to the Admin API is also caught | unit | Pass | `fetch(.../admin/api/2025-10/products/1.json, { method: 'PUT' })` in a temporary `lib` file: exit 1 |

### SHOP-02

| Item | Tag | Status | Evidence |
|---|---|---|---|
| A test with an overlaid title proves that no overlay string appears anywhere in the push payload | unit | **Partial. Stays open until OVL-03** | No overlay exists yet. The test seeds a `products` row and a `variants` row whose content differs from the order's, runs the real `pushOrderToShopify` against a fake Shopify, and checks every query and variable for the catalog and order strings. A temporary break that reads the catalog title from the `products` table into the draft failed with `CATALOG-TITLE-SENTINEL reached Shopify`. The hook is the `OVL-03 HOOK` comment and `seedOverlay()`. `OVERLAY-TITLE-SENTINEL` is already on the checked list, but nothing writes it yet, so today that one string proves nothing |
| Negative: a new key on a line item fails the test | unit | Pass | Exact key sets are asserted: paid lines `quantity, variantId`; gift lines `appliedDiscount, quantity, variantId`. Temporary `title` on a paid line and `customAttributes` on a gift line: exit 1 both times |

### SHOP-03

| Item | Tag | Status | Evidence |
|---|---|---|---|
| `checkoutUrl` is gone and all tests pass | unit | Pass | `pnpm test`: 41 of 41. Nothing called it before removal (`grep -rn checkoutUrl lib app components scripts` found only the definition). `pnpm build` NOT run (no secrets or servers in this batch), so see the drills below |
| Negative: a grep for Shopify `cart/` checkout URLs in `lib`, `app` and `components` finds nothing | unit | Pass | `SHOP-03: no Shopify cart or checkout link` passes. `checkoutUrl` put back temporarily: exit 1 |

### SHOP-04

| Item | Tag | Status | Evidence |
|---|---|---|---|
| The test lists every merchant text reaching Shopify: discount description, discount title, shipping title, note, tags, cancel staff note | unit | Pass | `MERCHANT_TEXT_ROUTES` and `CANCEL_STAFF_NOTE`. Each is proved by following a marker string: offer label, bundle title (through the real offer engine), store name, shipping label, order id, cancel reason. Each one reaches Shopify only by its named field |
| Negative: a new free-text field fails the test | unit | Pass | Every field of a full draft order is checked against a closed list. Temporary `poNumber` on the draft: exit 1. Temporary `note` argument on `orderCancel`: exit 1 |

### SHOP-06

| Item | Tag | Status | Evidence |
|---|---|---|---|
| A failing `test-shopify-boundary` fails the check | unit | Pass locally | `pnpm test` with the suite failing: exit 1, `40 of 41 suites passed`, `Failed: test:shopify-boundary` |
| Negative: adding `productUpdate` on a branch produces a failing check | manual drill | Pass locally, **not on GitHub** | `productUpdate` in a temporary staged file, then `git -c core.hooksPath=.githooks ... commit`: hook ran, `Commit stopped`, `COMMIT EXIT 1`, HEAD unchanged. The workflow itself has never run, because nothing here pushes |

## Proof that the tests can fail

Each break was applied, run, then reverted. The tree hash over `lib`, `app`,
`components`, `scripts`, `.githooks`, `.github` and `package.json` was identical
before and after, and the boundary suite passed again after the restore.

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
| A suite that never ends, `TEST_SUITE_TIMEOUT_MS=3000` | `pnpm test` | 1 | `stopped after 3.0s without finishing`, 0 processes left over |

## SHOP-06 findings

**Time.** `pnpm test` takes about 22 seconds here (21.2s to 23.0s over the last 15
runs). That is far under the 2 minute limit, so the hook runs the same `pnpm test`,
as the spec asks. No fast subset was needed.

**No secrets or network: every suite qualifies.** All 41 suites passed with a
stripped environment (`env -i` with only `PATH`, `HOME`, `TZ=UTC`, `CI=true`) and
outbound network denied by `sandbox-exec`, except loopback. No suite needs
reporting as an exception.

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
   `test:shopify-boundary`. The runner also fails if any `scripts/test-*.js` has no script.
2. **Two flaky suites fixed, outside the SHOP scope.** The baseline "all pass" was only
   sometimes true. A required check that fails at random would soon be bypassed, so
   these were fixed rather than left.
   - `test:cms-api` failed 12 of 40 runs: `newest kept expected 26, got 25`. Two history
     rows written in one millisecond were ordered by their random id, so the wrong one
     could be pruned or listed first. This is a real, if small, ordering bug.
     `lib/cms/history.js` now breaks ties by `rowid`. After the fix: 0 failures in 60 runs.
   - `test:shopify-push` failed 2 of 20 full runs: a sweep in the same millisecond as
     the failure still sees the 1ms backoff. This was a test bug. The test now waits
     10ms, as another test in that file already did. After the fix: 0 failures in 100 runs.
   - Then the whole gate: 15 of 15 runs passed. A rarer flake could still exist.
3. **The hook is present but OFF, as instructed for this batch.** So "runs as a required
   local check before each commit" is **not yet true**. It becomes true when the owner
   runs `pnpm hooks:enable` after the parallel sessions finish. `scripts/enable-git-hooks.sh`
   has only been syntax-checked (`sh -n`), never run. `core.hooksPath` was confirmed unset
   afterwards. The hook itself was exercised with `git -c core.hooksPath=.githooks`, which
   applies to one call and writes no config.
4. **More checks than the spec asks for.** The test also locks every mutation document's
   file and exact arguments, and the two files allowed to send the Admin token header.
   Any Admin REST URL counts as a write, even a read, because the method cannot be read
   reliably from source. A future REST read therefore needs a deliberate change here.
5. **The spike has one more mutation than the spec's list.** `scripts/spike-order-push.js`
   also calls `orderCreate`. The exception covers that one name in that one file, and
   nothing may import the spike.
6. **One more field carries the order id.** The spec's six routes do not include
   `customAttributes[].value`, which carries our order id (with the store's prefix) next
   to fixed ids. The test records it as ids and fixed strings, not as a free-text route.
7. **`NEXT_PUBLIC_SHOPIFY_DOMAIN` is still in `.env.example`.** Nothing reads it now. It
   was left alone because this batch does not open `.env` files. The owner can delete that line.

Spec citations for these five requirements were opened and matched the code at 939d630.
`main` is still 92 commits ahead of `origin` (`git rev-list --count origin/main..main`), so
a push-triggered workflow would not run today, as the spec says. One old comment was wrong: `lib/ids.js` said `draftOrderCreate` uses numeric ids, but the
push sends full ids. That comment is corrected.

## Limits of these tests

- The scans read source text, so they can be beaten on purpose. `"muta" + "tion"` is not
  seen. A mutation name outside a document is caught only for the resources in
  `MUTATION_NAME`. Inside a document, any name is caught.
- A REST URL split so that `/admin/api/` never appears together is missed by the URL scan.
  The Admin token header check is the second net, unless that header is split too.
- The boundary test skips its own file, and it scans only `lib`, `app`, `components`
  and `scripts`, as the requirement says. Root files such as `instrumentation.js` are not scanned.
- `MUTATION_NAME` and `NOT_SCOPES` can flag an ordinary identifier, such as a local
  function that happens to be called `pageCreate`. None exists today on `cms/phase-1`,
  `cms/p1-gen03`, `cms/p1-med01` or `cms/p1-au05` (checked with `git grep`). If one
  appears, rename it, or for a `write_*` name add it to `NOT_SCOPES`.
- The hook tests the files on disk, not only what is staged.
- `core.hooksPath` is shared by all worktrees. A worktree on a commit older than this one
  has no `.githooks` folder, and git then runs no hook there, with no warning.

## Test results on the final tree

```
pnpm test:shopify-boundary    23 passed, 0 failed
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
