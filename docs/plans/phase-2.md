# Phase 2 plan: merchant console on shadcn (lines 1–5)

One section per line. Agents read only Line 0 plus their own line.

## Shared rules for lines 1–5

**Order:** Phase 1 line 10 merged → Line 0 merged → lines 1–5 built side by side, each in its own worktree, branch and database. Merge in any order, except **line 4 before line 3**.

**Shared files.** Only appended rows, at the anchor given for each line. Keep both sides when appends conflict.

| File | Who appends what |
|---|---|
| `lib/admin/new-ui-routes.js` | each line adds its prefix (1 `/admin/dashboard`, 2 `/admin/orders`, 3 `/admin/catalog`, 4 `/admin/offers` and `/admin/bundles`, 5 `/admin/media`) |
| `package.json` | `test:<suite>` and `drill:<area>`, placed right after that line's anchor key (1 `test:reporting`, 2 `test:order-projection`, 3 `test:order-catalog`, 4 `test:offer-form`, 5 `test:media-picker`) |
| `scripts/drills/run-isolated.mjs` | one `DRILLS` entry after a set entry (1 after `smoke`, 2 after `p5`, 3 after `p6`, 4 after `sf-styles`, 5 after `agency-gone`). Nobody edits `ALL`; the session adds the five names at phase end. |
| `scripts/support/admin-routes.js` | line 2 only, and it edits a row (drops the `allowStatus` on `orders/[id]` push) |
| `scripts/support/admin-pages.js` | line 4 only: `bundles`, `bundles/[id]`, `offers/[id]` |
| `lib/admin/nav.js` | line 4 only: a Bundles item in Growth, after Offers |
| `docs/UI.md` | each line fills only its own sub-heading under "Merchant screens (Phase 2)" |
| dead-code allowlist (`test:no-dead-code`) | each line adds rows for the old components its page stops importing, reason "removed by Phase 2 line 10" |

**Every line:**
- New UI is never inside a `data-legacy` region.
- No old `components/console/*` or old `components/admin/*` imports in new files, except `useToast` and the pure models named in a line.
- Old components stay in place; Phase 2 line 10 deletes them.
- No edits to `docs/FEATURES.md`, `docs/DECISIONS.md` or `test-support-reads.js`. Least-trusted tests go in the line's own suite, using `scripts/support/page-harness.js`.
- Builders run only their own suite and drill. The session does the full run.

## Line 0 (prerequisite): new-UI regions and the shared console parts

**Fit:** no `docs/FEATURES.md` line of its own; it is the base for lines 1–5. One builder (opus), merged before the five fork.

1. `lib/admin/new-ui-routes.js` (new): `NEW_UI_ROUTES` (frozen, one prefix per line, starts empty) and `isNewUiRoute(pathname)` (the prefix at a `/`, the same rule as `activeItem`).
2. `components/admin/shell/AdminShell.js`: on a new-UI route, `main` holds the page directly. `ConsoleNotices` keeps its own `<div data-legacy className="contents">`.
3. `scripts/test-console-shell.js` and `scripts/drills/shell/run.mjs` read `isNewUiRoute`:
   - an old route still wants `main > [data-legacy]`;
   - a new route wants none, and support's stray-control rule covers the whole of `main`.
4. `components/ui/`: add `card`, `tabs`, `select`, `switch`, `checkbox`, `popover` (shadcn 4.23.0, generated in a scratch project, restyled per `components/ui/README.md`; `radix-ui` 1.8.1 already covers them). Update the README list.
5. `components/kit/` (new; our own parts from UI.md, built on `components/ui` only):
   - `page-header.js`: title, description, breadcrumb, actions.
   - `status-badge.js`: words and tones for order, offer, bundle, media and sync states.
   - `empty-state.js`.
   - `money-cell.js`: `formatMoney`, mono, right-aligned.
   - `role-gate.js`: hides a control, or disables it with the reason in a tooltip.
   - `data-table.js`: columns, rows, row link, a slot for row actions, skeleton rows, empty state, a sticky header, 40px rows (48px on touch), truncation with a tooltip, and a footer showing "1–50 of N" with Previous/Next or "Load more". Sorting and filtering come from the server through props. No TanStack.
6. `scripts/test-console-kit.js` (`test:console-kit`): each part rendered with `renderToStaticMarkup`; `RoleGate` with and without the action.
7. `scripts/test-console-ui.js`: the "no storefront import" rule also covers `components/kit/`.
8. `docs/UI.md`: list the six new parts and `components/kit/`, and add the section "Merchant screens (Phase 2)" with sub-headings Dashboard, Orders, Catalog, Offers and bundles, Media.

**Checks first:** `node scripts/test-console-shell.js`, `node scripts/test-console-ui.js`, `pnpm drill:shell`.
**Done when:** `NEW_UI_ROUTES` is empty, every screen still renders, and `pnpm drill:console-styles` passes.

---

## Line 1: the dashboard on the new UI

**Design:** a server-rendered page with no new route. Numbers come from `lib/reporting.js`. One new read-model, `lib/admin/dashboard.js`, builds the action queue and the store status. The sync card reuses `ImportStepBody` from `components/admin/onboarding/ImportStep.js` (new UI), not `SyncProgress`.

### 1. Feature list (floor)
1. **Sales:**
   - Today so far (net and order count, in the store's timezone), 7 days, the chosen range, and average order.
   - Range 7/30/90 through `?days=`.
   - Daily net-revenue bars for the range, quiet days shown as zero. The chart has a visually hidden table version.
   - Refunds netted out; "no sales yet today" in plain words.
2. **Orders to act on.** Each row has a count, plain words, and a link:
   - push failed (`sync_failed`) → `/admin/orders?status=sync_failed`;
   - push stuck for over an hour; refund not mirrored (from `discrepancies()`) → the order;
   - open return requests → `/admin/orders?view=returns`;
   - COD orders not yet pushed for over 15 minutes → `?status=cod_pending`;
   - failed contact-message emails: the link to Integrations shows only with `settings.read`; otherwise the text says to ask an admin.
   - The empty state says "Nothing needs you right now".
3. **Store status:**
   - Open or Closed. Closed shows "Onboarding n/4" and links to `/admin/onboarding`.
   - Store address with "Open storefront".
   - Shopify connected or not, with no shop domain for support.
   - Catalog: product count and last synced.
   - Shopify push coverage %.
   - Unpublished changes, linking to `/admin/releases`.
   - A suspended or maintenance banner if `tenant.status` is not `active`.
4. **Sync card** while a first import is running, failed or stalled (same rule as today). "Run again" needs `sync.run`; other roles see why not.
5. **Freshness line:** last order, catalog synced, analytics coverage, in plain words.
6. **States:** loading skeleton (`dashboard/loading.js`); an error with Try again; a new store with no orders points to onboarding; support's view has no write controls.

Out of scope: analytics charts (line 9), comparison periods.

### 2. Data
None. All reads use existing tables, inside `withTenant` through `tfetch`.

### 3. Permissions and least-trusted tests

| Read or control | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| page (`storefront.read`) | yes | yes | yes | yes | → `/admin/login` |
| sales and action queue (`orders.read`) | yes | yes | yes | yes, order ids only | — |
| "Run again" sync (`sync.run`) | yes | yes | reason shown | reason shown | — |
| Integrations link (`settings.read`) | yes | yes | text only | text only | — |

Tests in `test-dashboard.js`:
- Support's props hold no customer name, email or phone, no shop domain, and no contact-message addresses (canaries from `page-harness`).
- `canSync` is false for staff and support.
- No href to a settings page for staff or support.
- Signed out redirects to login.

### 4. Events
None. The dashboard reads only.

### 5. File plan
1. `lib/admin/dashboard.js` (new): `actionQueue({ role })` and `storeStatus({ role })`. Each part is caught on its own: an unreadable part shows "couldn't check", never a guess.
2. `app/(console)/admin/(authed)/dashboard/page.js` (rewrite) and `dashboard/loading.js` (new).
3. `components/admin/dashboard/{SalesSummary,SalesChart,ActionQueue,StoreStatus,RangeSwitch}.js` (new; `components/ui` and `components/kit` only).
4. `scripts/test-first-sync.js`: only the dashboard assertion (~1686) changes, to expect `catalogSyncStatus()` plus `ImportStepBody` under the same show rule.
5. `scripts/test-dashboard.js`; `package.json` `test:dashboard` and `drill:dashboard`.
6. `scripts/drills/dashboard/run.mjs`, registered with `withRolesStore`:
   - owner: an order placed by the seed shows in Today; range switch;
   - support: read-only, no Run again, no settings link;
   - 375 / 768 / 1280 screenshots into `docs/cms-reviews/drills/DASHBOARD/`.
7. Shared appends: the `new-ui-routes.js` row and the UI.md sub-block.

### 6. Checks first
`node scripts/test-reporting.js`; `node scripts/test-first-sync.js`; `node scripts/test-support-reads.js` (the dashboard row must keep passing).

### 7. Risks
1. `ImportStepBody`'s props may be tied to onboarding step facts. Map `catalogSyncStatus().view` to it in the page; don't edit onboarding files.
2. Timezone edge at midnight: test `dayInTz` with a fixed clock.

**Drill:** `drill:dashboard`

---

## Line 2: orders list, search and open; admins push or cancel; support read-only

**Design:** keep `GET /api/admin/orders`, `GET|POST /api/admin/orders/[id]` and `/api/admin/returns`. Fix push on an unknown order (404, not 500). Fix a stable cursor. Lengthen new order ids (Later bullets 1 and 3).

### 1. Feature list (floor)
1. **List:**
   - Status tabs with counts (All, Pending payment, COD pending, Paid, Pushing, Pushed, Push failed, Cancelled).
   - Payment filter: COD or online.
   - Search: id, email, phone, Shopify order number. Support searches by id only, as today.
   - 50 rows a page with a stable cursor.
   - Columns: id (mono), placed, customer (masked for support), payment, status, total (`MoneyCell`), push state; push errors truncated with a tooltip.
   - The address keeps state: `?status=`, `?payment=`, `?q=`, `?view=returns` (the contract line 1 links to).
2. **Returns tab:**
   - Open requests with order link, reason and requested date.
   - Approve or reject with a note (`returns.decide`, AlertDialog); support sees status only.
   - The nav badge count is unchanged.
3. **Order page `/admin/orders/[id]`:**
   - Header: id with Copy, status, financial and fulfilment badges.
   - Customer card: support sees "hidden for support" and no fields.
   - Payment and sync card, with "View in Shopify" when pushed.
   - Lines with the Shopify title/SKU line (OVL-06), totals, discounts with coupon, shipping, refunded.
   - Shipments with tracking, refunds, timeline.
   - Unknown id → not-found page.
4. **Push to Shopify** (`orders.push`):
   - Shown only when the state machine allows it (export `canPush` from `lib/shopify-push.js`, built on `PUSHABLE`).
   - Each answer (`already`, `skipped`, `inFlight`, `dead`) in plain words; the page refreshes.
5. **Reconcile** (`orders.push`), only when pushed. This fixes a bug: today staff see the button and get refused.
6. **Cancel** (`orders.cancel`, when `canTransition` allows):
   - AlertDialog with a reason (≤200).
   - A captured payment needs a Razorpay refund id, with words saying to refund in Razorpay first.
   - Each result code in plain words.
7. **Fix:** `RetryPushButton` today shows for every role on `sync_failed`. The new page gates it with `roleAllows`.
8. **Fix:** push for an unknown order → 404 `{ error: "We couldn't find that order." }`. Other failures keep a 5xx through `infraResponse`, with a plain message.
9. **Fix:** new order ids are `<PREFIX>-` plus 16 hex characters (64 random bits). Old ids stay valid and are never rewritten. `lib/errors.js` fingerprinting matches both lengths and every prefix.
10. **States:** list and detail skeletons; empty ("No orders yet", or "No orders match" with Clear); error with Try again; support and staff views.

Out of scope: refunds from the console, editing orders, CSV export (it stays on analytics).

### 2. Data: `migrations/tenant/0029_orders_list_index.sql` (nothing destructive)
```sql
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC, id DESC);
```
The cursor becomes the pair `(created_at, id)`, encoded as one opaque `before` string. The old plain `before=<iso>` is still accepted. No column changes (order ids are TEXT).

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| list, search, open (`orders.read`) | full | full | full | redacted, id search only | 401 / → login |
| decide return (`returns.decide`) | yes | yes | yes | hidden, 403 | 401 |
| push, reconcile (`orders.push`) | yes | yes | hidden, 403 | hidden, 403 | 401 |
| cancel (`orders.cancel`) | yes | yes | hidden, 403 | hidden, 403 | 401 |

Tests in `test-orders-console.js`:
- Support: `GET ?q=<email>` matches nothing; no PII in list or detail props; no push, reconcile or cancel control in the detail page's props or markup.
- Staff: no push, reconcile or cancel control, but return decisions are allowed.
- The owner's orders page still carries the order-email canary (the positive control in `test-support-reads`).
- Signed out → 401.

`admin-routes.js`: the push row loses `allowStatus`, so `test:permissions` now expects a non-5xx answer.

### 4. Events
Unchanged: `audit` `orders.push`, `orders.reconcile`, `orders.cancel`; `slog` `admin_order_push`, `admin_order_cancel`. A 404 push writes no audit (nothing happened). Consumers: the audit view and the operator console.

### 5. File plan
1. `migrations/tenant/0029_orders_list_index.sql`.
2. `lib/admin/orders.js`: composite cursor, `payment` filter, Shopify-number search.
3. `lib/shopify-push.js`: export `canPush`.
4. `lib/orders.js`: `orderNumber()` → 16 hex. `lib/errors.js`: the fingerprint regex. `lib/schema.sql`: comment only.
5. `app/api/admin/orders/route.js` (`payment` param); `app/api/admin/orders/[id]/route.js` (404 before push and reconcile).
6. `app/(console)/admin/(authed)/orders/page.js`, `orders/loading.js`, `orders/[id]/page.js`, `orders/[id]/loading.js`.
7. `components/admin/orders/{OrdersList,OrderFilters,ReturnsList,OrderHeader,OrderActions,CancelDialog,OrderLines,OrderTimeline}.js`.
8. `scripts/test-order-catalog.js`: point its page stubs at the new components; keep the OVL-06 assertions.
9. `scripts/support/admin-routes.js`: the push row.
10. `scripts/test-orders-console.js`; `package.json` `test:orders-console` and `drill:orders`.
11. `scripts/drills/orders/run.mjs` (roles store):
    - owner: search, open, cancel a COD order;
    - admin: push refusal words;
    - staff and support: no write controls;
    - evidence in `docs/cms-reviews/drills/ORDERS/`.
12. Shared appends.

### 6. Checks first
`node scripts/test-orders.js`, `test-order-projection.js`, `test-order-catalog.js`, `test-permissions.js`, `test-shopper-reads.js`; `node scripts/test-schema-compat.js` after adding 0029. Look for id-length assumptions: `grep -rnE "BL-|\[A-F0-9\]\{8\}|slice\(0, 8\)" lib app components scripts`.

### 7. Risks
1. Order ids reach Shopify as a tag (≤40 characters; 20 is fine) and are shown to shoppers. Check `test-orders` and the checkout suites for format assertions.
2. A real push in the drill needs a Shopify stand-in that answers `draftOrderCreate`. If `scripts/drills/connect`'s fake doesn't, the drill checks the refusal paths, and unit tests stub `gql`.
3. Another session may hold the migration number: renumber at merge if 0029 is taken.

**Drill:** `drill:orders`

---

## Line 3: browse products and collections; open a product's content in the editor

**Design:** keep `GET /api/admin/catalog` and add browse modes. The product list reuses `listProductContent` (published names, edited, live, changed in Shopify, orphaned), then reads the page's price, stock and type in one query. `?product=` and `?collection=` on the page still redirect to the editor (existing links rely on it).

### 1. Feature list (floor)
1. **Products tab:**
   - Search (published name, Shopify name, handle).
   - Content filters with counts: All, Edited, Changed in Shopify, No longer in Shopify.
   - Stock filter: in stock / sold out.
   - 50 a page by cursor.
   - Columns: image, name (Shopify's name under it when different), type, price range (`MoneyCell`), stock, content badge (Published, Draft changes, Shopify only).
2. **Product sheet** (row click):
   - Shopify facts (variants with SKU, price, stock; collections; vendor); published badge and modules.
   - "Edit content" via `entityEditorHref({ product })`; support sees "View content".
   - "View on store" and "View in Shopify" links.
   - The "price and stock change in Shopify" note.
3. **Collections tab:**
   - title, handle, product count, pinned count.
   - Opening one lists its products in position order (paged), and has "Edit collection content" via `entityEditorHref({ collection })`.
4. **Catalog header:** last synced and product count. "Sync from Shopify" needs `sync.run`, through the existing `POST /api/admin/sync`; other roles see why not.
5. **Bundles leave this page:** a link card "Bundles are with your offers" → `/admin/bundles` (line 4 merges first).
6. **Quizzes:** roles with `storefront.write` keep the existing `QuizPanel` in an old-screen tray (`data-legacy`). Support gets a new-UI one-line summary ("n quizzes"), no controls. See open question 1.
7. **States:** skeleton; empty catalog → "Connect Shopify in onboarding"; search with no match → Clear; "published view unavailable" note (`UNAVAILABLE_NOTE`); support's view.

Out of scope: editing anything here (the editor, line 6); catalog values (Shopify owns them).

### 2. Data
None.
- `listProductContent` gains an optional `available: true | false | null` (default `null`, so the editor is unchanged).
- The catalog GET collection list adds `id` and a product count (`collection_products`, indexed).

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| browse, sheet, collections (`storefront.read`) | yes | yes | yes | yes | 401 / → login |
| Edit content link (editor) | Edit | Edit | Edit | "View content" | — |
| Sync from Shopify (`sync.run`) | yes | yes | reason | reason | 401 |
| quiz tray (`storefront.write`) | yes | yes | yes | summary only | — |

Tests in `test-catalog-browse.js`:
- Support gets `GET ?view=products` 200 with no write flags.
- The page as support renders no `QuizPanel` and no sync control.
- `?view=collection&id=<other store's gid>` → 404 (other store is a tenant fixture).
- Signed out → 401.

### 4. Events
None new. Sync keeps its existing audit and `slog`.

### 5. File plan
1. `lib/admin/catalog-browse.js` (new): `browseProducts({ q, filter, available, cursor })`, `productDetail(gid)`, `listCollections()`, `collectionProducts(gid, cursor)`.
2. `lib/admin/product-content-list.js`: the `available` option only.
3. `app/api/admin/catalog/route.js`: `?view=products|collections|collection&id=` plus the existing `?product=`. With no `view`, the answer is the old one.
4. `app/(console)/admin/(authed)/catalog/page.js` (rewrite; keeps the `catalogHref` redirect) and `catalog/loading.js`.
5. `components/admin/catalog/{CatalogTabs,ProductsTable,ProductSheet,CollectionsTable,CollectionProducts,SyncHeader,QuizTray}.js`.
6. `scripts/test-product-editor.js`: only the catalog-page part (~1310); the `CommercePanels` stub becomes `QuizPanel` only.
7. `scripts/test-catalog-browse.js`; `package.json` `test:catalog-browse` and `drill:catalog`.
8. `scripts/drills/catalog/run.mjs` (roles store):
   - search, filter, sheet, open in editor (lands on `/admin/editor?product=`);
   - collection drill-down;
   - support read-only;
   - evidence in `docs/cms-reviews/drills/CATALOG/`.
9. Shared appends.

### 6. Checks first
`node scripts/test-product-content.js`, `test-product-editor.js`, `test-api-shapes.js` (it may pin the catalog or `listProductContent` shapes); `grep -n "admin/catalog" scripts/test-provision.js scripts/test-bundle-form.js scripts/drills/p5/blocks.mjs`.

### 7. Risks
1. Opening the editor as support runs the first-store generator, which writes drafts (Later bullet; it belongs to line 6). The drill's support pass must not open the editor. Say so in the report.
2. Phase 1 line 10 Package B also edits `test-product-editor.js` and `editor-entry.js`. Rebase after it; don't edit `editor-entry.js`.

**Drill:** `drill:catalog`

---

## Line 4: create and edit offers and bundles; support read-only

**Design:** keep every offers and bundles route. New pages: `/admin/offers`, `/admin/offers/[id]` (`new` means create), `/admin/bundles`, `/admin/bundles/[id]`. Reuse the pure models `components/admin/offerFormModel.js`, `lib/offers/plain.js` and `lib/commerce/bundle-words.js`, without editing them. One new product/variant picker on Popover (Command and `cmdk` stay deferred).

### 1. Feature list (floor)
1. **Offers list:**
   - Each offer as a sentence (`offerSentence`), with type and status (Live, Scheduled, Ended, Off; `offerScheduleStatus`), schedule and a stale-name warning.
   - Tabs by status with counts; search by name or code.
   - On/off `Switch`; turning off a live offer asks first.
   - Rows owned by a bundle say "Part of bundle X", link to it, and have no switch (`NOT_HERE`).
2. **Offer form:**
   - Pick a kind (`OFFER_KINDS`), then fields per type (tiers, buy X get Y, gift variant, coupon code A–Z/0–9, 3–20).
   - Target: product, variant, tag, type, or all (`/api/admin/offers/targets` and `refs`).
   - Schedule in store time; title auto or custom.
   - Live sentence, warnings, and "Try it" example carts (`offers/simulate`, `offers.read`, so support can preview too).
   - Field errors via `plainErrors`; nothing typed is lost on error; unsaved-changes guard.
3. **Edit extras:**
   - "Go back to previous settings" (revert with `expect`; 409 CHANGED in plain words).
   - Delete (AlertDialog).
   - The done message (`doneMessage`).
4. **Bundles list:**
   - Components with quantity, bundle price against the components' sum, saving.
   - Compatibility state with reasons (`reasonSentence`), enabled, "On your home page".
   - Enable is refused with reasons; disabling a bundle that is on the home page asks first (`disableAsksFirst`).
   - Delete (AlertDialog, warns when on the home page).
5. **Bundle form:**
   - title, description, variant picker with quantity, price.
   - Debounced live check (`POST {check}`).
   - "Turn on after saving"; 409 slug taken and 422 reasons in words.
6. **Support:** the same lists and read-only detail pages (fields disabled, no switches, Save or Delete); the simulator works.
7. **Nav:** a Bundles item under Growth.
8. **States:** skeletons; empty with "New offer" or "New bundle"; error with Try again; unknown id → not-found.

Out of scope: scheduling bundles (Phase 8). The editor's `BundleControl`/`BundleForm` stay as they are (line 6).

### 2. Data
None.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| lists, detail, simulate, targets (`offers.read`) | yes | yes | yes | yes | 401 / → login |
| create, edit, toggle, revert, delete; bundle check and save (`offers.write`) | yes | yes | yes | hidden, 403 | 401 |

Tests in `test-offers-console.js`:
- Support's pages for `/admin/offers`, `offers/[id]`, `/admin/bundles` and `bundles/[id]` carry `canWrite: false`, and their markup has no enabled switch, Save or Delete.
- `POST /api/admin/bundles {check}` as support → 403.
- The bundle-owned offer row shows no switch for any role.
- Signed out → 401.

New `admin-pages.js` rows:
- `{ page: "bundles", action: "offers.read" }`
- `{ page: "bundles/[id]", action: "offers.read", params: { id: "bun-missing" } }`
- `{ page: "offers/[id]", action: "offers.read", params: { id: "off_missing" } }`

The sweep accepts a not-found.

### 4. Events
Unchanged: `audit` `offers.write` (offer and bundle resources); `slog` `offer_saved`, `offer_toggled`, `offer_deleted`.

### 5. File plan
1. `app/(console)/admin/(authed)/offers/page.js` (rewrite), `offers/loading.js`, `offers/[id]/page.js`.
2. `app/(console)/admin/(authed)/bundles/page.js`, `bundles/loading.js`, `bundles/[id]/page.js` (new).
3. `components/admin/offers/{OffersList,OfferEditor,OfferKindPicker,TargetField,ScheduleField,SimulatePanel,RefCombobox}.js`.
4. `components/admin/bundles/{BundlesList,BundleEditor,BundleCheck}.js` (new; `BundleForm.js` untouched).
5. `lib/admin/nav.js` (Bundles item); `scripts/support/admin-pages.js` (3 rows).
6. `scripts/test-offers-console.js`; `package.json` `test:offers-console` and `drill:offers`.
7. `scripts/drills/offers/run.mjs` (roles store):
   - staff creates a tiered offer, simulates, turns it off, reverts, deletes;
   - creates a bundle, then the refused-enable words;
   - support read-only on all four pages;
   - evidence in `docs/cms-reviews/drills/OFFERS/`.
8. Shared appends.

### 6. Checks first
`node scripts/test-offers.js`, `test-offers-admin.js`, `test-offer-form.js`, `test-bundle-form.js`, `test-console-shell.js` (it may pin the nav list); read the query shape of `lib/admin/refs.js`.

### 7. Risks
1. The picker without Command/`cmdk`: build Popover + Input + listbox with full keyboard support (arrows, Enter, Esc). The drill checks the keyboard path.
2. Two editors for bundles (console and editor) until line 6: same API, same words module.

**Drill:** `drill:offers`

---

## Line 5: media upload, find, archive and delete

**Design:** keep `/api/admin/media`. Add a paged library view (`GET ?view=library`) served by a new `lib/admin/media-library.js`, so `lib/media.js` and the old `GET` shape (`MediaPicker`, `MediaAdmin`) don't change. Upload stays `lib/media-upload.js` `uploadImage`.

### 1. Feature list (floor)
1. **Library:**
   - Grid (with a list toggle) of originals with thumbnails.
   - Tabs Active / Archived with counts.
   - Search by file name or alt text; type filter (PNG, JPEG, WebP, GIF, SVG); sort newest, oldest, name, size.
   - 50 a page by cursor.
2. **Upload:**
   - Button and drag-and-drop, several files at once, a progress bar per file (`uploadImage` `onProgress`).
   - Size and type limits shown from `limits`; per-file refusals in words.
   - Duplicate: "reused". Archived match: "back in your library".
3. **Details sheet:**
   - Preview, name, type, size, dimensions, uploaded date, Copy URL.
   - Alt text edit (`storefront.write`), with a note when empty.
   - "Where it's used" (PUT usage, a read).
4. **Archive / bring back** (`PATCH {archived}`) with the archive note words.
5. **Delete:**
   - AlertDialog; an unused file is deleted.
   - A file in use gets 409 `MEDIA_IN_USE`: the usage list by page name and "Archive it instead", never a force.
6. **States:** skeleton grid; empty ("Upload your first image"); empty search → Clear; error with Try again; support's view (no upload zone, alt read-only, no archive or delete).

Out of scope: bulk actions; folders; picking images inside the editor (`MediaPicker`, line 6).

### 2. Data
None. The library is a store's own images (hundreds). Filtering is SQL `WHERE` on `filename`/`alt`/`mime`/`archived_at` with a `(created_at, id)` cursor; no index needed. Blobs are never selected.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| library, details, usage (`storefront.read`) | yes | yes | yes | yes | 401 / → login |
| upload, alt, archive, delete (`storefront.write`) | yes | yes | yes | hidden, 403 | 401 |

Tests in `test-media-library.js`:
- Support gets `GET ?view=library&archived=only` 200; usage PUT 200.
- The page as support has no upload input and no archive or delete control in its props or markup.
- Another store's `med_` id → 404 (tenant fixture).
- Signed out → 401.

### 4. Events
Unchanged: `audit` `storefront.write` (`media:<id>`); `slog` `media_uploaded`, `media_archived`, `media_unarchived`, `media_deleted`.

### 5. File plan
1. `lib/admin/media-library.js` (new): `listLibrary({ q, type, archived: "active"|"archived", sort, cursor, limit: 50 })` → `{ items, nextCursor, counts }`.
2. `app/api/admin/media/route.js`: GET `?view=library` branch only.
3. `app/(console)/admin/(authed)/media/page.js` (rewrite) and `media/loading.js`.
4. `components/admin/media/{MediaLibrary,MediaToolbar,MediaGrid,UploadZone,MediaSheet,DeleteMediaDialog}.js`.
5. `scripts/test-media-library.js`: includes the check that `UploadZone` uploads only through `uploadImage`; `package.json` `test:media-library` and `drill:media`.
6. `scripts/drills/media/run.mjs` (roles store):
   - staff uploads two files, finds one by name, edits alt, archives and brings back;
   - deleting a file used on home → the usage words;
   - deletes an unused one;
   - support read-only;
   - evidence in `docs/cms-reviews/drills/MEDIA/`.
7. Shared appends.

### 6. Checks first
`node scripts/test-media-upload.js`, `test-media-picker.js`, `test-media-refs.js`, `test-api-shapes.js`; confirm Phase 1 line 10 removed `STORE_MIGRATING` from the media route.

### 7. Risks
1. Media storage moved in 0027 (`storage_url`), so a row may point to R2. Thumbnails and URLs must use `mediaUrl()`, never the blob.
2. Drag and drop in Playwright: use `setInputFiles` on the hidden input, plus one `DataTransfer` drop check.

**Drill:** `drill:media`

---

## Decisions for `docs/DECISIONS.md` (on the owner's behalf; schema and permissions first)

1. **Orders list index (0029), stable cursor and longer ids:**
   - Two indexes on `orders(created_at, id)` and `(status, created_at, id)`; nothing destructive.
   - The cursor becomes `(created_at, id)`.
   - New order ids carry 64 random bits (`PREFIX-` + 16 hex); old ids are never rewritten.
2. **Push 404:** push or reconcile on an unknown order answers 404; the `allowStatus` exception is removed.
3. **Button gating:** push and reconcile buttons need `orders.push` (staff and support no longer see them), and cancel needs `orders.cancel`.
4. **No new actions or routes:** lines 1–5 use the existing actions; lines 3 and 5 add query modes to existing GET routes, and the old answers stay.
5. **Bundles page:** bundles get their own page `/admin/bundles` under Growth with `offers.*` permissions, and leave the catalog page. The editor's bundle field stays on the old form until line 6.
6. **Quizzes:** they stay on the catalog page in an old-screen tray for writers and as a summary for support, until a line rebuilds them.
7. **New-UI regions:** the shell decides by a route list (`lib/admin/new-ui-routes.js`), one prefix per rebuilt area. Each line adds its own row.
8. **`components/kit/`:** holds our own console parts (PageHeader, StatusBadge, EmptyState, MoneyCell, RoleGate, DataTable). DataTable is server-driven with no TanStack Table (shadcn's data-table guide needs `@tanstack/react-table`, a new dependency with no need here). Card, Tabs, Select, Switch, Checkbox and Popover come from shadcn 4.23.0 on the existing `radix-ui`, so no new dependency.
9. **Toasts:** new screens use the existing `useToast` for success, and show errors inline so nothing typed is lost. Sonner stays deferred.
10. **Old components stay until line 10:** pages stop importing them, and the dead-code allowlist names each one with "removed by Phase 2 line 10".

## Risks and open questions (most serious first)

1. **Phase 1 line 10 is not merged yet,** and it touches `AdminShell.js`, `admin-pages.js`, `lib/media.js`, `MediaAdmin.js` and `test-product-editor.js`. Its dead-code guard will flag every old component a Phase 2 page stops importing. Run `git log --oneline -1 -- scripts/test-no-dead-code.js` and `node scripts/test-no-dead-code.js` before Line 0. If the allowlist sits inside the guard file instead of a data file, five builders will edit the same array: move it to a data file in Line 0.
2. **Open question: who rebuilds quizzes?** No Phase 2 line covers them, and line 10 needs every route on the new UI. I recommend adding "A merchant can create and edit product-finder quizzes on the new UI" to Phase 2 before line 10. Until then, decision 6 holds.
3. **Line 0 changes the shell test and drill everyone depends on.** If it slips, all five lines wait. Run `node scripts/test-console-shell.js` and `pnpm drill:shell` at Line 0's end, before forking.
4. **Shopify stand-in for real pushes.** Line 2's drill can only show a real push if the Shopify stand-in answers `draftOrderCreate`/`draftOrderComplete`. Check with `grep -n "draftOrder" scripts/drills/connect/*.mjs scripts/support/*.js`; if it doesn't, the push is proven in unit tests only, and the report says so.
5. **Five parallel drills against three heavy slots.** Expect the known flake (the sign-in 500 under load). Run each drill through `~/.claude/bin/heavy`, keep the server log on failure, and rerun alone before calling a failure real.

Files referenced: `/Users/snehal/Documents/Projects 2026/storeasy26/docs/FEATURES.md`, `/Users/snehal/Documents/Projects 2026/storeasy26/docs/plans/phase-1.md`, `/Users/snehal/Documents/Projects 2026/storeasy26/docs/UI.md`, `/Users/snehal/Documents/Projects 2026/storeasy26/lib/platform/authz.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/scripts/support/admin-routes.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/scripts/support/admin-pages.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/components/admin/shell/AdminShell.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/orders/[id]/route.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/lib/orders.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/lib/shopify-push.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/catalog/route.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/lib/admin/product-content-list.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/media/route.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/app/api/admin/bundles/route.js`, `/Users/snehal/Documents/Projects 2026/storeasy26/scripts/drills/run-isolated.mjs`.

Sources:
- [shadcn/ui Data Table guide](https://ui.shadcn.com/docs/components/data-table)
---

## Shared rules for lines 6–11

**Order:** lines 1–5 merged. Then lines 6, 7, 8, 9 and 10 are built side by side, each in its own worktree, branch and database. Line 11 starts when all five are merged.

- **Merge order:** 8 before 7 (line 7's Team tab links to line 8's page). Line 10 only after line 3 (both edit `catalog/page.js`). Lines 6 and 9 merge in any order.
- **Packages inside a line** run one after another in the line's worktree. For 6b and 6c, or 7b, a second worktree may fork from the line branch once the first package's commit is in, and merges back in order.
- **Dead-code rows** are now reasoned "removed by Phase 2 line 11". Line 11 deletes every "line 10" and "line 11" row.

| File | Who appends what |
|---|---|
| `lib/admin/new-ui-routes.js` | 6 `/admin/editor`, `/admin/releases`; 7 `/admin/settings`, `/admin/integrations`, `/admin/billing`; 8 `/admin/settings/team`; 9 `/admin/analytics`, `/admin/experiments`, `/admin/insights`, `/admin/automations`; 10 `/admin/quizzes` |
| `package.json` (after anchor) | 6 `test:publish-ui`, 7 `test:support-reads`, 8 `test:permissions`, 9 `drill:dashboard`, 10 `drill:media`, 11 `test:no-dead-code` |
| `scripts/drills/run-isolated.mjs` `DRILLS` (after entry) | 6 `shell`, 7 `signup`, 8 `connect`, 9 `operator-onboarding`, 10 `operator-create-store`. Line 11 edits `ALL`. |
| `scripts/support/admin-routes.js` | 8 the `team` rows, 9 the `experiments` rows, 10 the `quiz` rows (each only its own path) |
| `scripts/support/admin-pages.js` | 7 `settings/*`; 8 `settings/team`; 9 `experiments/[slug]`; 10 `quizzes`, `quizzes/[slug]` |
| `lib/admin/nav.js` | line 10 only (Quizzes in Catalog) |
| `components/admin/shell/AdminShell.js`, `scripts/drills/shell/run.mjs` | line 6 only (editor full-bleed; READ_POSTS `ops`); line 11 |
| `components/ui/` and its README | 6a `toggle-group`, `scroll-area`, `collapsible`; 7a `alert` (shadcn 4.23.0 on `radix-ui` 1.8.1, no new dependency) |
| `read-controls.js`, `dead-code-allowlist.js`, `docs/UI.md` sub-headings | each line appends its own rows or sub-heading |

The "Every line" rules from lines 1–5 still apply.

---

## Line 6: the editor in the new shell (page list, section tree, inspector, preview, publish panel), plus the Publishing page

**Design:** restyle in place. Every `components/admin/editor/**` file and `components/admin/shared/{MediaPicker,RefPicker}.js` swaps `components/console/*` for `components/ui` and `components/kit`. The pure models stay unchanged: `store.js`, `editorModel.js`, `treeModel.js`, `inspectorModel.js`, `richTextModel.js`, `publishModel.js`, `previewMachine.js`, `documentsApi.js`. The page passes `can = { write, publish, offersWrite }` from `roleAllows`. `/admin/releases` moves here (D4) because it is built from the publish components.

### 1. Feature list (floor)
1. **Frame:**
   - Full-bleed three panes from 1024px: tree, inspector, preview.
   - At 768 the preview is a toggle. At 375 the panes become tabs (Sections, Edit, Preview).
   - A status line shows saved, saving, offline, conflict or backup offered.
2. **Page list:**
   - Grouped: Home, Pages, Header and footer, Design, Policies, Product content, Collection content.
   - Search; a draft or live badge; "Unpublished changes" dot; archived toggle.
   - New page (title and address); archive and bring back.
   - Deep links `?doc=`, `?path=`, `?product=`, `?collection=` unchanged.
3. **Section tree:** select; add (AddSection catalogue); move up and down; hide; copy; delete with confirm; block rows nested (`collapsible`). Keyboard: arrows move focus, Enter selects.
4. **Inspector:**
   - Every control restyled: text, rich text, link, menu, gallery, product list, pairs, bundle and bundle list, design and brand.
   - Field notes and issues anchored to fields.
   - MediaPicker and RefPicker in a `dialog`. "Create a bundle" only with `offersWrite`.
5. **Preview:** device widths 375/768/1280 (`toggle-group`); show-design toggle; reload; open in a new tab; an expired preview session reopens.
6. **Publish panel:**
   - Publish with the publish checks listed and fixable.
   - Take offline (confirm lists linking pages); Undo notice; Earlier versions (view, restore as draft).
   - Staff see the reason, not the buttons.
7. **Templates (`/admin/editor/templates`):** saved section templates list, rename, delete, insert into a page.
8. **Publishing (`/admin/releases`):**
   - "Waiting to publish" (documents with drafts), with Publish selected (`publishSet`, same checks).
   - Recently published with Undo and Undo set.
   - Links into the editor.
9. **Support:**
   - Every page readable.
   - No add, move, hide, copy, delete, new page or archive. Fields disabled.
   - No publish, undo or restore controls; the reason is shown.
   - No `saveDraft` is ever sent, including the keepalive on pagehide.
10. **Generator:** opening the editor runs `generateFirstStore` only when `can.write`.
11. **States:** loading skeleton per pane; a document that failed to load, with Try again; mode error page; conflict banner with "Load theirs / Keep mine as backup".

Out of scope: drag-and-drop and the studio (Phase 6), scheduling releases.

### 2. Data
None. All reads are existing `documents` PUT ops and `preview-session` POSTs.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| open editor, list, tree, inspector, preview, history, Publishing (`storefront.read`) | yes | yes | yes | yes, read-only | → login, 401 |
| drafts, sections, new page, archive, templates, restore (`storefront.write`) | yes | yes | yes | hidden, 403 | 401 |
| publish, publishSet, take offline, undo (`storefront.publish`) | yes | yes | reason shown, 403 | hidden, 403 | 401 |
| create bundle in editor (`offers.write`) | yes | yes | yes | "ask an owner" | — |
| first-store generator on open | runs | runs | runs | never | — |

Tests in `scripts/test-editor-ui.js`:
- **Support:**
  - props `can.write=false`;
  - markup has no enabled Add, Move, Hide, Copy, Delete, Publish, Undo or Restore;
  - every input disabled;
  - a stubbed `generateFirstStore` is never called (staff: called once).
- **Store:** a store built with `readOnly` never calls `saveDraft`, and `beforeUnload` never calls `sendKeepalive`, even with forced edits.
- **READ_POSTS rows for `/admin/editor` and `/admin/releases`:** `ops` ⊆ `DOCUMENT_READS`; every `preview-session` variant is `storefront.read` in `admin-routes.js`.
- **Other store and signed out:** another store's `doc_` id → not found; signed out → redirect.
- **Anonymous shopper:** a draft is not visible on the storefront without a preview session (reuse the `test:publish-service` fixture).

### 4. Events
Unchanged:
- `audit` `storefront.write` and `storefront.publish`;
- `publish_log` in the publish batch;
- `slog` `editor_first_run_failed`, `editor_starting_brand_failed`.

### 5. File plan
**6a (opus), the frame:**
- `editor/page.js` (`can`) and `editor/loading.js`;
- `AdminShell.js` (an `editor` full-bleed variant, no padding or max width);
- `DocumentEditor.js`, `Switcher.js`, `StatusLine.js`, `tree/{SectionTree,AddSection}.js`;
- `editor/templates/page.js` and the new `components/admin/editor/templates/TemplatesList.js` (replaces `SavedTemplates.js`, which gets an allowlist row);
- `components/ui/{toggle-group,scroll-area,collapsible}.js`;
- `scripts/drills/shell/run.mjs`: a READ_POSTS row may carry `ops: [...]`. The browser matches the body's single top-level key. The server-log witness counts a 403 on that path as a write.
- the `read-controls.js` rows (editor and releases, with `ops`);
- `scripts/test-editor-ui.js`; `package.json` `test:editor-ui` and `drill:editor`.

**6b (opus), the inspector:** `fields/*.js` (no change to `inspectorModel.js` or `richTextModel.js`), `ProductForm.js`, `CollectionForm.js`, `shared/MediaPicker.js`, `shared/RefPicker.js`.

**6c (opus), preview and publishing:**
- `PreviewPane.js`;
- `publish/{PublishPanel,EarlierVersions,RecentlyPublished,TakeOfflineConfirm,UndoNotice}.js`;
- `releases/page.js` (rewrite) and `releases/loading.js`;
- new `components/admin/releases/{PublishingPage,WaitingList}.js`. `PublishingHistory` moves out of `DocumentEditor.js` into `components/admin/releases/`.

**Then:**
- update the markup assertions in: `test-editor-shell`, `-tree`, `-inspector`, `-store`, `test-publish-ui`, `test-publish-undo`, `test-product-editor`, `test-media-picker`, `test-rich-text`, `test-bundle-form`, `test-logout-preview`, `test-onboarding-brand`, `test-onboarding-open`;
- write `scripts/drills/editor/run.mjs`;
- add the shared appends.

### 6. Checks first
- Baseline the editor suites: `node scripts/test-editor-shell.js && node scripts/test-editor-tree.js && node scripts/test-editor-inspector.js && node scripts/test-editor-store.js && node scripts/test-publish-ui.js && node scripts/test-product-editor.js && node scripts/test-media-picker.js`.
- See whether the shell-drill escapes work has landed: `git log --oneline -5 -- scripts/drills/shell/run.mjs`.
- Find the template routes: `grep -n "Template" lib/admin/documents-api.js`.

### 7. Risks
1. About 13 suites assert old markup or class names. Change the assertions, never the behaviour they pin.
2. The preview iframe must keep storefront styles. `test:console-ui` and `drill:sf-styles` must still pass.
3. The in-progress "shell drill escapes" work (keepalive on pagehide) edits the same drill. Rebase on it first.

**Drill:** `drill:editor`
- owner: edit, preview, publish, Undo;
- staff: edit, Publish shows the reason;
- support: the `supportNewUiControls` pass on `/admin/editor` and `/admin/releases`, no write request;
- screenshots at 375, 768 and 1280 into `docs/cms-reviews/drills/EDITOR/`.

---

## Line 7: settings (store details, checkout and payments, shipping, domains), integrations and billing; staff and support cannot reach them

**Design:** `/admin/settings` becomes sub-pages under one `settings/layout.js` with a section nav from a new data file, `lib/admin/settings-sections.js`. Each tab saves only its section through the existing `PUT /api/admin/settings` (`buildSettingsPatch` already touches only the sections present). No route changes. This line also takes the support-banner fix (D5).

### 1. Feature list (floor)
1. **Section nav:**
   - Details, Checkout and payments, Shipping, Domains and SEO, Tracking, Products from Shopify, Privacy, Audit log, Help, Team (line 8's page).
   - A vertical list from 1024px; a select at 375.
2. **Details:**
   - Name, store address, support email and phone, title, tagline, footer tagline, legal name.
   - Domains and Shopify domain shown read-only.
   - The setup-login password row, as today.
3. **Checkout and payments:**
   - Checkout mode and timezone.
   - Razorpay key id; key secret and webhook secret are write-only ("Saved", "Not set", "Replace").
   - "Test keys" (integrations `test`, a read).
   - A "Shoppers can pay with …" line from the open checks.
4. **Shipping:**
   - Flat rate, free over, COD fee, COD fee waived at, basis.
   - Inline `validateShippingConfig` errors.
   - A worked example in words ("an order of ₹999 pays ₹49").
5. **Domains and SEO:**
   - Each domain with its status and primary flag; the TXT record with Copy.
   - Verify (`POST verify`). Claiming stays with operators, and the screen says so.
6. **Tracking, Products from Shopify, Privacy, Audit log, Help:**
   - Tracking: GA4, Meta pixel, CAPI token write-only, test code.
   - Products from Shopify: sync card using `ImportStepBody` as on the dashboard; Run sync with `sync.run`.
   - Audit log: paged, filtered by who, action and date; diffs never show secret values.
7. **Integrations:** providers list, Test, Revoke with confirm, failed contact-message emails.
8. **Billing:** plan, usage and history, Subscribe. An unconfigured provider shows plain words (the route's honest 503).
9. **Every tab:**
   - sticky Save / Discard bar;
   - leave-with-unsaved warning;
   - inline errors that keep what was typed;
   - success toast;
   - `?from=onboarding` back link kept;
   - loading and error states.
10. **Old links:** `/admin/settings#payments` and the other hashes redirect client-side to the new tab. `lib/onboarding/open-step.js` and `lib/admin/documents-api-shapes.js` links are updated.
11. **Staff and support:** no nav item (already). Any settings, integrations or billing URL renders "Your role can't open settings" with no settings data.
12. **Banner fix:** the support-access banner (operator id, reason) shows only to signed-in members. The `(auth)` and `(invite)` layouts get incidents only.

### 2. Data
None.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| every settings tab, integrations, billing (`settings.read`) | yes | yes | no-data page, API 403 | no-data page, API 403 | → login, 401 |
| save, verify domain, revoke, subscribe (`settings.write`) | yes | yes | 403 | 403 | 401 |
| audit log (`audit.read`) | yes | yes | 403 | 403 | 401 |
| run sync (`sync.run`) | yes | yes | — | — | — |
| support-access banner | shown | shown | shown | shown | **not shown** |

Tests in `scripts/test-settings-ui.js`:
- **Staff and support pages:** each settings sub-page, integrations and billing as staff and as support → props hold no settings, secret flags, domains or audit rows (`page-harness` canaries).
- **Admin view:** no secret value reaches props, only the `has_*` flags.
- **Signed out:** the `(auth)` layout with an active grant renders no operator id or reason (and the same for `(invite)`). Signed out → login.
- **Anonymous shopper:** after a shipping save, a cart total uses the new rate (the `test:commerce` fixture).

### 4. Events
Unchanged:
- `audit` `settings.write` (config keys and secret key names only);
- the integrations and billing audits;
- `slog` as today.

### 5. File plan
**7a (opus):**
- `lib/admin/settings-sections.js` (new);
- `settings/layout.js` and `settings/page.js` (Details), `settings/{checkout,shipping,domains}/page.js`, `settings/loading.js`;
- `components/admin/settings/{SettingsNav,SaveBar,SecretField,DetailsForm,CheckoutForm,ShippingForm,DomainsList,HashRedirect,NoAccess}.js`;
- `components/ui/alert.js`;
- `lib/admin/notices.js` (`consoleNotices({ member })`) and the `(auth)`/`(invite)` layouts;
- `lib/onboarding/open-step.js`, `lib/admin/documents-api-shapes.js`;
- `scripts/test-settings-ui.js`; `package.json` `test:settings-ui`, `drill:settings`.

**7b (opus, secrets):**
- `settings/{tracking,sync,privacy,audit,help}/page.js`, `integrations/page.js`, `billing/page.js` (rewrite);
- `components/admin/settings/{TrackingForm,SyncPanel,PrivacyPanel,AuditTable,HelpPanel}.js`;
- `components/admin/integrations/IntegrationsList.js`, `components/admin/billing/BillingPanel.js`.

**Then:**
- allowlist rows for `SettingsAdmin.js`, `OpsPanels.js`, `IntegrationsAdmin.js`, `MessagesPanel.js`, `BillingAdmin.js` (and `SyncProgress.js` if it loses its last importer);
- `scripts/drills/settings/run.mjs`.

### 6. Checks first
- `node scripts/test-support-reads.js`, `node scripts/test-onboarding-open.js`, `node scripts/test-billing.js`.
- Which providers `test` supports: `grep -n "test" app/api/admin/integrations/route.js`.
- Whether a pure shipping function exists for the example: `grep -rn "export function.*[Ss]hipping" lib/`.

### 7. Risks
1. `PUT /api/admin/settings` has no revision, so two admins saving the same tab is last-write-wins. Tabs keep patches per section, so only same-section edits collide.
2. Onboarding step 4 deep-links settings anchors. `test:onboarding-open` must pass with the new hrefs.

**Drill:** `drill:settings`
- admin: edit each of the four tabs, reload, values kept;
- an old `#payments` link lands on Checkout;
- staff and support: direct URLs show the no-access page;
- signed out with an open grant: `/admin/login` shows no banner.

---

## Line 8: team; invite with a role, remove a member; only the owner grants or transfers ownership

**Design:**
- **Page:** `/admin/settings/team`, gated `team.manage`.
- **Route:** keep `/api/admin/team` and add `revoke-invite` and `transfer`.
- **Identity:** make the last-owner guard atomic in `lib/platform/identity.js`, and refuse `role` on a non-member.
- **Unchanged:** the raise-only invite path (`addInviteMembership`) and `expirePendingInvites`.

### 1. Feature list (floor)
1. **Members:** name, email, role, joined, a "You" marker, owners first.
2. **Pending invites:** email, role, sent, expires. Revoke. "Send a new link" (revoke and invite again).
3. **Invite dialog:**
   - Email; the role select offers Owner only to an owner.
   - The link is shown once with Copy, and is also emailed through `sendPlatformMail` when mail is configured. A failed or unconfigured send says so in plain words.
   - Warning when the address is already a member at that role or higher ("an invite can only raise a role").
4. **Change role:**
   - Per row. Admins change non-owners among admin, staff and support. Only an owner grants Owner or changes an owner.
   - The last-owner refusal is shown in plain words.
5. **Remove:** AlertDialog. Owner rows only for an owner. The last owner is refused. No remove on your own row.
6. **Transfer ownership (owner only):**
   - Pick a member; confirm by typing the store name.
   - In one batch the target becomes owner and you become admin; the page then reloads as admin.
7. **Invites can't undo changes:** a role change, removal or transfer expires that member's pending invites, and the invite list refreshes.
8. **States:** loading; "Team accounts need the platform control plane" (`supported:false`); error with Try again; staff and support get the no-access page with no member data.

### 2. Data
None. No platform migration: `invitations.expires_at` serves for revoke, as `expirePendingInvites` already does.
- **Owner guard:** `addMembership` and `removeMembership` become single conditional statements (`UPDATE … WHERE NOT (role='owner' AND (SELECT COUNT(*) … role='owner') <= 1)`, checked by affected rows).
- **Transfer:** `transferOwnership(from, to, tenantId)` runs a `platformDb().batch([...], "write")` of two updates.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| page and `GET` (`team.manage`) | yes | yes | no-data page, 403 | no-data page, 403 | → login, 401 |
| invite admin, staff or support; revoke those invites | yes | yes | 403 | 403 | 401 |
| invite owner, revoke an owner invite (`team.owner`) | yes | 403, option hidden | 403 | 403 | 401 |
| role or remove on a non-owner | yes | yes | 403 | 403 | 401 |
| grant owner, change or remove an owner, transfer (`team.owner`) | yes | 403, hidden | 403 | 403 | 401 |

Tests in `scripts/test-team.js` (real platform test database):
- **Owner invites:** admin inviting an owner → 403; owner → 200.
- **Raise-only accept:** accepting an invite at or below the held role → `alreadyMember`, role unchanged, token spent; a raising invite raises.
- **Invites expire:** a role change, a removal or a transfer expires that member's pending invites, and the old token can no longer be accepted.
- **Owner protection:** admin changing or removing an owner → 403. Demoting or removing the last owner → 422.
- **Atomic guard:** two concurrent demotions of the only two owners leave one.
- **Non-member and other store:** `role` with a non-member id → 404 and no membership row; another store's user id → 404.
- **Transfer:** by owner → target owner, caller admin; by admin → 403; to a non-member → 404.
- **Revoke:** an admin revoking an owner invite → 403.
- **Support, staff, signed out:** support and staff `GET` → 403; support page props hold no email (canary); signed out → 401.
- **Audit:** every write writes an `audit` row, with action `team.owner` for owner-related writes.

### 4. Events
- `audit` `team.manage` / `team.owner`: `invite:<email>`, `member:<id>`, and the new `invite-revoked:<id>` and `ownership:<from>→<to>`.
- `slog` `team_invited`, `team_role_set`, `team_removed`, plus the new `team_invite_revoked`, `team_ownership_transferred`, `team_invite_mailed`, `team_invite_mail_failed`.

### 5. File plan
1. `lib/platform/identity.js`: atomic guards, `transferOwnership`, `revokeInvite(inviteId, tenantId)`.
2. `app/api/admin/team/route.js`: `revoke-invite` (owner invite needs `team.owner`); `transfer` (`team.owner`); `role` requires an existing membership; optional mail send.
3. `app/(console)/admin/(authed)/settings/team/page.js` and `loading.js`.
4. `components/admin/team/{TeamPage,MembersTable,InvitesTable,InviteDialog,RoleSelect,RemoveDialog,TransferDialog}.js`.
5. `admin-routes.js`: rows `revoke-invite`, `revoke-owner-invite` (`team.owner`, asks `team.manage`), `transfer` (`team.owner`).
6. `scripts/test-team.js`; `package.json` `test:team`, `drill:team`; `scripts/drills/team/run.mjs`.

### 6. Checks first
`node scripts/test-permissions.js`, `node scripts/test-operator-create-store.js` (it holds the P1-A invite tests), `node scripts/test-authz.js`. Then confirm libsql batch support: `grep -n "batch" lib/platform/control.js`.

### 7. Risks
1. Transfer demotes the caller mid-session. The page must reload from the server, and nothing may cache the old role. Today authz is a fresh lookup per request.

**Drill:** `drill:team`
- owner invites a staff member, accepts in a second context, the new member signs in as staff;
- admin cannot see the Owner option;
- owner transfers to admin and lands as admin;
- staff gets the no-access page.

---

## Line 9: analytics, experiments, insights and automations on the new UI

**Design:** no new routes. One new page, `/admin/experiments/[slug]` (detail and analysis). Automations and insights use sheets. Releases moved to line 6c (D4). Insights is added here (D3).

### 1. Feature list (floor)
1. **Analytics:**
   - Range 7/30/90; sales rollup; funnel.
   - Top products, search terms (zero-result flag), campaigns, devices.
   - Coverage note when tracking is thin; CSV export per table (built in the browser); empty states.
2. **Experiments:**
   - List by status.
   - Create and edit a draft: name, hypothesis, target, variants and weights summing to 100, metric, minimum sample. Frozen once started.
   - Start (D6), pause, complete.
   - Analysis with blocks in words (no peeking, too few samples, sample-ratio mismatch).
   - Adopt winner → a draft, with "Open in editor".
3. **Insights:**
   - List; Generate, showing the budget left and a "not configured" state.
   - Dismiss and restore; Apply → a draft, with an editor link.
4. **Automations (admin only):**
   - Rules list; create and edit (trigger, conditions, action, cap, quiet hours).
   - Enable; remove with confirm; kill switch with confirm.
   - Dry run shows what would be sent; recent runs; Retry a failed run.
5. **States:** skeletons, errors with Try again; support sees analytics, experiments and insights read-only.

### 2. Data
None.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| analytics (`orders.read`) | yes | yes | yes | yes, aggregates only | → login |
| experiments and insights read (`storefront.read`) | yes | yes | yes | read-only | 401 |
| experiment draft, pause, complete, adopt; insights generate, apply, dismiss (`storefront.write`) | yes | yes | yes | hidden, 403 | 401 |
| experiment **start** (`storefront.publish`, D6) | yes | yes | reason shown, 403 | hidden, 403 | 401 |
| automations, all (`settings.read`/`write`) | yes | yes | no nav, no-data page | no nav, no-data page | 401 |

Tests in `scripts/test-growth-ui.js`:
- **Support props:** analytics props hold no customer name, email or phone; the experiments and insights pages have no write controls.
- **Staff and support on automations:** the automations page as staff or support has no rules in props.
- **Start gate:** staff `POST {start}` → 403; admin → 200.
- **Anonymous shopper:** a draft or paused experiment is never served by `/api/exp`.

### 4. Events
- Unchanged: the existing audits (`storefront.write`, `settings.write`), and `slog` for runs and dry runs.
- A start by an admin is now audited as `storefront.publish`.

### 5. File plan
**9a (sonnet):** `analytics/page.js` (rewrite) and `loading.js`; `components/admin/analytics/{AnalyticsTables,FunnelCard,CsvButton}.js`; `insights/page.js`; `components/admin/insights/InsightsList.js`.

**9b (opus):**
- `experiments/page.js`, `experiments/[slug]/page.js`;
- `components/admin/experiments/{ExperimentsList,ExperimentForm,AnalysisPanel}.js`;
- `app/api/admin/experiments/route.js` (start needs `storefront.publish`);
- `automations/page.js`; `components/admin/automations/{RulesList,RuleSheet,RunsTable}.js`.

**Then:**
- the `admin-routes.js` row `experiments POST start` (`storefront.publish`, asks `storefront.write`) and the `admin-pages.js` row;
- allowlist rows for `ExportCsv.js`, `ExperimentsAdmin.js`, `InsightsAdmin.js`, `AutomationsAdmin.js`;
- `scripts/test-growth-ui.js`, `test:growth-ui`, `drill:growth`.

### 6. Checks first
`node scripts/test-reporting.js`, and the experiment and automation suites: `ls scripts/test-*experiment* scripts/test-*automation*`, then run each.

### 7. Risks
1. D6 changes what staff can do today. Tell the owner in the report.

**Drill:** `drill:growth`
- admin creates and starts an experiment;
- staff sees Start with the reason;
- support runs the read pass on analytics, experiments and insights;
- staff gets the no-access page on automations.

---

## Line 10: product-finder quizzes on the new UI; support sees them read-only

**Design:**
- **Pages:** `/admin/quizzes` and `/admin/quizzes/[slug]` (`new` creates), in nav under Catalog.
- **Route:** keep `/api/admin/quiz`, adding `GET ?view=usage&slug=` (document_refs with `ref_type='quiz'`) and `GET ?view=tags`.
- **Catalog page:** drops the `QuizPanel` tray (after line 3).

### 1. Feature list (floor)
1. **List:** title, address `/quiz/<slug>`, On or Off, question count, updated, "used on n pages"; search; empty state "Make your first quiz".
2. **Editor:**
   - Title, intro; slug set at create and locked after.
   - Questions: add, reorder, delete. Options: add, reorder, delete; catalog-tag picker with counts.
   - `validateQuiz` errors inline; unsaved warning.
3. **Preview:** "Try it", run in the page by `scoreQuiz` and `recommendProducts` through the public quiz API's shape; "Open on the store" when On.
4. **On and off (D6):** staff save quizzes that are Off. Turning one On, or editing or deleting one that is On, needs `storefront.publish`.
5. **Delete:** when used on pages → 409 `QUIZ_IN_USE` with the page names and "Turn it off instead". Otherwise an AlertDialog.
6. **Support:** list and editor read-only, with no Save, Delete or On/Off.

### 2. Data
None. Usage reads `document_refs(ref_type, ref_id)` (index `document_refs_target`, 0023) joined to current draft and live versions.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out |
|---|---|---|---|---|---|
| list, open, usage, tags (`storefront.read`) | yes | yes | yes | read-only | → login, 401 |
| save or delete a quiz that is Off (`storefront.write`) | yes | yes | yes | hidden, 403 | 401 |
| turn On, edit or delete while On (`storefront.publish`) | yes | yes | reason shown, 403 | hidden, 403 | 401 |

Tests in `scripts/test-quizzes-ui.js`:
- **Support:** props and markup have no save, delete or switch.
- **Staff On/Off rule:** `POST {quiz, enabled:true}` → 403; staff editing an On quiz → 403; staff saving one that is Off → 200.
- **Delete in use:** deleting a quiz used on home → 409 with names, and the row stays.
- **Anonymous shopper:** a quiz that is Off → 404 at `/quiz/<slug>` and `/api/quiz/<slug>`.
- **Other store:** another store's slug → 404.

### 4. Events
`audit` `storefront.write` `quiz:<slug>` as today. Turning On is audited as `storefront.publish`. `slog` `quiz_saved`, `quiz_deleted`.

### 5. File plan
1. `lib/admin/quiz-usage.js` (new).
2. `app/api/admin/quiz/route.js`: views, the publish gate, the 409.
3. `quizzes/page.js`, `quizzes/[slug]/page.js` and `loading.js`.
4. `components/admin/quizzes/{QuizList,QuizEditor,QuestionList,TagPicker,QuizTry,DeleteQuizDialog}.js`.
5. `catalog/page.js`: remove the tray.
6. `nav.js`: the Quizzes item.
7. Rows in `admin-routes.js` (`quiz POST enable`, `storefront.publish`, asks `storefront.write`) and `admin-pages.js`; the `CommercePanels.js` allowlist row if line 3 has dropped `BundlesPanel`.
8. `scripts/test-quizzes-ui.js`, `test:quizzes-ui`, `drill:quizzes`.

### 6. Checks first
- `git log --oneline -1 -- "app/(console)/admin/(authed)/catalog/page.js"` (line 3 merged).
- `node scripts/test-console-shell.js` (does it pin the nav item count?).
- Where catalog tags live: `grep -n "tags" lib/schema.sql`.

### 7. Risks
1. Slug-only identity: a "rename address" would orphan links. The slug stays locked (D7).

**Drill:** `drill:quizzes`
- staff creates a quiz that is Off and tries it;
- admin turns it On, and the store shows it;
- deleting it while used shows the page names;
- support runs the read pass.

---

## Line 11: remove the old console screens and their components

**Design:** first prove every `ADMIN_PAGES` row is a new-UI route. Then delete the legacy machinery and finish the last old screens.

### 1. Feature list (floor)
1. **Guard:** a test that every `(authed)` page is new UI. Then delete `lib/admin/new-ui-routes.js` and the `[data-legacy]` branch in `AdminShell.js`. The shell test and drill drop the region checks, and support's stray-control rule covers every page.
2. **Rebuild the last old screens:**
   - the `(auth)` layout, login and reset;
   - the `(invite)` layout and accept-invite;
   - `ConsoleNotices` (on `alert`);
   - the root `(authed)/error.js` and `loading.js`;
   - `handoff`, or its removal if nothing routes to it.
3. **Delete:**
   - `components/console/` (whole folder, with its README row);
   - every old `components/admin/*.js` with an allowlist row;
   - the `data-legacy`-scoped console CSS;
   - `docs/cms-reviews/drills/SHELL/support-write-controls.json` and its writer.
4. **Clean up:**
   - every "removed by Phase 2 line 10/11" allowlist row is gone;
   - add a test that no file imports `components/console` and no source holds `data-legacy`;
   - `docs/UI.md` drops the legacy notes.
5. **Phase end:** `ALL` gains `dashboard`, `orders`, `catalog`, `offers`, `media`, `editor`, `settings`, `team`, `growth`, `quizzes`, `console-styles`; `pnpm drill:all`.

### 2. Data
None. Legacy tables untouched.

### 3. Permissions
No action changes. The least-trusted tests:
- **Support:** the shell drill's support pass now runs on every page.
- **Signed out:** all console pages redirect, and login shows no grant banner.
- **Anonymous shopper:** storefront render comparison unchanged (`drill:sf-styles`).

### 4. Events
None.

### 5. File plan
1. `scripts/test-no-legacy-ui.js` (`test:no-legacy-ui`).
2. `AdminShell.js`, `test-console-shell.js`, `scripts/drills/shell/run.mjs`.
3. The layouts and pages in item 2; `components/admin/auth/{LoginForm,ResetForm,AcceptInviteForm}.js` (new).
4. The deletions; `dead-code-allowlist.js`; `package.json`; `run-isolated.mjs` `ALL`; `docs/UI.md`.

### 6. Checks first
- `node scripts/test-no-dead-code.js`
- `grep -rln "data-legacy" app components lib scripts`
- `grep -rln "components/console" app components lib`
- `git ls-files "app/(console)/admin/(handoff)"`

### 7. Risks
1. Suites import old components as fixtures. `grep -rln "components/console\|components/admin/[A-Z]" scripts/` must come back empty before deleting.

**Drill:** `drill:shell` (updated), then `pnpm drill:all` once.

---

## Decisions for `docs/DECISIONS.md` (schema and permissions first)
1. **No migrations in lines 6–11.** The next free numbers stay tenant 0030 and platform 0016.
2. **Team hardening (line 8):**
   - the last-owner guard becomes one conditional statement;
   - `role` on a non-member is a 404;
   - `transfer` (owner only) is one batch;
   - `revoke-invite` uses `expires_at`;
   - an owner-role invite needs `team.owner` to create or revoke.
3. **Unassigned routes assigned:** integrations and billing → line 7; insights → line 9; editor templates → line 6; the sign-in and invite pages → line 11. FEATURES lines 7 and 9 should name them.
4. **Publishing page in line 6:** `/admin/releases` is built in line 6 (6c) because it is made of the publish-panel components. Line 9's tick covers releases once line 6 has merged.
5. **Support banner → line 7:** line 7 is the line about who may see what. The fix is a server change in `lib/admin/notices.js` and two layouts that no other line touches. The visual restyle waits for line 11.
6. **Going live needs `storefront.publish`:**
   - Starting an experiment, and turning a quiz On or changing or deleting one that is On, now need `storefront.publish`. Both put content in front of shoppers, and staff do not publish.
   - Pausing or completing an experiment stays `storefront.write`.
7. **Quizzes:** their own pages under Catalog. The slug is locked after create. Delete is refused while a page uses the quiz.
8. **READ_POSTS rows may carry `ops`:** a row can list the body op names allowed (⊆ `DOCUMENT_READS`). The drill's server-log witness counts a 403 on that path as a write, because a path-only row for `PUT /api/admin/documents` would also hide `saveDraft`.
9. **Settings as sub-pages:** each tab has its own page from `lib/admin/settings-sections.js`, saving only its section. Old `#hash` links redirect.
10. **New shadcn parts on the existing `radix-ui`, no new dependency:** `toggle-group`, `scroll-area`, `collapsible` and `alert`. No `cmdk`, `react-hook-form` or `react-resizable-panels`.

## Risks and open questions (most serious first)
1. **Three things edit `scripts/drills/shell/run.mjs`:** the in-progress shell-drill escapes work (keepalive on pagehide), line 6's `ops` matching and line 11's region removal. Land the escapes first. Check with `git log --oneline -5 -- scripts/drills/shell/run.mjs`.
2. **Line 6 is the largest slice** and rewrites markup that about 13 suites assert. Baseline the suites first (line 6 checks). Expect most of the fix-up time there.
3. **Decision 6 is a visible behaviour change for staff**, who can start experiments and turn quizzes on today. It follows the "never publish what a founder did not publish" rule. Put it in the report.
4. **Settings saves are last-write-wins.** There is no revision on `PUT /api/admin/settings`. This is accepted for now; record it under Later if the owner wants conflict detection.
5. **Mail for invites.** Whether `sendPlatformMail` works locally decides whether the line 8 drill can prove an email. Check with `grep -n "export" lib/platform/platform-mail.js`. If it can't, the drill proves the link only and the report says so.
