# P2 · HARDEN · Closing the review findings on the atomic publish commit

Branch `cms/p2-harden`, cut from `319a20f`. Plan: `docs/cms-reviews/P2-PLAN.md` (decisions 1 and 2). Spec: `docs/CMS_FULL_BUILD_SPEC.md` 8.6. Requirements: PUB-01, PUB-02 (the atomic batch). Migrations: none.

Files changed: `lib/documents/commit.js`, `lib/documents/release-list.js` (one new pure helper), `scripts/test-publish.js`, `docs/cms-reviews/P2-ATOM.md` (new "Hardening (P2-HARDEN)" section) and this packet. `package.json`, `.github/`, migrations, the readers and the legacy release code are untouched. Nothing in the app calls `commitPublishBatch` yet, and no tenant changes mode.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:publish` 52 passed, 0 failed, in about 5 seconds (sqld part about 4.6 s). Whole gate `pnpm test`: 66 of 66 suites passed in 116.2 s. `pnpm build` passes |
| Browser verified | Not applicable. Nothing a shopper or founder sees changed, and nothing in the app calls this code yet. No dev server ran |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. See owner checks |
| Production enabled | **NOT DONE.** Nothing pushed, deployed or migrated |

## What and why

The independent review of P2-ATOM found four ways the commit could tell the publish service something false. Each one would make the founder see a wrong message, or worse, see "published" when the live list points at the wrong content.

1. **A reused version id was reported as ok.** `ON CONFLICT(id) DO NOTHING` keeps the old row when an id is reused, and the flip guard only counted that the id existed. Build B reused `ver_1` (doc_home's) for doc_footer: the batch reported ok and the live list said doc_footer was at a version that holds doc_home's body.
2. **Caller bugs were reported as a race.** An undefined revision made the client throw a TypeError, which the reconcile read as `{lost}`. A build naming a document that does not exist always misses the revision guard, which also read as `{lost}`. The publish service would rebuild three times and then tell the founder "someone else published" (409). That is false.
3. **Two guards had no test.** Reconcile's "this build's release row exists" proof (`oursPresent`) and the `content_hash` check inside the flip guard's `EXISTS` could both be removed without any test failing.

While fixing (1) I found the same hole in two more places, and closed them too:

- The reconcile's list check compared bare version ids. With the flip guard fixed, a reused id that is live under doc_home still made the reconcile say ok, because the live list "held" the id.
- The reconcile's release-row proof and pointer check compared the release id only. A build that reused an existing release id missed the flip (thanks to the `content_hash` check), but the reconcile then saw "our" release row and said ok. Against the P2-ATOM code the new release-id case fails with `older release: reported ok`.

## Design

### Up-front build check (`buildProblems`, `argProblems`)

`commitPublishBatch` first checks the build, before any database call. A malformed build returns `{failed: true, outcome: "failed", code: "BAD_BUILD", problems: [...]}` and the client is never called. `publishStatements` throws the same error (`code: "BAD_BUILD"`), so the suite's statement-order case still works.

`buildProblems(build)` refuses:
- a build that is not an object; a missing or blank `releaseId`; a `pointer` that is not a string or null;
- no `list` that is a version 4 list (unless `canonical` is given); a `hash`, `setId` or `now` of the wrong type;
- no documents; a document without an `id`, named twice, or with a `revision` that is not a whole number (undefined, `"1"`, `1.5`); `published_version_id` or `published_hash` of the wrong type;
- a version without an `id`, `document_id` or `body_hash`, or an id used twice;
- a log row without an `id`, or an id used twice.

Then `argProblems(stmts)` checks every value the statements would send: only null, string, finite number, bigint, boolean or bytes. This catches anything the first check does not name (undefined, an object, NaN) before it can become a TypeError inside `client.batch`.

On purpose, the check does **not** refuse a null version body, a null list hash, or a log row's own fields. Those are left to the database, whose NOT NULL and CHECK refusals are the tested last line (P2-ATOM acceptance 4 and 5 still run through the real database and end `failed`, code `DB_REFUSED`).

### The flip guard counts only this build's rows

The version term of the flip is now:

```sql
(SELECT count(*) FROM document_versions
  WHERE (id = ? AND document_id = ? AND body_hash = ?) OR …) = :nv
```

A row kept by `ON CONFLICT(id) DO NOTHING` that belongs to another document, or holds another body, does not count, so the flip misses and the batch rolls back. The rest of the batch (order, abort, `ON CONFLICT(id) DO NOTHING`, the retry term) is unchanged.

### The reconcile reads more, in the same one query

`readBack` still sends one `execute`. It now also reads the live release's `content_hash`, this build's release row's `content_hash`, how many of this build's version ids exist, how many of those are this build's (same id, document and body), and which of the named documents exist (`json_group_array`).

`{ok}` now needs one of:
- the pointer is this build's release id **and** the live list hash is this build's hash;
- this build's release row exists **with this build's hash** (`oursPresent`);
- every slot this build's list gives one of its versions (`documents:<id>` or `indexes:<name>`) still holds the same `{version, hash}` in the live list. The slots come from `listSlots(list)`, a new pure helper in `release-list.js`.

Otherwise, in this order:

| Outcome | When |
|---|---|
| `{failed, code: "VERSION_ID_CLASH"}` | some version id of this build exists but belongs to another document or body |
| `{failed, code: "RELEASE_ID_CLASH"}` | the release id exists with another list hash |
| `{failed, code: "MISSING_DOCUMENT", missing}` | a document the build names is not in `documents` |
| `{failed, code: "DB_REFUSED"}` | the database refused a statement (as before) |
| `{lost, pointer, list, busy}` | none of the above: a real race, busy, or a transport failure before the commit |
| `{unknown}` | the re-read itself failed (unchanged) |

So a missing document is told apart from a revision race by the read-back: the revision guard misses in both, but only the missing document has no row.

### What P2-PUBLISH must do with the outcomes

`{failed}` now always carries a `code`. All of them mean "nothing changed"; none of them is "someone else published". Suggested mapping: `BAD_BUILD`, `VERSION_ID_CLASH`, `RELEASE_ID_CLASH` and `DB_REFUSED` → 500 "Publish failed; nothing changed" (and log it; it is our bug). `MISSING_DOCUMENT` → 404/409 "This page was deleted" (it is a real state of the store). Only `{lost}` rebuilds; only `{unknown}` answers 503.

## Acceptance, with evidence

All cases are in `scripts/test-publish.js`. "sqld" cases run on a throwaway sqld 0.24.32 through the Hrana fault proxy and HEAD's `lib/db.js`; "file" cases on a `file:` database through `lib/db.js`. "Before" means the test run against the P2-ATOM `commit.js` (`git show HEAD:lib/documents/commit.js`). The mutations (H1 to H13) were applied one at a time by `scratchpad/p2-b2/P2-HARDEN/mut/run.py`, each followed by `pnpm test:publish`, then reverted.

| # | Acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | A build reusing another document's version id never reports ok; nothing is written (sqld + file) | DONE | `✓ file: a build reusing another document's version id never reports ok, and nothing is written (P2-HARDEN)` and the same `sqld (HEAD lib/db.js)` case. Two builds: (a) doc_home's **live** version id reused for doc_footer with the very same body, (b) the same id reused for doc_home with another body. Each ends `failed`, code `VERSION_ID_CLASH`, the snapshot (pointer, row counts, documents) unchanged, no release or log row, the old version row unchanged. Before: `other document: reported ok`. Mutations H1 (count by id only), H2 (ignore `document_id`), H3 (ignore `body_hash`), H4 (reconcile list check by bare id) and H12: both cases fail |
| 2 | A malformed build (undefined revision, missing id) returns `{failed, code BAD_BUILD}` with no database call | DONE | `✓ a malformed build returns {failed, code BAD_BUILD} with no database call (P2-HARDEN)`: 18 malformed builds (undefined revision, string revision, 1.5, no document id, a document twice, no documents, no or blank release id, version without id, document_id or body_hash, version id twice, log row without id, numeric pointer, no list, NaN, an object argument, not an object) against a spy client: each `failed`/`BAD_BUILD` with problems listed and 0 calls; the good build makes 1 call. Before: `undefined revision outcome: expected "failed", got "ok"` (the spy was called). Mutations H7 (no up-front check) and H8 (no argument check): fail |
| 3 | A build naming a document missing from the documents table returns `{failed}`, not `{lost}`; a real revision race still returns `{lost}` (sqld) | DONE | `✓ sqld (HEAD lib/db.js): a build naming a document missing from the documents table fails (MISSING_DOCUMENT), not lost; a real revision race still loses (P2-HARDEN)` (also on file). `failed`, code `MISSING_DOCUMENT`, `missing: ["doc_ghost"]`, nothing written; then a revision bump on doc_home makes a second build `lost` with no code, nothing written. Before: `outcome: expected "failed", got "lost"`. Mutation H9 (drop the MISSING_DOCUMENT branch): both fail |
| 4 | Reconcile reports ok through this build's release row after a later publish replaced our document; removing `oursPresent` fails it (sqld) | DONE | `✓ sqld, reconcile reports ok through this build's release row after a later publish replaced our document (P2-HARDEN)`: commit_then_drop once on the raw no-retry client; before the reconcile, a second publish of doc_p_about commits on top. The case asserts the pointer moved on, the live list's doc_p_about is the later version (so neither the pointer nor the list proves ours), and the outcome is `ok`, reconciled, with our rows written once. Mutation H5 (remove `back.oursPresent`): this case fails (outcome `lost`) |
| 5 | Removing the `content_hash` check in the flip guard makes a named test fail (sqld) | DONE | `✓ sqld (HEAD lib/db.js): a build reusing an existing release id never reports ok (the content_hash check in the flip guard) (P2-HARDEN)` (also on file). Reusing an older release id and the live release id: each `failed`, code `RELEASE_ID_CLASH`, snapshot and the old release row unchanged. Mutation H6 (`AND content_hash = ?` → `AND ? IS NOT NULL`): both fail (the flip goes to the old release and reports ok). Mutations H10 (release-row proof without the hash), H11 (pointer check without the live hash) and H13: fail too |
| 6 | `test:publish` and the full `pnpm test` gate pass | DONE | `pnpm test:publish`: 52 passed, 0 failed (44 from P2-ATOM, unchanged and still passing, plus 8 new). `pnpm test`: 66 of 66 suites passed in 116.2 s. `pnpm build`: exit 0 |

Mutation results (each line: the mutation, then the tests that failed; every other test passed):

| Mutation | Failed tests |
|---|---|
| H1 flip guard counts version rows by id only | version-id reuse (file, sqld) |
| H2 flip guard ignores `document_id` | version-id reuse (file, sqld) |
| H3 flip guard ignores `body_hash` | version-id reuse (file, sqld) |
| H4 reconcile list check by bare id (the P2-ATOM rule) | version-id reuse (file, sqld) |
| H5 reconcile without `oursPresent` | release-row reconcile (sqld) |
| H6 flip guard without `content_hash` | release-id reuse (file, sqld) |
| H7 no up-front build check | BAD_BUILD |
| H8 no argument check | BAD_BUILD |
| H9 no MISSING_DOCUMENT branch | missing document (file, sqld) |
| H10 `oursPresent` without the hash | release-id reuse (file, sqld) |
| H11 pointer check without the live hash | release-id reuse (file, sqld) |
| H12 no VERSION_ID_CLASH code | version-id reuse (file, sqld) |
| H13 no RELEASE_ID_CLASH code | release-id reuse (file, sqld) |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish` | 52 passed, 0 failed | about 5 s (sqld part 4.6 s), far under the 2-minute limit |
| `pnpm test` (whole gate) | 66 of 66 suites passed | 116.2 s |
| `pnpm build` | passes (exit 0) | |

Every sqld and proxy the suite started was stopped (no `sqld` process left after the runs). No dev server ran.

## Known limits

- **Null bodies, a null list hash and bad log fields are still left to the database** (code `DB_REFUSED`), on purpose, so the database's NOT NULL refusal stays tested through the real batch.
- **The check does not prove the build is coherent**: that `list` names exactly the build's versions, that `documents[].published_version_id` matches, or that slugs are unique against the journal index. That stays with the service that makes the build (P2-PUBLISH), as P2-ATOM recorded.
- **A clash code is reported only after the batch was tried.** The flip guard makes the batch roll back; the read-back then names the clash. One extra round trip, only on failure.
- **The guard and the read-back grow with the number of versions** (one `OR` term with 3 values each). SQLite's 32,766-value limit allows about 10,000 versions in one publish; a publish set is a handful.
- **A version that has no slot in the build's list** (not expected today) cannot be proven by the list check; the reconcile then relies on the pointer or the release row.
- **`{lost}` after a transport error is still not proof that the batch will never commit** (from the P2-ATOM review): if the client gives up while sqld waits on a lock, the read-back can see nothing, and the batch can commit afterwards. The rebuild then loses once more and republishes on top. Duplicate rows, no lost data.
- **P2-PLAN.md section 1 still names three outcomes.** `{failed}` and its codes are a contract change P2-PUBLISH depends on. The plan is not in this item's files; the orchestrator should update it.

### From review

Non-blocking findings from the independent review, added at merge.

- The version guard checks id, document_id and body_hash, but not kind. Probe on a file: database: an existing kind='checkpoint' row for doc_home (same id, same body) is named in a build as a 'published' version. The outcome is ok, the row stays kind='checkpoint', and the live list points at it. The DELETE trigger allows deleting checkpoints, so `DELETE FROM document_versions WHERE id = <it>` went through and left the live list pointing at a row that no longer exists. A reused id is a caller bug, and pruning is meant to skip versions a release references (DOC-08), so this does not block. Before restore-then-publish lands, P2-PUBLISH should always mint a new published row and never reuse a checkpoint id. Alternatively, the guard and read-back can also match `kind = v.kind`, or refuse kind 'checkpoint'.
- `oursPresent` ("this build's release row exists with this hash, so the batch committed") only holds if a release row is never written before its flip. Today that holds: v4 release rollback is refused, and schedules build a fresh release when they fire (spec, PUB-07). If a later item ever pre-inserts a release row, for example for a scheduled or approved release, and then flips it with the same id, a lost revision race would wrongly reconcile as ok. Worth one line under Known limits, and a rule for P2-PUBLISH and the schedule work: release ids are always fresh.
- A mutation survived: removing `slots.length > 0 &&` in liveListHoldsMine (a version with no slot in the build's list then counts as proven) did not fail any test, 52/52 still pass. It only matters for a build whose versions have no list slot, which the packet already lists as a known limit. A small unit test of liveListHoldsMine (it is exported in __commitInternals) would pin it.
- prepare() still throws, rather than returning an outcome, when an error is not BAD_BUILD (for example listCanonical or sha256Hex throwing). This was also true before the change. P2-PUBLISH should wrap commitPublishBatch in a try and treat a throw as failed, never as lost.
- The contract changed: {failed} now carries five codes. P2-PLAN.md section 1 / decision 2 still lists three outcomes, so the orchestrator should update it before P2-PUBLISH, as the builder noted. The suggested reply for MISSING_DOCUMENT ('404/409 This page was deleted') needs a decision. A 409 there would look like the 'someone else published' message this item was meant to stop.
- test:publish picks system-chosen free ports for sqld and the proxy, so this review could not keep them to 4640-4649. They did not clash with anything, and the suite cleans up after itself.
- Reproduced: test:publish 52 passed, 0 failed, in 4.9 s. Full `pnpm test` 66/66 passed in 119.1 s, run after an offline frozen-lockfile install in the review worktree. Against the 319a20f commit.js, all 7 new tests fail: BAD_BUILD, version-id reuse (file and sqld), release-id reuse (file and sqld), missing document (file and sqld). My own mutations, one at a time, were each caught by a named test: list check without hash, pointer check without the live hash, oursPresent without the hash, oursPresent removed, guard counting by id only, content_hash removed from the guard, no MISSING_DOCUMENT branch, versionClash forced false, versionClash using >= (12 tests fail), no RELEASE_ID_CLASH branch, revision check removed, BAD_BUILD thrown instead of returned. The diff only touches commit.js, release-list.js (one pure helper, no new imports), test-publish.js and the docs. No node: imports were added, and nothing in the app calls commitPublishBatch, so legacy tenants, existing releases, editors and preview are unaffected. pnpm build was not re-run because no app import changed. Review worktree and mutation copy removed, and none of my sqld processes are left running.

## Owner checks

1. **CI sqld install** (unchanged from P2-ATOM owner check 1). `.github/` was not touched. `test:publish` needs sqld; CI fails on it until the pinned, checksum-verified step is approved and added.
2. **Hosted Turso** on a staging tenant: repeat P2-ATOM owner check 2, and once publish a build that reuses a version id of another document (for example through a scratch script) and confirm it ends `failed` with nothing written.
3. **Plan contract:** confirm the `{failed}` codes and the suggested status mapping above before P2-PUBLISH builds on them, and have P2-PLAN.md decision 2 updated.
