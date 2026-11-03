# Operations — monitoring, hardening, tracing (Session 17)

## Health

`GET /api/health` — dependency latencies (Turso, Typesense), queue depths
(order sync + event forwarding: pending/dead/oldest age), 24h error count, and
config flags. `200 {status:"ok"|"degraded"}`; **503** when Turso is down.
Point an uptime monitor here.

## Error tracking (first-party; Sentry-ready)

Errors are fingerprinted (source + name + normalized message + top frame — order
ids/numbers collapsed so one bug is one row) into **`app_errors`** with a running
count. Alerts via `ALERT_WEBHOOK_URL`, throttled to one per fingerprint per
`ERRORS_ALERT_EVERY_MS` (1h default).

- **Server/edge:** `instrumentation.js` `onRequestError` captures every unhandled
  render/route/action error.
- **Client:** `ErrorReporter` (window `error` + `unhandledrejection`, session-deduped,
  ≤10/session) beacons to `/api/errors` (hard-limited, 8KB cap, no PII accepted);
  the route `error.js` boundary reports its `digest`, linking UI to server capture.
- **Sentry later:** create the project, then forward from `lib/errors.js`
  `captureError` (or add `@sentry/nextjs` alongside) — this sink and its alerting stay.

## Alerts (ALERT_WEBHOOK_URL — set it in prod!)

Slack-compatible JSON. Sources: new/recurring app errors · Shopify-push
dead-letter (once at death + **daily digest** while any order stays stuck) ·
event-forwarding dead-letter (same pattern) · reconcile mismatches. Until the
env var is set, alerts are console-only in Vercel logs.

## Rate limiting

Per-minute, per-ip, fixed window ([lib/rate-limit.js](../lib/rate-limit.js)):
checkout **10** · track **60** · cart **60** · search **30** · errors **10**.
429 + `Retry-After`. In-memory **per instance** — stops bursts/loops without
infra, but is not a distributed quota; for hard guarantees add an Upstash/KV
store behind the same helper. Tune with `RATE_LIMIT_<NAME>`; local scripts can
set `RATE_LIMIT_DISABLED=1`.

## Tracing an order

- `pnpm order:trace BL-XXXXXXXX` — merged durable timeline: state machine
  transitions (order_events), purchase-event pipeline row (destinations,
  identity), Razorpay/Shopify refs, idempotency key, cart link.
- Vercel logs: every money-path step emits one JSON line (`slog`) carrying
  `order_id` — search the order id to follow `order_created` →
  `payment_verified` → `shopify_push_synced|failed`.

## Queues & jobs

- `/api/jobs/sync-shopify` (GET sweep · POST {orderId}) — daily cron 03:00 UTC.
- `/api/jobs/forward-events` (GET sweep · `?stats=1` · POST {eventId}) — daily
  cron 03:30 UTC. Both piggyback small sweeps on live traffic (webhook/collector).
- CLIs: `pnpm push:shopify [id]` · `pnpm events:stats` · `pnpm search:report [days]`
  · `pnpm order:cancel BL-X [reason]`.

## Performance (verified S17, prod build, full catalog)

48-item collection pages ≈ **90ms** server render / 338KB HTML, 44/48 images
lazy (4 priority above the fold) · PDP 124ms · `/api/search` at full index
(308 docs) **28–61ms** via Typesense. S6 CWV lab baseline (LCP 276ms home /
~1.2s PDP, CLS 0) still applies — the render path is unchanged; the consent
banner is `position:fixed` (no CLS). Re-run Lighthouse after major UI changes.

## Tests (SHOP-06)

`pnpm test` runs every `test:*` suite in `package.json` except `test:perf` (a
measurement), one at a time, prints one line per suite, shows the output of any
that failed and exits non-zero. It takes about 25 seconds. It needs no secrets
and no network. A suite stuck for 2 minutes is stopped and counted as failed
(`TEST_SUITE_TIMEOUT_MS` changes that), even if it started a background process
that keeps its output open. A `scripts/test-*.js` file that no `test:*` script
runs fails the run, because it would otherwise never run. So does a `test:*`
script that is anything other than exactly `node scripts/<file>.js`, because
something like `|| true` would hide a failure.

- **On push:** `.github/workflows/test.yml` runs `pnpm test`. It does nothing
  until this repo is pushed to GitHub.
- **Before each commit and merge commit:** `.githooks/pre-commit` runs the same
  `pnpm test`, and `.githooks/pre-merge-commit` runs that same check for `git merge`.
  They are off until you run `pnpm hooks:enable` once. That sets `core.hooksPath` in
  the repo's shared git config, so it applies to every worktree of this clone at
  once. To turn them off: `git config --unset core.hooksPath`. The tests read the
  files on disk, not what is staged. So the hook first stops the commit if a tracked
  file on disk differs from what is staged, and names the files. Stage them or put
  them aside, then commit again. Untracked files are not compared: the tests see
  them, and the commit does not carry them. A fast-forward merge makes no commit, so
  no hook runs.

`pnpm test:shopify-boundary` is the suite that enforces Decision 2 (content is
never written back to Shopify). If it fails on a change you meant to make, read
its message before touching its lists: a new mutation, write scope or field sent
to Shopify is a product decision, not a test fix.

## Deploying code that needs a new migration (MIG-05)

Tenant migrations run per tenant and one tenant can fail while the rest
succeed. Code that expects the new schema would then break for that one store,
in the cart or when an order is saved. So a release that needs new tenant schema
goes out in this order:

1. `pnpm tenant:migrate -- --all` exits 0. Use `--canary <slug>` to try one store
   first; a canary failure stops the rollout before any other store is touched.
2. `pnpm tenant:migrate -- --check` exits 0. This changes nothing. It reads every
   tenant's migration ledger, suspended tenants included, and prints one line per
   tenant. It exits 1 if any tenant is missing a migration this code ships, holds
   one whose file was edited after it ran, or can't be read, and also if the
   control plane lists no tenants (a wrong `PLATFORM_DB_URL` looks exactly like
   that). `--check --tenant <slug>` checks one store.
3. Deploy.

If step 1 or 2 fails, don't deploy. Fix the tenant it names, then run both again.
Run `--check` from the same commit you are about to deploy, because it compares
the ledgers with that commit's `migrations/tenant/` folder.

As a second line of defence, code tolerates a tenant one migration behind: new
columns are left out on that tenant until it is migrated (`lib/schema-compat.js`,
rule 7 in [migrations/README.md](../migrations/README.md)), and
`pnpm test:schema-compat` proves cart, product page data, search and order
creation still work there.

## Related runbooks

[docs/refunds.md](./refunds.md) — manual refund/cancel flows (Razorpay + Shopify + ledger).

## Offer admin (Session 19)

`/admin` — single-operator console (ADMIN_PASSWORD env; sessions are an httpOnly
cookie derived from it — rotate the password to revoke). CRUD + enable/disable +
schedule for the 4 offer types; every save is live on the next cart read (the
cart queries the offers table per evaluation — no cache, no deploy). Login is
rate-limited (5/min/ip). Offers were seeded once from lib/offers/config.js;
the DB is now the source of truth.
