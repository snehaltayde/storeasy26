# P6 · GEN-WRITE · The first-run writer and the shared policy-page rule (GEN-01)

Branch `cms/p6-gen-write`, cut from `cms/phase-1` at `b063753`. Both P5-FIX2 (`441b44d`) and P5-DRILLS (`211c982`) are merged there, as the plan requires.

## Files

- `lib/documents/service.js`: adds `createFirstRunDocuments`, `FIRST_RUN_ACTOR`, `FIRST_RUN_BY`, `FIRST_RUN_SKIP_REASONS` and the test-only `firstRunHooks`. Nothing that was already there changed: createDocument, saveDraft and every other writer are byte for byte the same.
- `lib/documents/policy-pages.js` (new): the one policy-page rule, shared by PUB-12, the policy starters and onboarding.
- `lib/admin/documents-api-shapes.js`: a new `FIRST_RUN` export holding the writer's outcomes, all `since: "p6"`.
- `scripts/test-api-shapes.js`: accepts `since: "p6"`, adds `P6_CODES` (FIRST_RUN_ACTOR, FIRST_RUN_STORE_LIVE, FIRST_RUN_RACE) to the built and new codes, walks `FIRST_RUN`, and adds one check (below).
- `scripts/test-documents.js`: a fresh documents store of its own (`zf`, `.test-documents-firstrun.db`), 12 writer tests and 3 policy-page tests.
- `scripts/test-failure-matrix.js`: **not changed.** It doesn't list DocumentError codes (it walks the real handlers and lib/cms/issues.js's INFRA_CODES only), so it has no row to add.

## Status by stage

| Stage | State |
|---|---|
| Implemented | done |
| Locally tested | done: `pnpm test` 98 of 98 suites, `pnpm build` passes |
| Browser verified | not needed: no screen changes. Nothing here is visible until P6-GEN, P6-OPEN and the UI items call it |
| Staging | NOT DONE (owner check) |

## What and why

GEN-01 needs a starting store made from the catalog without overwriting anything the founder wrote. Phase 6 makes only `doc_home` and `doc_design`, and they must land together or not at all. A store with a home but the lime platform design, or the other way round, is the half-made state the plan rules out. The writer is the only place first-run content is stored. The planner (`lib/first-run/plan.js`) and the runner (`generate.js`) come later in P6-GEN and call it.

The policy rule was moved into this item (plan revision 4) because P6-OPEN, P6-POLICY-START (both batch 2) and P6-ONBOARD (batch 4) all import it, so it has to exist before batch 2.

## Design

### `createFirstRunDocuments({ docs, actor, allowEmptyRefill = true })`

Returns `{ written, created, refilled, unchanged, skipped: [{ id, reason }] }`:
- `written` is a boolean: whether anything was stored.
- `created`, `refilled` and `unchanged` are document ids.
- `skipped[].reason` is `'founder'`, `'published'` or `'archived'`.

**Actor.** Only `{ kind: 'system', id: 'first-run' }` is accepted. Anything else, including the string `'system:first-run'` and the policy-starter actor, gets `DocumentError(400, 'FIRST_RUN_ACTOR')` in plain words, and nothing is read or written. `docs` must list editable singleton types with their singleton ids, each id once. A call that breaks this is a developer mistake and throws a `TypeError` (a 5xx), not a new code.

**Steps:**
1. **One read** of the rows for the ids.
2. **Classify** each row, in this order:
   - absent → create;
   - `archived_at` set → skip `archived`;
   - `published_version_id` set → skip `published`;
   - `updated_by = 'system:first-run'` → refill (rule `owned`);
   - `allowEmptyRefill` and revision 1 and `draft_hash` equals the empty body's hash → refill (rule `empty`);
   - otherwise → skip `founder`.

   The empty hash is `prepare(type, emptyBody(type)).hash`, the hash createDocument stores, cached per type. `documentHash` strips ids, so the random ids of `newSection()` never matter (the test proves that two bodies with different random ids hash the same).
3. **Validate** each body that may be written through the private `prepare()` (draft mode, sanitized, upgraded), the same path createDocument and saveDraft use. One bad body refuses the whole call with 422 and nothing is stored. A refill whose prepared hash equals the current `draft_hash` goes to `unchanged`: no statement, no revision bump, no version row. Skipped documents are never validated or touched.
4. **One `libsql.batch(…, "write")`:**
   - `documentsGuardStatement()`;
   - the not-live guard: `INSERT INTO cms_state … SELECT 2 … WHERE EXISTS (SELECT 1 FROM release_state WHERE id = 1 AND live_release_id IS NOT NULL)`. This guard, not `published_version_id`, keeps a refill off a store that was opened and then taken offline;
   - per created document: `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM documents WHERE id = ?)`, then `ABORT`, the `Created` checkpoint version (`versionStatement`, as createDocument writes it), and its `document_refs`;
   - per refilled document: `UPDATE … WHERE id = ? AND revision = ? AND published_version_id IS NULL AND archived_at IS NULL AND <rule>`, where the rule is `updated_by = 'system:first-run'` or `revision = 1 AND draft_hash = <the hash read>`. Then `ABORT`, a checkpoint version (always written, unlike saveDraft's if-due one, so each refill leaves its own version), its refs, and `pruneStatement(id)` as saveDraft prunes.
5. **After a throw:**
   - The rows are read again. If every planned row now carries our `updated_at`, hash and `system:first-run`, the batch committed and only its answer was lost: success.
   - Otherwise `classifyAbort(libsql, e, "documents")`, as openEntityContent does. Mode `migrating` → 409 STORE_MIGRATING (`MIGRATING_MESSAGE`). Any other mode → 409 STORE_USES_LEGACY.
   - A "lost" abort with `live_release_id` set → 409 FIRST_RUN_STORE_LIVE.
   - Any other lost abort → 409 FIRST_RUN_RACE.
   - A non-guard error is rethrown, so `failure()` makes it a 5xx.
   - A store from before migration 0021 (no documents table) → 409 STORE_USES_LEGACY.
   - DOCUMENTS_MODE_REQUIRED is not added.

**Test hook.** `firstRunHooks.beforeBatch({ plan })` runs between classify and batch. It is never set in production (the same pattern as `discardHooks` and `openEntityHooks`).

### `lib/documents/policy-pages.js`

- `isPrivacySlug` (`/privacy/`), `isReturnsSlug` (`/terms|refund|return/`) and `kindOfSlug`. Privacy wins when a slug matches both.
- `POLICY_KINDS`, `POLICY_STARTER_ACTOR` (frozen) and `POLICY_STARTER_BY = 'system:policy-starter'`. The value is written out, not built with service.js's `actorString`, so the module doesn't pull in the write service. A test checks the two agree.
- `POLICY_STATES` (`live`, `inSet`, `saved`, `starter`, `missing`, best first), plus `COUNTING_STATES` and `policyCounts(state)`. These are small helpers for batch 2 that state the review rule in one place.
- `policyStatus(rows, setIds = [])` is pure. It counts only `type 'page'` rows that are not archived and have a slug. For each kind it returns `{ state, doc }`, the best state across that kind's pages. A tie goes to the newest `updatedAt`, then the higher id, so row order never changes the answer.
- `readPolicyRows()` runs the one SELECT the brief names, mapped to `{ id, type, slug, label, revision, draftHash, publishedVersionId, archivedAt, updatedBy, updatedAt }`. A store with no documents table gives `[]`. `listDocuments` is not changed.

### Shapes

The writer is not an operation of `PUT /api/admin/documents`, so its outcomes are not in `SHAPES` or `COMMON`. Putting them there would change the operations list that suites pin, and the client mappers walk `COMMON`. Instead they sit in a separate `FIRST_RUN.outcomes`:
- `ok`
- `notFirstRunActor` (400)
- `storeLive` (409)
- `race` (409)
- `legacy` (409, this writer's own words)
- `storeMigrating` (409)
- `validationFailed`

test-api-shapes walks them with every other outcome, so the code scan finds an outcome for each new code. P6-OPEN adds its codes to `P6_CODES`, in the same `p6` set.

## Acceptance, with evidence

Each test below was checked against a mutated writer (one change at a time, then restored) and fails without the part it covers. A suite run on the base code doesn't have these tests at all.

| # | Acceptance item | State | Evidence |
|---|---|---|---|
| 1 | Fresh store: doc_home and doc_design created in one batch, version rows by system:first-run, plainName "Storeasy" | done | test-documents "on a fresh documents store it creates doc_home and doc_design in ONE batch…": the batch spy counts 1 batch; each doc has one `checkpoint` / `Created` / `system:first-run` version; `listHistory` names it "Storeasy" |
| 2 | Second call refills both (revision + 1, pruned as saveDraft prunes); third with the same bodies is unchanged with no bump and no version row | done | "a second call with different bodies refills both…" (revision 2, 2 versions; third call: 0 batches, storage byte-identical; fails with the unchanged-skip removed) and "refills prune old version rows…" (23 refills leave `CHECKPOINT_CAP` = 20 versions and the `Created` one is gone; fails with `pruneStatement` removed) |
| 3 | Founder-saved doc_home skipped `'founder'`, revision, body and versions unchanged | done | "a founder-saved doc_home is skipped…": row deep-equal before and after, version count unchanged, design still refilled |
| 4 | Empty createDocument home (merchant, revision 1) refilled; with a section added, skipped; `allowEmptyRefill:false` skips the empty one | done | "an empty doc_home made by createDocument…"; fails when `allowEmptyRefill` is ignored |
| 5 | Published doc skipped; live store 409 FIRST_RUN_STORE_LIVE; legacy 409 STORE_USES_LEGACY; migrating 409 STORE_MIGRATING; nothing written | done | "a published document is skipped…", "a live store gets 409…" (also the take-offline case: generator-owned unpublished drafts plus a live pointer; fails without the not-live guard and without the live mapping), "a legacy store gets 409…" (storage byte-identical each time) |
| 6 | Revision race aborts the whole batch, neither doc changes, FIRST_RUN_RACE; the empty-hash race aborts too | done | "a revision race…" (a real founder saveDraft in the hook) and "the SQL repeats each classified predicate…". The second covers four cases: another writer at the same revision, an edited revision-1 empty home with revision kept at 1 (proves the `draft_hash = ?` term), a real founder save on the empty home, and a home created meanwhile (the INSERT guard). It fails with the predicate removed, and with the `WHERE NOT EXISTS` removed |
| 7 | policy-pages: isReturnsSlug, kindOfSlug, and policyStatus live / starter / inSet / saved / cutover saved / archived and slugless ignored; readPolicyRows returns updatedBy | done | test-documents "policy-pages: the slug rule…", "policyStatus (pure)…", "policyStatus on real rows (readPolicyRows)…" |
| 8 | test-api-shapes passes with p6 and the three codes; the writer scan still passes; createDocument and saveDraft unchanged; `pnpm test` passes | done | test-api-shapes 34 passed. With the p6 codes taken out of the code list it fails ("no p2 outcome for FIRST_RUN_ACTOR, …"); without `p6` accepted it fails ("since is p6"). The new check compares each first-run refusal's words with service.js (or cms-mode.js for MIGRATING_MESSAGE). The "one writer" scan passes. Every existing createDocument and saveDraft test passes untouched, and the diff of service.js only adds lines after `__overlayInternals`. `pnpm test`: 98 of 98 suites. `pnpm build`: passes |

Also tested:
- **Lost answer:** the batch commits, then the call throws. That is success, not a race, and it fails without the read-back.
- **Actor and validation refusals:** five wrong actors give 400 FIRST_RUN_ACTOR in plain words, and an invalid design refuses the whole call with 422. Storage is unchanged in both cases.

## Tests

- `node scripts/test-documents.js`: 58 passed (43 before), about 2 s.
- `node scripts/test-api-shapes.js`: 34 passed (33 before).
- `pnpm test`: 98 of 98 suites, 211.8 s. `pnpm build`: passes.

## Known limits

- **No batch runs when nothing needs writing.** When everything is skipped or unchanged, no guard is asked. A live, legacy or migrating store then gets the skip and unchanged report, not a 409. This is truthful, because nothing was written. P6-GEN checks eligibility (documents mode, no live release) before calling.
- **Every refill writes a checkpoint, not an if-due one.** A refill always leaves its own version row (the acceptance needs "a new version row" per refill). The cap still holds through the prune. A refill only happens when the catalog-derived body changed, because unchanged bodies are skipped.
- **A refill bumps the revision of an editor that has the draft open.** That editor then gets "changed somewhere else" on its next save. This is the plan's "shouldFix not taken" and an owner check below. It only happens for generator-owned drafts, which a founder hasn't saved.
- **Singleton documents only.** Route documents (pages) would need slug handling. Phase 6 makes only doc_home and doc_design.
- **No API route or caller yet.** The FIRST_RUN outcomes describe what P6-GEN's route will answer. P6-GEN adds the route, the `ok: true` wrapper and the one retry on FIRST_RUN_RACE.
- **The suite simulates two races with raw SQL.** "Another writer at the same revision" and "edited at revision 1" can't happen through the service today, because every service write bumps the revision. They are there to prove that the SQL predicate, not just the revision check, guards each rule.
- **`archived` can't be reached through the service.** Singletons can't be archived (CANNOT_ARCHIVE). The test sets `archived_at` by hand to cover the branch.

## Owner checks

- **Staging (OQ-4):** on a throwaway documents tenant, once P6-GEN has landed, the first generation makes doc_home and doc_design together. A founder edit to the home is never overwritten by a later sync.
- **Open editor refill:** a sync-time refill while the editor is open shows the "newer version elsewhere" conflict. Confirm the wording is acceptable (already in the plan's list).
- **Hosted Turso:** the one-batch atomicity and the lost-answer read-back on a staging tenant. Local file databases and the harness can't show replica behaviour.

## Commands

```
node scripts/test-documents.js
node scripts/test-api-shapes.js
pnpm test
pnpm build
```
