# Features

One line is one slice: built from data model to tests, in this order. A line is ticked only
when it has been verified. See the `steelthread:slice-writing` skill for how to write lines.

## Already working (recorded at adoption, 2026-11-24)

Ticked only where a suite that proves it passed on `main` 68f31cc (`pnpm test`: 80 of 80, `pnpm typecheck` and `pnpm build` clean, run 2026-11-24). Browser drills were not re-run after the legacy-CMS retirement, so nothing here is browser-verified on today's code.

- [x] A merchant member can sign in with email and password and sign out; a support member is refused every write (`test:authz`, `test:admin-console`, `test:logout-preview`)
- [x] One store can never read another store's data through the admin API, the cache or media (`test:tenant-boundary`, `test:tenancy`)
- [x] A founder can edit a page, the home page, header, footer and design as drafts and publish them; staff can draft but not publish (`test:documents`, `test:publish-service`, `test:publish-checks`, `test:publish-ui`)
- [x] A founder can undo a publish (`test:publish-undo`)
- [x] A founder can edit a product's title, description and images over Shopify's values, and shoppers see the published values everywhere (`test:product-content`, `test:effective-read`, `test:product-editor`)
- [x] A founder can put a bundle card or grid on the home page; sold-out, disabled and no-saving bundles behave as decided (`test:commerce-blocks`, `test:bundle-form`)
- [x] A new store gets a generated starter home page and design after its first sync, with no AI key (`test:first-run`)
- [x] A founder cannot open the store without a way to pay, a privacy page and a returns page (`test:open-checks`, `test:policy-start`)
- [x] A shopper can add to cart and check out; totals are recomputed on the server and a double payment is refused (`test:commerce`, `test:orders`, `test:payment-recovery`)
- [x] A closed store shows only the maintenance page to shoppers (`test:maintenance`)

## Phase 0: hardening and the new console skeleton

- [x] A per-role permission harness calls every `app/api/admin/*` route as owner, admin, staff, support and signed-out, and a guard test fails when a new route has no permission check (`test:permissions`)
- [x] A support member gets a test proving they cannot read anything outside the matrix (settings, secrets, audit, team) on every existing admin read (`test:support-reads`)
- [x] A shopper can read only their own cart, orders and account, proven by a test that tries another shopper's ids on every shopper read (`test:shopper-reads`)
- [x] The agency partner programme is gone: no agency routes, screens or links remain, its tables are left unused, and its suite is replaced by a test that no agency route answers (`test:agency-removed`, `test:case-studies`; the live `drill:agency-gone` runs at the phase-end browser pass)
- [x] One command seeds a local store with an owner, admin, staff and support member, an operator, a shopper with an order, and a synced catalog (`pnpm seed:roles`; `test:seed-roles`)
- [x] The browser drills run on today's code: drills that tested the retired legacy CMS are removed, and `pnpm drill:p6` and the p5 drill pass (`pnpm drill:all`, each in a throwaway worktree; known flake below)
- [x] shadcn/ui is set up for the consoles only (tokens from `docs/UI.md`, `components/ui/`), and the storefront's styles are unchanged (a storefront render comparison proves it) (`test:console-ui`; `pnpm drill:sf-styles`, evidence in `docs/cms-reviews/drills/SF-STYLES/compare.json`)
- [x] A signed-in merchant lands in a new console shell (sidebar, top bar, store switcher) that shows only the sections their role can use; support sees no write actions (in the shell and nav; the 46 write controls support still sees inside old screens are listed in `docs/cms-reviews/drills/SHELL/support-write-controls.json` for Phase 2) (`test:console-shell`, `pnpm drill:shell`)

## Phase 1: simple onboarding

- [x] A founder can sign up on their own with name, email and password, verify the email, and land in their new (closed) store's console; a local file database stands in for Turso (`test:signup`, `pnpm drill:signup`; off until an operator turns on `ff_self-signup`)
- [x] Signup creates the store's Turso database for real (provisioning runs as a job; a failed step is retried or reported in plain words) (`test:signup-provision`, `test:turso-api`, `pnpm drill:signup` against a local Turso stand-in; real Turso not yet checked: owner runs `pnpm check:turso-real`, see `docs/cms-reviews/MANUAL-CHECKS.md`)
- [x] A founder sees one onboarding page with four steps (Connect Shopify, Import products, Brand, Open your store), each showing done, in progress or blocked, and it resumes where they left off; it replaces the start page and setup checklist (`test:onboarding`, `pnpm drill:p6` stage h)
- [x] A founder can connect their Shopify store from step 1 through OAuth, with a stand-in Shopify for tests first (`test:shopify-connect`, `pnpm drill:connect` against a local Shopify stand-in; real Shopify not yet checked: owner runs `scripts/real-checks/shopify-connect.mjs`, see `docs/cms-reviews/MANUAL-CHECKS.md`)
- [x] A founder sees their products import with live progress in step 2, and a failed import says what to do (`test:import-step`, `pnpm drill:p6` stage i)
- [x] A founder can choose a palette and add a logo in step 3, and the starter store updates in a live preview beside it (`test:onboarding-brand`, `test:preview-frame`, `pnpm drill:p6` stage b)
- [x] A founder can open their store in step 4 once payment and the privacy and returns pages are ready, with each missing item fixable from that step (`test:onboarding-open`, `pnpm drill:p6` stage j)
- [x] An operator can see every signup and the step each store is on, and help a stuck store from one screen (`test:operator-onboarding`, `pnpm drill:operator-onboarding`; the old operator handoff route is removed)
- [x] An operator can create a store for a founder in one form (name, owner email, Shopify domain), which sends the founder an invite into the same onboarding (`test:operator-create-store`, `pnpm drill:operator-create-store`)
- [x] No legacy code remains: retired modules, routes, screens, components, drills, scripts and docs that the new architecture no longer uses are removed (including the old operator handoff route that shows invite links), proven by a test that fails on any file nothing imports or routes to; legacy tables stay in the database untouched

## Phase 2: merchant console on shadcn

- [x] A merchant sees the dashboard (sales today, orders to act on, store status) on the new UI
- [x] A merchant can list, search and open orders, and admins can push or cancel them, on the new UI; support sees orders read-only
- [x] A merchant can browse products and collections and open a product's content in the editor, on the new UI
- [x] A merchant can create and edit offers and bundles on the new UI; support sees them read-only
- [x] A merchant can upload, find, archive and delete media on the new UI
- [x] A merchant uses the editor (page list, section tree, inspector, preview, publish panel) in the new shell
- [x] An admin can manage settings (store details, checkout and payments, shipping, domains), integrations and billing on the new UI; staff and support cannot reach them, and signed-out visitors never see the support-access banner
- [x] An admin can invite a team member with a role and remove one; only the owner can grant or transfer ownership
- [x] A merchant can see analytics, experiments, insights and automations on the new UI (the Publishing page is built with the editor line)
- [x] A merchant can create and edit product-finder quizzes on the new UI; support sees them read-only
- [ ] The old console screens and their components are removed once every route has a new screen

## Phase 3: operator console on shadcn

- [ ] An operator can list, search and open stores, with each store's status, plan and health
- [ ] An operator can suspend or resume a store and rotate its secrets, with an audit row for each
- [ ] An operator can manage plans, subscriptions and billing events
- [ ] An operator can manage feature flags and incidents
- [ ] An operator can open time-boxed support access to a store, and the store's team sees that it is open
- [ ] An operator can run job queues, provisioning runs, privacy requests, themes and case studies on the new UI
- [ ] The old operator console and `components/console/` are removed once every operator screen is on the new UI

## Phase 4: plugin system (roadmap Phase 2A)

- [ ] An admin can install a first-party plugin from `/admin/apps` and turn it off again; staff and support cannot
- [ ] A plugin can add a block to a named storefront slot, rendered without running the plugin's own JavaScript
- [ ] A plugin can receive store webhooks (order created, fulfilled) through an outbox with retries and signed deliveries
- [ ] An external plugin gets a scoped token limited to the permissions the admin approved, and every call with it is audited

## Phase 5: uploadable themes (roadmap Phase 2B)

- [ ] An admin can upload a theme package; anything with scripts, event handlers or external imports is refused with plain words
- [ ] A shopper sees a store rendered by an uploaded theme, with cart, buy box and checkout still Storeasy's own protected parts
- [ ] An admin can switch between installed themes with a preview before publishing

## Phase 6: studio editor (roadmap Phase 3)

- [ ] A founder edits in a full-screen studio with drag-and-drop sections and an instant preview
- [ ] A founder can customise the theme's colours, type and spacing in the studio within the design tokens

## Phase 7: flagship themes and storefront UX (roadmap Phase 4)

- [ ] A founder can choose one of five flagship themes at onboarding or later
- [ ] A shopper can filter search results by several facets
- [ ] A shopper on a phone sees a sticky add-to-cart bar and a cart drawer with tiered offers

## Phase 8: India and global checkout (roadmap Phase 5)

- [ ] A shopper can enter a pincode and get their address filled and a delivery estimate
- [ ] A shopper choosing COD is offered a prepaid nudge, and COD orders can require an OTP
- [ ] A signed-in shopper can save addresses and pick one at checkout
- [ ] A founder can sell in more than one currency and country
- [ ] A founder can schedule a bundle and an offer for a collection

## Phase 9: first-party plugins (roadmap Phase 6)

- [ ] A shopper who bought a product can leave a review through an invite link, an admin moderates it, and the product page shows stars and review structured data
- [ ] A shopper can subscribe to a product and pause, skip, swap or cancel from their account
- [ ] A shopper who agreed to marketing messages gets WhatsApp order updates and an abandoned-cart reminder; nobody else does
- [ ] A shopper sees a delivery estimate and live tracking from Shiprocket on the order page
- [ ] A founder can ask the AI copilot for a starter store, product SEO and FAQs, or offer ideas, and gets drafts only, within a daily token budget and with no shopper data sent

## Later (not planned yet)

- A read-only operator role (Phase 3 gives every operator every action; decided 2026-11-25).
- Support access: signing every member out and rotating the Turso database token as part of secret rotation (Phase 3 rotates only the keys Storeasy holds).
- **Drill install race (from the drill flake under load):** the sign-in 500 under load was Turbopack's `next/font/google` failing one boot's build; drills now check each boot and reboot only that error (2026-11-25, see DECISIONS). The `ERR_MODULE_NOT_FOUND @libsql/client` in a drill worktree was suspected to be a concurrent `pnpm install`; installs are now serialized, but the race was never reproduced. Watch `server.log` in `.drill-results/` if it shows again.
- One shared Storeasy Shopify app so self-serve founders connect without waiting for an operator (owner: later; needs Shopify app review and protected customer data approval).
- `lib/shopify-admin.js` uses Admin API version `2025-10`, past Shopify's 12-month support window; move to a supported version.

- `orders/[id]` POST push answers 500 for an unknown order; it should be 404 (allowed as `allowStatus` in `scripts/support/admin-routes.js` until fixed).
- Order ids carry only 32 random bits; lengthen them (order links are the only thing that protects an order page, so this matters once links can leak).
- The checkout client's fallback idempotency key (`components/checkout/CheckoutFlow.js` ~134) uses `Math.random`; use `crypto.randomUUID()`.
- Preview tokens in `lib/releases.js` still fall back to `"dev-only-secret"`; make them fail closed in production like order links.
- `/api/track` accepts any `transaction_id` as a purchase order id (analytics integrity).
- A signup that failed or stalled keeps its store address for good, even after it lapses; free the address once the signup can no longer finish.
- **Needs an owner decision:** anyone can make a store email one quiz-picks message to any address (an email relay for spam). Options: a per-address daily cap, double opt-in, or only emailing signed-in shoppers. (Phase 0 audit, open gap 1.)
- Sign-in takes a different time for an unknown email than for a wrong password, so timing reveals who is a member; make both paths do the same work. (Phase 0 audit, open gap 2.)
- The collectors (`/api/track`, `/api/exp`, `/api/errors`), `/api/shopify/webhooks` and the 23 public storefront pages have library tests and the browser pass but no route-level least-trusted suite. (Phase 0 audit, open gap 4.)
- The "operator has support access" banner (operator id and reason) also shows to signed-out visitors on `/admin/login`; show it only to signed-in members.
- **Archived pages and saved templates:** bringing back an archived page (archive is terminal today) and renaming or deleting saved templates (they sit in retired `cms_templates`; move templates to their own store first) need a line with its own design.
- **Shell sidebar:** `docs/UI.md` says the console sidebar collapses to icons at 768px and is hidden on editor routes; it stays fully open (labels truncated) at 768 and shows in the editor. Fix in the shell.
- **Soft-navigation writes from support:** opening `/admin/onboarding` as support sends `POST /api/admin/preview-session` and `/admin/releases` sends `PUT /api/admin/documents`; the shell drill lists them under `found.softNav`. Check those pages' own support passes (the editor line covers releases).
- **Insights model id:** `lib/ai/insights.js` hard-codes the model id (`AI_MODEL`); read it from config with a checked default before the AI line.
- **Dark mode contrast:** skeletons barely show against the page background.
- **Radio circles in dark mode:** unselected circles in `components/ui/radio-group.js` are barely visible in dark mode.
- **Roles harness cookies shared across ports:** every roles harness serves `roles.localhost`, and cookies are per host, not per port, so two harnesses running at once swap each other's sign-ins. Give each worktree's harness its own host name (for example `roles-<slot>.localhost`).
- **Font licences (owner):** fonts are now self-hosted from `app/fonts/` (done 2026-11-25). Before the site is hosted, add each family's SIL OFL 1.1 text (`OFL.txt` for Geist/Geist Mono and for Fraunces) next to its files; no copy existed on this machine.
- `requireAdmin`'s origin check passes a write with no Origin header; add a `Sec-Fetch-Site: cross-site` refusal as a second layer.

- Multi-provider AI (Gemini, OpenAI) beside Anthropic.
- Real-device and Safari checks of every console screen.
- The open items in `docs/cms-reviews/OWNER-HANDOVER.md` that are not slices yet.
