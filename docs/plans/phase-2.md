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