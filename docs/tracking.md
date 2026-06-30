# First-party server-side tracking — locked design (Session 9 spike)

**Goal:** one purchase event flows **first-party** from the browser to our own endpoint,
which relays it **server-side** to **GA4** (Measurement Protocol) and **Meta** (Conversions
API) — **deduplicated** against the browser pixels and with **SHA-256-hashed** PII. Resilient
to ad-blockers (the browser only ever talks to our origin) and privacy-correct (raw PII never
leaves our server).

Proven locally in this spike; wire into checkout in **Sessions 14–15**.

Files:
[`lib/tracking.js`](../lib/tracking.js) · [`app/api/track/route.js`](../app/api/track/route.js) ·
[`app/track-test/page.js`](../app/track-test/page.js) (spike harness — remove/gate for prod).

---

## Flow

```
 Browser (confirmation page)                         Our origin                external
 ─────────────────────────────                       ───────────              ──────────
 gtag('event','purchase',{transaction_id})  ───┐
 fbq('track','Purchase',{},{eventID})  ────────┤ (browser pixels, optional)
                                                │
 POST /api/track  { event_id, value, … } ──────┴──▶  /api/track (Node)
                                                       • read first-party cookies
                                                       • SHA-256 hash email/phone
                                                       • build GA4 + Meta payloads ──▶ GA4 /mp/collect
                                                                                   └─▶ Meta /events (CAPI)
```

The **same id** is used as GA4 `transaction_id` and Meta `event_id`, so each platform collapses
the browser copy and the server copy into one event. In production the id is the **order id**
(`BL-XXXX`) — stable, idempotent across browser/server/retries.

---

## First-party identifiers

| id | source | use |
|---|---|---|
| GA4 `client_id` | the `_ga` cookie (`GA1.1.<a>.<b>` → `<a>.<b>`) so server MP and browser gtag are the **same user**; else a first-party `_fp_cid` we mint | required by MP |
| Meta `fbp` | `_fbp` cookie (set by the pixel) or minted first-party (`fb.1.<ts>.<rand>`) | CAPI match |
| Meta `fbc` | `_fbc` cookie, or derived from the `fbclid` URL param | CAPI match (ad click) |
| `client_ip_address`, `client_user_agent` | request headers (`x-forwarded-for`, `user-agent`) | CAPI match |

`/api/track` mints + persists `_fp_cid` / `_fbp` (1–3 yr, `SameSite=Lax`) when absent, so a
returning browser keeps a stable identity even with no third-party pixel present.

---

## Dedup — the key mechanic

- **Meta:** browser `fbq('track','Purchase', …, { eventID })` + CAPI `event_id` with the **same
  value** → Meta keeps one (it prefers the richer copy). **Send from both** — it raises match
  quality and survives ad-blockers. Verified in Events Manager → Test Events ("Deduplicated").
- **GA4:** GA4 dedups `purchase` by **`transaction_id`**. Send the same `transaction_id` from gtag
  and MP and it won't double-count revenue. (Simpler alternative: fire purchase **server-only** —
  no browser `gtag('event','purchase')` — and avoid the question entirely.)

So one id → `event_id` (Meta) **and** `transaction_id` (GA4). The spike harness fires both the
browser pixels and the server with that shared id to exercise dedup on both platforms.

---

## Hashing (Meta PII) — verified

Normalise then SHA-256 (hex). Proven in this spike (independent recompute matched the endpoint):

| field | input | normalised | sha256 |
|---|---|---|---|
| `em` | `"Test@BeastLife.in "` | `test@beastlife.in` | `b58534c6…0df0ca` |
| `ph` | `"+91 90000 00000"` | `919000000000` (E.164, no `+`) | `0e3fb589…002bbd` |

Email → trim + lowercase. Phone → digits only; bare 10-digit Indian mobile gets `91` prefixed;
leading zeros dropped. GA4 MP does **not** take hashed PII here — it identifies via `client_id`
(Enhanced Conversions is a separate, later concern).

---

## GA4 Measurement Protocol

`POST https://www.google-analytics.com/mp/collect?measurement_id=G-XXXX&api_secret=…`

```jsonc
{ "client_id": "9938197274.1782768359",
  "events": [ { "name": "purchase", "params": {
    "transaction_id": "BL-XXXX", "value": 13565, "currency": "INR",
    "items": [ { "item_id": "…", "item_name": "…", "price": 4949, "quantity": 1 } ],
    "engagement_time_msec": 1,
    "debug_mode": 1 } } ] }   // debug_mode → shows in DebugView (drop in prod)
```

- **DebugView:** send to `/mp/collect` with `debug_mode: 1` (the route does this when `?debug=1`).
- **Validation:** `/debug/mp/collect` returns `validationMessages` (does **not** ingest). The route
  calls it in debug mode so you see schema errors immediately (`[]` = clean).
- Response is `204` no-body on success.

## Meta Conversions API

`POST https://graph.facebook.com/v21.0/<DATASET_ID>/events?access_token=…`

```jsonc
{ "data": [ {
    "event_name": "Purchase", "event_time": 1782768359,
    "event_id": "BL-XXXX", "action_source": "website",
    "event_source_url": "https://…/checkout/confirmation/BL-XXXX",
    "user_data": { "em": ["<sha256>"], "ph": ["<sha256>"], "fbp": "fb.1.…",
                   "fbc": "fb.1.…", "client_ip_address": "…", "client_user_agent": "…" },
    "custom_data": { "currency": "INR", "value": 13565, "content_type": "product",
                     "content_ids": ["…"], "contents": [ { "id": "…", "quantity": 1, "item_price": 4949 } ] } } ],
  "test_event_code": "TESTxxxxx" }   // routes to Events Manager → Test Events (drop in prod)
```

Response `{ "events_received": 1, "fbtrace_id": "…" }` confirms receipt.

---

## Env vars

```
NEXT_PUBLIC_GA4_MEASUREMENT_ID=G-XXXXXXX     # browser gtag + server MP
GA4_API_SECRET=…                              # server only (MP secret)
NEXT_PUBLIC_META_PIXEL_ID=…                   # browser fbq + server CAPI (dataset id)
META_CAPI_TOKEN=…                             # server only (CAPI access token)
META_TEST_EVENT_CODE=TESTxxxxx                # spike/QA only — remove for prod
# META_API_VERSION=v21.0
```

`NEXT_PUBLIC_*` are public by design (they ship in the browser tags). `GA4_API_SECRET` and
`META_CAPI_TOKEN` are **server-only** — they live in `.env.local` / Vercel env, never in client code.

---

## How to verify (spike)

1. Put the five values in `.env.local`; restart dev.
2. Open `/track-test` → **"Fire purchase — browser pixel + server"**. Note the shared `event_id`.
3. **GA4** → Admin → DebugView: a `purchase` appears (value 13565, the `transaction_id`). The
   route's `ga4Validation.validationMessages` should be `[]`.
4. **Meta** → Events Manager → your dataset → **Test Events**: a `Purchase` appears, marked
   **Deduplicated** (browser + server share the `event_id`); `events_received: 1` in the response.
5. Confirm `user_data` shows hashed `em`/`ph` (Meta displays them as hashed).

Both DebugView and Test Events work from **localhost**, so no deploy is needed for the spike.

---

## Production hardening (Sessions 14–15)

- **Where to fire:** server-side, right after the order is marked paid (`markOrderPaid` /
  confirmation), so the event doesn't depend on the browser reaching the confirmation page.
  Browser pixels still fire on the confirmation page for match quality; both share `event_id = order id`.
- **Idempotency:** `event_id = order id` already dedups, but guard the server relay so retries /
  webhook replays don't spam (fire once per paid order; record a `tracked_at`).
- **Reliability:** the relay is already `Promise.allSettled` (a tracking failure never breaks
  checkout). Add a short retry / queue for 5xx from GA4/Meta; consider Vercel `waitUntil` so the
  response isn't blocked on the upstreams.
- **Consent:** gate firing on the user's consent state (DPDP/▮GDPR) — no PII relay without consent.
- **Runtime:** route is Node (`node:crypto`). For an edge relay, swap to `crypto.subtle.digest`
  (async SHA-256). Keep secrets server-side either way.
- **Match quality:** add hashed `fn`/`ln`, `external_id` (hashed customer id), `country`, `ct`, `zp`
  from the order address to lift Meta EMQ.
- **Beyond purchase:** the same endpoint generalises to `view_item`, `add_to_cart`,
  `begin_checkout` (GA4 names) / `ViewContent`, `AddToCart`, `InitiateCheckout` (Meta) — one
  `event.name` map, same dedup + hashing path.
- **Swap creds:** spike uses a test GA4 property + Meta test dataset; swap to BeastLife's real
  Measurement ID / dataset + drop `META_TEST_EVENT_CODE` & `debug_mode`. Mechanism is identical.
- **Remove the harness:** delete or auth-gate `/track-test` before production.
