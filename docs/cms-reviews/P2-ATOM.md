# P2 · ATOM · The atomic document-release commit, proven first

Branch `cms/p2-atom`, cut from `4992670`. Plan: `docs/cms-reviews/P2-PLAN.md` (decisions 1, 2, 3, 10, 11, 14; batch 1). Spec: `docs/CMS_FULL_BUILD_SPEC.md` 8.2, 8.3, 8.4, 8.6. Requirements: DOC-01, PUB-01, and the batch part of PUB-02. Migration: `migrations/tenant/0021_documents.sql`.

Nothing in the app calls the new code yet. No tenant changes mode: every tenant, old or new, gets `cms_state.mode = 'legacy'`. Nothing outside the test suite writes a version 4 release row. Today's releases, editors and preview are untouched.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:publish` 44 passed, 0 failed, in about 5 seconds (the sqld part about 4.6 seconds). Whole gate `pnpm test`: 66 of 66 suites passed in 114.7 s. `pnpm build` passes |
| Browser verified | Not applicable. Nothing a shopper or founder sees changed, and nothing calls the new code. No dev server ran |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. See owner checks |
| Production enabled | **NOT DONE.** Nothing pushed, deployed or migrated. Migration 0021 ran only on throwaway local databases |

## What and why

Every later phase 2 item (the document service, the v4 reader, Publish, preview) depends on one thing being true: a publish writes its version rows, its release row, the pointer flip, the log and the documents' published fields **all together or not at all**, also when the network drops the answer after the database has committed, and also when HEAD's `lib/db.js` resends the batch. This item builds that commit and proves it on a real sqld before anything else is built on it.

## Design

### Migration 0021 (`migrations/tenant/0021_documents.sql`)

Only `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS` and one `INSERT OR IGNORE`, so it is safe to run twice.

- `documents`, `document_versions`, `publish_log`, `cms_state`, column for column as in spec 8.2.
- Indexes: `documents_slug` (UNIQUE on `slug` WHERE `slug IS NOT NULL AND archived_at IS NULL`), `documents_entity`, `documents_dirty`, `document_versions_doc`, `publish_log_doc`.
- Triggers: `document_versions_frozen` (BEFORE UPDATE → `RAISE(ABORT,'versions are frozen')`) and `document_versions_kept` (BEFORE DELETE WHEN `OLD.kind <> 'checkpoint'` → `RAISE(ABORT,'only checkpoint versions can be deleted')`).
- `cms_state` has `CHECK (id = 1)` and is seeded `(1, 'legacy', NULL, <now>)`.
- Not created, on purpose: `document_refs`, `document_schedules`, `product_content_live`, `collection_content_live`, `search_outbox`, `preview_sessions`. A suite case checks this.

### Ids (`lib/documents/ids.js`, edge-safe, Web Crypto only)

- `verId()`, `relId()`, `logId()`, `setId()`: prefix plus 16 random hex. A build mints them **once**, so a resent batch carries the same ids and `ON CONFLICT(id) DO NOTHING` absorbs the repeat.
- `singletonId(type)`: `doc_<type>`.
- `newRouteId()`: `doc_` plus 16 random base32 characters (80 bits), for page, campaign and journal documents made in the editor.
- `backfillRouteId(type, slug)`: `doc_p_` plus the first 16 hex of `sha256("route:" + slug)`. For MIG-01 only. The type is checked (page, campaign or journal) but not hashed, because `cms_pages` keys pages by slug across families, so a page whose family changes between two backfill runs keeps its id.

### The release list (`lib/documents/release-list.js`, pure and edge-safe)

- `emptyList(m, singletonTypes)`: `{v:4, m, documents:{doc_<t>: null …}, pages:[], redirects:[], indexes:{journal:null}}`. The singleton list is an argument, so this module does not depend on the registry (P2-REG passes it in).
- `setEntries(prevList, changes, {m})`: returns a new list. Only the entries, page rows and redirects **owned by** the documents in `changes` are replaced (or removed with `{remove:true}`); every other entry, including the explicit nulls, is kept. An entry keeps only `{version, hash}`, so nothing else can ride into the list. Pages and redirects are sorted, so the same content always hashes the same. The manifest number can't go down.
- `journalIndexBody(posts)`: entries carry `slug, title, description, enabled, family, effective_at, window_start, window_end` (plus `document` and `version`), sorted by slug. The list itself only holds the index's `{version, hash}`, so its size does not grow with posts.
- `listCanonical` / `listHash`: `stableStringify` and `sha256Hex` from `lib/releases.js` (imported; `lib/releases.js` is not changed).

### The commit (`lib/documents/commit.js`, Node console routes only)

`commitPublishBatch(build, {client})` sends ONE `client.batch(stmts, "write")`, in this order:

1. `INSERT INTO document_versions … ON CONFLICT(id) DO NOTHING`, one per version.
2. `INSERT INTO releases (… published_at NULL) … ON CONFLICT(id) DO NOTHING`.
3. The guarded flip: `UPDATE release_state SET live_release_id=:new, updated_at=:now WHERE id=1 AND (live_release_id IS :L OR live_release_id=:new) AND EXISTS(SELECT 1 FROM releases WHERE id=:new AND content_hash=:h) AND (SELECT count(*) FROM document_versions WHERE id IN (…))=:nv AND (SELECT revision FROM documents WHERE id=:d)=:rev` (one revision term per document).
4. The abort: `INSERT INTO release_state (id) SELECT 2 WHERE changes()=0`. `release_state` has `CHECK (id = 1)`, so when the flip matched nothing this insert fails and the whole batch rolls back (the GEN-02 pattern from `lib/sync.js`).
5. `UPDATE releases SET published_at=:now WHERE id=:new AND published_at IS NULL`.
6. `INSERT INTO publish_log … ON CONFLICT(id) DO NOTHING`, one per log row.
7. `UPDATE documents SET published_version_id, published_hash WHERE id=:d`.

Never `INSERT OR IGNORE` (it would also swallow NOT NULL and CHECK failures, so a broken row would be skipped while the pointer flips), and never `transaction()`.

**Reconcile.** On any thrown error, it re-reads the pointer, the live list, and whether this build's release row exists, in one query:

| Outcome | When |
|---|---|
| `{ok, reconciled:true}` | The pointer is `:new`, or the live list holds all of this build's version ids, or this build's release row exists. The release row is only ever written in the same batch as the flip, so its presence proves the batch committed, even if a later publish has already moved the pointer on. |
| `{lost, pointer, list, busy}` | None of the above, and the error was the guard's abort, `SQLITE_BUSY` / "database is locked" (`busy: true`), or a transport failure before the commit. Rebuilding from `{pointer, list}` is safe. |
| `{failed}` | None of the above, and the database refused a statement for another reason (NOT NULL, CHECK, a missing table, the frozen-version triggers). See "One addition to the plan" below. |
| `{unknown, cause, readError}` | The re-read itself threw. The publish may or may not be live. The caller must say so and must not rebuild. |

**One addition to the plan: `{failed}`.** The plan names three outcomes. A null body or a null hash is not a race: nothing was written, and rebuilding would fail the same way. Reporting it as `{lost}` would make P2-PUBLISH rebuild three times and then answer 409 "someone else published", which is false. So a statement the database refused is `{failed}`. The guard's own abort (a CHECK failure on `release_state` `id = 1`) is recognised first and stays `{lost}`. P2-PUBLISH should map `{failed}` to a 500 with a plain "Publish failed; nothing changed" message.

### The Hrana fault proxy (`scripts/support/hrana-fault-proxy.js`)

A byte-forwarding HTTP proxy in front of one sqld, modelled on `scripts/perf-dbcount.js` (not edited). Only `/v2/pipeline` and `/v3/pipeline` requests are counted or faulted; the version probe and every other path always pass. Modes:

- `pass()`.
- `dropBefore(n, match)`: destroys the client socket without forwarding.
- `commitThenDrop(n, match)`: forwards, waits for sqld's full answer, then destroys the client socket before writing a byte. The client sees "fetch failed", which HEAD's `isTransient()` retries.
- `hold(match)` with `release(needle)` and `waitHeld(n)`: queues requests to order them.

`match` is `"batch"` (pipelines that carry a batch) or `"any"`. `n` may be `Infinity`. Counters: `pipelines, batches, executes, other, dropped, committedThenDropped, held, forwarded, upstreamErrors`. It can listen on port 0 and reports its real `url`.

### The scaffold (plan decision 14)

`package.json` gains `test:publish`, `test:registry-contract`, `test:documents`, `test:release-readers`, `test:publish-service`, `test:writers`, `test:preview-overlay`, `test:sections-render` and `test:perf-docs`, each exactly `node scripts/<file>.js`. All but `test-publish.js` are placeholders that print `pending: owned by cms/p2-<id>` and exit 0. No later item edits `package.json`.

### Export (`lib/platform/export.js`)

`EXPORT_TABLES` gains `documents`, `document_versions`, `publish_log`, `cms_state`. The existing loop already records a table that is missing as `null` in the manifest, so a tenant at 0020 still exports.

## Acceptance, with evidence

All cases are in `scripts/test-publish.js`. "sqld" cases ran against a throwaway sqld 0.24.32 started by the suite on a free port (via `findSqld`/`startSqld` from `scripts/design-harness.js`), through the fault proxy, with the tenant's `dbUrl` pointed at the proxy so traffic went through HEAD's `lib/db.js`. "Mutation" names the change I made to prove the test fails without the code (run with `scratchpad/p2-b1/P2-ATOM/mut/run.py`, then reverted).

| # | Acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | One `commitPublishBatch` writes version rows, release row, flip, `published_at`, log rows and `documents.published_*` together; the pointer then reads `:new` (sqld + file) | DONE | `✓ file: one commitPublishBatch writes …` and `✓ sqld (HEAD lib/db.js): one commitPublishBatch writes …`. Mutation M12 (drop the `published_at` stamp): both fail |
| 2 | A guard that misses because the pointer moved leaves zero new rows in versions, releases and log, documents and pointer unchanged (proves `changes()=0` aborts across Hrana steps) (sqld) | DONE | `✓ sqld (HEAD lib/db.js): a guard miss because the pointer moved writes nothing …` (also on file). Mutation M1 (remove the abort statement): both fail |
| 3 | A `documents.revision` bumped between build and commit makes the batch lose, nothing written (sqld) | DONE | `✓ sqld (HEAD lib/db.js): a documents.revision bumped …` (also on file). Mutation M5 (drop the revision guard): both fail |
| 4 | A version with a null body, or a release with a null `content_hash`, makes the batch fail, nothing written, pointer unchanged (sqld + file) | DONE | `✓ … a version with a null body fails loudly …` and `✓ … a release with a null content_hash fails loudly …`, on both. Outcome `failed`, cause names NOT NULL. Mutation M2 (versions `INSERT OR IGNORE`): the null-body cases fail |
| 5 | A statement failing late in the batch rolls back the earlier INSERTs (sqld) | DONE | `✓ sqld (HEAD lib/db.js): a statement failing late in the batch (a log row after the flip) rolls back …` (also file). The case asserts the failing log row comes after the flip, and that the flip was undone too |
| 6 | Proxy `commit_then_drop` once, HEAD `lib/db.js`: ok; 2 batch pipeline requests; exactly one version, release and log row (sqld) | DONE | `✓ sqld, commit_then_drop once, HEAD lib/db.js: …` asserts `batches == 2`, `committedThenDropped == 1`, `reconciled == false` (the resent batch itself succeeded) and single rows. Mutation M3 (remove `OR live_release_id = :new`): fails |
| 7 | `commit_then_drop` on every attempt, and on the raw no-retry client: the error surfaces, reconcile reads the pointer and reports ok (sqld) | DONE | `✓ sqld, commit_then_drop on every attempt, HEAD lib/db.js …` (4 batch requests, cause "fetch failed", `reconciled: true`, single rows) and `✓ sqld, commit_then_drop once, raw no-retry client …` (1 batch request). Mutation M6 (reconcile never reads): both fail |
| 8 | `drop_before`: the retried batch succeeds once, with single rows (sqld) | DONE | `✓ sqld, drop_before once, HEAD lib/db.js …` (1 dropped, 2 batch requests). Also `✓ sqld, drop_before once, raw no-retry client: … lost with nothing written` |
| 9 | When the reconcile re-read also fails (proxy drops everything), the result is `{unknown}`, never `{lost}` | DONE | `✓ sqld, the proxy drops everything (raw no-retry client) …` and `(HEAD lib/db.js) …`. Mutation M7 (read failure reported as lost): both fail |
| 10 | Busy case: a batch sent while a second connection holds a write transaction ends ok or lost, never partial (sqld) | DONE | `✓ sqld busy case …`. In every run so far sqld waited for the lock, then the guard missed (the holder had moved the pointer), so it ended `lost` with no rows. If it ever ends `ok`, the case asserts every row is there. `SQLITE_BUSY` / "database is locked" classification is also covered by `✓ file: SQLITE_BUSY or 'database is locked' … is lost (busy), never ok` |
| 11 | Hold: two builds from one pointer for different documents; first commits, second `{lost}` with nothing persisted; a rebuild from the new list commits and both entries are live (sqld) | DONE | `✓ sqld, hold: two builds from one pointer …`: both batches are held at the proxy at the same time, released in order. Mutation M11 (`setEntries` drops other documents' pages): fails |
| 12 | UPDATE on `document_versions` raises; DELETE of a non-checkpoint raises; DELETE of a checkpoint succeeds | DONE | `✓ file: UPDATE on document_versions raises …` and the sqld one. Mutation M8 (trigger body `SELECT 1`): both fail |
| 13 | `documents_slug` refuses a second live draft at one slug, allows the slug of an archived document | DONE | `✓ file: documents_slug refuses …` and the sqld one. Mutation M9 (index without `archived_at IS NULL`): both fail |
| 14 | Pure: `emptyList(m)` holds null for every singleton passed in; `setEntries` keeps those nulls and replaces only the set's entries, pages and redirects; `listHash` is stableStringify + sha256Hex; same byte size with 0 and 1,000 journal posts | DONE | `✓ emptyList(m) holds an explicit null …`, `✓ setEntries keeps the nulls …`, `✓ listHash is sha256Hex(stableStringify(list)) …`, `✓ the list's byte size is the same with 0 and 1,000 journal posts …`. Mutations M10 (no singleton nulls) and M11: fail |
| 15 | Pure: `newRouteId` never repeats in 10,000 calls; `backfillRouteId` is deterministic | DONE | `✓ newRouteId: … no repeat in 10,000 calls`, `✓ backfillRouteId is deterministic …` (pinned to `sha256("route:"+slug)`, so a change to the hashing fails it) |
| 16 | Tenant export includes the four new tables; an export of a tenant at 0020 still succeeds | DONE | `✓ tenant export includes documents, document_versions, publish_log and cms_state; a tenant at 0020 still exports`. Without the `export.js` change it failed: `documents: expected 1, got undefined` (seen on the first run of the suite) |
| 17 | Existing v3 release rows and the pointer are untouched by a failed v4 batch; `tenant-migrate --check` passes with 0021; the full gate is green (57 + 9 suites) | DONE (with a note) | `✓ … existing v3 release rows and the pointer are untouched by a failed v4 batch` (file and sqld). `✓ cms_state is seeded 'legacy' …; tenant-migrate --check's ledger check is current with 0021` runs `checkLedger` (the function behind `--check`) on a database migrated with 0021 (current) and one at 0020 (missing exactly `0021_documents`). The real `pnpm tenant:migrate -- --check` reads `.env.local` and real tenants, so it was not run (owner check DR-3). `test:schema-compat` also passed, and it runs `tenant-migrate.js --check` against local tenants with the newest migration, now 0021. Gate: see Test results |

Also proven, beyond the list:
- `✓ the publish statements are in the planned order and never use INSERT OR IGNORE`, and `commit.js` has no `.transaction(`.
- `✓ 0021 is additive …`: every CREATE has IF NOT EXISTS, every INSERT is OR IGNORE, no DROP/ALTER, none of the later tables, and re-running 0021 on a tenant leaves `cms_state` as it was.
- `✓ ids.js and release-list.js are edge-safe: no node: imports, no process, no Buffer`.
- `✓ sqld: the proxy forwards the version probe untouched and counts only pipeline requests`.
- `✓ sqld, the pointer moved on after our commit and before the reconcile: still ok, rows written once`.

The version-count term of the flip (`count(*) … = :nv`) is defence in depth: with `ON CONFLICT(id) DO NOTHING` a version row can only be missing if its insert raised, which already fails the batch. No test can remove it alone and see a wrong result. With it removed **and** the versions insert changed to `INSERT OR IGNORE`, the null-body cases fail (the statement-shape case also catches `OR IGNORE`).

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:publish` | 44 passed, 0 failed | about 5.0 s (sqld part 4.6 s), far under the 2-minute suite limit |
| the 8 placeholders | each prints `pending: owned by cms/p2-<id>`, exit 0 | under 0.1 s each |
| `pnpm test` (whole gate) | 66 of 66 suites passed (57 existing plus 9 new), including `test:schema-compat` | 114.7 s |
| `pnpm build` | passes (exit 0) | |

## Known limits

- **Restoring an export of a documents-mode tenant is not verified** (DOC-12). The export side is tested; the restore side waits.
- **Hosted Turso atomicity is not proven.** Everything here ran on local sqld 0.24.32 and on `file:`. Turso's hosted service is the same server family, but this is an owner check.
- **`test:publish` needs sqld and fails without it.** CI has no sqld yet (see owner checks), so once this repo is pushed, the CI gate fails on `test:publish` until the sqld step is approved and added. This is deliberate: the suite never skips.
- **The busy case in practice ends `lost` through the guard**, because sqld waits for the lock rather than answering `SQLITE_BUSY` at once. A real `SQLITE_BUSY` answer is covered by the classification case with a stub client, not by sqld.
- **`{failed}` is a fourth outcome** the plan did not name (see Design). P2-PUBLISH needs to handle it.
- `backfillRouteId` ids (`doc_p_<16 hex>`) differ in shape from editor-made ids (`doc_<16 base32>`). Both start with `doc_`, and the two can't collide (`_` is not a base32 character).
- `commitPublishBatch` trusts its build: it does not check that `list` and `versions` agree, or that slugs are unique across the list and the journal index. Those belong to the service that makes the build (P2-PUBLISH).

## Owner checks

1. **CI sqld install (needs your approval of source and checksum before anyone adds it).** `.github/` was not touched. The step to add to `.github/workflows/test.yml`, after `pnpm install` and before `pnpm test`:

   ```yaml
         - name: Install sqld (libsql-server), pinned and checksum-verified
           env:
             SQLD_VERSION: "0.24.32"
             SQLD_SHA256: "<sha256 of the asset below, filled in by the owner>"
           run: |
             set -euo pipefail
             asset="libsql-server-x86_64-unknown-linux-gnu.tar.xz"
             url="https://github.com/tursodatabase/libsql/releases/download/libsql-server-v${SQLD_VERSION}/${asset}"
             curl -fsSL --retry 3 -o "/tmp/${asset}" "$url"
             echo "${SQLD_SHA256}  /tmp/${asset}" | sha256sum -c -
             mkdir -p "$HOME/.local/sqld"
             tar -xJf "/tmp/${asset}" -C "$HOME/.local/sqld" --strip-components=1
             echo "SQLD_BIN=$HOME/.local/sqld/sqld" >> "$GITHUB_ENV"
             "$HOME/.local/sqld/sqld" --version
   ```

   What to check: that `tursodatabase/libsql` release `libsql-server-v0.24.32` (the version this suite ran against locally, built 2025-02-14) is the source you want; that the asset name and archive layout match (adjust `--strip-components` if the binary is at the top level); and the SHA-256 you compute yourself from the downloaded asset (`shasum -a 256 libsql-server-x86_64-unknown-linux-gnu.tar.xz`). `findSqld` reads `SQLD_BIN` first.
2. **Hosted Turso** on a staging tenant: one publish; two concurrent publishes; a publish while another connection holds `BEGIN IMMEDIATE`; a lost answer after commit (the retry must report ok with single rows); and replica read consistency right after a publish.
3. **DR-3:** run `pnpm tenant:migrate -- --all` and then `-- --check` so 0021 is on every tenant before the code that needs it deploys. 0021 seeds every tenant `legacy`; nothing reads it yet.
4. **Restoring an export** of a documents-mode tenant (DOC-12, the restore side).
