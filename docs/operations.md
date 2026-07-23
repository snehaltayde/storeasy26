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
