# P4 · SCAFFOLD · The ground for phase 4

Branch `cms/p4-scaffold`, cut from `f64421e`. Plan: `docs/cms-reviews/P4-PLAN.md` (decisions 2 and 4, sections 3 to 5; batch 0) and `P4-BATCHES.json`. Requirements it prepares: OVL-02, MIG-01, MIG-05, MIG-03. It proves none of them end to end. It gives later items the pinned tables, the deterministic ids, the editor's product and collection addresses, a file-database tenant fixture, the env-store check, and the registered suites and operator commands.

Migration owned: `0024_content_live.sql`.

No tenant changes behaviour. Nothing in the app reads the new tables or imports the new helpers yet (checked with `grep -rn` over `app/ lib/ components/`: the only hits are the migration itself and the helpers' own files). Today's releases, editors and preview are untouched. No P3-FIX5 file was edited.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 138.0 s (81 before, plus 15 placeholders); no unregistered `scripts/test-*.js`. `test:schema-compat` 42 passed in about 4 s; `test:editor-routes` 31 passed in 0.5 s; `test:publish` 72 passed in 6 s. `pnpm build` passes |
| Browser verified | Not applicable. Nothing a shopper or founder sees changed. The new URL helpers are not wired into any page yet (EDITOR and ED05 do that). No dev server ran; ports 6100 and 7100 to 7109 were not used |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. Applying 0024 to real tenants and the env store is an owner step (below) |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

Phase 4 has 19 items over 8 batches. Before batch 1 is cut, the things several items share must exist once, in one place:

1. **The live tables (decision 2).** LIVEROW, EFFECTIVE, SEARCH, CUTOVER and REVERSE all read or write them. Pinning the DDL now means no two items race to change it.
2. **Deterministic content document ids (decision 4).** MAPPER, LIVEROW and CUTOVER must agree on a product's document id without a lookup.
3. **Editability (R2 fix).** MAPPER and CUTOVER need "does this type have an editor" and the cart ruling before LIVEROW's service changes exist.
4. **The URL contract (section 4).** EDITOR and ED05 build and parse `/admin/editor?product=` and `?collection=` with one pair of helpers.
5. **A file-database tenant fixture.** Every phase 4 suite and CLI test needs tenants at a given migration stage with real synced products, and must never reach a hosted database.
6. **MIG-05 for the env store.** `--check` read only the registered tenants. The `_default` env store also runs tenant migrations and was never checked.
7. **The suites and operator commands.** `package.json` is SCAFFOLD's only, so all 15 suites and the 4 runbook commands are registered now.

## Design

### (1) `migrations/tenant/0024_content_live.sql`

`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` only. Columns, types, NOT NULL and keys exactly as the brief pins them:

- `product_content_live`: the 20 spec 8.2 columns, in spec order, then `pairs_title TEXT` and `layout_template TEXT`. Index `product_content_live_document(document_id)`.
- `collection_content_live`: the 6 spec columns, then `layout_template TEXT`.
- `search_outbox`: the 5 spec columns, and the partial index `search_outbox_pending ON search_outbox(created_at) WHERE done_at IS NULL`.
- `cms_migration_runs`: the run lock and resumable state, `kind` CHECKed to `cutover` or `reverse`.
- `content_live_reversed`: MIG-04's copy-aside, primary key `(run_id, kind, entity_id)`.

The file header says the DDL is pinned and that any later column need is a new `0026_*` file with a named owner. `migrations/README.md` gains the owner step for 0023, 0024 and 0025.

### (2) `lib/documents/ids.js`

`productDocumentId(productId)` gives `doc_prod_` plus the first 16 hex characters of SHA-256(productId); `collectionDocumentId` gives `doc_coll_` the same way. Both go through one Web Crypto helper, `sha256Hex16`, which `backfillRouteId` now uses too (its output is unchanged, and the test checks that against `node:crypto`). They are **async** and return a Promise; the JSDoc says so. An empty or non-string id is refused (the Promise rejects). Nothing calls them yet.

### (3) `lib/registry/editability.js` (new, pure)

- `typeHasEditor(typeName)`: true when the registry type exists, is editable and is not a system type. Today that is every type except `journal_index`, and unknown names are false.
- `cartEditable()` returns the constant `CART_EDITABLE = true`, the plan's OQ-6 default.

It imports only `lib/registry/index.js`. It has no database, request or `node:` import. `lib/documents/service.js` still refuses cart writes (`refuseCart`) until LIVEROW makes it match.

### (4) `lib/admin/editor-entry.js`

- `entityEditorHref({product})` gives `/admin/editor?product=<encoded gid>`, and `{collection}` gives `?collection=`. Anything else gives the bare `/admin/editor`: nothing given, both given, or a value that is not a Shopify gid of that kind.
- `parseEditorTarget(searchParams)` accepts a `URLSearchParams` or Next's plain `searchParams` object (string or string array). The first key present wins, in the order `doc`, `product`, `collection`. When the winning key's value is bad the answer is `{}`; it never falls through to the next key. It returns `{doc}`, `{product}`, `{collection}` or `{}`.
- What counts as valid:
  - a doc id matches `^doc_[a-z0-9_]{1,80}$`;
  - a gid is `gid://shopify/Product/<tail>` or `gid://shopify/Collection/<tail>`, where the tail is 1 to 64 URL-safe characters. Fixtures use words like `orphan`, so the tail is not limited to digits.
- `isProductGid` and `isCollectionGid` are exported for ED05 and EDITOR.

`LEGACY_ROUTE_DOCS` is unchanged (ED05 owns it), and the test pins its 8 entries.

### (5) `scripts/support/tenant-fixture.js`

This is an exported helper, not a suite.

- `assertLocalDbUrl` accepts only `file:` URLs. It refuses `libsql://`, `https://`, `ws://`, `http://127.0.0.1` (a sqld), `file://host/…` and bare paths.
- `makePlatform({name})` creates and migrates `.test-<name>-platform.db` and points `PLATFORM_DB_URL` at it.
- `makeTenant({name, stage, products, id, config, secrets})`:
  - creates `.test-<name>-tenant.db` at the repo root;
  - migrates it with `runMigrations(client, MIGRATIONS.filter(…))`, the same call `test-schema-compat` makes. The filter compares the 4-digit number, because the string `"0023_document_refs" <= "0023"` is false;
  - seeds products with `lib/sync.js` `writeProduct(p, syncedAt, null)` inside `withTenant`;
  - registers the tenant when `makePlatform` ran, and otherwise returns an unregistered tenant object.
- Stages are `0017`, `0020`, `0022`, `0023`, `0024` and `latest`. An unknown stage is refused before any file is made.
- It returns `run`, `client`, `migrateTo`, `cleanup` and the products it wrote. `fixtureProduct(i, over)` builds one Shopify-shaped product.
- Existing suites are not moved onto it.

### (6) `scripts/test-schema-compat.js`, new part 7

- Adds the pins `BEFORE_CONTENT_LIVE = "0023_document_refs"` and `CONTENT_LIVE = "0024_content_live"`.
- Builds a fixture tenant at 0023 and migrates it to 0024.
- Checks every column of the five tables with `PRAGMA table_info` against the pinned list, as `[name, type, notnull, pk]`.
- Checks both indexes and their columns. `search_outbox_pending` must be partial on `done_at IS NULL` and must be used by the pending read (EXPLAIN QUERY PLAN).
- Checks the `kind` CHECK and the copy-aside key.
- Runs the 0024 file twice more and the runner once more, and the schema must not change.
- The 0024 file contains nothing but `CREATE … IF NOT EXISTS`.
- `latest` and every other stage are covered by the fixture case.

### (7) `scripts/tenant-migrate.js --check --include-env`

`--include-env` (with `--check` only) also reads the env store's ledger. That is the database `lib/db.js` uses with no tenant: `TURSO_DB_URL || DATABASE_URL || file:local.db`, with the same token variables. It writes nothing.

What it prints:
- `✓ the env store (_default): current, …` when the env store holds every migration;
- `✗ … behind, missing … Run pnpm migrate.` when it doesn't;
- the summary counts the env store as one more store.

`--include-env` without `--check` is refused, because `--all` never migrated the env store (`pnpm migrate` does). Without the flag, the CLI's code path and output are byte-for-byte what they were, and it never opens the env database.

### (8) `package.json`, placeholders and stubs

The 15 suites, each exactly `node scripts/test-<x>.js`. Each placeholder prints `placeholder, owned by P4-<ID>` and exits 0:

| Suite | Owner |
|---|---|
| `test:legacy-write-guard` | P4-GUARD |
| `test:media-refs` | P4-MEDIA |
| `test:legacy-fixtures` | P4-FIXTURES |
| `test:content-seam` | P4-SEAM |
| `test:effective-read` | P4-EFFECTIVE |
| `test:product-content` | P4-LIVEROW |
| `test:migrate-map` | P4-MAPPER |
| `test:search-effective` | P4-SEARCH |
| `test:entity-content` | P4-OVL07 |
| `test:media-picker` | P4-PICKER |
| `test:product-editor` | P4-EDITOR |
| `test:legacy-routes` | P4-ED05 |
| `test:migrate-render` | P4-EQUIV |
| `test:migrate-documents` | P4-CUTOVER |
| `test:migrate-reverse` | P4-REVERSE |

The operator commands and their stubs. Each stub prints `not built yet (P4-<owner>)` to stderr and exits 1:

| Command | File | Replaced by |
|---|---|---|
| `migrate:documents` | `scripts/migrate-documents.js` | P4-MAPPER (then CUTOVER) |
| `reverse:documents` | `scripts/reverse-documents.js` | P4-REVERSE |
| `media:reindex` | `scripts/reindex-document-refs.js` | P4-MEDIA |
| `drill:p4` | `scripts/drills/p4/run.mjs` | P4-HARNESS (then DRILLS) |

The operator commands carry no `--env-file`. A stub needs no env, and the builder rule is file databases only. If CUTOVER's real command needs `.env.local` for the owner's hosted run, record it as a Known limit for the orchestrator, because `package.json` is SCAFFOLD's.

## Acceptance, with evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm test` passes with 96 gated suites (81 + 15) and no unregistered `scripts/test-*.js` | **DONE** | `pnpm test`: "96 of 96 suites passed in 138.0s"; run-tests exits 1 on an unregistered file, and it did not. The schema-compat case "the operator commands are registered … the 15 suites are registered" pins all 15 entries |
| 2 | A tenant at 0023 then 0024 has the five tables, exact columns, both indexes; 0024 re-runs | **DONE** | `test-schema-compat` cases "the fixture builds a tenant at 0023_document_refs with no content live tables…" and "a tenant migrated to 0023_document_refs then 0024_content_live has every pinned table, column and index; running 0024 again succeeds". Both fail without the 0024 file (checked by removing it: 4 cases fail) |
| 3 | `await productDocumentId(x)` is deterministic, `/^doc_prod_[0-9a-f]{16}$/`, differs per id; `collectionDocumentId` the same with `doc_coll_` | **DONE** | `test-editor-routes` "P4-SCAFFOLD unit: productDocumentId and collectionDocumentId are async, deterministic, shaped and differ per id". It also checks that both return a Promise, that the hash equals SHA-256 from `node:crypto`, that bad input is refused, and that `backfillRouteId` is unchanged. It fails with HEAD's `ids.js` |
| 4 | `entityEditorHref` and `parseEditorTarget` round-trip product and collection gids, encode them, `{}` for junk | **DONE** | `test-editor-routes`: "…round-trip product and collection gids, encoded" (through `URLSearchParams`, a plain object and an array value) and "one key wins … junk gives {} …" (21 junk inputs, 10 junk hrefs). Both fail with HEAD's `editor-entry.js` |
| 5 | The fixture refuses `libsql://` and builds tenants at 0023, 0024 and latest whose products were written by `writeProduct` inside `withTenant` | **DONE** | `test-schema-compat` "the tenant fixture refuses non-file URLs and builds tenants at every stage…". It runs all six stages, checks the ledger size and newest id, the product, image and variant rows exactly as `writeProduct` writes them, a read through `withTenant` + `lib/db.js`, and that the env store got no fixture products. "…makePlatform registers a fixture tenant…" covers the registered path, and `--check` reads it. The cases fail without the fixture (the import fails) |
| 6 | `--check --include-env` fails when the env file database lacks 0024 and passes after migrating it; `--check` alone is unchanged | **DONE** | `test-schema-compat` "--check --include-env fails when the env file database lacks 0024_content_live, and passes after pnpm migrate…" migrates with the real `scripts/migrate.js`. "--check without --include-env never opens the env store and prints what it always did" pins the exact output and checks no env file is created. "--include-env only goes with --check…" covers the refusal and an unreadable env store. With HEAD's `tenant-migrate.js`, 2 of these cases fail; the unchanged-output case passes both ways, as it should |
| 7 | The four stubs exit 1 with their line; `typeHasEditor` and `cartEditable` are pure, with a unit case | **DONE** | `test-schema-compat` "the operator commands are registered; each one still a stub exits 1 with its 'not built yet' line…" checks the exact output and exit code of all 4. `pnpm -s run migrate:documents` (and the other 3) printed `not built yet (P4-MAPPER)` etc. and exited 1. `test-editor-routes` "typeHasEditor and cartEditable are pure…" compares every registered type with the registry, covers unknown names and checks the source has no `node:`, db or request use. The chosen existing suite is `test-editor-routes` (in this item's file list; `test-registry-contract` is not) |

## Tests

- `scripts/test-schema-compat.js`: part 7, 8 new cases (42 in all, about 4 s).
- `scripts/test-editor-routes.js`: 4 new P4-SCAFFOLD unit cases (31 in all, 0.5 s).
- `scripts/test-publish.js`: one assertion adjusted (see Known limits).
- Proof that the tests fail without the change: each of HEAD's `tenant-migrate.js`, `editor-entry.js` and `ids.js` was put back in turn, and the 0024 file was removed. The cases named above failed, then passed again with this branch's files.

## Known limits

- **One file beyond the plan's list: `scripts/test-publish.js`.** Its P3-COMMIT case asserted that a 0022 store misses *exactly* `["0023_document_refs"]`. Any new migration breaks that. It now asserts "0023 and later", with 0023 first, the same form P3-COMMIT used in `test-preview-overlay.js`. That is one assertion, and no other phase 4 item owns this file. The orchestrator should add it to this item's files.
- **`lib/platform/export.js` does not export the new tables.** It isn't in this item's files. The live rows can be rebuilt from document versions, but `cms_migration_runs` and `content_live_reversed` are records an operator may want in an export. Name an owner (CUTOVER or REVERSE) to add them.
- **A 0024 tenant is not "more current" for any reader.** Table presence selects no behaviour, by design. Nothing probes these tables yet.
- **Stub tests are conditional.** The stub case in `test-schema-compat` checks a command only while its file still holds `P4-SCAFFOLD: stub`. Once the owner replaces the file, the case only checks the `package.json` entry, so owners need not edit `test-schema-compat`.
- **The fixture's `cleanup()` deletes the file but cannot close a cached `lib/db.js` client.** A suite that rebuilds the same fixture name twice in one process should use a new name, or a new tenant id.
- **`parseEditorTarget` accepts any URL-safe gid tail,** not only digits, because the test fixtures use words. Whether the product or collection exists is the editor's check, not the parser's.
- **The operator commands have no `--env-file=.env.local`** (see Design (8)).

From review:

- The first full pnpm test run at 033a57c failed. It gave 95 of 96, and test:schema-compat failed on the old case 'a tenant migrated while the instance is warm: orders get the columns once the re-check window passes', which said 'inside the window, the column exists but is left out: expected null, got "Whey Gold"'. That case has a fixed window of 80 ms. The second full run passed 96 of 96. The suite run alone 6 times, and 8 more times under CPU load both with and without the 0024 file, always passed. The P1-MIG-05-OVL-06 packet already lists this timing case as possibly flaky, so it is not a SCAFFOLD regression. 0024 does add a little migration work inside that 80 ms window, so the P4-SCAFFOLD packet's Known limits should mention it for the orchestrator.
- Mutation gap in lib/registry/editability.js. Replacing `t.system !== true` with `true` still passes every test (31 passed, 0 failed). Today no registered type is both editable and system (journal_index is editable:false and system:true), so the system check is never tested on its own. A unit case with a stubbed editable+system type would pin it.
- typeHasEditor('cart') is true whatever cartEditable() returns. If OQ-6 is ruled false, MAPPER and CUTOVER have to check cartEditable() themselves, because typeHasEditor will not. This should be written in the packet or in editability.js before batch 2.
- If neither TURSO_DB_URL nor DATABASE_URL is set, tenant-migrate --check --include-env falls back to file:local.db. That creates an empty local.db as a side effect of a check that is meant to be read-only. The check still fails safe: the ledger is missing everything, so it exits 1.
- The four operator commands (migrate:documents, reverse:documents, media:reindex, drill:p4) have no --env-file=.env.local, unlike migrate and tenant:migrate. This matches the brief's exact strings and does not matter for the stubs, but MAPPER, REVERSE and MEDIA will need some way to load env. The builder already raised this for the orchestrator.
- Two files changed outside the item's list, both disclosed as Known limits. In scripts/test-publish.js the P3-COMMIT assertion now expects 'every id >= 0023 missing, 0023 first'. It is still strict and not weakened. lib/platform/export.js does not export the new 0024 tables. That loses no data today because nothing writes them, but it needs a named owner before LIVEROW writes live rows, or a tenant export would quietly leave out live product content.
- Checks that passed: the 0024 DDL matches spec 8.2 column for column, plus pairs_title and layout_template. Mutation tests are caught for each of these: a dropped column, the partial index, IF NOT EXISTS, the hash length, the doc_coll prefix, the parseEditorTarget no-fall-through rule, gid encoding, CART_EDITABLE, the assertLocalDbUrl file: check, writeProduct outside withTenant, the stage filter, the env-store result being ignored, and the --include-env refusal. All 4 stubs exit 1 with 'not built yet (P4-<owner>)'. pnpm build passes. Nothing changed under .github/ or MANUAL-CHECKS.md. The new lib files have no node: imports. The review worktree was removed and no processes were left running.

## From review

See "From review" at the end of Known limits.

## Owner checks

- Apply 0023, 0024 and 0025 on every tenant and on the env store before code that reads or writes them deploys. Run `pnpm tenant:migrate -- --all`, then `pnpm migrate` (the env store), then `pnpm tenant:migrate -- --check --include-env`, which must exit 0. Order and reasons: `migrations/README.md`, "Phase 4".
- CI: the sqld download in `.github/` needs the owner's approval of its source and checksum before CI can run the phase 4 sqld suites. This item changed nothing under `.github/`.
- OQ-6, the `doc_cart` ruling: `CART_EDITABLE = true` is the default. Confirm it, or tell LIVEROW and MAPPER before batch 2.
