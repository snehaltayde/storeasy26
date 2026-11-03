# Storeasy — Manual Testing Guide (post-S50 redesign)

Everything you need to test the product by hand: how to start each environment,
how to log in to every console, feature-by-feature functional checklists, and a
design/visual QA pass for the S50 console redesign.

> **Golden rules while testing**
> - Test orders on real/staging storefronts always use **snehal@mediastic.in**, and every test order gets **cancelled afterwards** (admin → order → Cancel, or `pnpm order:cancel`).
> - Never run `vercel deploy --prod` or `pnpm push:shopify` as part of testing.
> - Credentials live in gitignored env files (`.env.local`, `.design-env`). Read them locally (`cat .design-env`); never paste them into chats, issues, or screenshots.
> - The design-harness databases are throwaway local databases (in `.design-data/`) — reseeding (`pnpm seed:design`) wipes and rebuilds them, so feel free to mutate anything there.

---

## 1. Environments

| Environment | Start | URL(s) | Use it for |
|---|---|---|---|
| **Design harness** (recommended for console and storefront review) | `pnpm dev:design` (it seeds itself the first time; `pnpm seed:design` starts fresh) | http://localhost:3017 | The storefront on the **edge runtime**, exactly as deployed code declares it, plus all three consoles, with rich seeded data (8 products in 3 collections, every order status, returns, offers, experiments, automations, incident, agency). Local databases (sqld); nothing hosted is touched. Needs `sqld` (see "How the design harness runs" below). |
| **Local dev** | `pnpm dev` | BeastLife: http://localhost:3007 · Demo tenant: http://127.0.0.1:3007 · Marketing: http://site.localhost:3007 | Storefront testing (browse, cart, checkout, wishlist, quiz, PWA) against the staging Turso DBs, plus consoles with real data. |
| **Hosted demo** | already deployed | your hosted tenant domains | Final authed walkthroughs — same checklists as below. |

Only one Next dev server can run per project directory — stop the 3007 server
before starting the harness (and vice versa).

**Reset harness data at any time:** stop the server, `pnpm seed:design`, start again.

### How the design harness runs (P1-HARNESS)

- **Why sqld.** The storefront runs on the edge runtime, and the edge database
  client can only reach a database over http, never a local file. So the harness
  starts `sqld` (the local libSQL server) once per database and gives Next
  `http://127.0.0.1` addresses. No code is edited: `runtime = "edge"` stays.
- **Getting sqld.** The harness looks for it in `SQLD_BIN`, then your `PATH`,
  then `~/.turso/sqld` (where the Turso CLI puts it). If none is there it stops
  with a plain message saying how to install it.
- **Ports.** Web: `DESIGN_PORT` (default 3017). Databases: three ports in a row
  from `DESIGN_SQLD_PORT` (default 18017: platform, store, default). Example:
  `DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 pnpm dev:design`. A busy port stops
  the harness with a message naming it.
- **Data.** `.design-data/` (gitignored): one folder per database, its log, and
  a pid file. The old `.design-*.db` files are no longer used and can be deleted.
  After a new migration lands, `pnpm dev:design` says so; run `pnpm seed:design`.
- **Stopping.** Ctrl-C (or SIGTERM to the harness) stops Next and every
  database server. If the harness was killed outright, the next start stops
  the database servers it left behind, by the PIDs it recorded.
- **Hosted keys are blanked.** Database tokens, Shopify, Razorpay, Typesense,
  mail, analytics forwarding, alert webhooks and `COOKIE_DOMAIN` are set empty
  for the harness, even if `.env.local` has them, so nothing hosted can be
  reached from it.
- **Browser drills.** With the harness running: `pnpm drill:smoke` (a product
  page at 375, 768 and 1440 wide, add to cart, the drawer) and `pnpm drill:edge`
  (every storefront page on the edge runtime, maintenance, the Designer). They
  drive the installed desktop Chrome headless (never a download), sign in with
  `.design-env`, and write small screenshots plus `results.json` to
  `docs/cms-reviews/drills/<id>/`. Add `--start` to have a drill start and
  stop the harness itself, `--headed` to watch. New journeys go in
  `scripts/drills/`; the helpers are in `scripts/drill.js`. See
  `docs/cms-reviews/P1-HARNESS.md`.

---

## 2. Logins

### Merchant console — `/admin/login`
- **Harness:** http://localhost:3017/admin/login — leave **Email empty**, enter the `DESIGN_ADMIN_PASSWORD` value from `.design-env`. (Empty email = the store's bootstrap/setup password; the login form's hint says this too.)
- **Local/hosted:** a team member's email + password, or empty email + that store's `admin_password` secret.
- After login you must land on **/admin/dashboard** (an S50 fix — it used to land on Offers).
- To test **roles** (admin / staff / support): Settings → Team → create an invite, open the invite URL in a private window, accept, then log in as that member. Staff/support must not see Setup, Automations, Integrations, Billing, Settings in the sidebar (URLs still 403 server-side if visited directly).

### Platform (operator) console — `/platform`
- **Harness:** http://localhost:3017/platform — the `PLATFORM_ADMIN_PASSWORD` value from `.design-env`.
- **Local/hosted:** the operator password from that environment's secrets.

### Partners (agency) console — `/partners`
- **Harness:** http://localhost:3017/partners — email `partner@design.test`, password = the same `DESIGN_ADMIN_PASSWORD` value from `.design-env` (the seed reuses it).
- The seeded agency is **Northwind Studio** (verified, referral-eligible) with an accepted staff grant on the `design` tenant and one pending client approval.

### Public approval page — `/approve/<code>`
- In the partners console, open the pending approval ("Homepage refresh for the winter drop") and reveal its code (SecretReveal). Open http://localhost:3017/approve/`<code>` in a private window — no login needed; the client approves or rejects there.

### Storefront customer account (3007 only)
- Order-status links are signed links emailed per order; wishlist/account flows are reachable from the storefront header.

---

## 3. Design & visual QA (the S50 pass)

Run this on the harness, signed in to each console. The system under test:
restrained light UI, near-black primary buttons, **lime only as a sparing
accent (never a button background, never "success")**, emerald = success,
one icon family (lucide), 24–26px titles / 14px body / 11px chips.

### 3.1 Layout at four widths
Check at ~**1440, 1280, 768, 390** (resize the window or use devtools device mode):
- No horizontal page scroll at any width; tables scroll inside their own container instead.
- **≥768:** sidebar visible; collapse it (icon-only rail) — the choice must survive a reload (localStorage). Tooltips appear on collapsed icons.
- **<768:** sidebar is gone; a top bar with a menu button opens a **drawer**. Escape closes it; focus returns to the menu button.
- Page titles don't wrap awkwardly; sticky page headers stay readable while scrolling.

### 3.2 Chrome & leak checks
- Consoles must show **no storefront chrome**: no shop header/search/cart drawer/footer/cookie banner on any `/admin`, `/platform`, `/partners`, `/approve` page — including login pages and error pages.
- The harness tenant deliberately uses a **teal accent + cream background + oversized type** on its brand. If any console surface shows teal/cream/huge type, tenant brand variables are leaking — that's a bug.
- Visit a garbage URL (e.g. `/no-such-page`) on 3007 — storefront 404. Visit a garbage **console** URL (e.g. `/admin/no-such`) — console-styled error/404, not the storefront joke 500.

### 3.3 Interaction states (spot-check per screen archetype)
- **Loading:** hard-refresh a console page — skeletons, never a blank screen.
- **Empty:** Orders → search `zzzz` — a proper empty state, not a bare table.
- **Error:** stop the dev server mid-session, click a refresh/action in an open page — an error banner with Retry, not a silent nothing. (Restart the server, Retry must recover.)
- **Busy:** every submit/confirm button shows a busy state and disables while in flight; double-clicking must not double-submit.
- **Permission:** log in as staff/support (see §2) — read-only screens show a permission note instead of edit controls that would 403.
- **Toasts vs banners:** transient results arrive as toasts (auto-dismiss); validation/conflict/permission problems are persistent banners.

### 3.4 Keyboard & accessibility
- Tab through login → every control gets a **visible focus ring**.
- Open any dialog: focus moves in, Tab cycles inside it, **Escape closes**, focus returns to the trigger.
- Tabs (e.g. Orders status tabs): arrow keys move between tabs.
- Switches toggle with Space.
- Status chips: color is never the only signal — each has a text label; hover shows the **raw status string** in the title tooltip.
- Enable "reduce motion" in OS settings — transitions/animations should disappear.

### 3.5 Status vocabulary
Harness Orders shows all 7 statuses. Check tones: paid/synced = green, sync failed = red, syncing = blue, COD pending = amber, pending payment/cancelled = grey. "Customized" in the storefront editor = lime accent (the one place lime appears as a status).

---

## 4. Merchant console — feature checklists (harness unless noted)

### 4.1 Dashboard
- "Today so far" shows **today in the merchant's timezone** (₹0 is honest if nothing sold today — it must NOT show the last active day).
- Range switcher 7/30/90 days changes the chart and stats; the 7-day chart includes zero-sales days as gaps, not omissions.
- Discrepancy queue lists the two seeded `DD-FAIL…` orders; each links to its order detail.
- Setup badge in the sidebar shows progress (n/total); Orders badge shows open returns (1 seeded `requested`).

### 4.2 Orders & Returns
- Tabs per status with counts; All shows 24 orders. Right-aligned money columns.
- Open **DD-FAIL1** → sync-error banner with the Shopify error text; **Retry push** and **Reconcile** buttons fire and toast a result.
- Open **DD-SYNC1** → shows a ₹899 refund and links to the return.
- **Returns tab:** approve the `requested` return (ret_d1) via its confirm dialog — note the money-handling toast (refunds go via the provider, not here). The seeded approved/completed/rejected rows render their statuses.
- "Load more" paginates without duplicating rows.
- **Cancel order** (S51): on any cancellable order's detail page — typed order-id confirm, reason field, refund-id field when money is captured. It cancels on the Shopify side too (restock, no refund, no email), and treats "already cancelled in Shopify" as success. **Reconcile** also adopts Shopify-side cancellations.

### 4.3 Catalog · Media
- Catalog lists the 8 seeded products (Detox Clay Mask shows unavailable). Bundles and Quiz builders open; quiz delete asks for confirmation.
- Media uploads/deletes ask for confirmation on delete.

### 4.4 Storefront CMS (S52 — dedicated areas, WordPress-style)
The old single Storefront screen is now a CMS with its own routes, all deep-linkable:
- **Overview** (`/admin/storefront`): live-vs-draft state with a per-item change list — every chip links to the right editor; recent edits; validation blockers; the two publish planes stated honestly (drafts-until-publish vs applies-immediately).
- **Home page** (`/admin/storefront/home`): hero, homepage sections (hidden sections show a Hidden badge and survive saves), collections curation with a real picker (chips + reorder). One explicit save model; undo/redo on sections; draft preview pane at the bottom.
- **Pages** (`/admin/storefront/pages`): searchable list with family tabs (Pages/Campaigns/Journal), window-aware status (Scheduled/Expired), Customized vs Standard copy; per-row Preview/Duplicate/Delete (typed confirm; default pages read "Revert to standard copy"). Each page edits at its own URL with breadcrumbs, a template picker on create (slug always editable), a media picker on image sections, meta description, visibility windows in local time.
- **Navigation** (`/admin/storefront/navigation`): announcement bar + structured header/footer menu editors (label/link rows, one child level, visible caps, automatic-vs-custom mode made explicit). The footer's auto-added links are documented read-only.
- **Product pages** (`/admin/storefront/product-pages`): the global PDP accordions with working Show/Hide.
- **Conflict drill** (works on every editor): two tabs, save in A, save in B → B gets ONE consistent banner: "Load their version" / "Overwrite with mine" — never a silent wipe. Unsaved changes also warn on tab close.

### 4.5 Theme · Brand · Publishing
- **Theme**: applying a kit asks explicitly before replacing your brand colors or hero copy (both off by default); kit cards preview from their real swatches.
- **Brand**: the accent ladder, sample button and contrast warnings update live while you type (debounced); Save only enables when dirty; reset is honestly labeled "Reset to platform default".
- **Publishing** (`/admin/releases`): the "What will publish" card lists exactly which blocks/pages/brand/theme changed since live — publish confirms with that list; scheduling states its honest limits (snapshot taken now, no re-validation) and pending schedules can be **cancelled** from history; rollback copy states drafts stay untouched, and after a rollback the diff recomputes against the old live. Verify a published change on the harness storefront (http://localhost:3017, signed out or in a private window) or on 3007.

### 4.6 Offers · Upsells
- Three seeded offers in three states: "Serum duo" **active**, "FESTIVE10" **scheduled**, "Free lip mask" **draft/disabled** — statuses and dates render correctly.
- Create/edit each offer type (tiered qty, coupon, free gift); invalid configs are rejected with field-level errors.
- Upsells: the "Pairs well with" PDP placement is listed and editable.

### 4.7 Experiments
- "Hero promise test" is **running** with 46 exposures and 1 conversion; "CTA copy test" is **completed**.
- Results honor no-peeking (no significance callouts before min sample) and report SRM checks.
- Adopt / complete actions confirm first; a success note appears as a success (an S50 fix — it used to render in the error slot).

### 4.8 Automations
- Two rules seeded: "Big order ping" (enabled) and "Thank-you note" (disabled, quiet hours 22:00–08:00).
- Run history shows done / skipped (condition) / failed / dry-run rows with reasons.
- **Dry-run** a rule — consumes nothing, reports "WOULD send…". **Retry** the failed run. Delete asks for confirmation. The "disable all" kill switch stops everything.

### 4.9 Insights (AI)
- Without `ANTHROPIC_API_KEY` set, the screen must show an honest "AI not configured" state — never fabricated insights. (With a key, insights cite real evidence facts and propose allowlisted components only.)

### 4.10 Setup · Integrations · Billing · Settings (admin+ only)
- Setup: checklist reflects real state (harness ~2/9) and deep-links to each step.
- Integrations: connect/configure flows; **revoking** a provider requires typing the provider key into a danger dialog.
- Billing: plan state renders; plan change confirms first. Analytics export (CSV) downloads; top-products currency follows the store (not hardcoded INR — an S50 fix).
- Settings: profile/sections navigable by anchor; a sticky save bar appears only when dirty; team invite URLs appear in a reveal-once well with Copy; role changes/removals confirm first.

---

## 5. Platform (operator) console — `/platform`

- Fleet stats at top; sticky section nav jumps to each panel; every panel shows loading/empty/error states (none may render blank).
- **Tenants:** the `design` tenant row → Sync/Connect/Details visible; the **⋯ menu** holds Export, Maintenance (dialog with message textarea), Suspend, and **Offboard** — offboard requires typing the tenant id. Maintenance mode must keep `/admin/login` reachable (deliberate S50 change) while the storefront shows the maintenance page.
- **Provisioning:** provision a throwaway tenant on the harness; the generated admin password appears once in a SecretReveal. Rollback asks for the run id.
- **Incidents:** the seeded "Payments provider latency" incident is open; its public message banners on tenant admin consoles. Resolve it — the banner clears.
- **Privacy/redaction:** redaction requires typing REDACT; it covers orders, customers, events, and wishlists.
- **Flags:** `ff_*` namespace enforced; flip `ff_checkout` off and confirm checkout on 3007 returns the kill-switch response, then flip it back. CRITICAL flags re-read uncached.
- **Costs:** enter a period total; allocation across tenants + unallocated must sum exactly to the total; unmeasured tenants are listed.
- **Partners/Agencies:** Northwind Studio shows verified; suspend/verify confirm first; commission rows tie to billing events (earn once, reverse once).
- **Support grants:** issue a support grant for a tenant → that tenant's admin shows the "support access" banner; the grant expires/revokes cleanly.

---

## 6. Partners console & approvals — `/partners`

- Portfolio health cards render for the granted client; sections never vanish when empty (kits shows an empty state).
- Grant invites: create one bound to a client email; it can only be accepted in the client's admin by a team-managing member with that email; roles offered are support/staff/admin (never owner).
- Kits: generating a kit **scrubs** source-tenant identifiers; applying one creates CMS **drafts** only (brand is suggested, not applied).
- Approvals: the pending "Homepage refresh" approval shows its code in a reveal well; open `/approve/<code>` publicly; approve → recorded with approver name; if the underlying draft changes after the snapshot, deciding must fail with a conflict (409) rather than approving stale content.
- Reports open in a dialog; codes/secrets never render as plain inline text.

---

## 7. Storefront — on 3007, or the harness where noted

Browse, search, cart, checkout's first steps, account sign-in, CMS pages and
maintenance also work on the harness (edge runtime, seeded catalog). Anything
that needs Shopify, a real payment or real email stays on 3007 or hosted.

- **Browse:** home, collections, PDP on both localhost (BeastLife) and 127.0.0.1 (demo) — each shows its own brand. site.localhost shows the marketing site. An unknown host 404s.
- **Search:** header search returns products; zero-result searches render a friendly state.
- **Cart & offers:** add 2× an offer-targeted product — the tiered discount applies in the cart; coupon codes apply/reject with clear messages; free-gift threshold adds the gift.
- **Checkout:** place ONE test order (COD is simplest) using **snehal@mediastic.in**. Verify it appears in `/admin/orders`, the status timeline advances, and the Shopify push succeeds (or surfaces its error honestly). **Then cancel it** (order detail → Cancel, or `pnpm order:cancel`).
- **Wishlist:** heart products logged-out (stored locally); the list survives reload; merging into an account happens only on explicit action; removed/unavailable products resolve as unavailable/gone rather than erroring.
- **Quiz:** complete the routine quiz → recommendations render from real catalog products.
- **Consent:** decline analytics in the cookie banner → no analytics events fire (check the network tab); accept → events flow.
- **Experiments:** with a running experiment, the hero varies by visitor (`_unit` cookie); clearing the cookie can re-bucket you.
- **PWA/perf:** the site installs as a PWA; navigation feels instant; no console errors on key pages.
- **Maintenance:** (operator) enable maintenance on a tenant → storefront shows the maintenance message, `/admin/login` still works; disable afterwards.

---

## 8. Automated checks (run anytime, ~all green expected)

```bash
pnpm build
```

Suites (each `pnpm test:<name>`): the full baseline is 37 suites / ~496 checks —
most relevant to console testing: `test:admin-console`, `test:cms`,
`test:authz`, `test:platform-ops`, `test:agency`, `test:identity`,
`test:security` (client-import scan), `test:orders`, `test:offers-admin`.

---

## 9. Reporting a bug you find

Note: environment (harness/3007/hosted), console + screen, role you were
signed in as, viewport width, steps, expected vs actual, and the raw status
string from the chip tooltip if relevant. Console errors
(`read_console_messages` in the app, or browser devtools) help.

## 10. Known limitations (so you don't chase them)

- Harness storefront: fixed in P1-HARNESS (it used to fail on every page because the edge runtime can't open file databases). It needs `sqld` installed.
- Harness hero: a running hero experiment can show its variant title instead of your draft, even in the Designer preview (P1-HARNESS finding).
- Harness emails never send (`RESEND_API_KEY` empty) — automation "email" actions queue/report, not deliver.
- AI Insights needs `ANTHROPIC_API_KEY`; without it the honest unconfigured state **is** the correct behavior.
- Dark mode doesn't exist — consoles are deliberately light-only.
