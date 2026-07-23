# Refunds & cancellations — manual runbook (Session 18, v1)

No automated refund integration in v1. Every refund is TWO manual actions —
**Razorpay** (moves the money) and **Shopify** (fixes the books/stock) — plus
recording the outcome in our ledger. Everything you need is on one screen:

```bash
pnpm order:trace BL-XXXXXXXX
```
→ payment id (`pay_…`), captured amount, Shopify order ref, current status.

## A. Cancel BEFORE fulfilment — payment NOT captured (COD or unpaid)

```bash
pnpm order:cancel BL-XXXXXXXX "customer requested"
```
Cancels the Shopify order (restocks, no email) and moves our row to `cancelled`.
Nothing to refund. Customer-notify: reply to their request; v1 sends no
automatic cancellation email.

## B. Refund a CAPTURED (Razorpay) payment

1. **`pnpm order:trace BL-X`** → note `rz_payment pay_…` and the captured total
   (order total INCLUDES shipping/COD fee — refund policy decides whether
   shipping is returned; default full refund, per the returns policy).
2. **Razorpay** → dashboard.razorpay.com → Payments → search the `pay_…` id →
   **Refund** → full or partial amount (paise-exact). Or via API:
   ```bash
   curl -u $KEY_ID:$KEY_SECRET https://api.razorpay.com/v1/payments/pay_XXXX/refund \
     -X POST -d amount=<paise>   # omit amount for full refund
   ```
   Note the returned refund id `rfnd_…`. Test-mode refunds behave identically.
3. **Shopify** → the order (id from trace) → **Refund** → select items ±
   shipping → set the manual gateway amount to match the Razorpay refund →
   Refund (this restocks unless you untoggle it, and emails the customer the
   refund notification natively).
4. **Our ledger** — if the order is fully cancelled:
   ```bash
   pnpm order:cancel BL-XXXXXXXX "refunded — damaged in transit" --refunded rfnd_XXXX
   ```
   Records the refund id + amount in the audit trail and moves the row to
   `cancelled`. (Partial refunds that keep the order alive: leave the status,
   note the `rfnd_…` in Shopify's timeline — v1 has no partial-refund state.)

## C. COD refunds (returned goods, order already delivered)

No gateway to refund. Per the returns policy: collect the customer's bank/UPI
details via care@beastlife.in after the Return Authorization, transfer, then do
the Shopify refund (step B3) for the books, and record with
`--refunded manual-cod-<date>`.

## Guardrails already enforced

- `pnpm order:cancel` **refuses** captured-payment orders without `--refunded` —
  money can't silently vanish from the ledger.
- Cancelling a synced order cancels Shopify FIRST (restock, no refund there —
  Razorpay is where money moves); a fulfilled Shopify order refuses cancellation
  → cancel the fulfilment in admin (or refund instead).
- The audit trail (`order_events`) keeps reason + refund id + amount forever;
  the status page shows the customer a cancelled state with support contacts.

## Inventory note (v1)

Shopify is the source of truth. Draft-completed orders decrement stock and CAN
go below zero on a race — the push **accepts + flags** (alert + `oversell_flagged`
log with variant ids). Resolution is manual: refund/cancel per this runbook, or
restock and fulfil late.
