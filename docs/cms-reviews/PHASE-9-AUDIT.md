# Phase 9 least-trusted audit

Date: 2026-11-26. Audited on `main` at `9d7e1c5d` (Phase 9 step 0 and lines 1–5, and the export fix; plan `docs/plans/phase-9.md`).

**Suites run** through `heavy`, one at a time: `test-reviews` 26/0, `test-subscriptions` 30/0, `test-whatsapp` 37/0, `test-shiprocket` 34/0, `test-copilot` 24/0, `test-support-reads` 39/0, `test-permissions` 162/0, `test-shopper-reads` 37/0, `test-privacy` 14/0, `test-apps` 27/0. No drills were run during the audit.

**Callers:** the anonymous shopper; a signed-in shopper holding another shopper's ids; the signed-out visitor; someone holding a forwarded signed link; `support` and op-support (both act as `support`); `staff`; another store's owner (a store B session, B's ids or B's keys on A's host); an outside caller posing as Meta or Shiprocket.

## Entry points

| Entry point | Check | Support / op-support / staff | Shopper / signed out | Other store's owner | Proof (suite) |
|---|---|---|---|---|---|
| `POST /api/reviews` (review, opt-out) | store from host; `sameOrigin`; 10/h/IP; signed invite token checked against this store's invite rows; single use; review lands `pending`; every refused link gets the same words | n/a | own invite only; used, expired, tampered or Reviews-off → same words, no row | B's token refused on A | test-reviews, test-shopper-reads |
| Review pages (`/reviews/write`, `/reviews/optout`, `/products/[handle]/reviews`) | no pixels on `/reviews/*`; `referrer: "origin"`; `StripToken`; product list shows approved only, only while the Reviews block is live, else 404 | n/a | approved reviews only; no email or order id | B's reviews never on A | test-reviews |
| `/api/admin/reviews` | `reviews.read` (support and up), `reviews.moderate` (staff and up); ≤50 ids; audited `reviews.<action>` | support: no email, order id or reject reason; POST 403. Staff moderate | 401 | 401 | test-reviews, test-support-reads, test-permissions |
| `/api/account/subscriptions` | shopper cookie; every query scoped to `customer_id`; writes 30/10 min; `pay` builds a renewal cart from the due delivery, prices recomputed on the server | n/a | signed out 401; another shopper's id → 404, same as missing, row unchanged | n/a | test-subscriptions, test-shopper-reads |
| `/api/admin/subscriptions` | `subscriptions.read`; `subscriptions.manage` (staff and up) with a reason, audited | support sees no customer details (origin and renewal order ids only); POST 403 | 401 | 401 | test-subscriptions, test-support-reads, test-permissions |
| Renewal orders and held cart | renewal cart priced by its subscription's percent; the shopper's own cart waits in a second cookie; a failed online attempt doesn't lock the delivery | n/a | own renewal only | n/a | test-subscriptions |
| `POST /api/messaging/consent` | cart cookie only (body ids ignored); `sameOrigin`; ticks 10/10 min, syncs 60/10 min; strict `e164`; server's own wording; since the fixes marketing 3/IP/day and 2 carts/phone/7 days, silent | n/a | own cart only; GET masks the phone | B's consents never on A | test-whatsapp |
| `/api/account/messaging` | shopper cookie; own consents only; `sameOrigin`; 20/10 min | n/a | signed out 401 | n/a | test-whatsapp, test-shopper-reads |
| `/m/stop` and `POST /api/messaging/stop` | signed stop token (HMAC with the store's link secret, expiring, consent id only); `sameOrigin`; 20/10 min; bad token changes nothing; since the fixes no pixels on `/m/*`, `referrer: "origin"`, `StripToken` | n/a | the page shows nothing about the person | B's token refused on A | test-whatsapp, test-reviews |
| `/cart/r/[token]` | signed cart token (consent id only); revoked, erased or ordered → just the store | n/a | opens that consent's cart, no PII | B's token refused on A | test-whatsapp |
| `/api/whatsapp/webhook` | host names the store; GET verify token in constant time; POST `X-Hub-Signature-256` over the raw body in constant time; no secret → 401; >256 KB → 413 before the HMAC; only STOP/UNSUBSCRIBE acts | n/a | unsigned → 401, nothing changes | B's app secret refused on A | test-whatsapp |
| `/api/admin/apps/[id]/whatsapp` | `apps.read` / `apps.manage`; WhatsApp install only, else 404; log of the last 50, never the text | support: phones masked, no secret; staff see full phones | 401 | 401 / 404 | test-whatsapp, test-apps, test-support-reads |
| `/api/admin/apps/[id]/parcel-key` | `apps.read` (never the key or hash) / `apps.manage` rotate (key shown once, old key 24 h overlap); audited `apps.shiprocket_token_rotate` | support GET only, POST 403 | 401 | 401 / 404 | test-shiprocket, test-support-reads |
| `POST /api/parcel-updates` | store from host; `x-api-key` vs this store's hash in constant time; >64 KB → 413; 300/min; the body is only a hint: a `courier_refetch` job asks Shiprocket for the AWB; unknown AWB ignored | n/a | no key or wrong key → 401, nothing read | B's key → 401 on A | test-shiprocket |
| `/api/admin/copilot` | `storefront.read` GET; run needs the task's action (`storefront.write` or `offers.write`); kill switch, install and provider; catalog and brand data only, `assertOutgoingClean`; budget reserved first; drafts only; audited `copilot.run` without the copy | support reads the page, POST 403; staff by their actions | 401 | 401 | test-copilot, test-support-reads, test-permissions |
| `plugin_sweep` job | one job per 10-minute window (idempotency key); per store inside `withTenant`; enabled installs not killed by Storeasy; `fetch` bound to the manifest's egress list; a throw logged, not retried | n/a | n/a | each store's sweep sees only its own installs and secrets | test-reviews, test-whatsapp (and `test-plugin-sweeps` in the full run) |
| `FIRST_PARTY_INTERNAL` topics | `order.delivery_updated` reaches only `whatsapp`; custom apps are checked against `SUBSCRIBABLE` alone, other manifests refused; the body is `{ order: { id }, delivery }` with no PII | n/a | n/a | a custom app can't subscribe | test-whatsapp, test-apps |
| Export and privacy | `redactCustomer` deletes reviews, invites, the review opt-out, consents and reminder rows, cancels and unlinks subscriptions, scrubs `notifications`; since the fixes, by every phone of the request, its orders and the account | n/a | n/a | n/a | test-privacy, test-whatsapp, test-reviews, test-subscriptions |

## Attacks

- **Another shopper's subscription id** (read, skip, pause, swap, cancel, pay): 404, row unchanged. Held.
- **A forged, reused, expired or other store's review, stop or cart token:** same words, nothing changed. Held.
- **Unsigned or wrongly signed Meta webhook; a Shiprocket post without this store's key:** 401, nothing read. Held.
- **A tampered Shiprocket body:** only names an AWB; Shiprocket's own answer is written. Held.
- **A custom app subscribing to an internal topic:** refused. Held.
- **Support reading review emails, subscription customers, WhatsApp phones or the parcel key:** masked or absent. Held.
- **The copilot reading orders, customers or search terms, or publishing:** none read; drafts only. Held.
- **Client-supplied money on a renewal cart:** recomputed on the server. Held.
- **Error text revealing existence:** fixed words throughout. Held.
- **The three gaps below**, now fixed.

## Gaps (fixed on `phase9/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P9-A | Low-Medium (privacy) | `redactCustomer` scrubbed `notifications` only by the email and phone the request named. After an email-only erase, WhatsApp rows kept the order's E.164 phone and a body with the first name, order id, total and signed links, and the export ships `notifications`. | `lib/privacy.js` scrubs by the same phones `eraseConsents` uses (the request's, the matched orders', the account's), each in E.164; `test-whatsapp` case: an email-only erase with a sent WhatsApp row. |
| P9-B | Low-Medium (abuse) | The checkout consent route recorded a marketing consent for any typed phone, limited only to 10 ticks per IP per 10 minutes: a script rotating carts could make the store send its reminder template to arbitrary numbers. | A 3-per-IP-per-day cap on marketing ticks across carts, and a 2-carts-per-phone-per-7-days cap on marketing consents (`marketingPhoneCapped`, revoked rows count); both silent (same reply, no row); `test-whatsapp` case. |
| P9-C | Low (token leak) | `/m/stop?t=` loaded gtag and the Meta pixel, because `NO_PIXELS` covered only `/reviews/`. | `NO_PIXELS` also matches `^/m(?:/|$)`; the stop page has `referrer: "origin"` and renders `StripToken`; the pixel test in `test-reviews` covers `/m/stop`. |

## Accepted

- Typed phones are not proven; order updates go only to the phone on an order the shopper placed.
- A forwarded reminder link opens that cart, with no PII.
- The stop link revokes all of that phone's consents.
- `shipment_tracking`, `courier_pin_cache` and `ai_usage_ledger` are outside export and erase: they hold no shopper PII. `courier_auth` stays out of the export.
- `review_optouts.email_hash` is an unkeyed SHA-256; it is deleted on erase.
- Support sees subscription origin and renewal order ids.
- Staff see full phones in the WhatsApp log.
- The copilot's default model.

## Not checked

- Real Meta, Shiprocket, Anthropic and Razorpay runs, and the Rich Results Test (in `MANUAL-CHECKS.md`).
- Browser markup (covered by the Phase 9 `drill:all`).
- **Origin checks on shopper POST routes** when sibling store subdomains are same-site. Older than Phase 9; logged in `docs/FEATURES.md` Later.

## Phase 9 browser suite

`drill:all` at `64f33263` (2026-11-26, 3,816 s; every Phase 9 plugin and the design sweep, before the audit fixes) passed every drill, including `plugins` (reviews, subscriptions, WhatsApp, Shiprocket, copilot stages). The audit fixes (`39389352`) then passed `pnpm typecheck`, the full `pnpm test`, `drill:plugins` and `drill:sf-styles`; they touch only privacy erase, consent caps and the `/m/stop` page, which those cover.
