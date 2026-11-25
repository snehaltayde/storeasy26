# Phase 4 least-trusted audit

Date: 2026-11-25. Read-only audit by the reviewer agent.

- **Lines 1, 3, 4:** audited on `main` at `8c6138b1`.
- **Line 2 (storefront slots):** audited on `phase4/line2` at `4860096d` in `../storeasy26-wt/p4-line2`. That branch moved while the audit ran (`291b1f62` to `4860096d`), and its route was renamed from `apps/[id]/placements` to `apps/[id]/blocks`. Any later commit there needs another look.

**Suites run** through `heavy`, in the main checkout:

| Suite | Result |
|---|---|
| `test-app-tokens` | 30/0 |
| `test-plugin-webhooks` | 40/0 |
| `test-apps` | 27/0 |
| `test-support-reads` | 35/0 (59 probes × 4 callers, 35 pages) |

**Not run:** `test-plugin-slots` (it is only on the branch, and the brief limits runs to the main checkout), `pnpm typecheck` and the drills.

**Callers:**
- `support`, and an operator under a support grant (`__Host-support`, which acts as `support`)
- the anonymous shopper
- an app token holder (Bearer `sea_tok_…`), including a token from another store
- the signed-out visitor

## Entry points

| Entry point | Check | Support / operator support | Signed out / anonymous | App token (own store / other store) | Proof (suite) |
|---|---|---|---|---|---|
| `GET /api/admin/apps` | `requireAdmin("apps.read")` | 200. Settings come without secrets, and each secret shows only as set or not set | 401 | 401 (`requireAdmin` ignores Bearer) / 401 | test-apps, test-support-reads (canaries: secret setting, `secrets_enc`, store B's app), test-permissions (app-token caller) |
| `POST /api/admin/apps` (`install`, `create_custom`) | `apps.manage` plus the origin check | 403, nothing made | 401 | 401 | test-apps, test-plugin-webhooks "create_custom: staff, support…" |
| `GET /api/admin/apps/[id]` | `apps.read`; Activity only with `audit.read` | 200, no `activity`; store B's id gives 404 | 401 | 401 | test-support-reads |
| `POST /api/admin/apps/[id]` (enable, disable, uninstall, settings) | `apps.manage` | 403 | 401 | 401 | test-apps, test-permissions |
| `GET /api/admin/apps/[id]/webhooks` | `apps.read`; payloads and the full URL only when `!redactsPii(role)` | Status only, no `payload` key, URL masked to `origin/…`; no `whsec_`; store B gives 404 | 401 | 401 | test-plugin-webhooks "payloads: … support and operator support see status only", test-support-reads (canaries: path, secret, B's app) |
| `POST …/webhooks` (endpoint, rotate_secret, test, pause, resume, resend) | `apps.manage` | 403 on every variant | 401 | 401 | test-plugin-webhooks "webhooks POST: staff, support…" |
| `GET …/tokens` | `apps.read` | 200: names, scopes, status. No secret, no `secret_hash` | 401 | 401 | test-app-tokens "GET tokens…", test-support-reads (canaries: token secret and hash) |
| `POST …/tokens` (create, revoke, scopes) | `apps.manage` | 403, nothing made | 401 | 401 | test-app-tokens "POST tokens…" |
| `GET …/calls` | `audit.read` | 403 | 401 | 401 | test-permissions row, test-app-tokens "every call writes one apps.api_call row" |
| `GET` / `POST …/blocks` (branch) | `apps.read` / `apps.manage` | GET 200, POST 403 | 401 | 401 | test-plugin-slots "signed out…", "staff, support and operator support: 403…"; support-reads probe on the branch |
| `/api/apps/v1/{me, products, products/[handle], collections, offers, orders, orders/[id]}` | `requireAppToken` (`lib/plugins/api-auth.js`): Bearer only, GET only, effective scopes are the token's scopes ∩ the app's approval, a strict audit row before any answer | Merchant cookies give 401 | 401, not attributed, rate-limited by IP | Own store: 200 in scope, 403 out of scope, 503 if the audit row can't be written. Other store: 401 (the id isn't in this store's database) | test-app-tokens "v1 me…", "store B's host with store A's token: 401", "orders… never a customer field", "out of scope", "revoked, expired, switched-off…", "kill switch" |
| Pages `/admin/apps`, `/admin/apps/[id]` | `adminActor` + `roleAllows("apps.read")`; write controls behind `RoleGate`; webhooks and tokens load through their routes | Read-only, no canary in any prop | Redirect to `/admin/login` | n/a | test-support-reads page sweep, `read-controls.js` |
| Storefront slots (branch): PDP ×3 in both layouts, guest and account order pages, layout footer | Tenant database from the host; enabled installs only; placements in state `live`; kill switch fails closed; Off blocks only in a founder preview (`contentSource().preview`); props pass `validateBlockProps` | n/a | Live first-party blocks only; nothing from store B; order slot only after the signed-link or ownership check | n/a (custom apps can't place blocks) | test-plugin-slots "turn Badges live…absent on store B's", "slot markup holds no script…", "founder preview…", "kill switch fails closed" |
| Job `plugin_fanout` | Worker `runAsTenant(job.tenant_id)`; payload `{eventId}` | n/a | n/a | n/a | test-plugin-webhooks "order.created…", "idempotency…" |
| Job `plugin_delivery` | At send time it re-checks: install enabled, endpoint, secret, topic scope | n/a | n/a | n/a | test-plugin-webhooks "an app that is off…", "uninstalling… clears its signing secrets", "retries…" |
| Webhook egress (`safeFetch`) | https on port 443; host on the app's allowlist; no IP literals, private names or Shopify; every DNS answer checked at connect time; no redirects; 4 KB read; fixed-word errors | n/a | n/a | Body is `orderSnapshot` (an allowlist, no customer fields) | test-plugin-webhooks egress tests, "the sent body" `noPii` |

## Attacks on paper

| Attack | Result |
|---|---|
| Another store's install, token or delivery id | Every read runs on the host's own database. Admin routes give 404 (test-support-reads B probes; test-plugin-webhooks "store isolation"; test-plugin-slots "store B's owner… 404"). Store A's token on store B gives 401, unattributed. `resend` and `revokeToken` are filtered by `install_id`, so another app's ids in the same store give 404. Held. |
| Secrets in an answer, log, audit diff or export | `whsec_` appears only in the create and rotate answers (`no-store`), and token secrets only in the create answer. Audit diffs hold `via`, host, scopes and expiry, never a URL path, secret or hash. `slog` gets token ids and paths only. The export leaves out `plugin_installs` (so no `secrets_enc`) and `plugin_tokens`, and `plugin_endpoints` goes out without its secret columns. Held. |
| Customer data in webhook payloads or v1 | `orderSnapshot` and `ITEM_COLUMNS` are allowlists, and v1 orders go through `redactOrderForRole(…, "support")` and then an allowlist pick. Proven with PII canaries on the stored payload, the sent body, the handler event and v1. Held, apart from coupon codes (P4-D). |
| Support seeing payloads or full URLs | `redactsPii`: no `payload` key and a host-only URL for support and operator support. Held. Free-text `lastError` from first-party handlers is the exception (P4-C). |
| Revoked or expired token | 401. Attributable, so audited, and rate-limited before the audit write. Uninstalling revokes the tokens; turning the app off suspends them. Held. |
| Drafts or unpublished content reaching v1 or a slot | v1 products use the effective read (live rows only; test "never a draft"). Offers are live only and carry no codes. Off placements render only in a founder preview, and the shopper HTML is checked for the note and the block. Held. |
| Shopper contact data reaching a plugin through the order slot | `slotContext` keeps only `id`, `status`, `fulfillment_status` and `created_at`, and the outlets sit after the token or ownership check. Held in code, but only unit-tested (P4-B). |

## Gaps (ranked)

| # | Severity | Gap | Fix | Failing test that should exist |
|---|---|---|---|---|
| P4-A | Medium | **Operators can't switch off a custom app, the new external caller.** A custom app's `plugin_id` is `custom:<16 hex>` (`lib/plugins/custom-apps.js:102`). That makes its kill flag `ff_plugin-custom:…` (`lib/plugins/catalog.js:26`). The colon fails `KEY_RE` (`lib/platform/flags.js:20`), so the operator flags route refuses that key (`flags.js:110`). The `verifyToken` kill check (`tokens.js:200`) can therefore never fire in production. The suite only passes because it inserts the flag row straight into `feature_flags`. Separately, `deliver()` skips the kill check for custom apps entirely (`lib/plugins/deliveries.js:181`). Scenario: an abusive app keeps reading orders and receiving webhooks until a store admin acts. | Give custom apps a flag-safe id (`custom-<hex>`, with a migration that renames existing rows), or map custom ids to a valid key in `killFlag`. Check the kill switch for custom installs in `deliver()` and `fanOut` too. | `scripts/test-app-tokens.js` "an operator kills one custom app through the flags route": POST the operator flags route with `killFlag(pluginId)` and expect 200; then `v1("me")` gives 401. In `scripts/test-plugin-webhooks.js`, a pending delivery for that app ends `skipped`. |
| P4-B | Low (test) | **The order slot's no-contact promise has no end-to-end proof.** No Phase 4 block uses `storefront.order.status`. The page test renders an empty slot and checks source order with `indexOf`, so a future outlet passing `ctx={order}` through a different path, or an edit to `slotContext`, would not be caught on the real pages. | Add the test below. | `scripts/test-plugin-slots.js` "order slot: a fixture block's resolver gets only id/status/fulfillment_status/created_at on the guest and account order pages": register a fixture plugin with a `data(ctx)` that records `ctx` on `storefront.order.status` and put it Live. Render both pages for an order with email, phone, name and address canaries, using a valid token or session. Assert the recorded keys are exactly those four fields and the HTML holds no canary. Assert a bad token gives 404 and the resolver is never called. |
| P4-C | Low (future leak path) | **First-party handler error text reaches support.** `sendInternal` stores the handler's `out.error` verbatim, up to 200 characters (`deliveries.js:149`). `webhooksView` returns `lastError` to every role (`custom-apps.js:265`). Phase 9 handlers (WhatsApp, Shiprocket) will echo third-party errors that can quote a shopper's phone number or address. | Store fixed words in `last_error` for `internal` targets and `slog` the raw text. Or replace `lastError` for `redactsPii` roles, as `SUPPORT_PUSH_ERROR` does. | `scripts/test-plugin-webhooks.js` "first-party handler error text never reaches support": the fixture handler returns `{ ok: false, error: PII.phone }`; support's and operator support's `GET …/webhooks` text excludes `PII.phone`. |
| P4-D | Low (needs an owner decision) | **Coupon codes reach apps.** v1 offers drop a coupon's code on purpose (`api-reads.js:83-87`). But v1 orders (`api-reads.js:96`) and every webhook payload (`events.js:63`, `topics.js:49`) carry `coupon_code`, so an `orders.read` app collects every code shoppers used, including one-off or personal codes. Support sees codes by an earlier decision; a third party is a new audience. | Decide. Either drop `coupon_code` from v1 and webhooks (keep `discount_total`), or record that it stays. | If dropped: `scripts/test-app-tokens.js` "v1 orders never carry coupon_code" and `scripts/test-plugin-webhooks.js` "the sent body has no coupon_code", both on a fixture order with a canary code. |
| P4-E | Low | **The rate limit is per token, not per app.** `api-auth.js:90` keys the budget on `v.token.id`. One app with 5 tokens gets 600 strict control-plane `audit_log` writes a minute; 10 apps get 6,000 per store. On Vercel without Upstash this also multiplies by instance. The Calls list shows only the last 100 rows, so a flood hides older calls. | Add a per-install budget beside the per-token one, or a per-store cap. | `scripts/test-app-tokens.js` "two tokens of one app share one budget": 120 calls on token 1, then token 2's next call gives 429 (audited). |

## Accepted

- Staff see webhook payloads and full endpoint URLs. Only `support` redacts, and payloads hold no customer data by design.
- Admins and owners save a Live block's settings, or Trust badges' settings, and the change shows at once. There is no Publish step and no `publish_log` row; it is audited as `apps.placement` / `apps.settings`. The drafts-only rule covers generators and AI, and only `apps.manage` (admin, owner) can do this.
- Support can open the founder preview (`storefront.read`) and so see Off blocks. It already reads their settings through `GET …/blocks`.
- A custom app may point its webhook at any public host, including another Storeasy store's URL. The POST carries no cookies and only the signed body.
- Token rate limits are per server instance when Upstash is not set (documented in `api-auth.js:23`).

## Not checked

- `test-plugin-slots` (branch only) and `pnpm typecheck`. Neither was run in this audit.
- Drills (`drill:apps`) and browser markup, including the RSC payload of PDP pages with Off blocks.
- Real DNS, TLS and proxy behaviour for egress; Upstash rate limits; timing side channels in `verifyToken`.
- Whether the hosting proxy logs `Authorization` headers (the token would land in its logs).
- The tenant export leaves out `plugin_installs`, `plugin_placements` and `plugin_tokens` (without hashes), although its comment says it holds every table a store owns. That is a completeness question, not a leak.
- Phase 9 first-party handlers and resolvers (none ship in Phase 4).
- `v1 orders ?status=<unknown>` silently returns every status instead of 400 (correctness, not access).

**Verdict:** ship after fixes. Fix P4-A, add the P4-B and P4-C tests, and get an owner decision on P4-D before line 2 merges and Phase 4 closes.

## Owner-side decision

- P4-D: coupon codes are dropped from app webhooks and `/api/apps/v1` orders (the discount total stays), following the owner's no-customer-data-to-apps decision.
