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
6. **Schema before code (MIG-05).** Code that needs a new tenant migration
   deploys in this order, and only in this order:
   1. `pnpm tenant:migrate -- --all` exits 0 (add `--canary <slug>` to try one
      store first).
   2. `pnpm tenant:migrate -- --check` exits 0. It is read only: it reads every
      tenant's ledger, suspended tenants included, and fails if any tenant is
      missing a migration this code ships, holds an edited one, can't be read,
      or if the control plane lists no tenants at all.
   3. Deploy.

   If step 1 or 2 fails, do not deploy. Fix the named tenant and run both again.
7. **Code still works one migration behind.** Steps 1 to 3 are the rule, but a
   tenant can fall behind anyway (a failed tenant, a restore, a new tenant
   provisioned from an older build). So storefront and order code must not break
   on a tenant at the previous schema:
   - a new **column** is optional on read and on insert. Ask
     `hasColumns(table, [cols])` from [lib/schema-compat.js](../lib/schema-compat.js)
     and leave the columns out when it says no. It probes once per database with a
     `SELECT … LIMIT 0` (never a PRAGMA, never per request), remembers "present"
     for good and re-asks "absent" after a minute, and is edge-safe.
   - a new **table** read on a shopper path falls back on "no such table", the way
     `getLiveReleaseState` in `lib/releases.js` does.
   - `scripts/test-schema-compat.js` runs cart, product page data, search and
     order creation against a tenant at the previous schema. Move its
     `OLDER_SCHEMA` to the migration before yours when you add one that those
     paths depend on.
