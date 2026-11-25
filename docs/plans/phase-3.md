# Phase 3 plan: operator console on shadcn

## Two findings that change the brief

**1. Phase 3 cannot go first, so Phase 2 line 11 must keep most of `components/console/`.** The grep finds 13 operator files that import it: `app/(console)/platform/{page,error,loading}.js`, `app/(console)/{layout,error}.js`, and every old file in `components/platform/` (PlatformAdmin, PlatformLogin, TenantDetail, and the Overview, Incidents, PrivacyOps, ProvisionRuns, Themes, Billing, GrowthOps, Queues and CaseStudies panels). Through those, the operator side needs 13 of the 16 console files: `cx`, `status`, `Badge`, `Banner`, `Button`, `Card`, `Copy`, `Dialog`, `fields`, `Switch`, `Table`, `Toast` and `bits`. Only `PageHeader.js`, `Tabs.js` and `charts.js` are merchant-only. Phase 3 is eight slices, so it cannot finish before line 11. **Tell the line 11 builder now:**
- Delete only those three files.
- Keep the `data-legacy` rules in `app/console.css`.
- Limit `test:no-legacy-ui` to `app/(console)/admin`, `components/admin` and `lib`. Allowlist `app/(console)/{layout,error}.js`, `app/(console)/platform/**` and `components/platform/**` with the reason "removed by Phase 3 line 7".

**2. There are no operator roles, and operator-support is not one.** Operators are one flag, `users.is_operator`, plus the shared bootstrap password until the first operator user exists. `operator-support` is an operator's own `_platform` cookie arriving at a store's `/admin` while a support grant is open (`supportActor`, `lib/admin-auth.js:100`). On the platform host the same cookie is a full operator. So:
- The least-trusted callers of the operator console are the **signed-out visitor** and a **merchant session**.
- No operator page has a read-only viewer, so **no stray-control drill is needed on operator pages**. Each line instead proves that signed-out and merchant callers get the sign-in page and no console data.
- The operator-support stray-control pass belongs in **line 5**, which is about the merchant console as seen through a grant.
- A read-only operator role is left for Later (decision 2).

**Also found:**
- **Missing origin check.** `billing`, `costs` and `flags` POSTs skip `sameOrigin`, which breaks the recorded decision "Same-origin check on every non-GET request".
- **Wrong audit actor.** Every operator audit row records the fixed id `"operator"`. Support grants and flag `updated_by` do the same.
- **Database URL leak.** `GET /api/platform/tenants` sends each store's `db_url` to the browser.
- **Support access does not work in production.** The `_platform` cookie is host-only and there is no proxy. An operator signed in on the platform host carries no cookie to a store's own domain, so the `consoleUrl` link works only when both are the same host (true locally). Line 5 fixes this.
- **Untested operator routes.** No test calls every `app/api/platform` route the way `test:permissions` does for admin routes.

## New FEATURES lines and order

Three additions to Phase 3, for the session to make:
- **Line 0:** a prerequisite with no FEATURES line, like Phase 2's.
- **Line 6 (new):** "An operator can run job queues, provisioning runs, privacy requests, themes and case studies on the new UI."
- **Line 7 (new):** "The old operator console and `components/console/` are removed once every operator screen is on the new UI."

**Order:** Phase 2 line 11 merged → line 0 → lines 1, 3, 4 and 6 side by side → lines 2 and 5 side by side once line 1 is merged → line 7.

**Every line follows these rules:**
- No new `components/console` imports.
- No edits to `docs/FEATURES.md` or `docs/DECISIONS.md`.
- Builders run only their own suite and drill.
- Every operator write uses `requireOperator` from line 0 and passes the real operator id to `audit()`.
- The store id comes from the URL path. That is fine here because operators span stores and the CLAUDE.md host rule covers store-scoped merchant queries.

| Shared file | Who appends what (keep both sides on conflict) |
|---|---|
| `lib/platform/nav.js` (line 0) | 3 Billing; 4 Flags, Incidents; 5 Support access; 6 Operations. Append at the end of `PLATFORM_NAV`; line 7 removes "Old console" |
| `scripts/support/platform-pages.js` (line 0) | each line adds its page paths |
| `scripts/support/platform-routes.js` (line 0) | each line edits only its own routes' rows |
| `components/platform/stores/StoreDetail.js` (line 1) | 2 at the `{/* line 2: lifecycle */}` anchor, 5 at `{/* line 5: support access */}` |
| `package.json` (right after this key) | 0 `test:operator-create-store`; 1 `test:operator-onboarding`; 2 `test:platform-ops`; 3 `test:billing`; 4 `test:platform-core`; 5 `test:support-reads`; 6 `test:platform-sync`; 7 `test:no-dead-code` |
| `scripts/drills/run-isolated.mjs` `DRILLS` (right after this entry) | 0 `operator-create-store`; 1 `operator-onboarding`; 2 `connect`; 3 `signup`; 4 `shell`; 5 `settings`; 6 `team`. Only line 7 edits `ALL` |
| `scripts/drills/shell/run.mjs` | line 0 (reads `platform-pages.js`, widens `PLATFORM_CONSOLE`); line 5 (moves `supportNewUiControls` out); line 7 |
| `scripts/support/admin-routes.js`, `route-harness.js`, `test-permissions.js` | line 5 only |
| `docs/UI.md` "Operator screens (Phase 3)" | each line fills only its own sub-heading |
| `dead-code-allowlist.js` | each line adds rows for old platform files it orphans, reason "removed by Phase 3 line 7" |

---

## Line 0 (prerequisite): operator guard, route harness, operator shell and sign-in

**Fit:** no FEATURES line; it is the base for lines 1–7. One opus builder.

### Features (floor)
1. **`requireOperator(request, { write })`** in a new `lib/platform/require-operator.js`, Edge-safe. It returns `{ operator: { id, kind: "operator" | "bootstrap", name } }` or a response:
   - 403 for a cross-origin write;
   - 401 for no session, a revoked, expired or non-operator session, a merchant token, or bootstrap once an operator exists.
2. **Every `app/api/platform/*` route moves to it**, except `login`, `logout` and `billing/webhook`. This fixes the `billing`, `costs` and `flags` origin checks. Every `audit()`, `setFlag`, `setOverride`, `createSupportGrant` and `revokeSupportGrant` call gets the real operator id.
3. **`scripts/support/platform-routes.js`** holds one row per route × method × body action, each with a write or read flag. A new `scripts/test-platform-permissions.js` (`test:platform-permissions`) calls each row as:
   - operator, bootstrap before the first operator, and bootstrap after it;
   - signed out;
   - a merchant owner's and a merchant support member's `_admin` cookie;
   - a merchant token put in `_platform`;
   - a "operator" session for a non-operator user;
   - revoked and expired operator sessions.

   Cross-origin writes must get 403. A static guard fails when a route file or method has no row.
4. **Operator shell.** `app/(console)/platform/layout.js` wraps signed-in operators in `components/platform/shell/PlatformShell.js`:
   - `components/ui/sidebar` with `cookiePath="/platform"`;
   - the nav from `lib/platform/nav.js`: Stores (`/platform`, still the old page), Signups & onboarding, New store;
   - the operator's name and email, Sign out, and a mobile sheet.

   Signed-out visitors get no shell.
5. **Sign-in on the new UI.** Rewrite `components/platform/PlatformLogin.js` on `components/ui`:
   - keep the ids `#pl-email`, `#pl-password` and `#pl-totp` (`scripts/drill.js:229` uses them);
   - the TOTP enrolment secret is shown once with Copy;
   - plain-words errors;
   - the "Not configured" state.

   Add `components/kit/copy-button.js`; it is the third screen to need one.
6. **Old pages unchanged.** The old `/platform` page keeps its `data-legacy` region inside the new shell.

### Data
None.

### Permissions
Every row also holds for revoked and expired sessions, a non-operator's "operator" session, and bootstrap after the first operator: those are treated as signed out.

| Caller | any `/platform/*` page | any operator API |
|---|---|---|
| operator (TOTP) | shell and page | allowed |
| bootstrap, before the first operator exists | shell and page | allowed |
| signed out | sign-in, no shell | 401 |
| merchant session (`_admin`, or its token in `_platform`) | sign-in, no shell | 401 |

**Least-trusted tests:**
- The signed-out and merchant renders hold no store id or name canary.
- Cross-origin writes get 403 before auth.

### File plan
1. `lib/platform/require-operator.js`.
2. The route edits under `app/api/platform/**` (18 route files).
3. `scripts/support/platform-routes.js`, `scripts/support/platform-pages.js`, `scripts/test-platform-permissions.js`.
4. `lib/platform/nav.js`, `components/platform/shell/{PlatformShell,PlatformNav}.js`, `app/(console)/platform/layout.js`.
5. `components/platform/PlatformLogin.js`, `components/kit/copy-button.js`.
6. `scripts/test-platform-shell.js`.
7. `scripts/drills/platform-shell/run.mjs`. In `shell/run.mjs`, `OPERATOR_PAGES` is read from `platform-pages.js`.
8. `package.json`, `run-isolated.mjs`, and `docs/UI.md` (add the "Operator screens (Phase 3)" heading with one sub-heading per line).

### Checks first
- `node scripts/test-operator-onboarding.js`
- `node scripts/test-operator-create-store.js`
- `node scripts/test-case-studies.js`
- `node scripts/test-billing.js`
- `pnpm drill:shell`
- `grep -rn "verifyPlatformToken" app/api/platform | wc -l`

### Risks
1. `test-billing.js` and `test-case-studies.js` may POST without an Origin header. Set it in the suites; never loosen the route.

**Drill:** `drill:platform-shell`

---

## Line 1: list, search and open stores, with each store's status, plan and health

### Features (floor)
1. **`/platform` becomes the Stores list.** The old page moves unchanged to `/platform/legacy` (nav item "Old console", deleted by line 7), so no operator tool disappears from main in the meantime.
2. **Fleet strip** (from `overview`):
   - store counts by status;
   - 30-day net revenue, listing the stores that could not be counted (never counted as zero);
   - MRR;
   - how many stores are behind on migrations.
3. **List** (`DataTable`, 50 per page, filters in the URL):
   - **Search:** name, id, domain, owner email.
   - **Filters:** status (active, suspended, maintenance), plan, and "needs attention".
   - **Sort:** name, created, last updated.
   - **Columns:** name and id, status badge, plan and subscription state, onboarding n/4 or Open, health, flags (support access open, open incident).
4. **Health without blocking the list.** The list is control-plane SQL only. Live health loads only for the visible rows through `GET /api/platform/tenants?health=id,id`, with a 5-second limit per store. Each row says Healthy, "Needs attention: <reason>" (sync failed, Shopify uninstalled, pushes failing, migrations behind) or "Can't reach the store's database"; a failed check never shows as healthy.
5. **Store page** `/platform/stores/[id]`, read-only:
   - a header with an Open storefront link;
   - the health card with Try again;
   - onboarding steps, linking to the onboarding sheet;
   - Shopify connection and app redirect URLs, with Copy;
   - plan and subscription, linking to `/platform/billing?store=`;
   - live release, migration head against the repo head, theme pin;
   - **secret names only, never values**;
   - the last 10 provisioning runs;
   - the last 20 audit rows for the store, with operator names;
   - open incidents for the store;
   - support access status;
   - the last operator notes.
6. **States:** loading skeletons; empty fleet ("Create a store"); an unknown id gets a not-found page; errors with Try again; tables stay usable at 375px.
7. **No database details in the browser:** strip `db_url` from every response.

### Data
None. Reads `tenants`, the latest `subscriptions` row per store (`idx_subscriptions_tenant`), `onboarding_progress`, `support_grants`, `incidents`, `memberships`/`users` (owner email) and `audit_log`.

### Permissions
Every row also holds for revoked and expired sessions, a non-operator's "operator" session, and bootstrap after the first operator: those are treated as signed out.

| Read | operator | bootstrap (before first operator) | signed out | merchant session |
|---|---|---|---|---|
| `/platform`, `/platform/stores/[id]` pages | yes | yes | sign-in | sign-in |
| `GET tenants` (list, `?health=`), `GET tenants/[id]` | 200 | 200 | 401 | 401 |

**Tests in `test-platform-stores.js`:**
- The operator's raw JSON never holds `db_url`, `db_token`, a secret value or `password_hash` (canaries).
- The signed-out and merchant page renders hold no store canary.
- A merchant session put in `_platform` gets 401 on the health call too.

### File plan
1. `lib/platform/stores-list.js`: `listStores({ q, status, plan, attention, sort, offset })`, `storeHealth(ids)`, `storeDetail(id)`.
2. `app/api/platform/tenants/route.js` and `[id]/route.js` (GET only).
3. `app/(console)/platform/page.js` (rewrite) and `loading.js`; `legacy/page.js` (the moved old page); `stores/[id]/page.js` and `loading.js`.
4. `components/platform/stores/{StoresTable,FleetStrip,StoreDetail,HealthCard}.js`. `StoreDetail.js` carries the two anchors for lines 2 and 5.
5. `scripts/test-platform-stores.js`, the platform-routes and platform-pages rows, `scripts/drills/platform-stores/run.mjs` (search, filter, open, 375/768/1280 screenshots, anonymous and merchant passes).

### Checks first
- `node scripts/test-platform-permissions.js`
- `grep -rn "api/platform/tenants\"" scripts`: suites that read the old list shape.

### Risks
1. Owner-email search joins `users`. Use an exact lower-case email match, as `onboarding-ops.js:103` already does; no LIKE over emails.

**Drill:** `drill:platform-stores`

---

## Line 2: suspend or resume a store and rotate its secrets, with an audit row for each

### Features (floor)
1. **Suspend** (AlertDialog, reason of at least 5 characters). The dialog says what happens: the storefront and the console fail closed, jobs skip the store, and it can take up to 30 seconds to apply on other servers. **Resume** gets the same dialog.
2. **Maintenance on or off**, with the shoppers' message and a preview.
3. **Rotate secrets** (a dialog with checkboxes):
   - **Order-link signing key:** the dialog warns that old order links in customers' emails stop working.
   - **Store console password:** a new password is shown once with Copy, and only if the store has no members.

   The dialog also lists the merchant-owned keys (Razorpay, Meta, GA) by name with "The store's team changes these in Settings". Shopify tokens cannot be rotated here.
4. **The other store actions on the new UI:**
   - edit details (the existing PATCH `update`, with its field errors);
   - Sync catalog now (202 progress);
   - Export (link expiry shown);
   - Offboard (a typed-name confirmation, with the stages listed).
5. **An audit row for each,** with the real operator id. Actions: `tenant.status` (`{status, reason}`), `tenant.maintenance`, `tenant.secrets_rotate` (`{rotated: [plain names]}`, no values), `tenant.update`, `tenant.sync`, `tenant.export`, `tenant.offboard`. Each action is followed by a `slog`.
6. **The owner is emailed** on suspend and resume through `sendPlatformMail` when mail is configured. The UI says when it is not.
7. **The store page shows the new state** at once (fresh read) and the audit rows under recent activity.

### Data
None (`tenants.status`, `config.maintenance`, `secrets_enc`).

### Permissions
Every row also holds for revoked and expired sessions, a non-operator's "operator" session, and bootstrap after the first operator: those are treated as signed out.

| Action | operator | bootstrap (before first operator) | signed out | merchant session | cross-origin |
|---|---|---|---|---|---|
| suspend, resume, maintenance, rotate, update, sync, export, offboard | yes | yes | 401 | 401 | 403 |

**Tests in `test-store-lifecycle.js`:**
- An audit row exists for each action, with the operator's id and no secret value.
- After a rotation, an old order link fails and a new one works.
- A merchant session gets 401 and nothing changes (the row is compared before and after).
- Another store is untouched.

### File plan
1. `lib/platform/store-lifecycle.js`: `setStoreStatus`, `rotateStoreSecrets` (shared with `offboardTenant` in `export.js`).
2. `app/api/platform/tenants/[id]/route.js` (PATCH gains `rotate`).
3. `components/platform/stores/{LifecycleCard,RotateSecretsDialog,EditStoreDialog,OffboardDialog}.js` and the StoreDetail anchor.
4. `scripts/test-store-lifecycle.js`; `scripts/drills/store-lifecycle/run.mjs` proves suspend → storefront closed → resume, and maintenance.

### Checks first
- `node scripts/test-platform-ops.js`
- `node scripts/test-platform-core.js`
- `grep -n "offboardTenant" -r scripts lib`

### Risks
1. Rotation invalidates order links already emailed to customers. The dialog must say so, and nothing rotates by default.
2. The 30-second host cache (`PLATFORM_CACHE_MS`): test that `patchTenant` clears this server's cache.

**Drill:** `drill:store-lifecycle`

---

## Line 3: plans, subscriptions and billing events (with costs)

### Features (floor)
`/platform/billing`, with tabs in the URL:
1. **Overview:**
   - MRR, and gross, refunds and net by month;
   - whether the provider is configured;
   - the exception queue (payment trouble, past grace, orphan events), each row linking to its store.
2. **Subscriptions** (`DataTable`, searchable by store, filters for status and plan, opened by `?store=`):
   - **Start or change plan:** a free plan starts locally; a paid plan returns a link for the founder to pay, shown once with Copy. Changing plan cancels the old subscription at the end of its cycle.
   - **Extend grace:** up to +30 days, with a reason.
   - **Cancel:** a local subscription ends now. A provider subscription is cancelled at Razorpay (`POST /v1/subscriptions/{id}/cancel`, `cancel_at_cycle_end` true by default, checked in Razorpay's current docs). When the provider is not configured, the button is disabled and says why.
3. **Plans:**
   - versions with price (stored in paise, shown in rupees), interval, features as key/value rows, and the number of subscribers on each version;
   - **New version**, validated;
   - **Retire a version:** no new sales, and pinned subscribers keep it.
4. **Billing events:** the ledger, filtered by store, type and month, 50 per page, with signed amounts and orphans marked.
5. **Overrides:** set or clear per store, with a reason and an expiry.
6. **Costs** (moved here from the old GrowthOps panels): monthly inputs, the allocation report with the unallocated share, and per-store budgets.

### Data
None (`plans.status`, `subscriptions.grace_until` and `billing_events` already exist).

### Permissions
Every row also holds for revoked and expired sessions, a non-operator's "operator" session, and bootstrap after the first operator: those are treated as signed out.

| Action | operator | bootstrap (before first operator) | signed out | merchant session |
|---|---|---|---|---|
| page, `GET billing`, `GET costs` | yes | yes | sign-in / 401 | sign-in / 401 |
| override, clear, plan version, retire, start, grace, cancel, costs | yes | yes | 401 | 401 (403 cross-origin) |

**Tests:**
- Each write gets an audit row: `billing.*` or `costs.*`, with the real operator id.
- A merchant's `/api/admin/billing` read never shows another store's subscription.
- The provider is a fetch stand-in; no real Razorpay call is made.

### File plan
1. `lib/platform/billing.js` (add `retirePlanVersion`, `extendGrace`, `cancelSubscription`, `listSubscriptions`, `listBillingEvents`) and `razorpay-billing.js` (`cancelProviderSubscription`).
2. `app/api/platform/billing/route.js`, `app/api/platform/costs/route.js`.
3. `app/(console)/platform/billing/page.js` and `loading.js`; `components/platform/billing/{Overview,Subscriptions,Plans,Events,Overrides,Costs}.js`.
4. `scripts/test-platform-billing.js`, `scripts/drills/platform-billing/run.mjs`, and the rows in `platform-routes.js` and `platform-pages.js`.

### Checks first
- `node scripts/test-billing.js`
- `grep -n "fetch\|api.razorpay" lib/platform/razorpay-billing.js`: how the provider is stubbed.

### Risks
1. A provider cancel cannot be undone. Use an AlertDialog that says so; the suite proves the stand-in received the call and nothing else did.
2. Money is stored in paise here, while store money uses whole currency units. Use one formatter and test it at the boundary.

**Drill:** `drill:platform-billing`

---

## Line 4: feature flags and incidents

### Features (floor)
1. **`/platform/flags`:**
   - **List:** key, description, a plain state ("On for everyone", "Off", "On for 3 stores", "Expired"), critical, expiry, and updated by (operator name) and when. Searchable.
   - **Create or edit**, with the key checked against `^ff_[a-z0-9-]+$`.
   - **Per-store overrides:** pick a store, then on or off.
   - **Emergency disable:** an AlertDialog that explains a critical flag takes effect on the next request.
   - **Delete:** an AlertDialog that states what the code falls back to.
   - **History** from `audit_log` rows for `flag:<key>`.
2. **`/platform/incidents`:**
   - **List:** open first, then resolved, 50 per page, filtered by platform-wide or one store.
   - **Open an incident:** title, scope (platform-wide, or a store the server checks exists, otherwise 404), public message, internal note.
   - **Post an update:** a new public message, kept as a timeline from audit rows.
   - **Edit the internal note.**
   - **Resolve:** an AlertDialog with an optional closing message.
   - **Preview** of the banner merchants will see.
3. **Audit:** the actions become `incident.open`, `incident.update` and `incident.resolve` (not `tenant.status`). `tenantId` is the incident's store. **The diff never holds the internal note's text**, so merchant audit views can't leak it.

### Data
None. The timeline reads `audit_log` with `tenant_id IS ? AND resource = ?` (`idx_audit_tenant_at`).

### Permissions

| Action | operator | bootstrap (before first operator) | signed out | merchant session | merchant console (any role, operator-support) |
|---|---|---|---|---|---|
| flag and incident pages, GET | yes | yes | sign-in / 401 | sign-in / 401 | — |
| every flag and incident write | yes | yes | 401 | 401 (403 cross-origin) | — |
| incident banner (public message only) | — | — | — | — | members see it |

**Least-trusted tests:**
- A merchant support member's notices and their audit-log read never contain the internal-note canary.
- A merchant token in `_platform` gets 401 on every write, and nothing changes.

### File plan
1. `lib/platform/incidents.js` (open, update, resolve, list, timeline) and `lib/platform/flags.js` (actor id, history).
2. `app/api/platform/{flags,incidents}/route.js`.
3. Pages `app/(console)/platform/{flags,incidents}/page.js` and `loading.js`; `components/platform/{flags,incidents}/*.js`.
4. `scripts/test-flags-incidents.js`, `scripts/drills/flags-incidents/run.mjs` (opening an incident shows the banner on the roles store; resolving clears it).

### Checks first
- `node scripts/test-platform-core.js`
- `grep -rn "flagEnabled(" lib app | head`
- `grep -rn "internal_note" lib app`

### Risks
1. Old incident audit rows say `tenant.status`. Leave them; the timeline reads both names.

**Drill:** `drill:flags-incidents`

---

## Line 5: time-boxed support access, visible to the store's team

### Features (floor)
1. **On the store page** (the StoreDetail anchor):
   - **Open access:** a reason of at least 5 characters and 1, 4, 8, 24 or 72 hours.
   - **Status:** open until when, by whom and why.
   - **Close now.**
   - **History:** the last 20 grants (operator name, reason, opened, closed or expired, and by whom).
   - The onboarding sheet's existing open and close actions stay as they are.
2. **`/platform/support-access`:** every open grant across stores, with Close.
3. **Entering the store's console (works across hosts).** "Enter store console (read-only)":
   1. `POST /api/platform/support {action:"enter"}` mints a single-use entry token that lasts 60 seconds. It needs a TOTP operator; bootstrap is refused in plain words.
   2. The page auto-submits a form POST to `<store>/api/admin/support-entry`.
   3. That route uses up the token, checks the grant is open and belongs to that store, and creates a `support` session tied to the grant that ends when the grant does.
   4. It sets a host-only `_support` cookie (httpOnly, Secure, SameSite=Lax) and sends the browser to `/admin` (303).
4. **`supportActor` accepts `_support`.** It checks a live `support` session, `is_operator`, that the session's grant matches the store's open grant, and the store host. The old `_platform` path on the same host stays. Closing or expiring a grant revokes its sessions, and merchant logout clears `_support`.
5. **The store's team:**
   - the members' banner shows the operator's name (not their id), the reason and the end time;
   - owners and admins are emailed when access opens (best effort; the operator UI says if mail is off);
   - a "Support access" card on `/admin/settings/team` shows the open grant with "End support access now" (AlertDialog) and the last 20 grants.

### Data: `migrations/platform/0017_support_sessions.sql` (nothing destructive)
```sql
ALTER TABLE sessions ADD COLUMN grant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_grant ON sessions(grant_id);
```
New session kinds `support_entry` and `support` go in `sessions.kind` (TEXT), with no schema change. `verifySession` returns `grant_id` and applies the `is_operator` check to `support`.

### Permissions

| Action | operator | bootstrap (before first operator) | signed out | merchant session | owner, admin | staff, support | operator-support |
|---|---|---|---|---|---|---|---|
| open, close, list (platform) | yes | yes | 401 | 401 | — | — | — |
| enter (mint the entry token) | yes | 403, said in words | 401 | 401 | — | — | — |
| `admin/support-entry` POST | — | — | needs a valid token, else 400 | 400 | 400 | 400 | — |
| `GET /api/admin/support-access` (`audit.read`) | — | — | 401 | — | 200 | 403 | 403 |
| end access (`team.manage`) | — | — | 401 | — | 200 | 403 | 403 |

**Least-trusted tests:**
- **Token misuse:** a used token, an expired one, store A's token on store B, and a token for a closed grant all get 400 and set no cookie.
- **Every admin read:** `route-harness` gains the caller `operator-support-entry` (`_support`). `test:permissions` and `test:support-reads` run it with the same expectations as support.

### File plan
1. Migration 0017 (0016 went to line 3).
2. `lib/platform/sessions.js`, `lib/platform/support.js` (enter, revoke sessions, history, owner mail), `lib/admin-auth.js` (`supportActor`).
3. `app/api/platform/support/route.js`, `app/api/admin/support-entry/route.js`, `app/api/admin/support-access/route.js`, `app/api/admin/logout/route.js`.
4. `lib/admin/notices.js`.
5. `components/platform/support/{SupportAccessCard,EnterConsole}.js`, `app/(console)/platform/support-access/page.js`, `components/admin/team/SupportAccessCard.js` and the team page.
6. `scripts/support/{route-harness,admin-routes}.js`, `test-permissions.js`, `test-support-reads.js`, `scripts/test-support-access.js`.
7. `scripts/drills/support/stray.mjs`: `supportNewUiControls` moved out of `shell/run.mjs`.
8. `scripts/drills/support-access/run.mjs`, which:
   1. opens a grant on `localhost`;
   2. enters `roles.localhost` (a different host);
   3. runs the stray-control pass on every `ADMIN_PAGES` row as operator-support;
   4. checks the owner sees the banner and card, then ends access;
   5. checks the operator's next request goes to login.

### Checks first
- `node scripts/test-permissions.js`
- `node scripts/test-support-reads.js`
- `node scripts/test-console-shell.js`
- `node scripts/test-schema-compat.js`
- `git log --oneline -3 -- scripts/drills/shell/run.mjs` (line 11 must be in)

### Risks
1. The entry route is a new cross-origin credential path. The reviewer must check that the token is single-use, lasts 60 seconds, is bound to the store and the grant, never appears in a URL, and that the issued cookie is host-only.

**Drill:** `drill:support-access`

---

## Line 6 (new): queues, provisioning runs, privacy requests, themes and case studies

### Features (floor)
`/platform/operations` with tabs. Each tab does everything today's panel does, on `components/ui` and `components/kit`, with loading, empty and error states:
- **Queues:** counts by state, dead letters, retry and discard.
- **Provisioning runs:** list, resume or abandon, and a secret shown once.
- **Privacy requests:** list and act, with a typed-name confirmation for erasure.
- **Themes:** fleet theme pins.
- **Case studies:** create, edit, publish, archive.

Every write gets an audit row with the real operator id.

### Data
None.

### Permissions
The same as line 4's operator columns. Privacy and provisioning responses never carry customer PII or secret values beyond the existing one-time reveal (canary test).

### File plan
`app/(console)/platform/operations/page.js` and `loading.js`; `components/platform/operations/{Queues,ProvisionRuns,Privacy,Themes,CaseStudies}.js`; the routes' audit and actor edits; `scripts/test-platform-operations.js`; `scripts/drills/platform-ops/run.mjs`.

### Checks first
- `node scripts/test-case-studies.js`
- `grep -n "action ===" app/api/platform/{queues,provisions,privacy,themes,case-studies}/route.js`

### Risks
1. Privacy erasure cannot be undone. Use the typed-name confirmation, and the drill runs only on the throwaway store.

**Drill:** `drill:platform-ops`

---

## Line 7 (new): remove the old operator console and `components/console/`

### Features (floor)
1. **Delete:**
   - `/platform/legacy`;
   - `PlatformAdmin`, `TenantDetail` and every old panel;
   - the rest of `components/console/` and its README row;
   - the `data-legacy` CSS.
2. **Rebuild** `app/(console)/{error,layout}.js` and `platform/{error,loading}.js` on the new UI. If line 11 left `useToast` in place, move it to `components/ui` (sonner was approved in the shadcn decision).
3. **Tests:** `test:no-legacy-ui` covers the whole repo, and every "Phase 3 line 7" allowlist row is gone.
4. **Phase end:** `ALL` gains `platform-shell`, `platform-stores`, `store-lifecycle`, `platform-billing`, `flags-incidents`, `support-access` and `platform-ops`; then run `pnpm drill:all`.

### Data
None.

### Permissions
No change. The anonymous and merchant passes run on every `platform-pages.js` row.

### Checks first
- `grep -rln "components/console\|data-legacy" app components lib scripts`
- `node scripts/test-no-dead-code.js`

### Risks
1. Test suites that import old components as fixtures. The grep above must come back empty before anything is deleted.

**Drill:** `drill:platform-shell`, then `pnpm drill:all`.

---

## Decisions for `docs/DECISIONS.md` (schema and permissions first)

1. **Two migrations in Phase 3:** platform `0016_subscription_changes.sql` (line 3: one live subscription per store, additive columns and a unique partial index) and `0017_support_sessions.sql` (line 5: `sessions.grant_id` and its index). Both additive. Tenant migrations stay at 0029; the next free platform number is 0018.
2. **No operator roles in Phase 3.** Every operator, and bootstrap while no operator exists, may take every operator action. A read-only operator role goes under Later. The least-trusted callers of the operator console are the signed-out visitor and a merchant session.
3. **One guard, `requireOperator`, on every operator route,** with the origin check on every write. This fixes `billing`, `costs` and `flags`. Audit rows name the real operator.
4. **Support entry across hosts** uses a single-use, 60-second entry token and a host-only `_support` session tied to the grant. Bootstrap cannot enter. `_platform` on the same host keeps working.
5. **Merchants:** owners and admins can end support access (`team.manage`) and read its history (`audit.read`). The banner names the operator.
6. **Secret rotation** covers only the keys Storeasy holds (the order-link key and the store console password). Merchant-owned keys are listed, not rotated. Signing every member out, and rotating the Turso database token, go under Later.
7. **Incidents** keep their update history in `audit_log` (`incident.*` actions), never with the internal note's text. No new table.
8. **Costs move into Billing.** The remaining old panels get new line 6, and the removal gets new line 7. The old console survives at `/platform/legacy` until line 7.
9. **Billing:** a paid subscription is cancelled at Razorpay at the end of its cycle by default, and changing plan cancels the old one at cycle end.

## Risks and open questions (most serious first)

1. **Line 11 is in flight with a plan to delete all of `components/console/`** and a repo-wide no-`data-legacy` test. If it isn't told about finding 1 first, the operator console breaks on main. Run `grep -rln "components/console" components/platform app/\(console\)/platform app/\(console\)/*.js` on its branch before it merges.
2. **Line 5's entry route** is the one new credential path. It needs the security review in its own right, not just the line review.
3. **`test:permissions` gains a caller in line 5,** so every admin route row runs one more time. Check suite time with `time node scripts/test-permissions.js` before and after.
4. **The Razorpay cancel API** was checked in current docs (`POST /v1/subscriptions/{id}/cancel`, `cancel_at_cycle_end`). It has not been run against a real account; add it to `docs/cms-reviews/MANUAL-CHECKS.md`.
5. **Operator drills skip the TOTP screen.** They mint an operator user and session directly (`operator-onboarding/run.mjs:93`). Line 0's drill must type a real TOTP code once, so the rebuilt sign-in is actually proven.
