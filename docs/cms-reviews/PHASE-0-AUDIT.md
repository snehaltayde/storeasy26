# Phase 0 end-of-phase least-trusted audit

Date: 2026-11-24. Branch `phase0/audit`. Method: `steelthread:least-trusted-audit`, "Phase-end audit".
Least-trusted roles (CLAUDE.md, `docs/ARCHITECTURE.md` matrix): **support** in the merchant console
(`offers.read`, `orders.read`, `storefront.read`, `upsells.read`; customer PII redacted) and the
**anonymous shopper** on the storefront.

Inventory by search: `find app -name route.js` (86 route files), every `page.js` / `layout.js` /
`not-found.js` under `app/` (70), `app/sitemap.js` and `app/robots.js`, `grep "use server"` (none: the
app has no server actions), the 10 job types in `lib/platform/worker.js` `HANDLERS`, and one AI entry
point (`/api/admin/insights`). **168 entry points** in all (86 routes, 70 pages/layouts, 2 metadata files, 10 job types).

Test names below are the `t("…")` labels; "harness" means the row's table drives a generic test.

- PR = `scripts/test-permissions.js` (every row of `scripts/support/admin-routes.js` as every caller,
  "`<row> → <action> as each caller`"; guard "every route file, exported method and requireAdmin
  action has its row")
- SR = `scripts/test-support-reads.js` (every probe of `scripts/support/support-reads.js` as staff,
  support and operator-under-grant: "`<caller>: every probe answers its status with only its listed
  top-level keys`" and "`<caller>: no canary in any probe`")
- SH = `scripts/test-shopper-reads.js`; CS = `scripts/test-console-shell.js`
- DS = `pnpm drill:shell` (browser, this audit's pass added `supportDeepLinks`, `supportEmptyStates`,
  `anonymousPass`)

## 1. Merchant admin API (`app/api/admin/**`, 40 route files)

Check: `requireAdmin(request, "<area>.<verb>")` (`lib/admin-auth.js`) on every method; store from the
request host via `tenantHandler` → `withTenant()`. Signed-out = 401 for every method (PR "guard: every
exported method of every non-exempt route answers a signed-out caller 401").

| Entry point | Check (action) | Scope filter | Support gets | Anonymous gets | Proof |
|---|---|---|---|---|---|
| `audit` GET | `audit.read` | host store's audit rows | 403 | 401 | PR row; SR "denied rows: every refusal … carries no canary"; DS API 403 |
| `automations`, `billing`, `domains`, `privacy`, `settings`, `integrations` GET (+ `integrations` POST test) | `settings.read` | host store | 403 | 401 | PR rows; SR denied rows; DS API 403 (settings, integrations) |
| `help` GET | `settings.read` (F3: support and staff cannot open Help, recorded) | host store | 403 | 401 | PR row; DS API 403 |
| `team` GET/POST, owner targets | `team.manage` / `team.owner` (second check in route) | host store's members | 403 | 401 | PR rows; PR "F1: an admin can neither demote nor remove an owner" ; DS API 403 |
| All write rows (`*` POST/PUT/PATCH/DELETE: automations, billing, brand-step, bundles, catalog, documents saveDraft/archive, domains, experiments, first-run (enqueues `generate`), insights (AI generate/apply), integrations revoke, media, offers*, orders cancel/push/reconcile (enqueue `shopify_push`), policy-start, quiz, returns, settings, setup, sync (enqueues `catalog_sync`), theme) | `*.write`, `orders.*`, `returns.decide`, `sync.run`, `settings.write` | host store | 403 | 401 | PR rows (each as support); PR "cross-origin: every write row … answers the owner 403"; SR "denied rows" |
| `documents` publish / publishSet, `releases` publish/schedule/rollback/cancel/approve | `storefront.publish` | host store | 403 | 401 | PR rows; DS "support: publish, setup, settings … APIs answer 403" |
| `documents` reads (listDocuments, getDocument, listHistory, listRecentlyPublished, listChanges, listProductContent, openingChecks) | `storefront.read` (`lib/admin/documents-api.js`) | host store; archived documents are this store's own | allowed, only listed keys, no member emails (S3) | 401 | SR probes; SR "S3 documents: history and recent publishes name nobody by email"; PR guard "every DOCUMENT_READS op … has a storefront.read row" |
| `orders` GET (list, `?q=`, `?before=` paging, `counts`) | `orders.read` | host store; `piiSearch` off for support | allowed; contact PII redacted; `?q=` matches order ids only (no email/phone oracle); counts are this store's | 401 | SR "S4 orders: a PII-redacted caller's ?q= matches order ids only"; SR probes |
| `orders/[id]` GET | `orders.read` | host store; unknown/other store's id = 404 | PII and snapshot null, `pii_redacted`; no cart id or idempotency key | 401 | SR "orders/[id] (S5) …", "orders/[id] for support: only listed order keys …" |
| `returns` GET | `orders.read` | host store | no customer fields, no emails | 401 | SR "returns, setup, releases: no customer fields and no emails" |
| `offers`, `offers/[id]`, `offers/targets`, `offers/simulate`, `bundles` GET | `offers.read` | host store | allowed, listed keys | 401 | SR probes |
| `catalog`, `brand-step`, `experiments`, `first-run`, `sync`, `theme`, `quiz`, `refs`, `setup`, `releases` GET (+ releases preview) | `storefront.read` | host store | allowed, listed keys, no canary | 401 | SR probes; SR "returns, setup, releases …" |
| `insights` GET (AI) | `storefront.read`; the AI call is POST `storefront.write`; facts carry no PII (`lib/ai/insights.js` PII guard) | host store | allowed, listed keys | 401 | SR probe "insights"; PR rows |
| `media` GET (`?archived=include`), PUT usage | `storefront.read` | host store; archived media are the store's own | listing and usage, never file bytes | 401 | SR "media: listings and usage carry no file bytes" |
| `preview-session` create/showDesign/revoke | `storefront.read` | host store; a session belongs to its creator | makes only its own links; the owner's sid answers 404 | 401 | SR "preview-session: a read-only caller makes only its own links" |
| `stores` GET | `storefront.read` | the caller's own memberships | exactly its stores, never a suspended one or another's; `{id,name,role,url,current}` only | 401 | SR "stores: support gets exactly A and C …" |
| `login`, `logout`, `accept-invite`, `reset`, `recover`, `maintenance-pass` | exempt (credential / token) | host store | — | 400/401 with a generic body; recover gives the same body for an unknown email | PR "exempt login …", "exempt recover …", "exempt maintenance-pass …", "exempt logout …" |

## 2. Merchant console pages (`app/(console)/admin/**`, 36 files)

| Entry point | Check | Scope | Support gets | Anonymous gets | Proof |
|---|---|---|---|---|---|
| `(authed)/layout.js` | `actor` or `redirect("/admin/login")`; nav from `navFor(role)` | host store | shell with support's nav, read-only pill, account menu with Sign out only | → `/admin/login` | CS "the (authed) layout", "the shell, rendered"; DS nav and menu checks; DS "anonymous: all 31 console pages redirect to /admin/login" |
| 31 pages (`scripts/support/admin-pages.js`) | page action; `roleAllows(actor.role, action)` before data where a read-only role lacks it | host store | every page renders (or redirects) with no canary in any prop | → `/admin/login` | SR "pages: every console page has a row", "S2 pages: every page a least-trusted role may not read checks roleAllows …", "page sweep: every console page runs as support", "page sweep (S1, S2): no prop … holds a canary"; DS every nav item at 3 widths |
| `settings`, `integrations`, `automations`, `billing` pages | `settings.read` gate → `PermissionNote` | — | the permission note, none of the data | → `/admin/login` | SR "S2 pages: Settings, Integrations and Automations show … a PermissionNote"; DS "support deep link /admin/<page>: the permission note, no error" (all four, billing included) |
| `setup` page | `storefront.read`; its POST needs `settings.write` | host store | read-only checklist; POST 403 | → `/admin/login` | SR page sweep; DS "support deep link /admin/setup" and API 403 |
| Empty store | — | Roles Annex: nothing published, no orders | every nav item renders its empty state | — | DS "support on the empty Roles Annex: <href> renders" |
| `(auth)/login`, `reset`, `accept-invite` pages + layout | public forms; tokens checked by their POST routes | host store | — | the form | PR exempt rows (the POSTs); DS signs in through the login form |
| `(console)/layout.js`, `(console)/not-found.js` | none needed (no data) | — | — | — | none (no data read) |

## 3. Operator console (`app/(console)/platform/**`, `app/api/platform/**`)

| Entry point | Check | Support (merchant session) gets | Anonymous gets | Proof |
|---|---|---|---|---|
| `/platform` page + layout | `verifyPlatformToken(_platform)`; else `PlatformLogin` | the operator sign-in, never the console | the operator sign-in | DS "support at /platform …", "anonymous at /platform …" |
| 20 `api/platform/**` routes | `lib/platform/admin-auth.js` (password + TOTP, support grants) | 401 (a merchant `_admin` is not a `_platform`) | 401 | SH map "every entry file … has exactly one row" (class operator); suites per row in `shopper-routes.js` (test-tenant-ops, test-platform-ops, test-billing, test-privacy, test-provision, test-jobs, test-identity, test-case-studies); test-security "support role is read-only: every write action denied" |

## 4. Storefront (anonymous shopper)

Check: `storefrontHandler` / `tfetch` resolve the store from the host; a never-published store is
closed (`closedStoreGate`, `StoreClosed` in the layout); content reads come from the live release only.

| Entry point | Scope filter | Anonymous gets | Proof |
|---|---|---|---|
| `account` GET/POST | `_customer` cookie only, never an id in body/query | 401 / nothing of A's; OTP request gives one body for known, unknown and over-cap emails | SH "GET view=me\|orders\|wishlist: every other caller gets B's or nothing", "POST request_otp: the same body …", "POST profile, wishlist_merge, wishlist_remove: anonymous 401" |
| `cart` GET/POST | cart cookie only | own cart only; a body `cartId` is ignored | SH "GET /api/cart: own cart only …", "POST /api/cart: a cartId or id in the body never touches A's cart" |
| `checkout` POST | cart cookie; money recomputed on the server | an idempotency key alone never returns another cart's order; shopper text, never raw errors; closed store 403 | SH "createOrder: the same key from another cart is a conflict …", "a checkout failure answers with shopper text …"; test-commerce "PUB-06 checkout: anonymous COD and card on a closed store are 403 STORE_CLOSED …" |
| `search`, `upsell`, `wishlist`, `media/[id]` | host store; live release; media id from the host's own database | none of store A's data from store B's host; no canaries | SH "search, upsell, wishlist and media answer anonymous callers with none of A's data" |
| `contact`, `leads`, `quiz/[slug]` POST (collectors; quiz email enqueues `send_notification`) | host store; closed store 403 | write-only intake; quiz: an enabled quiz only | test-commerce "PUB-06 forms: contact, leads and quiz POST on a closed store are 403 …"; test-effective-read "a draft … is read nowhere: cart, search, sitemap, quiz email, order …" |
| `track`, `exp`, `errors` POST (collectors; `track` enqueues `forward_event`) | host store; size caps, rate limits | `{ok}` only | none at route level (`suite: null` in `shopper-routes.js`); see open gap 4 |
| `preview` GET/POST | signed preview token, revocable | without a valid token: no draft | test-logout-preview |
| `connect/shopify/start`, `connect/shopify/callback` | job secret or `_platform`; callback: signed OAuth state | **was open with no `CRON_SECRET` (gap B)**; now 401 in production | SH "production, no CRON_SECRET: every job route, the health rollup and the Shopify connect start answer anonymous 401 (gap B)"; test-first-sync (callback); test-platform-sync "oauth callback hmac …" |
| `shopify/webhooks`, `razorpay/webhook`, `platform/billing/webhook` (enqueue `webhook_apply`, `payment_confirm`, `billing_apply`) | provider HMAC before any read | 401 on a bad signature | test-security "valid HMAC passes; wrong secret, tampered body, missing header all fail"; test-platform-sync "webhook hmac …"; test-payment-recovery; test-billing |
| `jobs/tick`, `jobs/forward-events`, `jobs/sync-catalog`, `jobs/sync-shopify` (run every job type) | `CRON_SECRET` (`lib/cron-auth.js`) | **was open with no `CRON_SECRET`, in production too; `sync-shopify` GET listed every store's stuck orders (gap B)**; now 401 in production | SH gap B test above; test-first-sync (tick) |
| `health` GET, `health?all=1` | `?all=1`: job secret; single store: host | **was: queue depths, oldest pending order age, event and error counts, integration flags, raw dependency errors (gap A)**; now `{status, at}` and the same status code | SH "anonymous /api/health gets only {status, at} … (gap A); the job secret gets the full body" |
| `[...unmatched]` API | — | 404 JSON, open or closed store | test-api-unmatched |
| Shopper pages: layout (`initialCart`), `account`, `account/orders/[orderId]`, `orders/[orderId]`, `checkout/confirmation/[orderId]`, `checkout` | cookie or signed order link | redirect to sign-in / notFound for tampered, expired, other order's or other store's links | SH "/account: …", "/account/orders/[orderId]: … anonymous is redirected to sign in", "/orders/[orderId]: …", "/checkout/confirmation/[orderId]: …", "/checkout and the storefront layout's initialCart …" |
| 23 public pages (home, about, bundles, campaigns, collections, contact, customers, integrations, journal, legal, policies, pricing, products, quiz, search, templates, trust, verticals, wishlist, catch-all, not-found) | live release only; bundles/quizzes `enabled`; journal by publish window; campaigns windowed | published content only; a closed store shows "Opening soon" | test-effective-read "a draft (documents.draft, no live row) is read nowhere …"; test-maintenance (curtain); DS "anonymous on the closed Roles Annex: <path> shows only "Opening soon"" (7 paths) |
| `sitemap.js`, `robots.js`, `manifest.webmanifest`, `offline` | host store | closed store: the front door only | DS "the closed Roles Annex sitemap lists only its front door"; SH map row |

## 5. Background jobs (`lib/platform/worker.js` HANDLERS)

No job takes a caller's id: each is enqueued server-side by a route above after its own check.

| Job | Enqueued by | Least-trusted can trigger? |
|---|---|---|
| `shopify_push` | checkout settle (`lib/payment-settle.js`), admin `orders/[id]` push (`orders.push`) | anonymous: only by placing its own order; support: no (403) |
| `forward_event` | `/api/track`, purchase settle | anonymous: its own events (consent-gated) |
| `webhook_apply`, `billing_apply`, `payment_confirm` | signed webhooks / verified payment callback | no (signature) |
| `send_notification` | quiz email, returns, OTP, automations | anonymous: OTP (capped, one body) and one quiz email (open gap 1) |
| `catalog_sync` | admin `sync` (`sync.run`), `first-run`, connect callback, operator, `jobs/sync-catalog` | support: no; anonymous: no (gap B closed) |
| `search_reindex` | sync, document publish | no |
| `generate` | admin `first-run` POST (`storefront.write`) | no |
| `publish_release` | retired (no-op) | no |
| all | `/api/jobs/tick` runs them | no (gap B closed) |

## 6. Side doors tried

- **Lists, search, paging past own data:** orders `?q=`/`?before=` and `listProductContent` cursors run
  inside `withTenant()`; support's `?q=` matches ids only (SR S4). Storefront search from store B's host
  finds none of A's products (SH).
- **Counts:** orders `counts` are the host store's own (allowed for `orders.read`). Health counts were
  anonymous (gap A, fixed).
- **Exports:** the only export is `platform/tenants/[id]/export` (operator). None for merchants.
- **Emails / notifications:** OTP (no existence oracle, SH); quiz picks email to any address (open gap 1).
- **Error messages revealing existence:** login answers "Wrong email or password" for both an unknown
  email and a wrong password (timing differs: open gap 2); recover gives one body; `orders/[id]` 404 for
  another store's id; `connect/shopify/start` named tenants to anyone (now behind the secret).
- **Neighbour ids:** order links are signed (SH order-link tests); media ids are 72-bit random.
- **Archived / soft-deleted:** archived documents and media are listed to support on purpose (same store,
  `storefront.read`); archived media stay servable by id on the storefront (content-addressed, id
  unguessable; recorded, not a gap).
- **Not-yet-visible state:** drafts, scheduled releases and a never-published store: test-effective-read,
  test-commerce PUB-06, DS closed-store pass. Support's preview session shows drafts, which
  `storefront.read` already allows in the editor.
- **Other tenant's id:** the store always comes from the host; SR/SH run every probe with store A's ids
  on store B's host.

## 7. Browser pass (`pnpm drill:shell`)

See the result block at the end of this file.

## Gaps found and fixed

| Gap | Scenario | Test (red first, `19d4bbb`) | Fix |
|---|---|---|---|
| A | An anonymous `GET /api/health` on any store's host read its pending order count, oldest pending order age, event and error counts, which payment and Shopify integrations are configured, and raw dependency error text. `docs/ARCHITECTURE.md` already lists `health` as "the job secret". | SH "anonymous /api/health gets only {status, at} …" | `e0a6595`: without the job secret the body is `{status, at}` with the same status code (uptime monitors keep working) |
| B | With `CRON_SECRET` unset, every `/api/jobs/*` route, `/api/health?all=1` (every store's checks) and `/api/connect/shopify/start` (names any tenant's setup state) ran for anyone, production included; `GET /api/jobs/sync-shopify` listed every store's stuck order ids. | SH "production, no CRON_SECRET: every job route … answer anonymous 401 (gap B)" | `e0a6595`: one check, `lib/cron-auth.js`, open without a secret only outside production |

## Open gaps (not fixed here)

| # | Scenario | Why not fixed |
|---|---|---|
| 1 | Anyone can make an open store send one "your picks" email to any address through `POST /api/quiz/<slug>` with `consent: true` (30 per minute per IP; fixed text, no link to click). Consent is self-declared by the requester, not the address owner. | Needs a per-address cap or double opt-in: a product decision and a feature of its own. |
| 2 | Merchant login: an unknown email skips the password hash, so response time tells whether an email is a member (same message, same status). Same shape in operator login is unchecked. | Small, but a constant-time path wants its own test approach (timing assertions are flaky); Phase 1 hardening. |
| 3 | Support still sees enabled write buttons inside the old (`[data-legacy]`) screens; the server refuses them (PR). Listed in `docs/cms-reviews/drills/SHELL/support-write-controls.json`. | Phase 2 rebuilds those screens. |
| 4 | `track`, `exp`, `errors` (collectors), `shopify/webhooks`, `jobs/forward-events`, `jobs/sync-shopify` have no route-level suite (`suite: null`); their libs are tested and gap B's test covers the two job routes' refusal. `exp` answers `recorded: true/false`, which says whether a slug is a running experiment (visible on the storefront anyway). | Route-level suites are test debt, not a leak found. |

## Not checked

- Operator console as an operator under a support grant beyond SR's probes and test-security's grant
  tests (Phase 3 rebuilds it).
- Timing side channels other than login; rate-limit bypass via `x-forwarded-for` spoofing.
- Hosted behaviour (Vercel headers, Turso auth, R2 signed URLs): nothing is hosted.
- The p1–p4 drills (retired with the legacy CMS).

## Browser pass result

`steelthread-lock -- pnpm drill:shell` at `9943b17`: **276 passed, 0 failed** in 301 s
(`docs/cms-reviews/drills/SHELL/results-main.json`). This audit's 31 new checks all passed: support's
four deep links show the permission note, `/admin/setup` opens, ten publish/settings/team/audit/help/
integrations/setup API calls answer 403, `/platform` is the operator sign-in, and every support nav
item on the empty Roles Annex renders. For anonymous: all 31 console pages go to `/admin/login`,
`/platform` is the sign-in, seven storefront paths on the closed annex show only "Opening soon", and
its sitemap has one URL.
