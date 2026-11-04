# P4 · EQUIV · The rendered before/after comparison (MIG-02)

Branch `cms/p4-equiv`, cut from `b6110fe` (`cms/phase-1`). Plan: `docs/cms-reviews/P4-PLAN.md` (decision 8, sections 0 to 3, batch 4) and `P4-BATCHES.json`. Requirement: MIG-02 (the rendered part; the data check is P4-MAPPER's and P4-OVL07's, the rehearsal that runs both is P4-CUTOVER's).

Files: `lib/migrate/render-compare.js` (new), `lib/migrate/allowed-differences.js` (new), `scripts/migrate-render.mjs` (new), `scripts/test-migrate-render.js` (replaces SCAFFOLD's placeholder; no `package.json` change), this packet, and `docs/cms-reviews/drills/P4-EQUIV/results-harness.json` (drill results; see Known limits). Migrations owned: none. Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js`, `scripts/drills/p3/*`, `lib/migrate/check.js` and the other `lib/migrate/*` files, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`.

Nothing here runs on the storefront: no file under `app/` or `components/` changed and no route imports these files. `render-compare.js` uses no `node:` API anyway (its route-list function reads the store through `lib/db.js`, as `check.js` does).

This is the author's own report. Reviewers should re-read the code.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 195.9 s. `test:migrate-render`: 22 passed, 0 failed (about 1 s). `pnpm build` passes (its one warning is the old `next.config.mjs` NFT trace) |
| Browser verified | Harness verified, not in Chrome: the tool captures pages over HTTP, so the drill ran it against the design harness (`next dev` on `localhost:6140`, sqld on 7140 to 7142, seeded `--p4`): 75 real routes captured twice and compared the same; a changed title, a missing module, a reordered pair and a different template, each made in the live release on the harness, were found with their page and place, then undone (results below). No Chrome run: nothing a shopper or founder sees changed |
| Staging verified | **NOT DONE.** The tool refuses anything not on this machine. A rehearsal on a restore-drill copy is P4-CUTOVER's and the owner's |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real or hosted store touched, no store moved to documents mode, `--hosted` never passed (the tool refuses it) |

## What and why

MIG-02 says that before the pointer flips, old and new outputs are compared, and on canaries "the rendered pages of a fixed route list" too, comparing "normalized DOM, stripping scripts, hashed assets and id attributes, with allowed differences listed", with "no cart cookie and no experiment unit"; "any other difference stops the cutover". Plan decision 8 replaced the spec's preview pin with a required passing rehearsal on a local restore-drill copy, which includes this rendered comparison. This item builds the comparison and its capture tool, tested on synthetic captures and on the harness; P4-CUTOVER runs it inside the rehearsal.

## Design

### (1) `lib/migrate/render-compare.js`

**`normalize(html, { origin })`** gives the page as the comparison sees it, one element or text per line. `normalizeTree` gives the same as a tree plus the running experiments named in the page's data. It removes what differs between two visits to the same unchanged store, or what no shopper sees:

- **Scripts** (the page's code and its streamed data), comments, `<template>`, the Next.js route announcer and dev overlay, and `<link>`s to `/_next/` assets.
- **Streaming order.** React sends a fallback first and the real part later, in a hidden `<div id="S:n">` with a `$RC` (or `$RR`) or `$RS` instruction. The normalizer applies those instructions, so the comparison sees the finished page. On the harness the product page streams four parts; two captures can stream them in a different order, and the fallback skeletons would otherwise be compared. `$RX` (a part that failed on the server) is not applied: its fallback stays, as in a browser before the client renders.
- **Late metadata.** Next can send `<title>`, `<meta>` and `<link>` after the body (seen on the harness: one of two captures of `/collections/protein` had them at the end). Every one of them outside an `<svg>` is moved into `<head>`, sorted.
- **Attributes.** `id`, `nonce` and `data-precedence` go. React's generated ids inside other attributes (`for`, `aria-describedby`, …; the `_R_…_`, `«r…»` and `:r…:` forms) become `<id>`.
- **Build ids and hashed asset names.** Any `/_next/static/…` address becomes `/_next/static/<asset>`, and a `dpl=` deployment id is removed from any address. Build ids otherwise live only in scripts and those addresses.
- **Times and origin.** Full date-times (`2026-11-04T10:15:00Z`) become `<time>`; plain dates (a journal post's date) stay. The capture's own origin (`http://localhost:<port>`) becomes `<origin>`, so captures from different ports compare.
- **Preview-only markup.** `[data-preview-bar]` and `[data-preview-note]` elements, and `data-preview*`, `data-field*` and `data-doc` attributes (a cookie-less capture never gets a preview, so this is a belt).
- **Whitespace.** Runs collapse to one space, text is trimmed, empty text goes; adjacent text joins across a dropped comment; attributes are sorted.

Everything else is compared: text, images, links, classes, attributes and order.

**`compare(before, after, { allowed, route, maxPerRoute })`** takes one capture, a list of captures matched by route, or a plain HTML string. A capture is `{ route, status, contentType, location, body, origin }`. It answers `{ same, differences: [{ route, selector, before, after }], allowedApplied: [{ route, id }], compared }`.

- A page missing on one side, a different status, a different redirect target, or a different content type is a difference (`(page)`, `(status)`, `(redirect)`, `(content type)`).
- JSON bodies (the cart offer) are compared by path (`$.title`, `$.products`).
- HTML is compared as normalized trees. Equal subtrees are skipped by a hash. Children are aligned by their common start and end, then by the longest common run; what changed in place is compared inside (so a changed title is reported at its `h1`), the rest is reported as missing (`after: null`) or extra (`before: null`).
- The same children in another order give **one** difference at the parent, both orders shown in words ("in this order: Vegan Omega ₹979 | -20% Muesli …").
- A block whose template or kind changed (`data-pdp-template`, `data-collection-template`, `data-sec`, `data-section-kind`) gives **one** difference for the whole block, named by its marker.
- Selectors read like CSS: `html > body > main > div > div[data-pdp-template="editorial"] > div:nth-of-type(2) > div > div[data-sec="pdp-modules"] > details:nth-of-type(2)`. A marker attribute names the element when it is unique among its siblings; otherwise `:nth-of-type(n)` (counted in the normalized tree).
- At most 40 differences per page are listed, then "N more differences on this page".
- `allowed` defaults to `[]`, the strict direction: a caller that forgets the list gets false differences, never a hidden one. An entry is reported in `allowedApplied` only on a page where it removed a difference.

**`renderRoutesFor(mapped)`** builds the route list for a store from `mapTenant()`'s answer, inside `withTenant` (SELECTs only):

- **The canaries:** `/`; the first published page (`/policies/<slug>`), journal post, and campaign; `/journal`; the first old address that moved (a `page_redirects` row, at its family's prefix); the product with the most kinds of content (modules, pairs, template, then badge, from the mapped live rows); the collection with the most pinned products; `/collections`; `/checkout` (the cart page, empty because no cart cookie is sent); `/api/upsell` (the cart offer the drawer shows, JSON); `/search?q=<a word of that product's title>`.
- **Every product and collection with old content:** `lib/migrate/check.js`'s `entityIdsOf(mapped)` (the old tables, the live release's frozen arrays, the template exceptions, existing live rows), each with a catalog handle, as `/products/<handle>` and `/collections/<handle>`.

On the harness's `--p4` store this gave 75 routes: 12 canaries, 59 more products and 4 more collections.

### (2) `lib/migrate/allowed-differences.js`

`ALLOWED_DIFFERENCES`, frozen. Each entry has `id`, `reason` (plain words), `apply(tree, ctx)` (rewrites one side's normalized tree so the allowed variation disappears; called for both sides) and `fixture` (`{ route, before, after }`: two small pages that differ only in that way).

| id | What it sets aside | Why |
|---|---|---|
| `section-ids` | `data-section-id`, and a `data-sec` value that is a section id (`i-<n>` or `sec_…`) | The move gives every home and page section a lasting id where the old store used its position (`i-2` becomes `sec_l2`). The id reaches the page only in those two attributes, which shoppers never see and no stylesheet uses. Kind (`data-section-kind`), content and order are still compared, and fixed names (`hero`, `pdp-modules`, `pdp-pairs`, `announcement`, …) are not ids |
| `hero-test-variant` | the inside of `[data-sec="hero"]`, only when BOTH captures show the same running test | A cookie-less visitor gets a new random unit on every visit (`app/(storefront)/page.js`), so while a hero test runs the home page shows one hero or the other at random, before and after alike. Seen on the harness: two cookie-less visits to `/` showed "Winter repair, started." and "Visibly brighter in 14 days". The hero's content is still compared as data by the in-process check (`resolvedHomePage`). A test that started, stopped or changed is still a difference, and anything outside the hero still counts |

The running test is read from the page's streamed data before scripts are dropped: the `ExperimentPing` props (`{"slug":"…","unit":"<uuid>"}`).

**Where the list is asserted.** The spec names `test-migrate-documents` for the allowed differences. The list lives in `lib/migrate/allowed-differences.js` (`ALLOWED_DIFFERENCES`). This item's suite proves each entry is needed; **P4-CUTOVER's `scripts/test-migrate-documents.js` must import `ALLOWED_DIFFERENCES` from there and assert the same list** (ids, a reason each, and each fixture failing without its entry). The data check's own rules over getter answers stay in `lib/migrate/check.js` (`sameForShoppers`); CUTOVER may move them.

### (3) `scripts/migrate-render.mjs`

```
node scripts/migrate-render.mjs --make-routes <routes.json> --tenant <id> [--store-open | --not-launched]
node scripts/migrate-render.mjs --base http://localhost:<port> --routes <routes.json> --out <dir> [--timeout <s>]
node scripts/migrate-render.mjs --compare <beforeDir> <afterDir> [--json <file>]
```

- **Capture.** Each route is fetched once, as a shopper, with **no cookie header at all**: no cart, no experiment unit, no session, no preview. The request's headers are written in one place: `accept` and `user-agent` only. `fetch` keeps no cookie jar, so a `Set-Cookie` from the store never comes back. Redirects are recorded (status and target), not followed. It writes `<name>.html` (or `.json`) and `index.json` (tool, base, time, and per route: path, status, type, redirect, bytes, sha256).
- **Only this machine.** The base must be `http(s)` and pass HARNESS's `assertLocal` (imported from `scripts/drills/p4/lib.mjs`): `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`, never port 3017 (the owner's harness). Anything else is refused before any request and before any folder is made. A route must be a path on that base (`//host/x` is refused). `--hosted` is refused outright.
- **Folders are kept safe.** `--out` must be new, empty, or an earlier capture of this tool (its `index.json`). A folder holding anything else is refused and left as it was. Files are only added or overwritten by name, never deleted.
- **Compare.** Both captures are normalized and compared with `ALLOWED_DIFFERENCES`. The plain report lists each page that differs, with where, before and after; then the allowed differences used, with their reasons; then the verdict. Exit 0 when the same, **1 on any other difference**, 2 on a refusal or usage mistake. `--json` writes the full result.
- **Route list.** `--make-routes` needs the control plane (`PLATFORM_DB_URL`) and the store's database both on this machine (`file:` or a local sqld), and the same environment the other operator commands need. It reads only.

## Acceptance, with evidence

| # | Item | Status | Evidence | Fails without this change |
|---|---|---|---|---|
| 1 | Unit (test-migrate-render): two captures differing only in nonce, build id and asset hash compare same; a changed product title, a missing module, a reordered pair or a different template is a difference with its route and selector | **DONE** | Part 1: "two captures differing only in nonce, build id and asset hash compare the same" (the raw pages are checked to differ in all three first; the normalized pages are equal). Part 2: "a changed product title" (the `h1` text, `before` "Micronised Creatine", `after` "Micronised Creatine Plus", route given, selector through `div[data-pdp-template="editorial"]`; plus the page `<title>`); "a missing module" (exactly one difference at `div[data-sec="pdp-modules"] > details…`, `after` null); "a reordered pair" (exactly one difference at `section[data-sec="pdp-pairs"] > div`, both orders in words); "a different template" (exactly one difference at `div[data-pdp-template="editorial"]`). Harness drill, same four cases on real pages: below | On `b6110fe` the suite is SCAFFOLD's placeholder and `lib/migrate/render-compare.js` does not exist. Mutations: M1 (nonce kept), M2 (asset hash kept), M3 (`dpl=` build id kept) each fail the first case; M4 (no order detection) fails the reordered pair; M10 (no streaming step) fails the streamed-page case |
| 2 | Unit: every ALLOWED_DIFFERENCES entry has a reason and a fixture proving it is needed | **DONE** | Part 3: "the list: unique ids, and every entry has a plain reason, an apply and a fixture"; then per entry "its fixture differs without it, is the same with it (and with the whole list)": strict compare differs, the list without that entry still differs (no other entry covers it), with it the same and reported as used. Plus "section-ids does not hide a changed section kind, content or order" and "hero-test-variant only applies when both captures show the same running test" | On `b6110fe` there is no `allowed-differences.js`. Mutations: M8 (`section-ids` does nothing) and M9 (the hero rule ignores the test check) each fail |
| 3 | Unit: --compare exits non-zero on a difference; the tool refuses a non-localhost base; capture requests carry no cookie header (no cart cookie, no experiment unit) | **DONE** | Part 5: "--compare exits 1 on a difference and names it; 0 when the same" (the command as its own process: exit 1, "Different: /products/…" and "/api/upsell", where/before/after, "NOT the same", `--json` holds route and selector for each; the same captures exit 0; a folder that is not a capture exits 2). "a base not on this machine is refused before any request (library and command)": eight remote or wrong addresses (`https://shop.example.com`, `http://10.0.0.5:6140`, `http://localhost.example.com:6140`, `http://localhost:3017`, `ftp:`, `file:`, …) refused; a spy `fetch` is never called; the command exits 2 with plain words and makes no folder; `--hosted` exits 2. Part 4: "capture requests carry no cookie header": a local server on 127.0.0.1 answers every request with `Set-Cookie` for a cart and an experiment unit; across two library captures and one command capture no request has a `cookie` header, and neither value comes back | On `b6110fe` there is no `migrate-render.mjs`. Mutations: M5 (capture sends `_unit=p4-capture`, as HARNESS's helper does) fails the cookie case; M6 (no local check) fails the refusal case; M7 (compare exits 0 on a difference) fails the exit-code case |

### Harness drill (`next dev`, `localhost:6140`, seeded `--p4`)

Results: `docs/cms-reviews/drills/P4-EQUIV/results-harness.json`.

- `--make-routes --tenant design` wrote 75 routes: the 12 canaries above, with every product and collection with old content.
- **Unchanged store:** 75 routes captured twice, cookie-less: `--compare` "every one looks the same", exit 0. This includes the four streamed parts of the product page and the late metadata on a collection page.
- **Real changes**, each made on the harness's local database and undone after. Before = the first capture of the product and the pinned collection:

| Change | Result (exit 1) |
|---|---|
| The chosen product's catalog title set to "Micronised Creatine Plus" | 5 differences on `/products/micronised-creatine-12`: the `og:title` and `twitter:title` metas, `<title>`, the breadcrumb, and `…div[data-pdp-template="editorial"] > div:nth-of-type(1) > h1 > text()` |
| The live release's override for that product without its 2nd module | 1 difference: `…div[data-sec="pdp-modules"] > details:nth-of-type(2)`, before "Ingredients …", after nothing |
| Its first two pairs swapped in the live release | 1 difference: `…section[data-sec="pdp-pairs"] > div`, "in this order: Vegan Omega ₹979 \| -20% Muesli ₹619 ₹774 \| Protein Coffee ₹3,919" against "-20% Muesli … \| Vegan Omega … \| Protein Coffee …" |
| Its template exception editorial to classic | 2 differences: the whole `div[data-pdp-template="editorial"]` block (after `data-pdp-template="classic"`), and the hero image preload in `<head>` losing `fetchpriority` |

- **After every change was undone:** 75 routes captured again, the same as the first capture (exit 0).
- **The hero test:** the raw home page from one visit ("Winter repair, started.") against another visit ("Visibly brighter in 14 days") gives 3 differences inside `section[data-sec="hero"]` strictly; with `ALLOWED_DIFFERENCES`, the same, with `hero-test-variant` reported as used.

## Tests

| What | Result |
|---|---|
| `node scripts/test-migrate-render.js` | 22 passed, 0 failed |
| Mutations (scratch runner `…/scratchpad/p4-b4/P4-EQUIV/mut.py`, one break at a time, file restored after) | M1 nonce kept: 3 fail. M2 asset hash kept: 2 fail. M3 `dpl=` kept: 2 fail. M4 no order detection: 1 fails. M5 capture sends a unit cookie: 2 fail. M6 no local check: 1 fails. M7 compare exits 0: 1 fails. M8 `section-ids` does nothing: 1 fails. M9 hero rule ignores the test check: 1 fails. M10 no streaming step: 1 fails |
| `pnpm test` | 96 of 96 suites passed in 195.9 s |
| `pnpm build` | passes (the old `next.config.mjs` NFT warning only) |

The suite's six parts: normalizing (4 cases), real differences (6), the allowed list (5, one per entry plus two negatives), capturing (3), the command (3), the route list from a store (1, file databases from `legacy-tenants.js`: a `live_v3` store with modules, six modules, custom-title pairs, two pairs on one source, pins, product and collection templates and a journal redirect; every product and collection `entityIdsOf` names is listed, and each canary is the expected one).

## Known limits

- **Scripts are stripped, as the spec says,** so the product page's JSON-LD (title, price, availability for search engines) is not compared as such. What it carries is on the page and is compared there, and the data check compares the getters.
- **While a hero test runs, the hero's inside is compared only as data** (`hero-test-variant`), because a cookie-less visit gets a random variant. For a full rendered hero comparison in a rehearsal, the owner can pause the test for the rehearsal (see Owner checks). A started, stopped or different test is still a difference.
- **Cookie-less means an empty cart.** The cart drawer's HTML is client-side and empty; the cart is compared as `/checkout` (the empty cart page) and the cart offer as `/api/upsell` (no products excluded).
- **One capture per route, in order.** Next dev compiles each route on its first visit (the harness took about 8 s for 75 routes once warm, minutes cold). `--timeout` (default 180 s per page) covers the first compile.
- **All `id` attributes are stripped** (the spec's rule), so an in-page anchor id (for example `#new` on the home page) is not compared.
- **Full date-times are replaced in text too**, not only in attributes; a plain date stays.
- **Metadata order is not compared:** `<title>`, `<meta>` and `<link>` are sorted into `<head>`.
- **Selectors count in the normalized tree** (after scripts and comments are dropped). Where a marker attribute names an element they match the live page; an `:nth-of-type(n)` may count differently from the live DOM near dropped elements.
- **Large lists:** above 4 million child pairs (about 2,000 children on each side at one level), the longest-common-run step is skipped and the whole changed stretch is reported as missing and extra.
- **Only two allowed differences, both seen on the harness or in the mapper.** The first real legacy-to-documents capture pair (CUTOVER's rehearsal on the harness) may show more (for example a section id on the product page's main section, which `section-ids` already covers). Each new entry needs an id, a reason, a fixture and the owner's OK, in this file.
- **Old module HTML that today's sanitizer rewrites** (P4-OVL07, `MANUAL-CHECKS.md` line 568) is **not** in the list: it shows as a difference until the owner decides.
- **No `package.json` script** (SCAFFOLD only): the commands are `node scripts/migrate-render.mjs …`. If the runbook wants `pnpm migrate:render`, the orchestrator adds it.
- **`--make-routes` needs the operator environment** (the control plane address, `PLATFORM_SECRET`, as for `migrate-documents.js`) and refuses anything not on this machine. It has no `--hosted`: a real store is compared through a local restore-drill copy only.
- **The suite's own test server listens on 127.0.0.1 on a free port the system picks** (port 0), not 7140 to 7149, so the suite can run anywhere, in parallel with other suites.
- **`scripts/migrate-render.mjs` imports HARNESS's `assertLocal`** from `scripts/drills/p4/lib.mjs` (one rule for "this machine", 3017 included). That module loads the phase 3 drill helpers, which do nothing on import.
- **One file beyond the plan's list:** `docs/cms-reviews/drills/P4-EQUIV/results-harness.json` (the drill's results). The drill's scratch scripts (capturing with the harness environment, changing and restoring the live release) stay in the scratch folder.
- **Environment note for whoever reruns the drill:** in this session's sandbox, `next dev` and `next build` could not fetch the Google fonts (`next/font`), so the harness and the build ran outside the sandbox. No code change.

## From review

(none yet)

## Owner checks

- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need your approval (carried from P4-SCAFFOLD).
- **Before the first real cutover, read the rehearsal's rendered comparison** (CUTOVER's report): every page that differs, and every allowed difference it used with its reason. Approve the two allowed differences in this file, or say which to drop.
- **Hero test during the rehearsal:** decide whether to pause a running hero test for the rehearsal, so the hero is compared as rendered too, or accept the data comparison for it (`hero-test-variant`).
- **Old module HTML** (`MANUAL-CHECKS.md` line 568): decide per store whether it becomes an allowed difference (CUTOVER adds it here) or is fixed before the move.
- Optional: on your Mac, `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/dev-design.js`, then `node scripts/migrate-render.mjs --base http://localhost:<port> --routes <file> --out <dir>` twice and `--compare` them (exit 0).

## Commands

```
node scripts/migrate-render.mjs --make-routes routes.json --tenant <id>
node scripts/migrate-render.mjs --base http://localhost:6140 --routes routes.json --out captures/before
node scripts/migrate-render.mjs --base http://localhost:6140 --routes routes.json --out captures/after
node scripts/migrate-render.mjs --compare captures/before captures/after --json result.json
pnpm test:migrate-render
pnpm test
pnpm build
```
