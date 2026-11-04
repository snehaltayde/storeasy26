# P3 · CHECKS · Publish checks that block only what would really break, "publish both", publish again, and the first publish

Branch `cms/p3-checks`, cut from `5bbc819`. Plan: `docs/cms-reviews/P3-PLAN.md` (decisions 4, 5 and 7; critiques A2 and A6; "First publish needs a home page", "Offline entry and the inherited rule", "Alt-text warnings") and `P3-BATCHES.json`. Requirements: PUB-03, PUB-05, PUB-04, PUB-11, PUB-06, TOK-03. No migration. No new dependency. `build.js` is not edited. No real store changes mode. Legacy stores, today's releases, the editors and preview work as before: their suites pass unchanged.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 132.9 s. `pnpm test:publish-checks`: 21 passed in 1.1 s. `pnpm test:publish-service`: 58 passed in 1.9 s (sqld part 0.6 s). `pnpm test:api-shapes`: 29 passed in 0.1 s. `pnpm test:publish`: 72 passed in 6.1 s. `pnpm build` passes (its 2 Turbopack warnings about `next.config.mjs` tracing were there before) |
| Browser verified | Not applicable. This item has no screen: every acceptance line is a unit line, and the panel that shows these answers is P3-PUBLISHUI (batch 3). No dev server ran; port 3800 was not used |
| Staging verified | **NOT DONE** (owner checks below) |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed |

sqld and the fault proxy ran on ports 4800 to 4805 only. All of them were stopped (one sqld left by a crashed early run on 4800 was found and stopped; the sqld processes on 4880 to 4882 belong to another agent and were not touched).

## What and why

Phase 2 publish refused a page for its own validation errors and nothing else. A founder could publish a page whose button went to a page that didn't exist, a rail on a deleted collection got no warning, an empty alt text blocked a publish outright, and nothing said where a problem was or what to do. A link to a page that was never published went live as a broken link. A store could open with no home page. A page taken offline could be published again by accident, and the publish answer gave no link to see it live and nothing to undo it with.

This item:
- adds the reference checks (PUB-03), run over the set's own bodies only, against what will be live after this publish;
- gives every issue a level, an anchor, plain words for where it is, and at least one action;
- answers a link to an unpublished page with an offer to publish both (PUB-05);
- asks before publishing again what was taken offline (PUB-04), and clears `undone_version_id` on every publish;
- makes a closed store open with its home page (PUB-06);
- gives every published item `liveUrl` and `undo` (PUB-11, PUB-04);
- names who changed a document on the publish conflicts;
- confirms the design document blocks only changed colour pairs (TOK-03, PUB-03).

## Design

### 1. `lib/documents/checks.js` (new; node console routes only)

**`referenceChecks({ items, list, journalBody })`** reads only the set's own validated bodies. Every ref comes from the registry (`refsOf` for sections, `refsOfSetting` for a document's own settings), so a new section kind is checked with no change here.

What it checks against is M2: the live list's rows of every other document, plus the set's own rows (its slugs and `meta.enabled`), plus the live journal index (read only when a link or a redirect needs it), plus the code-default page slugs (`lib/content/pages.js`, only on BeastLife's own stores and only while the list uses the code defaults, exactly as `resolve.js` `v4ContentPage` serves them).

Reads, each at most one statement and each only when there is something to look up:

| Table | What | When |
|---|---|---|
| `documents` | `id, type, slug, label, revision, draft_hash, archived_at, published_version_id` (never a draft body) | a page link whose target isn't live in M2 |
| `collections` | by handle, with a count of products in stock | any collection link or setting |
| `products` | by handle, with `available` | any product link or setting |
| `media` | by id, for `/api/media/<id>` | any library image |

A table that can't be read leaves that check out and logs `documents_publish_check_unreadable`. A check never stops a publish because of a read failure.

| Level | Code | What |
|---|---|---|
| blocks | `LINK_TARGET_MISSING` | a page link, or a url to `/policies/<slug>`, `/campaigns/<slug>` or `/journal/<slug>`, to a page that isn't in M2 (missing or archived) |
| blocks | `LINK_TARGET_HIDDEN` | the same, to a page that is live but hidden (its own `meta.enabled: false`) |
| blocks | `LINKS_TO_UNPUBLISHED` | the same, to an existing, non-archived page that isn't live (never published, or taken offline). Its target is offered (section 2) |
| blocks | `LINK_COLLECTION_MISSING`, `LINK_PRODUCT_MISSING` | a collection or product link to a handle that isn't in the store |
| blocks | `REDIRECT_SELF` | an old address equal to the page's own |
| blocks | `REDIRECT_LOOP` | an old address that sends shoppers round in a circle (walked over M2's redirects) |
| blocks | (existing) | an empty required text, a missing purchase box, an empty home page: the validator, unchanged |
| warns | `PRODUCT_MISSING`, `PRODUCT_UNAVAILABLE` | a deleted or sold-out product in a list |
| warns | `COLLECTION_MISSING`, `COLLECTION_EMPTY` | a product rail whose collection is gone, or has nothing in stock; a missing collection in a list |
| warns | `MEDIA_MISSING` | an image whose media row is gone (shoppers see the colour block) |
| warns | `REQUIRED` on `<image>.alt` | missing alt text. The validator reports it as REQUIRED (an error at publish); `relevel()` makes it a warning at publish only (PUB-03 "Warns: missing alt text") |
| warns | `REDIRECT_SHADOWED` | an old address that a live page already uses (the page wins) |

**The inherited rule** is the existing `classify()` in `publish.js`, now applied to the reference issues too, and it marks its result: an error in a section whose id-stripped content equals the live section of the same id becomes a warning with `level: "inherited"`; one in a hidden section a warning with `level: "warns"`. Structure always blocks. An offline document has no live body (P3-COMMIT `liveEntryOf`), so nothing in it is inherited.

**`decorate(issue, { body, target, structure })`** gives every issue in a 422 and in the 200's warnings exactly the contract's keys: the issue keys plus

- `level`: `blocks` (severity error), `inherited` (classify said so, or `BRAND_HARD_TO_READ`: a design colour pair unchanged from live), else `warns`;
- `anchor`: P3-VALIDATE's `fieldAnchor` (`f-sec_bn1-button-link`, `f-doc-meta-redirect_from-1`);
- `where`: P3-VALIDATE's `where` with the body (`Banner · Button`, `Header menu · Menu items · item 1`, `Page · Old addresses`);
- `actions`, always at least one:
  - a block in a section: `hideSection` (only enabled sections block); a **structure** block in a section: `removeSection` instead, since hiding doesn't help;
  - a link to an unpublished page: `publishBoth` first, then the above;
  - a block on one entry of a document-level list (a menu item, an old address): `removeItem {field, index}`;
  - a reference warning: `removeItem` on a list entry, else `removeSection`;
  - anything else (a missing page title, `HOME_EMPTY`, an ordinary warning, a protected section): `openField`, which goes to the field. **This is a new action type in the contract** (section 7): without it, a document-level problem would have no action and the acceptance line "at least one action" could not hold.

### 2. `LINKS_TO_UNPUBLISHED` and the offer (PUB-05)

When every block left is a link to a page that isn't live, the answer is 422 `LINKS_TO_UNPUBLISHED`, "This page links to Diwali sale, which isn't published yet." (two or more targets: "…links to A and B, which aren't published yet."), with `issues` and `offer.publishSet`: the set, then each target, each `{id, revision, draftHash, label}`. The revision and draft hash come from the documents row; no target's draft body is read.

The client sends `offer.publishSet` back as `publishSet`. The targets are then in the set, so their own checks run, and a target with its own block gets the normal 422 naming it. A target changed after the offer has another revision, so it is 409 `DOCUMENT_CHANGED`; `draftHash` pins what the founder reviewed (P3-PUBLISHUI shows each target's changes before Confirm).

When other blocks sit beside a link to an unpublished page, the answer stays 422 `VALIDATION_FAILED`, and it carries the same `offer` (optional in the contract), so "publish both" still works from that answer.

An offline page is "not live", so a link to it is offered too: publishing it brings it back.

### 3. Publish again (PUB-04)

After the checks, for each item with `undone_version_id` and no `confirmRepublish`, the undone version's body is read (one statement for the set) and its `documentHash` (ids stripped) is compared with the item's `draft_hash`. It is never compared with `document_versions.body_hash` (ids kept: critique A2). Equal: 409 `REPUBLISH_CONFIRM_NEEDED` `{id}`, "You took this page offline. Publish the same content again?". With `confirmRepublish: true` it publishes.

**Ruling asked for by the P3-COMMIT review: a plain publish clears `undone_version_id`.** Every item that is built passes `undone: null`, with or without the confirm. The plan's rule (decision 4) is that the confirm is about publishing the content that was taken offline; once the page is live again, nothing is offline, so there is nothing left to confirm. Skipped items aren't built, so their column is left as it is. Pinned by a test that fails under mutation M9.

### 4. The first publish needs the home page (PUB-06)

On a store with no live release (state none, so closed), a set without `doc_home` is 409 `FIRST_PUBLISH_NEEDS_HOME`, "Publish your home page with this, so the store opens with a home page.", with `offer.publishSet` = the set plus `doc_home` (`{id, revision, draftHash, label}`, read as columns only). If the store has no home page document yet, the words say "…Make your home page, then publish it with this." and `offer` is null. A home page in the set that has its own block gets the normal 422. Once the store is open, a policy page publishes on its own as before. This holds until PUB-12 (open question).

### 5. `liveUrl` and `undo` (PUB-11, PUB-04)

Every published item is `{id, versionId, hash, liveUrl, undo}`:
- `liveUrl` = `liveExitUrl(livePath(type, meta))` (P3-COMMIT `paths.js`): `/api/preview?exit=1&to=%2Fpolicies%2Fx`, never a token;
- `undo` = `{id, revision, logId}`: the document's revision after the publish (a plain publish doesn't change it) and the id of this build's `publish_log` row for it. A late commit found through `onLost` gives the late build's own log ids.

### 6. Who changed it

`DOCUMENT_CHANGED`, `DRAFT_CHANGED` and `PUBLISHED_ELSEWHERE` publish conflicts (the top-level `current` and each `conflicts[].current`) carry `updatedBy` (the `updated_by` column, for the editor only; null when nobody is recorded) and `updatedByName` (`versions.js` `plainName` over the team names; "another tab" when it was the person publishing now). The names are read only when there is such a conflict (one platform statement). `DOCUMENT_ARCHIVED` is unchanged. `publish.js` `fromRow` keeps `service.js`'s keys; `updated_by` is kept beside each document in a WeakMap.

### 7. The design document (TOK-03)

Confirmed by test, no fix needed: P2-REG's live-aware rule (`lib/brand.js` `pairVerdicts`) blocks a failing pair only when its colours differ from the same pair live. Through publish: a changed failing pair is `BRAND_UNREADABLE`, level `blocks`. An unchanged failing pair is `BRAND_HARD_TO_READ`, now level `inherited`. A failing colour changed to another failing colour blocks again. Breaking the rule (mutation M25) fails the test.

### 8. Order of the answers

parse → authorize → mode → the set (400/428) → 404 → 409 not publishable → 409 conflicts → **409 `FIRST_PUBLISH_NEEDS_HOME`** → validation and reference checks (**422 `LINKS_TO_UNPUBLISHED`** or 422 `VALIDATION_FAILED`) → **409 `REPUBLISH_CONFIRM_NEEDED`** → skip → the guarded build. `product_content` stays `PUBLISH_NOT_AVAILABLE`.

### 9. The contract (`lib/admin/documents-api-shapes.js`, `scripts/test-api-shapes.js`)

- The keys this item sends are now required: `published[].liveUrl` and `published[].undo` (`addedInPhase3` removed), `current.updatedBy` and `current.updatedByName` on the three named publish conflicts (no longer optional), and `level`, `anchor`, `where`, `actions` on every publish issue.
- `PUBLISH_ACTION_TYPES` lists the five action types, with `openField` new. The header describes each action and level.
- `validationFailed` may carry `offer` (optional). New outcome `firstPublishNoHome` (`offer: null`).
- `test-api-shapes.js`:
  - `BUILT_CODES` (`REPUBLISH_CONFIRM_NEEDED`, `FIRST_PUBLISH_NEEDS_HOME`, `LINKS_TO_UNPUBLISHED`) must be emitted with their outcome's status, so a rename fails. The codes P3-UNDO and P3-CHANGES are still building (`TOO_MANY_KEPT`, `CANNOT_TAKE_OFFLINE`) may be emitted or not, so their merges don't turn this suite red, but a status must match;
  - `decorate()`'s literal keys are `PUBLISH_ISSUE`'s, and every action type `checks.js` makes is in the contract, and the other way round;
  - the extras of the three new refusals, the offer item's keys and the words are read from `publish.js`;
  - `withWho()` adds `updatedBy` and `updatedByName`, and the shapes no longer mark them optional;
  - `liveUrl` is `liveExitUrl(livePath(…))`, and the code's `undo` literal is `{id, revision, logId}`.
- The real answers are compared with the shapes key by key, every action against its own keys, in `test-publish-checks.js` (`likeShape`, `checkIssues`).

## Acceptance, with evidence

"Fails without" names a mutation from my scratch runner (`…/scratchpad/p3-b2/P3-CHECKS/mut/run.py`). Each mutation was applied alone, the named suites were run, and the file was restored. All 32 were caught. All tests are in `scripts/test-publish-checks.js` unless named.

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: a page linking to an unpublished campaign is 422 LINKS_TO_UNPUBLISHED with a plain message and an offer naming both with revision and draftHash; sending the offer makes both live in one release; changing the target's draft after the offer gives 409 DOCUMENT_CHANGED | DONE | "a page linking to an unpublished campaign…": the exact words, the exact offer (both, with revision and draftHash), the issue's where/anchor/actions (`publishBoth`, `hideSection`), storage unchanged; the offer sent back: both published, one release, one set, both in the live list; a second campaign through a page link: its draft saved after the offer gives 409 `DOCUMENT_CHANGED` naming it, storage unchanged, shapes matched. Also "sending the offer runs the targets' own checks…" (the target's own 422, an offline target offered, VALIDATION_FAILED carrying the offer) | M2, M26, M28 |
| 2 | unit: coverage. An image_with_text link to a missing page blocks; a product_rail on a deleted collection warns; a hero image whose media row is gone warns; an image with empty alt warns; a redirect_from equal to its own slug blocks; a link to a code-default policy slug passes | DONE | "coverage: …" proves each one through the API, with level, where and actions (an archived link target also blocks; an empty collection warns, a stocked one is silent; the image is fine before its media row is deleted; the validator alone would block the empty alt; the code-default link passes on a BeastLife store and is a missing page on a store without code defaults). "coverage, the rest": missing collection and product links block, a hidden live page blocks, a shadowed old address warns, a loop blocks, a header menu item offers `removeItem` | M1, M3, M4, M5, M23, M27, M29, M31, M32 |
| 3 | unit (negative): a broken link in the dirty home draft does not stop publishing a policy page; a deleted product only in a home list warns and does not block a hero typo publish | DONE | "negative: a broken link in the dirty home draft…": 200 with no issue; the statements show one read of drafts, `WHERE id IN (?)` for the set's one document; the home page's own publish is refused for its link. "negative: a deleted product only in a home list…": `PRODUCT_MISSING` and `PRODUCT_UNAVAILABLE` warn with `removeItem`, the typo is live. **No shipped home section holds a product list**, so this uses a test-only home kind with a `product_list` setting (the registry's `defineSection`, as test-sections-render does); the check is driven by `refsOf`, so the shipped `cart` document's list is checked the same way | M22, M30 |
| 4 | unit: a typo publish on a migrated-shape fixture whose untouched sections carry issues succeeds with those issues as level 'inherited'; the same issues on an offline page block (not inherited) | DONE | "a typo publish on a migrated-shape fixture…": a `migrated` live version with an empty text section and a link to a missing page; the typo publishes and both are `inherited`; taken offline, the same issues are `blocks` (422, storage unchanged) | M6 |
| 5 | unit: every issue in a 422 has level, anchor, where and at least one action; hideSection then saveDraft then publish succeeds (service-level replay) | DONE | "every issue in a 422 has…": a page with an empty banner, a missing link, a rail on a deleted collection, a too-long title and a self-redirect. `checkIssues` checks every issue's keys, level, anchor, where and each action's own keys. The replay applies each block's `hideSection` (and `removeItem` for the redirect), saves through the API and publishes: 200, the hidden sections aren't live. "doc-level and structure issues get an action too": a missing title and `HOME_EMPTY` get `openField`, a structure block gets `removeSection` | M7, M24 |
| 6 | unit: after take-offline (fixture undone_version_id whose stored body has different section ids), publishing the same content is 409 REPUBLISH_CONFIRM_NEEDED; with confirmRepublish it is live and undone_version_id is null; a changed body publishes with no confirm | DONE | "after take-offline…": the fixture version holds the same content under another section id (its `body_hash` differs from the draft hash, its `documentHash` is equal); 409 with the exact words and `{id}`, storage unchanged; with the confirm it is live, `undone_version_id` null, shoppers see it; offline again, a changed body publishes with no confirm and also clears the column. `test-publish-service` "an offline page…" now asks for and sends the confirm | M8, M9 |
| 7 | unit: the P22 skip rule. A document whose hash equals publishedHash but whose live entry points to another version is not skipped | DONE | "the P22 skip rule": the list points at a migrated version, the row at the first one with the draft's hash; published, not skipped, and shoppers see the draft; the plain case after it is skipped | M10 |
| 8 | unit: on a closed store, publishing a policy alone is 409 FIRST_PUBLISH_NEEDS_HOME with an offer adding doc_home; publishing home alone, or home with the policy, opens the store | DONE | "on a closed store…": three closed stores (`contentSource()` mode `closed`); the exact words and offer, storage unchanged; the offer sent back opens the store with both; home alone opens one; home with a policy in one set opens one; once open, a policy alone publishes. "…no home page document yet": `offer: null`, its words. `test-publish-service` first-publish and sqld cases now publish the home page too | M11 |
| 9 | unit: every publish response item has liveUrl starting '/api/preview?exit=1&to=' with no token and undo {id, revision, logId} matching the new log row; responses match documents-api-shapes.js keys | DONE | "every publish response item has liveUrl…": a set of a policy page, a campaign, a journal post, `about` and home; each liveUrl decodes to its address (`/policies/…`, `/campaigns/…`, `/journal/…`, `/about`, `/`), no token; each undo matches the log row by `set_id` and document and the current revision; the 200 matches the shapes. Every refusal in the suite is compared with its shape (`likeShape`). The two conflict tests check `updatedBy` and `updatedByName` (a staff member's name, "another tab", and a lost race's `PUBLISHED_ELSEWHERE`) | M12, M13, M14, M21 |
| 10 | unit: design publish blocks only when a changed token pair fails contrast; an unchanged failing pair is inherited; all P2 test-publish-service cases stay green | DONE | "design publish blocks only when a changed token pair fails contrast…": unreadable colours on a store whose live design is the platform default block; the same colours already live (a migrated design) with only the corner style changed publish with `BRAND_HARD_TO_READ` at level `inherited`; another failing foreground blocks again. `test-publish-service`: 58 of 58, the P2 cases changed only where this item's rules require (below) | M15, M25 |
| 11 | unit: scripts/test-api-shapes.js passes against the changed code, and still catches a renamed code or a dropped field | DONE | 29 of 29 against this branch | M19 (renamed `REPUBLISH_CONFIRM_NEEDED`), M20 (dropped `undo`), M21 (dropped `updatedByName`), M12 (dropped `liveUrl`) |
| 12 | unit: draftSlugOwner ignoring archived holders and the plain-publish undone_version_id rule are each pinned by a test that fails under its mutation | DONE | "P3-COMMIT pin: draftSlugOwner ignores an archived document…" (the archived row still holds the slug in its column; a live draft at the same slug is named). The plain-publish rule: item 6's last part. Also the two other review pins: "liveEntryOf counts an entry offline only when…" (both cases, as a pure call, plus a hidden live page keeping the inherited rule through publish) and "commit.js passes build.versions (never extraVersions) to liveListHoldsMine at its one call site" | M16, M9, M17, M18 |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish-checks` | 21 passed (all new; the file was a placeholder) | 1.1 s |
| `pnpm test:publish-service` | 58 passed (58 before; 5 cases changed, below) | 1.9 s, of which sqld 0.6 s |
| `pnpm test:api-shapes` | 29 passed (26 before; 3 new, 3 changed) | 0.1 s |
| `pnpm test:publish` | 72 passed, unchanged | 6.1 s |
| `pnpm test:failure-matrix` | 124 passed (2 lines changed, below) | 23.3 s |
| `pnpm test:schema-compat` | 34 passed (1 case changed, below) | 2.9 s |
| `pnpm test` | 81 of 81 | 132.9 s |
| `pnpm build` | passes | |

`test-publish-service.js` cases changed, each because this item's rules require it:
- the first publish on a closed store now shows the 409 and then publishes the policy with the home page (the code-default getters are checked for everything but the home page);
- the late-commit case expects `liveUrl` and `undo` of the build that went live;
- the 0022 store opens with its home page before the refs probe is counted;
- the offline page's "publish again" first gets `REPUBLISH_CONFIRM_NEEDED`, then sends the confirm;
- the sqld first publish shows the 409, then publishes a page with the home page.

## Known limits

- **Two test files outside this item's list were edited, a few lines each, because this item's required behaviour breaks them** (as P3-COMMIT did in batch 1). Neither has an owner in batch 2. The orchestrator should accept them with this branch:
  - `scripts/test-failure-matrix.js` (P3-VALIDATE in batch 1): the docs store now opens with a home page before its publish rows (`FIRST_PUBLISH_NEEDS_HOME`); the "empty home page" row empties that home page's draft instead of creating one; the issue-shape check also accepts the four publish keys (`level, anchor, where, actions`), and only those, after the issue keys.
  - `scripts/test-schema-compat.js` (P3-COMMIT in batch 1): the 0022 case publishes a home page first.
- **Missing alt text no longer blocks a publish.** In phase 2 it did (REQUIRED, an error at publish). PUB-03 lists it as a warning, so it is one now. A draft still marks it incomplete. Owner-visible.
- **A closed store can't publish anything without its home page** (until PUB-12). Anything that publishes first without it gets the 409: the harness seeds (P3-HARNESS) and the p2 drill (`scripts/drills/p2/run.mjs`) were not changed or run here. `perf-docs-fixture.js` (and so `seed-design-documents.js`) publishes the whole fixture in sets of 200 with the home page in the first set; `test-perf-docs` passes.
- **No shipped home section holds a product list.** The "deleted product only in a home list" line is proved with a test-only kind. The only shipped `product_list` is `doc_cart`'s, whose saves are locked today (`CART_NOT_AVAILABLE`).
- **Links checked:** typed page links, url links to `/policies/<slug>`, `/campaigns/<slug>` and `/journal/<slug>`, and typed collection and product links. Not checked: url links to `/about`, `/contact`, `/collections/<handle>`, `/products/<handle>`, `/bundles/…` and `/quiz/…`, and https images (only library images, `/api/media/<id>`). A page link to `about` is looked up by its slug among the pages.
- **A link to a page by its document id passes while that page is live under any address.** The link's own slug may be stale; the storefront renders the link from the stored href.
- **`openField` is a new action type.** P3-PUBLISHUI (batch 3) must render it ("Go to this field"). `removeItem` always has an index.
- **`LINKS_TO_UNPUBLISHED` says "This page links to…"** for every linking document, home and header included.
- **`REDIRECT_LOOP` can only happen between hidden pages** (a redirect's target is always the page's own address, and a live page wins over a redirect). It is tested with two hidden pages.
- **A check whose table can't be read is skipped**, with a log line, rather than blocking or failing the publish.
- **Cost:** a publish adds at most one statement per table above, only when there is something to look up, plus the journal index when a link or an old address needs it, the undone body for an offline item, the home row on a refused first publish, and one platform statement for names on a conflict. `test-perf-docs` passes unchanged; the counts were not measured separately.
- **Inherited reference warnings stay `warns`.** classify only changes errors, so a warning (a deleted product, a missing image) in an unchanged section keeps level `warns`, not `inherited`.
- **`liveUrl` of a page published hidden** (`meta.enabled: false`) still points at its address, where shoppers get "not found".
- **`updatedBy` names only the last saver.** For `PUBLISHED_ELSEWHERE` that is whoever last saved the draft, which may not be whoever published.
- The `PUBLISHED_ELSEWHERE` test lands the other publish as a migrated-style commit through the interleave hook, not through a second real publish.

From review:

- Review summary: I reviewed cms/p3-checks at 860bf7c against 5bbc819 in a detached worktree, which I have since removed. Nothing I started is still running on 4000 or 5001-5009. The sqld/dev-design processes on 5080-5082 belong to the P3-HARNESS agent and I did not touch them. Results: pnpm test passed 80 of 81 suites. The one failure was test:publish-service: its sqld could not bind port 5000, because macOS ControlCenter (AirPlay) is listening there. That is the environment, not the code. Rerun alone on 5006,5007 it passed 58/58, so all 81 suites pass. test:publish-checks 21/21, test:api-shapes 29/29, pnpm build passes. Edge check: checks.js and publish.js are imported only by documents-api.js, which is used only by app/api/admin/documents/route.js (runtime nodejs). documents-api-shapes.js still has no imports. I ran 39 mutations of my own and the tests caught 30. I also ran 7 contract mutations (renamed LINKS_TO_UNPUBLISHED and FIRST_PUBLISH_NEEDS_HOME codes, dropped where/offer/id/label, wrong status), and test-api-shapes and test-publish-checks caught all 7. The P3-COMMIT pins work: removing 'AND archived_at IS NULL' in draftSlugOwner, dropping the undone:null clear, passing extraVersions to liveListHoldsMine, and widening liveEntryOf for pages each fail a test. The acceptance claims I reproduced hold. A legacy-mode store still gets 409 STORE_USES_LEGACY.
- A page link checked by document id passes even when the slug it stores no longer exists, so shoppers get a 404. checks.js linkTarget/decided (around line 279) finds the target by r.document first (byDoc), but the storefront builds the href from link.slug (registry/settings.js linkHref, components/sections/parts.js). Reproduced: page 'moves' renamed to 'moved' and published, with no redirect. A new page with a banner pageLink('page','moves', <that doc id>) publishes with 200 and no issue, and its button goes to /policies/moves. The same thing happens inside one set, when B is renamed in the same publish as a page A that links to it by id. The packet lists this as a known limit. Suggested fix: when the byDoc row's slug differs from the link's slug (and no redirect covers the old one), report LINK_TARGET_MISSING (or a stale-link warning).
- False block: a link to an old address that a live redirect covers is refused as LINK_TARGET_MISSING, with the untrue words 'which isn't a page of your store'. Reproduced: a page 'new-addr' with redirect_from ['old-addr'] is live. A new page with a banner url '/policies/old-addr' gets 422 VALIDATION_FAILED, yet shoppers who click it are redirected to the page (resolve.js resolvedSlugRedirect). The checks never look at list.redirects for link targets.
- Missing warning: the redirect checks count only enabled rows (liveSlug = rows.filter(enabled)). But resolve.js resolvedSlugRedirect lets any page row at that slug win, a hidden one included, and the hidden page then gives a 404. Reproduced: a hidden live page 'hidden-holder', then a new page with redirect_from ['hidden-holder'], publishes with 200 and no issue, and that old address will never redirect. REDIRECT_SHADOWED (and the loop walk) should use every list row, not only enabled ones.
- Owner-visible effect, as the spec says: links in a document's own settings (header and footer menu items, sectionId null) are never inherited, because classify() only covers sections. Reproduced: a header goes live with a menu item to /policies/menu-tgt, then menu-tgt is taken offline. After that, every header publish, even one only adding an unrelated item, gets 422 LINKS_TO_UNPUBLISHED 'This page links to Menu tgt…' (the words say 'page' for the header). It offers publishBoth and removeItem, so the founder has a way out. Worth adding to the owner checks.
- Two-step flow the UI has to handle: when the offered target is a page that was taken offline, sending offer.publishSet back as it is gives 409 REPUBLISH_CONFIRM_NEEDED for the target (reproduced), because the offer items carry no confirmRepublish. P3-PUBLISHUI must chain that confirm. Otherwise the offer could mark offline targets, or the confirm could be implied by publishBoth. Neither the packet nor the owner checks mention this.
- Test gaps (the code behaves correctly in my probes, but no test pins it). (a) M2 'live list with the set applied': removing the `!inSet.has(row.document)` filter on list rows (checks.js:260) survives every suite. My probes showed the real code blocks when the set hides B or renames B while A links to its old address. (b) A link to a live journal post: forcing needJournal=false survives, though in real use it would make every link to a live post wrongly LINKS_TO_UNPUBLISHED. My probe showed the real code passes it. (c) Also surviving: the preference for the enabled row in byKey (line 271); the code-default check restricted to the page family (line 282); the loop walk's 'stop at a live slug' (line 385); the home.archived term in FIRST_PUBLISH; and the journal branch of liveEntryOf's narrower offline rule (build.js:151; only the page branch is pinned). Suggest a test for each of (a) and (b) at least.
- Contract change for other items: the new action type openField (documents-api-shapes.js PUBLISH_ACTION_TYPES) is not in the plan's action list. No other code uses action types yet, but P3-PUBLISHUI must render openField, offer on VALIDATION_FAILED, and offer:null on FIRST_PUBLISH_NEEDS_HOME. Disclosed in the packet; the orchestrator should pass it to the batch 3 briefs.
- Out-of-list edits to scripts/test-failure-matrix.js and scripts/test-schema-compat.js: I checked them, and they don't weaken assertions. They open the closed store with a home page first. The issue-shape check still requires the base keys in order, plus exactly level, anchor, where and actions. The 5 changed P2 cases in test-publish-service.js only follow the new rules (first publish needs home, republish confirm, liveUrl/undo on the late commit). Accepting them is the orchestrator's call, as the packet says.
- Ports note for later runs: on this Mac, port 5000 is taken by ControlCenter (AirPlay Receiver). Any batch given 5000 for sqld will see a 20-second health timeout in test:publish-service that looks like a code failure.

## Owner checks

- **CI sqld download** (standing): `.github/` was not touched. Approving the source and checksum of the sqld binary for CI is still the owner's call.
- **Ruling:** missing alt text warns at publish, where phase 2 blocked it (PUB-03 wording).
- **Ruling:** a closed store's first publish must include the home page; with no home page document yet the answer offers nothing (`offer: null`). Until PUB-12 (open question).
- **Ruling:** a plain publish clears `undone_version_id` (the confirm only guards publishing the taken-offline content again).
- **Ruling (standing from P3-COMMIT):** `liveEntryOf`'s narrower offline rule (a page hidden by its own `meta.enabled` keeps the inherited rule). Now pinned by a test in both cases.
- **Wording:** the new founder messages (the reference checks in `checks.js`, the three new refusals, "another tab").
- **Hosted Turso, on a staging tenant:** publish both (one set, all or nothing) and a publish after take offline, through the real handler.
- **Orchestrator:** accept the two out-of-list test edits (Known limits). P3-PUBLISHUI must handle `openField`, `offer` on `VALIDATION_FAILED`, and `offer: null` on `FIRST_PUBLISH_NEEDS_HOME`. P3-HARNESS seeds and the drills must publish the home page in a closed store's first set.

## Files

New: `lib/documents/checks.js`. Changed: `lib/documents/publish.js`, `lib/admin/documents-api-shapes.js`, `scripts/test-publish-checks.js` (the placeholder replaced), `scripts/test-publish-service.js`, `scripts/test-api-shapes.js`. Outside the list (Known limits): `scripts/test-failure-matrix.js`, `scripts/test-schema-compat.js`. This packet.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:publish-checks && pnpm test:api-shapes
TEST_PUBLISH_SERVICE_PORTS=4800,4801 pnpm test:publish-service
TEST_PUBLISH_PORTS=4802,4803 pnpm test:publish
TEST_PUBLISH_PORTS=4802,4803 TEST_PUBLISH_SERVICE_PORTS=4800,4801 pnpm test
pnpm build
python3 …/scratchpad/p3-b2/P3-CHECKS/mut/run.py      # the 32 mutations
```
