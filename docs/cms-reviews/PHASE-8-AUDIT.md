# Phase 8 least-trusted audit

Date: 2026-11-26. Audited on `main` at `370f65ba` (Phase 8 step 0 and lines 1–5, the Edge fix `bb94732f` and the billing clock fix `6a8fd73e`; `8cba589f..main`, plan `docs/plans/phase-8.md`), read-only, by the reviewer agent.

**Suites run** through `heavy`, one at a time: `test-addresses` 21/0, `test-cod-checkout` 29/0, `test-markets` 20/0, `test-pincode` 25/0, `test-offer-schedule` 19/0, `test-support-reads` 39/0, `test-permissions` 149/0, `test-shopper-reads` 37/0, `test-privacy` 13/0. No drills were run during the audit.

**Callers:** the anonymous shopper; a signed-in shopper holding another shopper's ids; the signed-out visitor; `support` and op-support (both act as `support`); `staff`; another store's owner (a store B session or B's ids on A's host).

## Entry points

| Entry point | Check | Support / op-support / staff | Shopper / signed out | Other store's owner | Proof (suite) |
|---|---|---|---|---|---|
| `GET /api/pincode?pin=` | store from host; 30/min/IP; six digits; place from the bundled dataset; delivery and COD from the host store's config; no pin in logs | n/a | 200 public facts; bad pin 400 | B's zones never on A | test-pincode, test-shopper-reads |
| checkout `quote` | cart from the cookie only; 60/min; market from the address country, checked against enabled markets; body money ignored | n/a | own cart's quote | B's markets and offers never on A | test-cod-checkout, test-markets |
| `cod_otp_send` | link secret; key + cart cookie; strict `e164`; COD available; `priceCheck`; caps (30 s cart, 3/cart/30 min, 5/phone/h, 10/IP/15 min, and since the fixes 5/email/h); capped → same reply, no message; masked `sentTo` | n/a | own cart only | n/a | test-cod-checkout |
| `cod_otp_verify` | bound to cart, key, phone hash, amount (minor units), currency and cart lines; 5 tries atomic; 10 tries/phone/h; timing-safe; 5 min expiry | n/a | another cart's challenge → 409 `COD_OTP_STALE` (same as missing) | n/a | test-cod-checkout |
| `cod` | dedup, validation, COD rule, `priceCheck`, then verified (15 min) and consumed; `payment_discount` never from the body | n/a | replay → 409; COD outside the base market refused | n/a | test-cod-checkout, test-markets |
| `razorpay_create` | allowlisted currency + international tick; server prepaid discount; minted in the market currency's minor units; base run stored | n/a | server numbers only; tampered `expectedTotal` / `expectedCurrency` → 409 | n/a | test-cod-checkout, test-markets |
| Razorpay webhook | captured amount in the order currency's minor units and `payment.currency` = `order.currency` (missing refused) | n/a | n/a | n/a | test-markets |
| `/api/account` addresses | shopper cookie; every query `customer_id = ? AND id = ?`; writes 30/10 min; cap and duplicate check inside the INSERT; delete + promote in one batch | no route; import-graph scan finds no console, operator or app route reaching `lib/addresses.js` | signed out 401; B with A's id → 404 (same bytes as missing), A's row unchanged | n/a | test-addresses, test-shopper-reads |
| `markOrderAddressUsed` | shopper from the request cookie, never the order; write-only | n/a | own row only | n/a | test-addresses |
| `GET /api/market` | Edge, 30/min; only base or enabled countries stored; `safeReturnPath`, relative 303 | n/a | unknown or disabled country → base; `//evil`, `\`, control chars, absolute URLs → `/` | B's markets never on A | test-markets |
| Settings: checkout and Markets | `settings.read` / `settings.write` (admin, owner); SMS refused with no provider; currency allowlist; audit `settings.write` with keys and rate changes | NoAccess, PUT 403 | n/a | 401 | test-cod-checkout, test-markets, test-support-reads |
| `GET /api/admin/offers/targets` `collections` | `offers.read`; host store's synced collections | 200, key allowlisted | 401 | 401 | test-support-reads |
| Offer with a `collection` target | `offers.write`; handle must exist in this store; matching via this store's `collection_products` | support 403; staff 200 (decision 6) | n/a | B's handle refused, never matches on A | test-offer-schedule |
| Bundles with a schedule | `offers.write`; canonical UTC; bundle + offer rows in one batch; audit carries the window | support 403, read-only chip; staff 200 | not found and card hidden outside the window; no bundle price; expiry mid-checkout → 409 | n/a | test-offer-schedule, test-support-reads |
| Collection offer note | live-at-now offers; titles only | n/a | titles only | n/a | test-offer-schedule |
| Order views (`payment_discount`, `cod_verified_at`, `market`, `base_*`, `fx_rate`) | `redactOrderForRole`; snapshot nulled for support | amounts and the "confirmed by code" line, never phone or address | own orders via token or account | n/a | test-support-reads |
| `cod_otp_redact` job | inside `runAsTenant`; also runs on every send and check | n/a | n/a | one job per store per 5 min | test-cod-checkout |
| Export and privacy for addresses | export holds no `customers`, `customer_addresses` or `cod_otps`; `redactCustomer` deletes addresses (only a missing table skipped) and, since the fixes, scrubs matching `notifications` rows | n/a | n/a | n/a | test-privacy |

## Attacks

- **Another shopper's address id** (read, edit, delete, default, edit-by-save; a remembered `savedId`): 404, row unchanged. Held.
- **Another cart's OTP challenge**, changed phone, cart or amount, used challenge: stale or required, no order. Held.
- **Phone enumeration:** same reply shape for every phone; capped phones still get "sent". Held (lockout wording changed in P8-B).
- **Guess caps:** 5 per challenge (atomic), never reset on resend, 10 per phone per hour, 3 challenges per cart per 30 min. Held.
- **Support seeing a phone or address:** new order columns aren't PII; snapshot nulled; no console address read. Held.
- **A market from another store:** host store's config only. Held.
- **Open redirect on `/api/market`:** closed. Held.
- **Client-supplied money:** ignored or compared; 409 fires. Held.
- **Scheduled bundle shown early:** the bundle's own window decides first. Held.
- **Another store's collection handle:** refused at save; per-store membership. Held.
- **Error text revealing existence:** fixed words. Held.
- **Support sweep:** `settings/markets` in `ADMIN_PAGES`; `pincode`, `market` in `SHOPPER_ROUTES`; `offers/targets` keys updated. Held.

## Gaps (fixed on `phase8/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P8-A | Low-Medium (abuse) | `cod_otp_send` by email capped cart, phone and IP but never the recipient: one IP rotating carts and phones could send ~40 code emails an hour to a victim's address from the store's sender. | A 5-per-hour cap on the recipient email that fails silently like the phone cap (same reply, no message, unmatchable hash); suite case. |
| P8-B | Low (availability, existence) | Anyone could lock a phone out of COD for an hour (11 wrong guesses across 3 challenges, or 5 sends), and the separate `phoneLocked` sentence told a first-try caller the number had been tried. | The phone lock counts only SMS challenges' tries and answers with the plain wrong-code words; the remaining send-cap lockout is recorded as accepted risk (prepaid still works). |
| P8-C | Low (privacy; older gap Phase 8 widens) | `cod_otp` notification rows kept the shopper's email (or the phone under the SMS stub) as `recipient` after `redactCustomer`, and the store export ships `notifications`. | `redactCustomer` scrubs `recipient` and `body` on `notifications` rows matching the email or the phone's `e164`; `test-privacy` case. |

## Accepted

- Staff schedule offers and bundles under `offers.write` (plan decision 6, risk 5).
- The email channel proves only the email, and the order says "Email confirmed by code".
- `/api/market` is a GET that sets a cookie; a cross-site link can switch a shopper's market, and checkout then answers 409 in the new currency.
- `cod_otps.phone_hash` is kept after redaction (keyed with the store secret).
- A phone-only privacy request finds no account (accounts are keyed by email).
- `x-vercel-ip-country` is trusted only when it names an enabled market, and only on the first visit.

## Not checked

- **Origin checks on shopper POST routes** (`/api/account`, `/api/checkout`) when sibling store subdomains under `SIGNUP_STORE_DOMAIN` are same-site and a store's own HTML could carry a form. Older than Phase 8; logged in `docs/FEATURES.md` Later as a pre-go-live check.
- The real SMS provider, the real pincode dataset, Razorpay international payments, the Shopify draft for a USD order (in `MANUAL-CHECKS.md`).
- Browser markup (covered by the Phase 8 `drill:all`).
