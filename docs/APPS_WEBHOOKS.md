# Receiving Storeasy webhooks (custom apps)

A custom app gets store events as signed HTTPS POSTs to the address saved for it in the store's console (Apps → Create custom app). This guide is for whoever builds the receiving service.

## Events

| Type | Sent when |
|---|---|
| `order.created` | An order is placed: a prepaid order once it is paid, a cash-on-delivery order once it is placed |
| `order.fulfilled` | The order's fulfilment status moves to fulfilled (once per order) |
| `ping` | Someone presses Send test event |

Order events need the "See your orders, without customer details" permission. **No event ever carries a customer's name, email, phone number or address.**

## The request

```
POST <your address>
content-type: application/json
webhook-id: dlv_3f2a9c0d1e4b5a67
webhook-timestamp: 1764075600
webhook-signature: v1,K5o0X3w4n0n3...=
```

Body:

```json
{
  "id": "evt_8c1d2e3f4a5b6c7d",
  "type": "order.created",
  "created_at": "2026-11-25T12:00:00.000Z",
  "store": "shop.example.com",
  "data": {
    "order": {
      "id": "BL-1A2B3C4D5E6F7A8B",
      "status": "cod_pending",
      "payment_method": "cod",
      "financial_status": null,
      "fulfillment_status": null,
      "currency": "INR",
      "subtotal": 999, "discount_total": 0, "shipping_total": 0, "total": 999,
      "coupon_code": null,
      "created_at": "2026-11-25T12:00:00.000Z",
      "paid_at": null,
      "line_items": [
        { "product_id": "gid://shopify/Product/1", "variant_id": "gid://shopify/ProductVariant/2", "title": "Whey", "variant_title": "1 kg", "quantity": 1, "unit_price": 999, "line_total": 999, "line_discount": 0, "is_gift": false }
      ],
      "line_items_truncated": false
    }
  }
}
```

Bodies are at most 256 KB; past 100 line items (or the size cap) the list is cut and `line_items_truncated` is `true`. A `ping` carries `data.message` only.

## Verifying the signature

Storeasy follows [Standard Webhooks](https://www.standardwebhooks.com) v1, so its libraries work as they are. By hand:

1. Take the secret you copied when the app was created (`whsec_...`). Base64-decode the part after `whsec_`: that is the HMAC key.
2. Build the signed content: `<webhook-id>.<webhook-timestamp>.<raw body>` (the body exactly as received, before any JSON parsing).
3. HMAC-SHA256 it with the key and base64-encode the result.
4. `webhook-signature` holds one or more space-separated `v1,<signature>` values. Accept the request if any of them equals yours (compare in constant time).
5. Refuse a `webhook-timestamp` more than 5 minutes from your clock, so an old request can't be replayed.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, headers, rawBody) {
  const ts = Number(headers["webhook-timestamp"]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const mine = createHmac("sha256", key).update(`${headers["webhook-id"]}.${ts}.${rawBody}`).digest();
  return String(headers["webhook-signature"] || "")
    .split(" ")
    .map((s) => Buffer.from(s.replace(/^v1,/, ""), "base64"))
    .some((sig) => sig.length === mine.length && timingSafeEqual(sig, mine));
}
```

**Rotating the secret.** Rotate secret in the console gives a new secret (shown once). For the next 24 hours every request carries two signatures, one per secret, so you can deploy the new secret without missing events. After that only the new one signs.

## Answering, retries and duplicates

- Answer any **2xx** within 15 seconds to mark the delivery Delivered. The body of your answer is ignored (at most 4 KB is read).
- Anything else is a failed attempt: 3xx (redirects are never followed), 4xx, 5xx, a timeout or a refused connection. Storeasy tries again after about 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours (each ±20%), 8 attempts over about 45 hours, then marks it Failed. Retries run on Storeasy's job tick, so the times are approximate.
- **410 Gone** pauses the app's webhooks at once. So does 72 hours of nothing but failures. The store's owners and admins are emailed; events while paused are recorded as Skipped, and the store can resend them after resuming.
- `webhook-id` is the same on every retry and on a Resend from the console. Use it as your idempotency key: the same event can reach you more than once.
- Events are not ordered; use `created_at` and the order's own state.

## Where Storeasy sends

Only to the one host saved for the app, over HTTPS on port 443. The address must be a public host name: IP addresses, `localhost`, private-network names and Shopify's hosts are refused, and a host that resolves to a private or reserved address is refused when the request is made. Changing the host is recorded in the app's activity.
