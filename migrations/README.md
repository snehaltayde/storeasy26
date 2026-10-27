# Migrations (S28 / BE17)

Two tracks, each with its own ledger (`schema_migrations` in every database):

- `migrations/tenant/` — every tenant commerce DB. `0001_baseline` is the frozen
  [lib/schema.sql](../lib/schema.sql).
- `migrations/platform/` — the control plane. `0001_baseline` is the frozen
  [lib/platform/schema.sql](../lib/platform/schema.sql).

## Rules

1. **Never edit an applied migration** (the baselines included). The runner
   checksum-locks applied files and hard-errors on a mismatch. Schema changes are
   NEW files: `NNNN_short_name.sql`, zero-padded, strictly increasing.
2. **Expand → backfill → contract.** Add the new column/table first (expand, its
   own migration), backfill data next, drop/rename old shapes last (contract, a
   later migration once every reader handles the new shape). The renderer/app must
   work with both shapes during a rollout.
3. **Write idempotently where possible** (`CREATE TABLE IF NOT EXISTS`, guarded
   `ALTER TABLE ADD COLUMN`). libsql's `executeMultiple` is not transactional
   across statements: a mid-file failure leaves earlier statements applied and the
   file UNRECORDED, so the retry re-runs the whole file.
4. **Run them**: `pnpm platform:migrate` (control plane), `pnpm migrate`
   (default/env tenant DB), `pnpm tenant:migrate -- --all | --tenant <slug>`
   (every registered tenant DB, failure-isolated per tenant). Provisioning runs
   the tenant track automatically.
5. Existing databases adopt the ledger safely: the baselines are all
   `IF NOT EXISTS`, so recording `0001_baseline` on a live DB is a no-op re-run.
