# Storeasy Apps API (v1)

A read-only API for a store's **custom apps** (Phase 4 line 4). It is meant for
your own server talking to Storeasy, not for browsers: there are no CORS
headers, and console cookies are ignored.

## Authentication

1. Create a custom app in **Apps → Create custom app**, approving what it can see.
2. On the app's page, **API access → Create token**: a name, the permissions
   (only ones the app was given) and an expiry (30, 90 or 365 days).
3. Copy the token. It is shown **once**: Storeasy keeps only a SHA-256
   fingerprint. Lost it? Revoke it and create another. An app has at most 5
   active tokens.

Send it on every call, to the store's own host:

```
GET https://<store host>/api/apps/v1/me
Authorization: Bearer sea_tok_0123456789abcdef.<64 hex characters>
```

A token works only on the store that made it. It stops working when it is
revoked, when it expires, when the app is turned off (it works again when the
app is turned on) and for good when the app is uninstalled.

## Permissions

What a call may read is the token's permissions **and** the app's current
approval: when an owner or admin narrows the app's approval, every token
narrows at once.

| Scope | Words shown to the merchant | Endpoints |
|---|---|---|
| (none) | | `me` |
| `storefront.read` | See your live store content, products and collections | `products`, `products/{handle}`, `collections` |
| `offers.read` | See your offers and bundles | `offers` |
| `orders.read` | See your orders, without customer details | `orders`, `orders/{id}` |

Customer details (names, emails, phone numbers, addresses, customer ids) are
never returned by any endpoint, and neither is any checkout or cart id.

## Endpoints (all `GET`)

| Path | Answer |
|---|---|
| `/api/apps/v1/me` | `{ app: { id, name }, scopes, store }` (scopes: the effective ones) |
| `/api/apps/v1/products` | `{ items: [{ id, handle, title, display_type, price_min, price_max, compare_at_min, currency, available, featured_image, featured_image_alt }], nextCursor }`, by title; live content only |
| `/api/apps/v1/products/{handle}` | `{ product }`: the card fields plus `display_vendor`, `description`, `description_html`, `options`, `images`, `variants` |
| `/api/apps/v1/collections` | `{ items: [{ id, handle, title, products }], nextCursor }` |
| `/api/apps/v1/offers` | `{ items: [{ id, type, label, enabled, starts_at, ends_at, config, updated_at }], nextCursor }` |
| `/api/apps/v1/orders` | `{ items: [order], nextCursor }`, newest first; `?status=` filters |
| `/api/apps/v1/orders/{id}` | `{ order }` with `items` |

An order is `{ id, status, payment_method, payment_status, subtotal,
discount_total, shipping_total, total, currency, coupon_code, applied_offers,
shopify_order_id, created_at, updated_at, paid_at, synced_at }`. Money is a
number in the store currency; times are ISO 8601 UTC.

## Paging

`?limit=` (1 to 100, default 50) and `?cursor=` (the previous answer's
`nextCursor`; `null` means there is no next page). Cursors are opaque.

## Errors

Every error is JSON `{ error, code }` in plain words.

| Status | When |
|---|---|
| 400 | a bad `limit` or `cursor` |
| 401 | "This token isn't valid for this store." (missing, unknown, revoked, expired, another store's, or the app is off) |
| 403 | "This app wasn't given permission to …" (the scope's words) |
| 404 | no such product or order |
| 429 | too many calls; wait `Retry-After` seconds |
| 503 | Storeasy couldn't record the call, so nothing was returned; or the store is unavailable |

## Limits and records

- 120 calls a minute per token (per client address). Tokens that don't
  resolve are limited by address.
- Every call made with a real token (allowed or refused) is recorded in the
  store's audit log before it is answered. If the record can't be written, the
  call answers 503 with no data. Owners and admins see the last 100 calls on
  the app's page and in the Audit log.
- The API is read-only in v1.
