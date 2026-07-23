# Order model — first-class, durable, idempotent (Session 10)

Orders are created **at checkout intent** with an **idempotency key tied to the payment
attempt**. A double click, network retry, or duplicate payment callback re-reads the
existing order — it can never create a second one. Every status change is an atomic
compare-and-set, persisted to an append-only audit trail.

Files: [`lib/orders.js`](../lib/orders.js) · [`app/api/checkout/route.js`](../app/api/checkout/route.js) ·
schema in [`lib/schema.sql`](../lib/schema.sql) · tests `pnpm test:orders`
([`scripts/test-orders.js`](../scripts/test-orders.js), isolated file DB — never touches Turso).

---

## Status state machine

```
razorpay ──▶ pending_payment ──▶ paid ──▶ syncing_shopify ──▶ synced
cod ───────▶ cod_pending ─────────────────▶   ▲    │
                  │                           │    ▼
                  ▼                      sync_failed  (retry loops back)
              cancelled   (also from pending_payment)
```

- **`status`** = workflow position (the machine above). **`payment_status`**
  (`pending | paid | cod`) = money state the UI shows. A COD order that syncs to
  Shopify is `synced` + `cod`; a Razorpay order is `synced` + `paid`.
- Transitions are validated against an allow-map and applied with a **CAS update**
  (`… WHERE id = ? AND status = <read status>`). A lost race re-reads: if the order is
  already at the target status it returns `{ already: true }` — no duplicate event.
- Every real transition appends to **`order_events`** (`from_status`, `to_status`,
  JSON `meta` — payment ids, sync attempt, errors). `from_status NULL` = creation.
- `cod_pending → paid` (collection on delivery) is deliberately not modelled yet.

Sync helpers for Session 12: `beginShopifySync` (increments `sync_attempts`),
`completeShopifySync({shopifyOrderId})` (sets `shopify_order_id`, `synced_at`, clears
`sync_error`), `failShopifySync({error})`.

## Idempotent creation

- The client mints **one key per payment attempt** (`crypto.randomUUID()` on first
  submit, held in a ref) and resends it on retries. `cod` / `razorpay_create` require it.
- The API **dedups by key before any cart checks**, so a retry that arrives after the
  first request cleared the cart still returns the same order instead of "Cart is empty".
- Hard guarantee: `UNIQUE INDEX ON orders(idempotency_key)`. A concurrent duplicate
  loses the insert, catches the constraint, and returns the winner's order (proven live:
  two concurrent submissions → one row, responses flagged `deduped: true/false`).
- **Key reuse with a different cart total → HTTP 409 `IDEMPOTENCY_CONFLICT`** (a
  "retry" that isn't a retry). The client rotates its key and resubmits once.
- `razorpay_create` dedups **before** minting a Razorpay order, so a retry reopens the
  **same** payable order. If a same-key insert race is lost after minting, the extra
  Razorpay order is an orphan (never paid, expires unused).
- `razorpay_verify` is idempotent via the machine: a duplicate callback with the same
  `razorpay_payment_id` returns `{ already: true }`; a **different** payment id on an
  already-paid order throws. (Signature check unchanged; tampered → 400.)

## Snapshot

`orders.snapshot` (JSON, `v: 1`) is the full reproducible record:
`items` · `gifts` · `appliedOffers` · `coupon` · `totals { subtotal, discountTotal,
shippingTotal, total, currency }` · `shipping { method, total }` (free/0 today; model
supports charging) · `contact` · `address` · `payment { method, razorpay_order_id }`.

Session 12 rebuilds the Shopify representation from it — lines at catalog price, gifts
as 100%-off lines, ONE order-level FIXED_AMOUNT discount = `totals.discountTotal`,
custom shipping line (see [shopify-order-sync.md](./shopify-order-sync.md)).
Normalized columns (`order_items`, totals, address) stay for querying; the snapshot is
the source of truth for reproduction.

## Durability

All order reads/writes go through `lib/db.js`, whose libSQL client retry-wraps
transient Turso connection failures (bounded backoff). Retried writes are safe by
construction: creation dedups on the key, transitions are CAS.

Legacy Phase-0 rows (`status='confirmed'`) were mapped by `pnpm migrate`:
razorpay → `paid`, cod → `cod_pending`.

## Webhook — the authoritative "paid" signal (Session 11)

`POST /api/razorpay/webhook` ([route](../app/api/razorpay/webhook/route.js)) — Razorpay's
`payment.captured` marks the order paid **independent of the browser**; the checkout
callback is optimistic UX. Whichever lands first wins the CAS transition, the other
no-ops (`already: true`); the audit trail records the winner
(`meta.source: "webhook" | "browser_callback"` + the Razorpay `webhook_event_id`).

- **Signature:** HMAC-SHA256 over the **raw body** with `RAZORPAY_WEBHOOK_SECRET` — a
  separate secret chosen at webhook creation, env-driven like the keys (test now,
  BeastLife live later). Invalid → 400.
- **Idempotent:** duplicate deliveries hit `markOrderPaid` replay-safety → 200
  `already: true`, no second `paid` event.
- **Amount guard:** captured paise must equal `round(order.total*100)` or the delivery
  is flagged (200, loud log) and the order is untouched.
- **Cart healing:** the order's `cart_id` lets the webhook clear the buyer's cart, so a
  dead browser doesn't strand items (Phase 0's leftover).
- **Response contract:** 400 bad sig/malformed · 200 processed/duplicate/ignored/
  unfixable-by-retry (logged `NEEDS ATTENTION`) · 5xx transient → Razorpay redelivers.
  Non-`payment.captured` events and unknown orders are acknowledged + ignored.
- **Registered webhook:** id `TGzmKzfHreuGsm` (test mode) →
  `https://storeasy26.vercel.app/api/razorpay/webhook`, `payment.captured` only.
  Note: all payments on this Razorpay account deliver here; orders the DB doesn't
  know are ignored, and local-dev orders share the same Turso so they get healed too.

**Go-live checklist (once BeastLife's KYC'd account exists):** swap
`NEXT_PUBLIC_RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` in Vercel **prod** to the live keys
(staging keeps test keys) · create a **live-mode** webhook to the same URL with a fresh
secret → update `RAZORPAY_WEBHOOK_SECRET` (prod) · redeploy · keep the test webhook for
staging/dev accounts if useful.

## Shopify push — reliable, async, idempotent (Session 12)

[`lib/shopify-push.js`](../lib/shopify-push.js) productionizes the Session-8 draft-order
mechanism ([shopify-order-sync.md](./shopify-order-sync.md)), building the draft from the
**immutable order snapshot**: normal-price lines · gift as a 100%-off line · ONE
order-level `FIXED_AMOUNT` discount = engine `discountTotal` · custom shipping line ·
Razorpay refs + `bl_order_id` as attributes · **tag = our order id** ·
`draftOrderComplete(paymentPending)` ⇒ PAID (Razorpay) / **PENDING (COD)**.

- **Async:** `paid`/`cod_pending` routes fire an immediate push via `next/server`
  `after()` (response never waits). Stragglers are retried by the sweep: the Razorpay
  webhook piggybacks a small sweep on every payment, a daily Vercel cron hits
  `/api/jobs/sync-shopify` (`CRON_SECRET`-guarded; `POST {orderId}` = manual push;
  `pnpm push:shopify [id]` = ops CLI).
- **Retries:** bounded exponential backoff (`SHOPIFY_SYNC_BACKOFF_MS` · 2^attempt),
  max `SHOPIFY_SYNC_MAX_ATTEMPTS` (5). Stale `syncing_shopify` rows from crashed
  workers are reclaimed after `SHOPIFY_SYNC_STALE_MS`.
- **Dead-letter:** after max attempts the order stays `sync_failed` with its full
  snapshot — recoverable forever, reported by **every** sweep, and exactly one alert
  fires ([`lib/alerts.js`](../lib/alerts.js) → `ALERT_WEBHOOK_URL`, Slack-compatible
  JSON; always also `console.error`). A paid-but-unsynced order is caught, never lost.
- **Idempotent:** the CAS `beginShopifySync` collapses concurrent pushes, and every
  attempt searches Shopify by the order-id tag first — a retry after any crash point
  **adopts** the existing order (or completes a leftover OPEN draft) instead of
  creating a duplicate.
- **Reconciled:** Shopify's total must equal the captured amount to the paisa before
  `synced`; a mismatch fails loudly (`RECONCILE_MISMATCH` + alert, Shopify id recorded).

## Verified (2026-07-23, dev server + Turso + test-mode Razorpay)

- 18/18 unit/integration tests (`pnpm test:orders`).
- Live: 2 concurrent COD posts, same key → **one** order `BL-363BF262`; retry after
  cart-clear still returns it. 2 concurrent `razorpay_create` → one order
  `BL-D6C8963D`, both clients got the same `order_TGzXT62WQPvLCH`. Duplicate verify →
  one `paid` event, replay `already: true`; audit trail
  `∅→pending_payment, pending_payment→paid`.
- **Webhook (local, crafted deliveries):** blocked callback → paid via webhook alone +
  cart cleared · duplicate delivery → `already: true`, one paid event · tampered body →
  400, order untouched · valid sig + wrong amount → flagged, not paid ·
  `payment.authorized` → ignored · callback-first then webhook → reconciled, one event.
- **Webhook (REAL end-to-end on prod):** deployed app + registered test-mode webhook;
  hosted-checkout payment for `BL-1201AD9E` (₹444, Netbanking success) with the app's
  verify callback never firing → Razorpay delivered `payment.captured` (event
  `TGzt7HHEfE8DjM`) → order `paid` (`pay_TGzsgctNK8K9nq`), audit
  `meta.source = "webhook"`, buyer's cart cleared server-side, prod confirmation page
  shows Paid.

- **Shopify push (13 tests + live on beastlife-dev):** `pnpm test:shopify-push` covers
  input shape, COD pending, dup no-ops, adoption (order + open draft), transient retry,
  forced dead-letter with exactly one alert + intact snapshot, mismatch flag, stale
  reclaim, backoff gating, sweep limits. Live: `OID664668BL` = BL-1201AD9E (PAID ₹444;
  forced re-push **adopted** it — Shopify search shows one order for the tag) ·
  `OID664669BL` = BL-7118E62E (COD **PENDING** ₹5,947; BXGY ₹499 order discount + shaker
  gift line at ₹0; auto-pushed by the route's `after()`).
- **Full production pipeline (deployed app):** hosted-checkout payment for
  `BL-0F5426F8` (₹1,442) → real webhook `TH3APCqxglXqtC` marked it paid → prod
  `after()` pushed → **`OID664670BL` PAID ₹1,442.0**, one attempt, chain
  `pending_payment → paid → syncing_shopify → synced`, razorpay order+payment ids on
  the Shopify order. Zero manual steps between "bank Success click" and "synced".

## Still open (later sessions)

- Abandoned `pending_payment` / orphan-cart cleanup (cron) — `cancelled` exists for it.
- COD collection (`cod_pending → paid`) when fulfilment becomes real.
- Alerting for `NEEDS ATTENTION` webhook logs (amount mismatch / wrong-payment) beyond
  Vercel function logs.
