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

## Verified (2026-07-23, dev server + Turso + test-mode Razorpay)

- 18/18 unit/integration tests (`pnpm test:orders`).
- Live: 2 concurrent COD posts, same key → **one** order `BL-363BF262`; retry after
  cart-clear still returns it. 2 concurrent `razorpay_create` → one order
  `BL-D6C8963D`, both clients got the same `order_TGzXT62WQPvLCH`. Duplicate verify →
  one `paid` event, replay `already: true`; audit trail
  `∅→pending_payment, pending_payment→paid`.

## Still open (later sessions)

- Razorpay **webhook** backstop (captured payment whose client callback never lands) —
  slots straight into `markOrderPaid`, already replay-safe.
- Abandoned `pending_payment` / orphan-cart cleanup (cron) — `cancelled` exists for it.
- COD collection (`cod_pending → paid`) when fulfilment becomes real.
