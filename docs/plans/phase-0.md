# Phase 0 plan

One section per line of `docs/FEATURES.md` Phase 0. Agents read only the section for their line.

## Line 1: per-role permission harness and route guard

**Fit:** Phase 0, first line. Depends on nothing unbuilt. Line 2 (support cannot read outside the matrix, with body assertions) and line 4 (agency removal) build on this harness. Until line 4 lands, `admin/agency-grants` stays in the route table.

### 1. Feature list (what the harness must prove)

1. **Declared route table** in `scripts/support/admin-routes.js`: one row per route × method × action variant. Each row: `path`, `method`, `action` (authz string), `probe` (body / params / formData), optional `via` (lib file holding the `requireAdmin` call), optional `kind` (`gated` default, or an exempt kind below). Body-selected variants get their own rows:
   - `team` POST `{action:"invite",role:"owner"}` → team.owner; `{action:"remove"}` → team.manage
   - `integrations` POST `revoke` → settings.write; `test` → settings.read
   - `orders/[id]` POST `cancel` → orders.cancel; `push` and `reconcile` → orders.push
   - `releases` POST `preview` → storefront.read; anything else → storefront.publish
   - `documents` PUT `{listDocuments:true}` → read; `{saveDraft…}` → write; `{publish…}` → publish (`via` lib/admin/documents-api.js)
   - `preview-session` POST (via lib/admin/preview-session-api.js), `refs` GET (via lib/admin/refs.js), `releases` GET/POST (via lib/admin/releases-api.js)
   - Every other route: one row per exported method with the action found by grep (~41 files, ~80 rows).
2. **Table checked against authz:** every row's `action` is in `ACTIONS` (exported from authz.js). Expected result per role is computed with `roleAllows(role, action)`, never hand-written.
3. **Matrix test:** the test holds a copy of the ARCHITECTURE.md matrix (action → allowed roles); it must equal `ROLES × ACTIONS` from authz.js exactly.
4. **Every gated row called as each caller:**

   | Caller | Allowed | Denied |
   |---|---|---|
   | owner, admin, staff, support (real membership sessions on store A) | status not 401/403 | 403 |
   | signed-out (no cookie) | — | 401 |
   | owner of store B calling store A's host | — | 401 |
   | operator with an active support grant on A (`_platform` cookie + `createSupportGrant`) | same as support | same as support |

5. **Cross-origin:** every row whose action passes `isWriteAction` is also called as owner with `Origin: https://evil.test` → 403. Read actions on POST/PUT (`offers/simulate`, `integrations` test, `releases` preview, `preview-session`, `media` PUT, documents read ops) are marked `crossOrigin:"read"` in the table; after F2 they must also return 403 cross-origin.
6. **Guard test (static):** walks `app/api/admin/**/route.js` on the filesystem (not git). Fails when:
   - (a) a route file or exported method (`export const|async function GET|POST|PUT|PATCH|DELETE`) has no table row;
   - (b) a row points to a missing file or method;
   - (c) a `gated` row's source (or `via` file) has no `requireAdmin(` call or no `!auth.ok` check;
   - (d) a `requireAdmin(…, "x.y")` literal in the source (or `via`) is not in that route's rows;
   - (e) an exempt route calls `requireAdmin`, or is missing its declared rule.
7. **Exempt routes, each with its own tested rule:**

   | Route | Rule |
   |---|---|
   | `admin/login` POST | public; cross-origin → 403; signed-out `{}` → 400; wrong password → 401 with no `_admin` Set-Cookie |
   | `admin/logout` POST | any caller (`allowUnresolved`); cross-origin → 403; signed-out → 200 and clears `_admin`. Called only with a throwaway session (it revokes it) |
   | `admin/accept-invite` POST | public token route; cross-origin → 403; `{}` → 400; bad token → 400; never 401 |
   | `admin/reset` POST | same rule as accept-invite |
   | `admin/recover` POST | cross-origin → 403; `{}` → 400; unknown email → 200 with the generic body |
   | `admin/maintenance-pass` GET | public; always 302 to `/admin/login`; `_mx` cookie only for a verified member or operator session (with `MAINTENANCE_PASS_SECRET`/`PLATFORM_SECRET` set); signed-out gets no cookie |

   `preview-session`, `documents`, `refs`, `releases` are **gated** with `via`, not exempt.
8. **Fail-closed checks:** the tenant has members (bootstrap shared-password path closed), `ADMIN_PASSWORD` unset, and a legacy `_admin` token computed for the store → 401.

### 2. Findings (builder confirms each with a failing row first)

- **F1 (permission bug):** `app/api/admin/team/route.js` POST asks for `team.owner` only when `body.role === "owner"`. With `team.manage` an admin can demote (`{action:"role", userId:<owner>, role:"staff"}`) or remove an owner; the final-owner guard protects only the last owner. **Fix:** after `requireAdmin(team.manage)`, read `membershipRole(userId, tenant.id)`; if it is owner, require `roleAllows(actor.role,"team.owner")`, else 403. Add rows `team POST role-of-owner` / `remove-owner` → team.owner.
- **F2 (CSRF gap):** `requireAdmin` skips the origin check for `.read` actions even on POST/PUT. Mutating calls run under read actions: `preview-session` POST create / showDesign / revoke (storefront.read); `releases` POST preview; `integrations` POST test (outbound provider call). **Fix** in `lib/admin-auth.js`: `if ((isWriteAction(action) || mutatingMethod(request)) && !sameOrigin(request))`, where `mutatingMethod` = `request.method` exists and is not GET/HEAD. A missing method keeps today's behaviour (old fake requests in other suites).
- **F3 (no change, recorded):** `help` GET needs settings.read, so staff and support cannot open Help. `stores` GET uses storefront.read (line 2 checks it lists only the caller's own memberships). `maintenance-pass` gives support members a curtain pass (curtain only).

Everything else matches the matrix.

### 3. File plan (one builder, in this order)

1. `lib/platform/authz.js`: `export const ACTIONS = Object.freeze([...OWNER]);` (pure, edge-safe; not `*_SCOPES`).
2. `lib/admin-auth.js`: F2 method-aware origin check, with a comment.
3. `app/api/admin/team/route.js`: F1 owner-target check.
4. `scripts/support/route-harness.js` (helper): `registerHooks` for `@/` → repo path, `next/server|navigation` → `.js`, `next/headers` stubbed (pattern: `scripts/test-design-doc.js` lines 44-68); `makeRoleStore()` on `makePlatform` + `makeTenant({mode:"documents"})` from `scripts/support/tenant-fixture.js` (store A plus store B), users/memberships for owner/admin/staff/support via `lib/platform/identity.js`, sessions via `createSession`, an operator support grant; `as(caller)` → `call(path, method, {body, params, origin})` building a request (`method`, `url`, `nextUrl.pathname`, `cookies.get`, `headers.get` host/origin, `json()`, `formData()`) and importing `app/api/admin/<path>/route.js`.
5. `scripts/support/admin-routes.js`: the table (1.1) and exempt list (1.7) as plain data; per-row optional `allowStatus` with a one-line reason (never 401/403).
6. `scripts/test-permissions.js`: matrix (1.3); table vs authz (1.2); guard (1.6); role calls (1.4); cross-origin (1.5); exempt rules (1.7); fail-closed (1.8); F1 and F2 regressions. Prints "N rows × 7 callers"; removes its `.test-perm-*.db` files.
7. `package.json`: `"test:permissions": "node scripts/test-permissions.js"` (exactly; `run-tests.js` checks it), and the suite in `scripts/run-tests.js` if it keeps a list.
8. `docs/ARCHITECTURE.md`: matrix intro → "confirmed route by route by `test:permissions`", add the exempt-route list. (Session ticks FEATURES and writes DECISIONS.)

### 4. Decisions (recorded in docs/DECISIONS.md)

D1 hand-declared route table, results derived from `roleAllows`. D2 changing/removing an owner needs `team.owner`. D3 origin check on every non-GET/HEAD request. D4 export `ACTIONS`. D5 guard walks the filesystem. D6 allowed = not 401/403; bodies in line 2. D7 exempt routes with explicit rules; support gets a curtain pass. D8 new suite `test:permissions`.

### 5. Checks to run first

- `node --version` (needs `module.registerHooks`).
- `node scripts/test-authz.js && node scripts/test-design-doc.js`.
- A throwaway loop (in the scratchpad) importing each `app/api/admin/**/route.js` under the hooks; `first-run` and `brand-step` may pull JSX — see `scripts/test-first-run.js` ~line 292 for its loader.
- `grep -rn "requireAdmin(" scripts/test-*.js` for old fake requests without `method`; after F2 run `test-authz`, `test-preview-overlay`, `test-failure-matrix`, `test-documents` one by one.
- `grep -n "MAINTENANCE_PASS\|passSecret" lib/maintenance.js`; `grep -n "CONSOLE_API_PREFIX =" lib/tenant-request.js`.

### 6. Risks

1. Side effects of allowed calls: probes fail validation after the gate (`ord_missing`, `doc_missing`, invalid invite email, empty FormData, `{}`, provider `""`). Throwaway `file:` DBs (`assertLocalDbUrl`), `RATE_LIMIT_DISABLED=1`, Shopify/Razorpay/Resend/Typesense/R2 env blanked and asserted up front; logout last with its own session.
2. Parse before authorize (documents, preview-session): probes must be valid operations; signed-out gets exactly 401 on every gated row.
3. F2 may break old suites (mitigated by missing-method fallback); run the suites in §5.
4. Suite time: ~560 handler calls vs the 2-minute per-suite limit; import each route once, reuse sessions, small `PLATFORM_CACHE_MS` if needed.
5. Allowed routes answering 403 for their own reasons: `allowStatus` override per row with a reason, never 401/403 for an allowed role.

## Line 2: support cannot read outside the matrix

**Fit:** Phase 0 line 2; builds on line 1's harness (70b5eab).

### 1. Feature list (floor)

- **Callers checked:** every role without `settings.read` (staff, support, operator under a support grant), derived from `roleAllows`.
- **Method:** search each call's raw response text for every canary string (also lowercase and URL-encoded), plus a per-row allowlist of top-level response keys so a new field fails.
- **Canaries in the fixture:**
  - Store A secrets: `order_link_secret`, `admin_password`, `shopify_admin_token`, storefront tokens, `razorpay_key_secret`, `razorpay_webhook_secret`, `ga4_api_secret`, `meta_capi_token`, webhook secrets, `db_token`.
  - Store A config: `shopify_scopes`, `meta_test_event_code`.
  - Team: member emails (fixture users have no names, exercising the email fallback).
  - Audit: one `audit_log` row with a canary `resource`.
  - Order PII: one order with canary `email`, `phone`, `name`, address, snapshot, `cart_id`, `idempotency_key`; one contact message.
  - Store B: canary name, product, offer, document, secrets.
  - Sessions: owner `_admin` token, operator `_platform` token, `PLATFORM_SECRET`.
  - Patterns: `[\w.+-]+@perm-[ab]\.test`; key names `"secrets"`, `"dbToken"`, `"db_token"`, `"password_hash"`, `"token_hash"`.
- **Positive controls (owner):** `settings` GET has the config canary, `team` GET the emails, `audit` GET the audit canary. Secret values stay absent even for the owner on every route.
- **Per route:**

  | Route | Allowed | Extra checks |
  |---|---|---|
  | `brand-step` GET | brand step, palettes, current, design | — |
  | `bundles` GET | bundles, currency | — |
  | `catalog` GET (plain, `?product=`) | products, collections, `shopify_admin` | — |
  | `documents` PUT, all 7 read ops | document content | no member emails in `by`/`updatedByName` |
  | `experiments` GET (plain, `?analyze=`) | experiments | — |
  | `first-run`, `sync`, `theme` GET | progress, theme | — |
  | `insights` GET | `configured`, model, budget, insights | — |
  | `media` GET (`?archived=include`), `media` PUT | list, usage | no `data` blob |
  | `offers` GET, `offers/[id]` GET (real id), `offers/simulate` POST, `offers/targets` GET | offer content | — |
  | `orders` GET | redacted list | `?q=<canary email>` and `?q=<canary phone>` return 0 rows |
  | `orders/[id]` GET (real order) | state, money | PII null, snapshot null, `pii_redacted:true` |
  | `preview-session` | own token only | `revoke`/`showDesign` on the owner's session → 410; owner token never echoed |
  | `quiz` GET (plain, `?slug=`) | quiz | — |
  | `refs` GET (product, collection, variant, bundle) | items | — |
  | `releases` GET, POST preview | live release | no emails |
  | `returns` GET | no customer fields | — |
  | `setup` GET | booleans only | — |
  | `stores` GET | exactly A plus C (support also a member there); never B or suspended D | keys only `{id,name,role,url,current}` |

- **Console pages:** every `(authed)/**/page.js` gets an action in a page table (static guard), and a prop sweep: compile the page, stub its components to record props, call it with the support cookie; props must hold no canary.
- **Recorded, no test:** no route reads `upsells.read` (`upsells/page.js` redirects to the editor).

### 2. Findings (confirm each with a failing test first)

- **S1 (PII):** `app/(console)/admin/(authed)/orders/page.js:19,23` passes unredacted `listOrders` (email, phone, name) to `OrdersAdmin`. **Fix:** map through `redactOrderForRole(o, actor.role)`.
- **S2 (settings data):** `settings/page.js:65-88` (`settingsView`), `integrations/page.js:22-36` (`integrationStatus`), `automations/page.js:17-25` fetch for any role. **Fix:** `roleAllows(actor.role,"settings.read")` before any fetch, else `PermissionNote` (as `billing/page.js:24`).
- **S3 (team emails):** `lib/platform/identity.js:351` `teamMemberNames` falls back to email; reaches support via `listHistory` (`lib/documents/versions.js:191-196`), `getDocument` `updatedByName` (`service.js:274-277`), `listRecentlyPublished`/undo labels (`undo.js:350,658,842`), `publish.js:307`. **Fix:** name only; nameless → "Someone on your team".
- **S4 (PII oracle):** `lib/admin/orders.js:36-40` `q` matches email/phone for support. **Fix:** `piiSearch` option; support's `q` matches order id only; route and page.
- **S5 (cart credential):** `getOrder` (`lib/orders.js:578`) returns `cart_id` (= `cart_session` cookie) and `idempotency_key` to every role. **Fix:** strip both in `lib/admin/order-view.js` for all roles (grep `components/admin` first).
- **S6 (table gap):** `lib/admin/documents-api.js:114-115` has 7 read ops, `admin-routes.js:46-48` lists 3. **Fix:** add the 4 rows (`listRecentlyPublished`, `listChanges`, `listProductContent`, `openingChecks`), export `DOCUMENT_READS`, line-1 guard requires a row for each.

### 3. File plan (one builder, in order)

1. `lib/platform/identity.js` (S3)
2. `lib/admin/order-view.js` (S5), `lib/admin/orders.js` (S4)
3. `app/api/admin/orders/route.js`, `app/(console)/admin/(authed)/orders/page.js` (S1, S4)
4. `app/(console)/admin/(authed)/{settings,integrations,automations}/page.js` (S2)
5. `lib/admin/documents-api.js`: export `DOCUMENT_READS`
6. `scripts/support/route-harness.js`: `call()` also returns `text`; `makeRoleStore({name, a:{config,secrets,products}, b:{…}})` with defaults keeping today's behaviour
7. `scripts/support/admin-routes.js`: the 4 document read rows
8. `scripts/support/support-reads.js`: per-row probes and allowed key sets
9. `scripts/support/admin-pages.js`: page table
10. `scripts/support/page-harness.js`: swc compile, prop-recording stubs, `next/headers` cookie stub, `tfetch` stub
11. `scripts/test-support-reads.js`: the suite
12. `scripts/test-permissions.js`: `DOCUMENT_READS` guard
13. `package.json`: `test:support-reads`
14. `docs/ARCHITECTURE.md`: matrix note, support bodies proven by `test:support-reads`

Then ui-designer checks the three new `PermissionNote` states.

### 4. Decisions

Separate suite; canary search with owner positive controls; least-trusted callers derived; per-row key allowlist; names never emails; support searches orders by id only and the page redacts; `cart_id`/`idempotency_key` never leave the server in admin reads; Settings/Integrations/Automations gated on `settings.read` server-side (staff too); storefront-public values (Shopify domain, Razorpay key id, support email, shipping rates) and derived booleans are fine for support; support may create its own preview links only; pages tested by compiled prop sweep + static table.

### 5. Checks to run first

- Baselines: `node scripts/test-permissions.js`, `node scripts/test-documents.js`, `node scripts/test-orders.js`.
- `grep -rn "teamMemberNames\|redactOrderForRole\|pii_redacted\|cart_id" scripts/test-*.js`.
- `node -e "require('next/dist/build/swc/index.js').loadBindings().then(()=>console.log('ok'))"`.
- Scratchpad: with route-harness hooks, `createRequire(...)("<abs>/lib/admin-auth.js")` is the same module as `await import()` of it.
- `grep -n "db_token\|dbToken\|secret" lib/platform/control.js`.

### 6. Risks

1. Page harness may fail (`require(esm)`, shared AsyncLocalStorage) → fall back to static guard plus a support browser drill on `/admin/orders`, `/admin/settings`, `/admin/integrations`, `/admin/automations`.
2. S3 changes owner-visible labels too; may break history assertions.
3. Transformed canaries slip past search; keep them short lowercase ASCII.
4. Error bodies (`refs` 500, `media` 422 raw `e.message`) not covered by happy-path probes.
5. `route-harness.js` changes must keep `test:permissions` green alone.

## Line 3: a shopper reads only their own cart, orders and account

**Fit:** Phase 0 line 3; confirms `docs/ARCHITECTURE.md` matrix row "cart, checkout, account". There is no shopper privacy-request route and no order-lookup-by-email route.

### 1. How a shopper read identifies the caller

`_customer` cookie → `customerFromToken` (hashed, looked up in the store's DB); cart cookie (`CART_COOKIE`, UUID; body ids ignored); signed order link `?t=2.<exp>.<hmac20>` from `order_link_secret`.

**Callers on every read:** anonymous; shopper A (owner, positive control); shopper B using A's ids; B with a forged, revoked (after logout) or expired `_customer`; A's cookies replayed on store B's host; A's cart cookie with B's cart id in body/URL.

### 2. Probes (owner gets data; everyone else 401/403/404 or the empty shape, no canary in body or props)

- `GET /api/account` `view=me|orders|wishlist`: anonymous → 200 `{authenticated:false}`, exact keys.
- `GET /api/account?view=reorder&order=<A's>`: B → 404, same body as a nonexistent order.
- `POST /api/account`: `request_return` on A's order as B → 422 same text as unknown, no `return_requests` row; `profile`, `wishlist_merge`, `wishlist_remove`: anonymous 401, B changes only B's rows (A's unchanged in DB); `verify` with A's email + wrong code → no cookie, no `claimedOrders`; `request_otp` → same body for existing, nonexistent and over-cap emails.
- `GET`/`POST /api/cart`: own cart only; forged or other-store cookie → `emptyCart`; body `cartId`/`id` never changes A's cart.
- `POST /api/checkout`: `cod`/`razorpay_create` with A's `idempotencyKey` as B or anonymous → no `orderId`, `confirmationPath`, `razorpayOrderId`; A's cart not cleared. `razorpay_verify` with A's `orderId` and a bad signature, or B's valid signature → 400, no link.
- Pages: `/account`, `/account/orders/[orderId]` (B notFound, anonymous redirect); `/orders/[orderId]` and `/checkout/confirmation/[orderId]` — valid link works; 404 for tampered signature, expired `exp`, A's token on another order id, link signed by store B, missing token, v1 legacy token after cutoff (inject `now`), link forged with `"dev-only-secret"` in production; `/checkout` and the storefront layout's `initialCart`.
- Public reads (`search`, `upsell`, `wishlist` POST, `media/[id]`) anonymous with A's canaries in the DB → no canary.
- **Canaries:** A's and B's email, phone, name, address line 1, order id, `razorpay_payment_id`, coupon, cart id, customer id, session token, return reason, wishlist handle; store B's copies.

### 3. Findings (each red before its fix)

1. **High:** `app/api/checkout/route.js:49-61,201-208,262-264`, `lib/orders.js:101-109,151-156` — an idempotency key alone returns another shopper's order with a signed `confirmationPath` (name, address, phone, payment id) and their `razorpayOrderId`/amount; empty cart skips the amount check; dedup runs before the `!cartId` check, so anonymous works too; client fallback key is weak (`components/checkout/CheckoutFlow.js:134`). **Fix:** `findOrderByIdempotencyKey(key, cartId)` everywhere (incl. createOrder fast path and unique-violation recovery); same key with a different `cart_id` → 409 `IDEMPOTENCY_CONFLICT`, no order fields; no cart cookie → no dedup.
2. **Medium:** `lib/orders.js:466-471`, `lib/customers.js:35` — no `order_link_secret` and no `razorpay_key_secret` falls back to public `"dev-only-secret"`; order ids are 32-bit (`lib/orders.js:80-83`). **Fix:** in production verify returns false and mint throws without a tenant secret; dev fallback only outside production; same for customer hashes.
3. **Low:** `app/api/checkout/route.js:322-325` returns raw `e.message` (GEN-03). **Fix:** `shopperErrorMessage(e, …)`, keep `code`.
4. **Low:** `lib/customers.js:116-117` OTP attempts read-then-write. **Fix:** one conditional update `attempts = attempts + 1 where id = ? and attempts < 5`; 0 rows → refuse.
5. **Low (oracle):** `lib/customers.js:78-80` "Too many codes requested". **Fix:** over cap → same `{ok:true, sent:true}`, send nothing, log only. "No active code" on verify stays.

No change needed: `customerOrder` WHERE, `requestReturn` WHERE, cart reading only its cookie, Razorpay order match in `razorpay_verify`, tenant-bound sessions and links.

### 4. Data, permissions, events

No migration (`orders.cart_id` exists). Shopper identity comes only from `customerFromToken` and the cart cookie; order links only via `verifyOrderStatusToken`; shoppers are not added to `authz.js`. New `slog("checkout_idem_foreign_cart")` and `slog("account_otp_capped")`, no ids or PII.

### 5. File plan (one builder, in order)

1. `scripts/support/shopper-routes.js` (new): every `app/api/**/route.js` outside `admin/` with methods, class and owning suite. Classes: `shopper` (account, cart, checkout), `public-read` (search, upsell, wishlist, media/[id]), `collector` (track, exp, contact, leads, quiz/[slug], errors), `token` (approve, preview, connect/shopify/start, connect/shopify/callback), `agency` (partners, partners/auth), `operator` (platform/*), `webhook` (shopify/webhooks, razorpay/webhook, platform/billing/webhook), `job` (jobs/*, health). Also every `app/(storefront)/**/page.js` and `layout.js` as `shopper` or `public`.
2. `scripts/support/page-harness.js`: accept storefront pages; stub `lib/storefront-request` `tfetch`.
3. `scripts/test-shopper-reads.js` (new): guard (fails on any route file, method or page without a row, and if a `shopper` route reads `body.cartId`, `body.customerId` or a cart id from the query); the §2 probes on `makeRoleStore`/`makeTenant` with `host`, seeded customers A and B, orders, carts, wishlists, returns. Written first so findings 1, 2, 5 go red.
4. Fixes in `lib/orders.js`, `app/api/checkout/route.js`, `lib/customers.js`; Web Crypto only, no `node:*` (`lib/cart.js` is imported by the Edge cart route; leave it untouched).
5. `package.json`: `"test:shopper-reads": "node scripts/test-shopper-reads.js"`.
6. `docs/ARCHITECTURE.md`: the shopper matrix row confirmed by `test:shopper-reads`, plus a table of non-admin routes and their classes.

### 6. Checks to run first

- `node scripts/test-permissions.js && node scripts/test-support-reads.js`
- `node scripts/test-orders.js && node scripts/test-commerce.js && node scripts/test-customers.js` (drop any that don't exist)
- `node scripts/test-payment-recovery.js` (dedup retry paths)
- `grep -n idempotency_key lib/schema.sql migrations/tenant/*.sql` (UNIQUE/indexed?)
- `grep -n "(console)\|host" scripts/support/page-harness.js scripts/support/route-harness.js`
- `grep -rn "dev-only-secret" scripts lib`
- `git ls-files 'app/api/**/route.js' | grep -v '^app/api/admin/' | wc -l`

### 7. Risks

1. Finding 1 touches the money path: a real retry after the cart was cleared must still dedup (cart cookie remains); `test:payment-recovery` and `test-orders` must stay green.
2. Failing closed (finding 2) may break suites or `dev:design` running with NODE_ENV=production; grep first.
3. Storefront pages may need more stubbing (`tfetch`, `cookies()`, `after()`).
4. Out of scope: `/api/track` accepts any `transaction_id` as a purchase order id (integrity, later analytics line).
5. Legacy v1 order tokens don't expire until 2027-01-31; accepted, tested via injected `now`.

## Line 4: the agency partner programme is removed

**Fit:** Phase 0 line 4; uses the route guards from lines 1–3. Owner decision: routes, screens, links and the suite go; tables stay; no data deleted.

### 1. Delete (17 files)

- Pages: `app/(console)/partners/{page,error,loading}.js`, `app/(console)/approve/[token]/page.js`.
- API: `app/api/partners/route.js`, `app/api/partners/auth/route.js`, `app/api/approve/route.js`, `app/api/admin/agency-grants/route.js`, `app/api/platform/partners/route.js`.
- Components: `components/partners/PartnersConsole.js`, `components/partners/PartnersLogin.js`, `components/ApprovalDecision.js`, `components/platform/PartnersPanel.js`.
- Domain: `lib/platform/agency.js`.
- Suite: `scripts/test-agency.js` and `test:agency` in `package.json`.

### 2. Edit

- Settings: `app/(console)/admin/(authed)/settings/page.js` drops the `agency-access` section; `components/admin/OpsPanels.js` drops `AgencyAccessPanel`.
- Operator console: `components/platform/PlatformAdmin.js` replaces the "Partners" tab with "Case studies".
- Comments/labels: `components/console/status.js` (keep `accepted`/`revoked`, fix comment), `components/console/README.md`, `app/(console)/layout.js`, `lib/content-writes.js`, `lib/cms/view.js`, `lib/admin/brand-readability.js`.
- Types: `lib/types/tenant.ts` removes `"agency"` from `SessionKind` and the actor `kind` union.
- Fixture: `lib/registry/fixtures.js` renames `LEGACY_HERO_FIXTURES.agency_kit` → `full_hero` (same payload; comment "a whole hero with both buttons"); `scripts/test-registry-contract.js` renames the test, keeps `>= 5`, line ~423 → `full_hero`.
- Seed: `scripts/seed-design-preview.js` drops lines ~296–310 (agency, partner user, grant, approval). Existing harness rows untouched.
- Suites: `test-design-doc.js` (import ~94; agency-export lines ~746–751, retitle; ~848–859 drop agency half, keep theme-kit half, retitle; ~1287 reader list); `test-order-catalog.js` (import ~58; test ~421–427; header comment); `test-support-reads.js` ~316 drop `["agency-grants", {}]`; `test-copy.js` ~91, ~98 drop `components/partners`, `partners`, `approve`; `test-maintenance.js` ~408 drop `partners` from the regex.
- Guards: `scripts/support/admin-routes.js` drops the two `agency-grants` rows; `scripts/support/shopper-routes.js` drops `approve`, `partners`, `partners/auth`, replaces `platform/partners` with `{ path: "platform/case-studies", methods: ["GET","POST"], class: "operator", suite: "test-case-studies.js" }`, removes `"agency"` from `ROUTE_CLASSES`.
- Docs: `docs/ARCHITECTURE.md` agency tables row → "Unused since 2026-11-24, kept (migrations are additive)", drop the agency route-class row; `docs/MANUAL_TESTING_GUIDE.md` drops the Partners/approvals/test:agency sections; `docs/platform-guide.md` §"Agency platform" gets a "Removed 2026-11-24" note. Don't touch `docs/cms-reviews/**` or `docs/CMS_*.md`.

### 3. Must keep working

- **Case studies** (marketing `/customers` via `lib/platform/case-studies.js`) — their authoring UI, API and tests live in Partners today; they move:
  - `app/api/platform/case-studies/route.js` (operator only): GET list, POST `case_study`, `publish_case`, `delete_case` as they are, plus an `audit()` row on save and delete (today only publish is audited).
  - `components/platform/CaseStudiesPanel.js`: the case-study part of PartnersPanel (~264–340 plus the delete confirm), pointed at the new route.
- Support grants, the rest of the operator console, billing, jobs: no agency coupling. No env vars, middleware, sitemap or robots entries.

### 4. Auth for non-agency callers

`requireAdmin` has no agency path; `verifySession` rejects mismatched kinds. Agencies acted through `runAsTenant` inside `agency.js`, which goes; `runAsTenant` stays. The new suite proves:
- an agency session token in the merchant cookie against an admin route → 401; in the operator cookie against `platform/overview` → 401; only an `_agency` cookie → 401;
- an `agency-member` invite posted to `/api/admin/accept-invite` is refused and creates no membership;
- a user with only an `agency_members` row can't sign in at `/api/admin/login` or `/api/platform/login`.

### 5. Replacement tests

- `scripts/test-agency-removed.js` (`test:agency-removed`):
  1. Route table: walk `app/` for `page.js`/`route.js` (strip `(group)` segments); for `/partners`, `/approve/x`, `/api/partners`, `/api/partners/auth`, `/api/approve`, `/api/admin/agency-grants`, `/api/platform/partners` the only match may be `app/(storefront)/[...unmatched]/page.js`, which must call `notFound()`.
  2. Reference allowlist: scan `app/`, `components/`, `lib/`, `scripts/`, `package.json` for the table names `\b(agencies|agency_members|agency_grants|agency_kits|agency_referrals|agency_commissions|client_approvals)\b` and the paths `api/partners`, `["'\`]/partners\b`, `api/approve`, `["'\`]/approve/`, `agency-grants`, `platform/partners`, `platform/agency`, `components/partners`, `"_agency"`, `kind: "agency"`, `agency-member`. Allowed only in `migrations/**`, this test file, `scripts/drills/p1/migovl.mjs` and `scripts/drills/p4/**` (retired, not run), each with a reason; each allowlisted file must exist.
  3. The §4 auth checks (route-harness, file DBs with platform migrations incl. `0010`).
  4. No row in `ADMIN_ROUTES` or `SHOPPER_ROUTES` names a former path; `ROUTE_CLASSES` has no `agency`.
- `scripts/drills/agency-gone.mjs` (`drill:agency-gone`): fetch only, never seeds, base URL default `http://localhost:3017`; GET (and POST to the API paths) every former path as anonymous, support and owner; GET → 404; POST → 404 or 405, never 2xx.
- `scripts/test-case-studies.js` (`test:case-studies`): moves the publication-gate tests from `test-agency.js` ~284–314; route tests — signed out 401, merchant owner 401, operator 200; save, publish and delete each write `audit_log`; anonymous `getCaseStudy` of an unpublished study → null.

### 6. Build order (one builder)

1. The two new suites, red first.
2. Case-studies route → panel → `PlatformAdmin.js`.
3. Delete the 17 files.
4. Settings page and `OpsPanels.js`.
5. Types, fixture, comments.
6. Seed, then the suite edits.
7. Guards and `package.json` (remove `test:agency`; add `test:agency-removed`, `test:case-studies`, `drill:agency-gone`).
8. `git add` the new route before `test:security`; `git rm` the deletions.
9. Docs; then ui-designer on CaseStudiesPanel and Settings.

### 7. Checks to run first

- Baseline: `node scripts/test-permissions.js && node scripts/test-shopper-reads.js && node scripts/test-support-reads.js && node scripts/test-design-doc.js && node scripts/test-order-catalog.js && node scripts/test-registry-contract.js && node scripts/test-copy.js && node scripts/test-maintenance.js && node scripts/test-agency.js`; `pnpm typecheck`.
- `grep -rn "SessionKind\|kind: \"agency\"" lib app components scripts`
- `git ls-files app/api | grep -E "partners|approve|agency"`
- `grep -n '"test:security"' package.json`
- With the harness running: `curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3017/api/does-not-exist`.

### 8. Risks

1. Case studies lost with the Partners panel → new suite before deletions.
2. POST to an unmatched `/api/*` may not answer 404 (page catch-all) → curl first; record the answer.
3. The harness DB keeps its agency rows (`partner@design.test`, a grant on `design`); leave them, no re-seed. No FKs into agency tables.
4. `test-design-doc.js` and `test-order-catalog.js` mix agency checks into tests that matter for other things; keep the theme-kit and onboarding/Help/readability assertions.
5. Retired drills `p4/runbook.mjs`, `cutover.mjs` expect an "agency has access" result that nothing produces now; they stay unrunnable (Phase 0 drills line).

## Line 5: one command seeds a store with every role

**Fit:** Phase 0 line 5. The existing harness can't host it: `doSeed()` in `scripts/design-harness.js` runs `rmSync(.design-data)`, and its three sqld servers are taken. So it is its own harness profile: data in `.design-data-roles/`, sqld on 18027–18029, web on 3018, host `roles.localhost`. Owner rule: never delete or re-seed their existing data without asking.

### 1. What `pnpm seed:roles` creates

- Fresh platform DB, store DB and the unused default DB.
- Store `roles` ("Roles Demo Co") on `roles.localhost`, set up like p6: `applyTenantSchema`, `applyContentMode("documents")`, `upsertTenant` (INR, Asia/Kolkata, `checkout_mode: "direct"`, random `admin_password` and `order_link_secret`, no Shopify or Razorpay fields).
- Members via `createUser` + `addMembership`: `owner@roles.test`, `admin@roles.test`, `staff@roles.test`, `support@roles.test`, fresh random passwords every seed.
- Operator `operator@roles.test` via `createOperator`, pre-enrolled with `ensureTotpSecret` → `confirmTotp`.
- Synced catalog: `catalogFor("few")` (`scripts/support/tenant-fixture.js`) through the real `runCatalogSync` with injected fetchers and `NO_INDEX`; leaves a complete `sync_runs` row; `confirmedCatalogSync()` is confirmed. First-run starter drafts allowed; nothing published.
- Shopper `shopper@roles.test` ("Meera Shopper"): customer row and one COD order — `createCart`, `addItem` ×2 (product 1 × 2, product 2 × 1), `createOrder({ cartId, paymentMethod: "cod", shipping: computeShipping(...) })` with no cart passed (server recomputes), Pune address, `customer_id` set. Not `snehal@mediastic.in`.
- One audit row: `seed.roles_store`, actor `{ kind: "cli", id: "seed-roles" }`, tenant `roles`, counts only.

**Credentials:** only in `.design-data-roles/roles-seed.json`, mode 0600 (write with mode, then `chmodSync`); folder 0700; `/.design-data-roles/` in `.gitignore`. Holds store id, host, URL; each role's email and password; operator password, `totpSecret`, `otpauth`; shopper email and order id; product/collection/sync figures; seed time.

**Printed:** one line — `✓ roles store on http://roles.localhost:3018: owner, admin, staff, support, 1 operator, shopper with order <id> (₹<total>, COD), <n> products, sync complete. Store is closed (nothing published). Logins: .design-data-roles/roles-seed.json`. Never a password, secret or link.

**Refusals (before any client opens):**
- `.design-data-roles/` already holds data → refuse, change nothing, unless `--reset` (deletes only that folder).
- Platform DB already holds a tenant or user → refuse.
- Either harness running (`runningHarness` on both data folders) → refuse.
- Any DB URL that isn't `file:<local path>` or `http://127.0.0.1|localhost|[::1]:<port>` (covers `libsql://`, `https://`, `ws(s)://`, `file://host/...`, LAN IPs).
- Env names a Shopify or payment key (p6's `REAL_KEYS`); non-empty `TURSO_DB_URL`.

**Other commands:** `pnpm dev:roles` runs the roles harness (seeds first if no data; deletes nothing). `pnpm roles:code` prints the shopper's latest sign-in code from the store's `notifications` row (read-only, refuses hosted URLs, works while the roles harness runs).

**Out of scope:** an operator support grant; a published or open store.

### 2. Test: `scripts/test-seed-roles.js`

Setup: `blankOutsideServices()`, `blockNetwork()`, route loader from `scripts/support/route-harness.js`, `PLATFORM_SECRET` set; temp dir via `mkdtemp(os.tmpdir())` with `platform.db`, `tenant.db`, `default.db`; `seedRolesStore({ platformUrl, tenantUrl, defaultUrl, dataDir, host: "roles.localhost" })`; requests to real route modules with `host` and `origin`.

1. Credentials file 0600 with all six identities; returned summary has no password, TOTP secret or `otpauth`.
2. Each member `POST /api/admin/login` → 200 + `_admin`; owner/admin 200 on `settings` GET, staff/support 403, support 200 on `orders`; wrong password 401.
3. Operator `POST /api/platform/login` with email, password, `totpCode(secret)` → 200 + `_platform`; without a code → 401 "Authenticator code required".
4. Shopper: `request_otp`, read the code from `notifications` in `withTenant`, `verify`, cookie; `GET ?view=orders` has the order; total = sum of fixture prices.
5. Signed-out `GET /api/account?view=orders` → `authenticated: false`, no order id in the text.
6. Support `orders` and `orders/[id]` have the order id but not the shopper's email, phone or address; owner's response does (positive control).
7. Latest sync run `complete`, product count = catalog, ≥1 collection, sync confirmed.
8. Content mode documents; no live release; `publish_log` and `releases` empty; domains exactly `["roles.localhost"]`; one `seed.roles_store` audit row with no password.
9. Re-run on the same URLs throws "already holds a store"; row counts and file hash unchanged.
10. `assertFreshDataDir(dir)` throws on a seeded folder; returns a reset plan with `reset: true`.
11. Hosted URLs refused for platform and store: `libsql://x.turso.io`, `https://x`, `wss://x`, `http://10.0.0.5:8080`, `file://host/x`; temp folder still empty after each.
12. Running harness refused: spawn `node -e "setTimeout(()=>{},3e4)" dev-design.js`, write its pid file into a temp root, guard refuses, stop it with `child.kill()` (own handle, never by name).
13. A Shopify or Razorpay key in env → refused.
14. `git check-ignore .design-data-roles/x` succeeds.
15. `runHarness` with stand-in `seedCmd`/`nextCmd` and the roles profile never touches a sibling `.design-data` folder in the temp root.

### 3. File plan

1. `.gitignore`: `/.design-data-roles/`.
2. `scripts/design-harness.js`: `runHarness` gets a `profile` option `{ dataDirName, portEnv, defaultPorts, keepData, otherDataDirs, credentials, tenantId }`; defaults = today's values (`dev:design`/`seed:design` unchanged); with `keepData`, `doSeed` refuses instead of `rmSync` unless reset; `pointTenantAtThisRun` takes a tenant id.
3. `scripts/seed-roles-store.js` (new): `ROLES_STORE`, `ROLES_LOGINS`, `assertSeedDbUrl`, `assertFreshDataDir`, `seedRolesStore()`, `writeRolesSeed()`, `latestShopperCode()`; no side effects on import.
4. `scripts/seed-roles.js` (new): child process the harness runs; reads URLs from env, calls the core.
5. `scripts/dev-roles.js` (new): CLI `[seed [--reset] | code]`.
6. `scripts/test-seed-roles.js` (new).
7. `package.json`: `seed:roles` (`node scripts/dev-roles.js seed`), `dev:roles` (`node scripts/dev-roles.js`), `roles:code` (`node scripts/dev-roles.js code`), `test:seed-roles`.
8. Docs: `CLAUDE.md` Seed row → `pnpm seed:roles` (fresh role store on http://roles.localhost:3018; refuses if one exists; logins in `.design-data-roles/roles-seed.json`; `--reset` only with the owner's OK) and note `pnpm seed:design` wipes `.design-data/` (ask first, stop the harness first); Run row gains `pnpm dev:roles`. `docs/PLAYBOOK.md`: agents never run `--reset` or `seed:design` without asking.

No schema or migration; no new permission actions; events: one `audit_log` row, the sync's `sync_runs` row.

### 4. Checks first

1. `ls .design-data-roles 2>/dev/null` must not exist; if it does, stop and ask.
2. `command -v sqld || ls ~/.turso/sqld`
3. Baselines: `node scripts/test-permissions.js && node scripts/test-shopper-reads.js && node scripts/test-support-reads.js`
4. `grep -n "PLATFORM_SECRET" lib/platform/crypto.js` (TOTP key; seed and dev must share `design-preview-secret`).
5. `grep -n "closedStoreGate\|closed" "app/(storefront)/layout.js" app/api/account/route.js` (`/api/account` answers on a closed store?).
6. `grep -n "first\|firstRun\|first-run" lib/sync.js | head -20` (first sync writes, no network).
7. `grep -rn "test:design-harness" scripts package.json`.

### 5. Risks

1. `runHarness` is shared with `seed:design` (which wipes data) and has no suite; defaults must behave exactly as today; test 15 proves the profile never touches `.design-data`.
2. Closed store: shopper browser pages show "Opening soon"; only API reads are proven until the owner publishes.
3. `--reset` deletes data: no agent runs it without asking.
4. Safari may not resolve `*.localhost`; use Chrome or a hosts entry.
5. Fixture images point at `cdn.shopify.com/fixture/...` (broken offline; cosmetic).

## Line 6: the browser drills run on today's code

**Fit:** Phase 0 line 6. **Owner-data finding:** every p5/p6 stage reseeds through `seed-design-documents.js --p3|--p6` → `H.runHarness({mode:"seed"})` with the default profile → `rmSync(.design-data)`; their "legacy" stages also `copyData` over `ROOT/.design-data`. `drill:smoke`/`drill:edge` attach to the owner's :3017 (edge switches maintenance on); `drill:agency-gone` signs in on :3017 from `.design-data/p6-seed.json`. Today only "refuses while the harness runs" protects the data. Next 16.2's `.next/dev/lock` blocks a second `next dev` in the same folder, and a custom `distDir` rewrites tracked `tsconfig.json`, so drills must run in a throwaway worktree.

### 1. Per-drill verdicts

| Path | Verdict | Reason |
|---|---|---|
| `scripts/drills/p1/**`, `p1c/**`, `p2/**` (incl. `results-*.json`) | Delete | Legacy CMS editors / publish |
| `p3/run.mjs`, `smoke`, `routes`, `editor`, `design`, `rte`, `matrix` | Delete (keep `p3/lib.mjs`) | Not this line's bar; legacy parts; unit tests plus p5/p6 cover the editor |
| `p4/*` except `lib.mjs` | Delete; trim `p4/lib.mjs` | Legacy cutover + agency |
| `p4/lib.mjs` | Keep, remove exports p5/p6 don't import (`revokeAgency`, `moveStore`, `rehearse`, `makeRoutes`, `movedP4Store`, `reseedP4`, `readP4Seed`, `captureShopperRoutes`, migrate/reverse/render in `harnessContext`, …) | Shared helpers |
| `p5/legacy.mjs`; stages `baseline`, `legacy` | Delete | Legacy CMS |
| `p5` stages `pick`, `create`, `states`, `nosaving`, `disabled`, `grid`, `cart`, `console`, `unknown` | Keep and fix | Bundles in the documents editor; COD test order (cancelled); on the `--p3` seed |
| `p6/legacy.mjs`; stage `f` (also in `seed-p6.mjs`) | Delete | Legacy store |
| `p6` stage `final` | Delete; its `selfCheck` moves to the unit test | Reseeds for the deleted p3 drills |
| `p6` stages `baseline`, `a`–`e`, `g` | Keep and fix | Closed-store probe, start page without AI, brand, open checks, checkout off, empty catalog, policy starters |
| `scripts/drills/harness-edge.js` (`drill:edge`) | Delete | Designer is legacy; maintenance covered by `test:maintenance` and `drill:maintenance-edge` |
| `scripts/drills/smoke.js` (`drill:smoke`) | Keep and fix | PDP at 3 widths, add to cart, drawer; now isolated with `--start` |
| `scripts/drills/agency-gone.mjs` | Keep and fix | Logins from the worktree's roles store; no 3017 default |
| `scripts/drill.js` | Keep and fix | Add the isolation guard to its CLI entry |
| `scripts/drill-maintenance-edge.js`, `restore:drill` | Keep as-is | Not playwright drills; not in `drill:all` |

Chrome: `drill.js chromePath()` uses `CHROME_BIN`, else `/Applications/Google Chrome.app/...`, else Linux paths; never downloads.

### 2. Isolated runner: `scripts/drills/run-isolated.mjs <drill|all> [--keep] [--headed]`

1. Refuse if `git status --porcelain` shows tracked changes or new untracked files under `app/ components/ lib/ scripts/ migrations/` (ignore the three hands-off docs). Drills test committed HEAD.
2. Create a throwaway worktree at HEAD under `os.tmpdir()` (never in the repo or `.claude/worktrees`); `pnpm install --frozen-lockfile --prefer-offline`. It has its own `.next`, `.design-data`, `.design-env`, `.design-data-roles` and no `.env.local`.
3. Free ports from 6100 (site) and 7100 (DBs) plus a roles block, checked with `isPortBusy`; never 3017, 3018, 18017–18019, 18027–18029; a busy port → next block; never kill anything.
4. Child env: `DRILL_ISOLATED_ROOT=<worktree>`, the ports, `PLATFORM_CACHE_MS=1000`, every `BLANKED_ENV` name plus `ANTHROPIC_API_KEY` empty.
5. Run each drill from the worktree; for `agency-gone` first `dev-roles.js seed` in the worktree and start it.
6. Copy `<worktree>/docs/cms-reviews/drills/<ID>/` into gitignored `ROOT/.drill-results/<stamp>/<ID>/` plus `summary.json`.
7. `git worktree remove --force` and `prune`, unless `--keep`.
8. Hash `.design-env`, `.design-data/seeded.json`, `p*-seed.json` before and after; fail if any changed.

Second layer: `runDrill()` in `p3/lib.mjs` and the CLI entry of `drill.js` refuse unless `DRILL_ISOLATED_ROOT === ROOT`, telling you to use `pnpm drill:<name>`.

### 3. Commands

`package.json`: `drill:p6`, `drill:p5`, `drill:smoke`, `drill:agency-gone` → `node scripts/drills/run-isolated.mjs <name>`; `drill:all` → one worktree, one install, runs smoke, p5, p6, agency-gone, keeps going after a failure, non-zero if any failed; remove `drill:edge`, `drill:p4`; add `test:drills`. `CLAUDE.md`: one spec `pnpm drill:<name>` (p5, p6, smoke, agency-gone; throwaway worktree; needs committed code); all `pnpm drill:all`; drop the p1–p4 note.

### 4. File plan

**WP1 (runner, guard, tests):**
1. `scripts/drills/run-isolated.mjs` (new), exporting `assertCleanTree`, `choosePorts`, `worktreePath`, `ownerDataFingerprint`, `copyResults`.
2. `scripts/drills/p3/lib.mjs`: `assertIsolated(env, root)` called in `runDrill`.
3. `scripts/drill.js`: same guard in its CLI entry.
4. `scripts/drills/agency-gone.mjs`: base URL from env; logins from the roles seed file (env override); no 3017 default.
5. `scripts/test-drills.js` (new): package wiring; deleted paths gone; guard refuses in the main checkout; port choice skips busy and owner ports; dirty tree refused; a stand-in run in a temp git repo leaves its `.design-data`/`.design-env` byte-identical; `node scripts/drills/p6/lib.mjs --check` passes.
6. `package.json` scripts; `.gitignore` `/.drill-results/`.
7. `scripts/test-schema-compat.js`: drop the `drill:p6` row (~1288) and the `drill:p4` assertion (~1301).

**WP2 (removals and trims):**
1. Delete `scripts/drills/{p1,p1c,p2}/`, `harness-edge.js`, `p3/{run,smoke,routes,editor,design,rte,matrix}.mjs`, `p4/{run,cutover,editor,local-tenants,media,picker,product,reverse,routes,runbook,seed-p4}.mjs`, `p5/legacy.mjs`, `p6/legacy.mjs`.
2. `p4/lib.mjs`: remove unused exports after grepping p5/p6.
3. `p5/run.mjs`, `p5/lib.mjs`: remove the two legacy stages; update headers.
4. `p6/run.mjs`, `p6/lib.mjs` (`selfCheck` without `f`), `p6/seed-p6.mjs` (drop `f` from `P6_STAGES`, `stagePlan`); `seed-design-documents.js` only if it lists the stages.
5. `scripts/test-agency-removed.js`: remove the allowlist entries for `p1/migovl.mjs` and `p4/`; trimmed `p4/lib.mjs` has no agency names.
6. `scripts/test-editor-routes.js`: comment line ~14.
7. `CLAUDE.md` commands; `docs/PLAYBOOK.md` lesson.

Then the session runs typecheck, `pnpm test`, schema-compat, `pnpm drill:p5`, `pnpm drill:p6`, and `pnpm drill:all` at phase end, each under the lock.

### 5. Checks first (read-only)

- `ls -l "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version; echo "CHROME_BIN=$CHROME_BIN"`
- `ls -l ~/.turso/sqld; command -v sqld; echo "SQLD_BIN=$SQLD_BIN"`
- `node -p "require('playwright-core/package.json').version"`
- `cat .design-data/harness.pid.json 2>/dev/null; ls -l .next/dev/lock 2>/dev/null; lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3017|3018|6100|7100|7101|7102) '`
- `git status --porcelain; git worktree list`
- `shasum .design-env .design-data/*.json 2>/dev/null` (keep as the "before" picture)
- `node scripts/drills/p6/lib.mjs --check`

### 6. Risks

1. Cold `.next` plus install: slow, possibly flaky starts; the single retry in `reseedP6` stays; timeouts reported as failures.
2. p5/p6 may fail on today's code: fix selectors and seeds in the drills; real bugs are reported, not worked around.
3. The owner's harness keeps running; ports skipped, never freed; a fully busy block stops the runner with a message.
4. Drills see committed code only.
5. Lost browser coverage of the documents editor's rich text and design panel (deleted p3 drills): consider a browser spec in the console-shell line.
