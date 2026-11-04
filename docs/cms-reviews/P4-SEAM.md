# P4 · SEAM · The content getters against a given source

Branch `cms/p4-seam`, cut from `607cde2` (`cms/phase-1` with P4-SCAFFOLD merged). Plan: `docs/cms-reviews/P4-PLAN.md` (decision 8, section 3, batch 1) and `P4-BATCHES.json`. Requirements: MIG-02 (the data check before the flip) and MIG-01 (the backfilled list it checks). This item builds the seam only; nothing calls it yet. P4-MAPPER, P4-OVL07 and P4-CUTOVER use it.

Files: `lib/content/resolve.js`, `lib/content/documents-reader.js`, `scripts/test-content-seam.js` (replaces SCAFFOLD's placeholder; no `package.json` change), this packet. No migration. No P3-FIX5 file, no `lib/preview-sessions.js`, `lib/sanitize.js`, `lib/documents/after-commit.js` or `scripts/drills/p3/*` was edited.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 142.4 s. `test:content-seam` 18 passed in 0.6 s. `test:release-readers` (44), `test:sections-render` (36, the home-render baseline), `test:perf-docs` and `test:releases` pass unchanged. `pnpm build` passes |
| Browser verified | Not applicable. No shopper or founder output changed: every getter's answer is proven equal by the unit suite, and the a6d028e home-render and journal baselines pass unchanged. No dev server ran; port 6160 and 7160 to 7169 were not used |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso; nothing calls the seam on a real tenant until P4-CUTOVER |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

The MIG-02 data check (plan decision 8a) must compare what shoppers see today with what they would see after the cutover, before the flip. It needs every `resolved*` getter to run against a v4 list that is not live yet, whose version bodies may exist only in memory (a dry run), and later with product and collection content rows handed in. Until now each getter fetched its own source with `contentSource()`, which reads cookies, the live pointer and React's per-request cache. There was no way to give a getter another source without flipping the store.

## Design

### (1) `lib/content/resolve.js`

- Every exported getter is now a thin wrapper:
  `export async function resolvedX(...args) { return xFrom(await contentSource(), ...args); }`
  The body of each `xFrom(src, ...)` is the old getter's body with the `const src = await contentSource()` line removed. The draft, closed, live and preview branches are untouched.
- Getters that called other getters now call the `From` form with the same `src`: `resolvedHomePage` (hero and sections) and `resolvedJournalEntries` (the legacy page list and pages). Inside a request this is identical, because `contentSource()` was cached per request. Outside a request (a script) it reads the source once instead of several times.
- `contentGettersFor(src)` returns a frozen object with all 19 getters bound to `src`, under the exported names, with the same arguments. A missing source is refused.
- `candidateSource({ list, releaseId, bodies, entityRows })` returns a frozen `{ mode: "live", v: 4, list, releaseId, content: null, preview: false, bodies, entityRows }`. `list` goes through `Docs.parseList`, the same check the live reader makes, so a bad candidate list fails closed with the same `BAD_LIST` or `MISSING_SINGLETON` codes. `bodies` defaults to an empty Map. `entityRows` defaults to `{ product: new Map(), collection: new Map() }`.
- Every version read in `resolve.js` passes the source's bodies: the chrome, home, product layout, collection layout and cart sets (`documentBodies`) and the page, journal post and journal index reads (`versionBody`). A source built by `contentSource()` has no `bodies`, so it passes `null`, which is today's path.
- `contentSource()` and `readContentSource()` are unchanged and remain the only source on shopper requests. No module-level variable holds a source, no AsyncLocalStorage is used, and no `node:` import was added.

### (2) `lib/content/documents-reader.js`

- `liveVersions(ids, { bodies } = {})`: an id found in `bodies` is taken from there; only the rest are read, in one statement through the per-request cache as before. With no bodies (or none matching), the call is the old one: same key, same cached Map.
- A held entry is `{ document_id, body }`, where body is an object or its stored JSON text, plus an optional `schema_version`. It goes through `parseVersion`, so it gets the same refusals as a stored row: unreadable text or a missing document id is `BAD_VERSION`, a body from newer code is `UNKNOWN_SCHEMA`, and `documentBodies` still checks the document and type (`VERSION_MISMATCH`). The upgrade runs in memory, as for a stored row.
- Held answers never enter the per-request version cache, so a shopper read in the same request still reads the database, and a later dry run never sees an earlier one's bodies.
- `documentBodies(list, ids, { bodies } = {})` and `versionBody(id, { documentId, type, bodies })` pass `bodies` through. `bodies` may be a Map or a plain object.

### (3) `entityRows`

Carried on the candidate source and not read by any getter yet. P4-OVL07 makes the entity getters read it (and the live tables) whenever `src.v === 4`. Until then the three entity getters on any v4 source return today's neutral empties.

### (4) What did not change

No getter's output changed, nor the closed, draft, live or preview paths. `previewFrameRoutes`, `isStoreClosed` and `closedStoreGate` still read `contentSource()` and are not part of the bound set (they are not `resolved*` getters).

## Acceptance, with evidence

1. **For every a6d028e fixture state, `contentGettersFor(<the source contentSource() would build>)` answers deep-equal to the existing getters. `test-release-readers` and the home-render and journal baselines stay green unchanged.** DONE.
   - `test-content-seam` section 1 builds the a6d028e recorder's own tenant (`vgl`, same name, catalog and tables as `scripts/support/legacy-release-outputs.js`). In one simulated request per state it takes the source `contentSource()` built, then compares 34 calls (every getter, with the recorder's 23 argument sets plus 11 more) through `contentGettersFor(src)` and through the exported getters.
   - States: legacy drafts (no release), the S59 candidate preview, v1, v2 and v3 releases (the a6d028e fixture states), plus a v4 release, a v4 documents preview with a draft laid over, and the closed store.
   - For v1, v2 and v3 the seam's answers to the 23 recorded calls also equal `scripts/fixtures/legacy-release-outputs.a6d028e.json` exactly.
   - `test:release-readers` (it re-records v1 to v3 and the journal outputs and compares them with a6d028e), `test:sections-render` (the home-render a6d028e baseline) and `test:perf-docs` (statement counts) pass with no edit.
   - Fails without the change: with the original `resolve.js` and `documents-reader.js`, 17 of the 18 seam tests fail (no `contentGettersFor` or `candidateSource`).
2. **A candidate v4 list whose version bodies exist only in the bodies map resolves every non-entity getter, and a counted client shows no `document_versions` read for those ids.** DONE.
   - Section 2 puts dv's full store (every singleton, pages, a campaign, a redirect and a journal index with three posts) through `candidateSource` on `vgl`, a legacy store with a v3 release where none of those versions exist (the test checks there are 0 such rows).
   - Every non-entity getter is called; none throws. A statement watcher on the tenant's client records **no** `document_versions` statement. The answers equal the exported getters' answers on dv, where the same list and versions really were published through `commitPublishBatch`. Afterwards vgl's shopper still gets "Live hero v3".
   - A mixed map (only the four chrome versions held) reads the home versions from the database, and no read's arguments contain a held id.
   - A held body with the wrong document, a newer schema, unreadable text or no document id fails closed with the same codes as a stored one. A version neither held nor stored is `MISSING_VERSION`.
   - Fails without the change: when the reader ignores `bodies`, 5 tests fail. When `resolve.js` stops passing bodies to page reads, 3 fail.
3. **An import scan finds no `node:` import reachable from `resolve.js`; no module-level variable holds a source (grep check).** DONE.
   - Section 3 walks every static and dynamic relative (and `@/`) import from `lib/content/resolve.js` (more than 20 files, `documents-reader.js` included). The only hit is `lib/tenant-context.js: node:async_hooks`, which existed before this item. Next's edge runtime provides it, and `test-release-readers` already allows it. `pnpm build` passes.
   - The grep check: neither file uses AsyncLocalStorage, has a module-level `let` or `var`, or has a module-level non-function `const` named like a source, bodies, entity rows or candidate. Neither writes to `globalThis`, except the existing request-scope holder. `contentSource` is still `cache(async () => readContentSource() …)`, and every exported getter matches the thin-wrapper form.
   - Fails without the change: a mutation that keeps the "last bodies" in a module-level `let` fails this test and three of section 4.
4. **A normal shopper request path (`contentSource`) never sees bodies or entity rows from a previous `contentGettersFor` call.** DONE.
   - Section 4 runs on dv (a v4 release live). Its candidates hold **different** bodies under dv's **own live version ids** (the announcement, hero and About page changed to "ONE" and "TWO"), plus entity rows.
   - (a) Two candidate runs and then the shopper getters, in one request: each candidate sees its own words, the shopper sees "Docs bar", "Docs hero" and "About Docs", and the shopper's source has no `bodies` or `entityRows`.
   - (b) The shopper first, then a candidate, then the shopper again, in one request: the candidate reads its map before the request's cached versions, the shopper is unchanged, and `contentSource()` returned one source for the request.
   - (c) Two candidate requests, then a fresh shopper request, and a call outside any request: the live source's keys are exactly `content, list, mode, preview, releaseId, v`.
   - Fails without the change: all of section 4 fails on the old files. The module-level leak mutation above fails (a), (b) and (c).

## Tests

- `scripts/test-content-seam.js` (`pnpm test:content-seam`): 18 tests, file databases only (`.test-seam-*.db` in the worktree root, removed at the end). There is no network, no sqld, no Typesense and no Shopify.
- Mutation runs, done by hand and not committed:
  - original lib files: 17 failures;
  - the reader ignores bodies: 5 failures;
  - page reads skip bodies: 3 failures;
  - a module-level "last bodies": 4 failures.
  - One mutation was **not** caught: copying held entries into the cached Map of the database read. A shopper can never observe this, because held ids are by construction never in that cache key, and the shopper's own key is a different cache entry. It is recorded here so a reviewer does not take it for a gap in section 4.

## Known limits

- `entityRows` is carried but not read. The three entity getters (`resolvedProductOverride`, `resolvedCollectionPins` and `resolvedPdpPairs`) return today's v4 neutral empties on a candidate source until P4-OVL07.
- `versionBody` also takes `bodies`. The brief names only `documentBodies`, but a page, journal post or journal index whose version is held could not resolve otherwise (acceptance 2). LIVEROW and OVL07 should keep both signatures.
- A held body is not checked against the list entry's `hash`, just as a stored version is not on the live path. The cutover's own checks (row counts and body hashes at backfill) cover that.
- Catalog reads in the getters (rail and collection-index healing, cart upsell ids, the automatic pairs strip) read the tenant's current catalog for a candidate too. That is the same for both sides of the MIG-02 comparison.
- `contentGettersFor` on a legacy draft source reads the legacy tables, as the exported getters do. That is the legacy side's answer, by design.
- Outside a request (scripts), `resolvedHomePage` and `resolvedJournalEntries` on a legacy store now read the source once instead of once per inner getter. The output is the same, with fewer statements. No suite pins a statement count outside a request scope.
- `lib/tenant-context.js` imports `node:async_hooks` (pre-existing, edge-provided). It is reachable from `resolve.js` and is allowed by name in the scan.

From review:

- Reproduced the report on a fresh detached worktree at 4814c3d. pnpm test passed 96 of 96 suites. test-content-seam passed 18 of 18. pnpm build passed with only the existing edge-runtime warnings. The diff touches only resolve.js, documents-reader.js, test-content-seam.js and the packet, so test-release-readers, test-sections-render and test-perf-docs ran with no edits and are green. No server or sqld was started, ports 6360 and 7360 to 7369 were not used, and the worktree has been removed.
- Read the code. contentSource() is byte-identical to before. Every exported resolved* getter is a thin wrapper. No module-level source exists, no AsyncLocalStorage was added and no node: import was added. No dependency of the getters (store.js, placements.js, catalog-overrides.js, repo.js, registry/legacy.js) calls contentSource or resolve.js, so a candidate source cannot fall back to the live source by an indirect path. Held bodies go through parseVersion and never enter the per-request fetchVersionSet cache. The non-held key is the same as before, so the shopper path keeps its cache hits and statement counts.
- I ran 17 hand mutations against test-content-seam. Thirteen were caught: nav ignoring its argument; dropping bodies from the journal index, a journal post, the cart, PDP extras, surface templates, content pages or the home helper; candidateSource skipping parseList; candidateSource set to preview true; slugRedirect reading contentSource(); the cartUpsell wrapper dropping its arguments; held bodies skipping parseVersion. Four survived, listed below. None is a production defect.
- Test gap (survived mutation M16). When the candidate list has no doc_home (null, meaning the code default), homePageFrom falls back to homeSectionsFrom(src). Replacing that call with resolvedHomeSections(), which reads the live source, is not caught: section 2 always has a doc_home. Today's code is correct. Suggest that OVL07 or CUTOVER add a candidate case with doc_home set to null, because the MIG-02 comparison would quietly read the live store there.
- Test gap (survived mutation M11). In contentGettersFor, if resolvedPdpPairs drops its opts (the {limit} option), no test fails. The fixture has too few pairs for limit 2 and limit 4 to give different answers. resolvedPdpPairs is an entity getter that OVL07 rewrites, so OVL07's tests should use a limit smaller than the number of pairs.
- Survived mutation M2, harmless. On the legacy path, homePageFrom calling resolvedHero() instead of heroFrom(src) is not caught. A candidate source is always v4, and inside a request both reads give the same source, so no output can differ. Noted only for completeness.
- Survived mutation M14, copying held entries into the cached database Map. The builder already disclosed it. I confirmed held ids are never part of the cache key, so a shopper cannot observe it.
- Acceptance item 3 says no node: import is reachable from resolve.js. Strictly, one is: lib/tenant-context.js imports node:async_hooks. It existed before this item, the edge runtime provides it, and test-release-readers already allows it. The builder disclosed it in Known limits, and the build passes. The accurate wording would be that no new node: import was added.
- A minor behaviour to be aware of: if the bodies map holds an id with a null or undefined value, heldVersion treats it as not held and reads that version from the database instead of failing. CUTOVER should never put null values in the map.
- The resolvedNav, resolvedContentPage, resolvedSurfaceTemplateFor and entity wrappers now take (...args). Their arity (.length) changes, but default arguments are kept in the From functions and no caller depends on .length. No output changes.

## From review

See "From review" at the end of Known limits.

## Owner checks

None new from this item. Nothing reaches a real tenant until P4-CUTOVER, whose runbook and rehearsal cover the data check.
