# Phase 4 plan: plugin system (roadmap Phase 2A)

> **Owner decision (2026-11-25):** read-only tokens are fine; `customers.read` is **not offered** in Phase 4. Wherever this plan mentions `customers.read` or a customer block, drop it: order payloads and v1 order reads are always redacted as for support.

## Findings that change the brief

**1. A plugin contract already exists, and parts of it break the rules.** `lib/types/ecosystem.ts` declares `PluginManifest`, `ExtensionSlotId`, `WebhookTopic` and `PluginScope`. Three parts conflict with this phase:
- Slot kinds `iframe_widget` and `script_tag` break line 2 ("without running the plugin's own JavaScript").
- `PluginScope` uses `orders:read` (colon), while the project's permission vocabulary is `<area>.<verb>`.
- `WebhookTopic` has no `order.fulfilled`.

Line 1 rewrites these types to match the decisions below. Phase 5 themes already reference `storeasy:plugin-slot`, so the slot ids chosen here become that primitive's vocabulary.

**2. The cache namespace `plugins` is already reserved** in `lib/cache.js` (`CACHE_NAMESPACES`). Nothing uses it yet. Line 2 uses it.

**3. The job queue's dead-letter path alerts operators** (`failJob` → `sendAlert`). If a merchant's endpoint being down went through that path, every outage would page Storeasy. So plugin deliveries keep their own attempt count and schedule on the delivery row, re-schedule through the handler's `{ requeue, runAfter }` return (the `catalog_sync` pattern in `lib/platform/worker.js`), and throw only on Storeasy infrastructure errors. Infrastructure errors still dead-letter loudly.

**4. There is no SSRF guard anywhere in `lib/`.** Only loopback sets exist (`turso-api.js`, `shopify-origin.js`). Line 3 builds one, using Node built-ins only.

**5. Every token call writes a control-plane audit row.** `audit()` is best-effort by design: it never throws. Line 4 needs "every call is audited", so it adds a strict mode that throws, and the token route refuses (503) when the audit row can't be written.

**6. New non-admin routes trip existing guards.** `scripts/support/shopper-routes.js` fails on any route outside `app/api/admin/` that has no row. `test-maintenance.js` checks which API families are not maintenance-gated. Both need edits in line 4.

**7. Recorded product direction says "no public API goal".** Line 4 still needs an external token. The design keeps that surface small: a per-store custom app, a read-only v1, server-to-server only. The owner question below asks whether this is enough.

## FEATURES order and parallelism

**Order:** line 1 → lines 2 and 3 side by side → line 4 (it needs line 3's custom apps). Line 4 may start as soon as line 3 is merged, even if line 2 is still running.

**Every line follows these rules:**
- Store data only through `withTenant` (`tenantHandler`).
- Every admin route through `requireAdmin`.
- Every write records an audit row.
- No edits to `docs/FEATURES.md` or `docs/DECISIONS.md`.
- Builders run only their own suite and drill.
- Nothing under `lib/plugins/` that a storefront file can reach imports `node:*`. The only exceptions are `egress.js` and `deliveries.js`, which only the worker may import, and a test proves it.

| Shared file | Who appends what (keep both sides on conflict) |
|---|---|
| `lib/platform/authz.js` | line 1 only: `apps.read`, `apps.manage`, `APP_SCOPES`, `scopeAllows` |
| `lib/types/ecosystem.ts` | 1 rewrites the plugin types; 2 `SlotId` and `BlockPrimitive`; 3 `WebhookTopic`; 4 `AppTokenScope` |
| `lib/plugins/manifest.js` (line 1) | 2 validates `blocks`; 3 validates `events` and `egress`. Each adds one function at its own anchor comment (`// line 2: blocks`, `// line 3: events`) |
| `lib/plugins/first-party/trust-badges/manifest.js` (line 1) | line 2 adds `blocks` |
| `components/admin/apps/AppDetail.js` (line 1) | 2 at `{/* line 2: placements */}`, 3 at `{/* line 3: webhooks */}`, 4 at `{/* line 4: api access */}` |
| `app/api/admin/apps/route.js` (line 1) | line 3 adds the `create_custom` branch |
| `scripts/support/admin-routes.js` | each line adds only its own route rows |
| `scripts/support/support-reads.js` | each line adds its probes and canaries |
| `scripts/support/admin-pages.js` | line 1 only (`apps`, `apps/[id]`) |
| `package.json` (after `test:support-access`) | 1 `test:apps`; 2 `test:plugin-slots`; 3 `test:plugin-webhooks`; 4 `test:app-tokens` |
| `scripts/drills/run-isolated.mjs` `DRILLS` | line 1 adds `apps`; lines 2–4 add stage files only |
| `scripts/drills/apps/run.mjs` (line 1) | each line adds one import line for its `stage-<name>.mjs` |
| `docs/UI.md` "Merchant screens: Apps (Phase 4)" | each line fills its own sub-heading |
| `docs/ARCHITECTURE.md` | 1 matrix rows; 2 a "Plugin slots" paragraph; 3 event flow and background-work rows; 4 the route class `app-token` |
| `lib/platform/worker.js` `HANDLERS` | line 3 only |

**Migration numbers are fixed now**, so lines 2 and 3 can't collide:
- line 1: tenant `0030`
- line 2: tenant `0031`
- line 3: tenant `0032`
- line 4: tenant `0033` and platform `0019` (0018 went to the Phase 3 audit fixes)

The runner (`lib/platform/migrate.js`) keeps a ledger by id and runs any un-applied file in order. So 0032 merging before 0031 still applies cleanly, as long as neither references the other's tables. They don't.

---

## Line 1: an admin installs a first-party plugin from `/admin/apps` and turns it off again; staff and support cannot

**Fit:** Phase 4 line 1. Depends on nothing unbuilt. One opus builder (permissions, routes, schema), then ui-designer.

### Features (floor)
1. **Catalog in code.**
   - `lib/plugins/catalog.js` lists the first-party manifests.
   - Phase 4 ships one real plugin, **Trust badges** (`trust-badges`): up to 4 badges, each an icon from a fixed set plus a label. Its storefront blocks arrive in line 2.
   - A test-only seam, `registerPlugin(manifest)` → undo function (like `registerSectionComponent`), lets suites add fixture plugins.
2. **Manifest validation** (`lib/plugins/manifest.js`, pure, Edge-safe):
   - id slug `^[a-z0-9][a-z0-9-]{1,48}$`, name, semver version, summary, description, a lucide icon name;
   - `scopes` (keys of `APP_SCOPES`) and `settings` (registry setting kinds plus `secret`);
   - a contract check `checkCatalog()` that returns `[]` when every manifest keeps its promises (as `checkRegistry()` does).
3. **`/admin/apps`**, gated on `apps.read`:
   - an "Installed" tab: name, status badge (On / Off), installed by and when;
   - a "Browse" tab: catalog cards with "Install" (admin+ only);
   - empty states in plain words;
   - plugins an operator has switched off are shown as unavailable.
4. **Install dialog:**
   - says what the plugin does and lists every permission in `APP_SCOPES` words, or "It can't see your orders or customers" when there are none;
   - "Approve and install" records `granted_scopes`.
   - Installing never changes the storefront by itself (line 2 adds blocks switched off).
5. **`/admin/apps/[id]`** (the install id):
   - Overview: what it does, its permissions, version, installed by and when;
   - a Settings form built from the manifest (text, number, boolean, choice and the list kind; `secret` fields are write-only and show "Set" / "Not set");
   - an Activity list of this install's audit rows (`audit.read` holders only; others see nothing);
   - a Danger zone with **Turn off**, **Turn on** and **Uninstall**, each behind an AlertDialog in plain words.
6. **Turn off vs uninstall:**
   - Turn off keeps settings and stops everything the plugin does.
   - Uninstall archives the install (`status='uninstalled'`; nothing is deleted). It leaves the Installed list, and installing again creates a fresh install with fresh settings.
7. **Validation:**
   - settings are checked against the manifest using the registry's setting checks, with plain-words errors per field;
   - unknown keys are refused;
   - secrets are encrypted with `encryptJson` and never returned to a browser.
8. **Role behaviour:**
   - staff, support and operator-support see the list and detail read-only, with no Install, toggles or Save (the role gate and server checks);
   - the API refuses them with 403;
   - signed-out callers get 401.
9. **Nav:** "Apps" in the Store group (`apps.read`), plus the page title and breadcrumbs.
10. **Operator kill switch.** An existing feature flag `ff_plugin-<id>`, set off by an operator:
    - hides the plugin from Browse;
    - shows "Turned off by Storeasy" on installs;
    - refuses Turn on;
    - stops blocks (line 2) and deliveries (line 3).

    No new operator screen.
11. **Concurrency:** two admins installing at once give exactly one live install (a unique partial index; the loser gets "Already installed").
12. **Audit:** `apps.install`, `apps.enable`, `apps.disable`, `apps.uninstall`, `apps.settings`.
    - The `apps.settings` diff lists changed keys only.
    - The diff never uses a key matching `/secret|token|key|password/` for counts. Write `{ changed: [...], hidden_fields_changed: n }`, because `redactDiff` would blank a key containing "secret".

### Data: `migrations/tenant/0030_plugin_installs.sql` (additive)
```sql
CREATE TABLE IF NOT EXISTS plugin_installs (
  id             TEXT PRIMARY KEY,              -- "pin_" + 16 hex
  plugin_id      TEXT NOT NULL,                 -- "trust-badges", or "custom:<id>" (line 3)
  kind           TEXT NOT NULL,                 -- first_party | custom
  name           TEXT,                          -- custom apps only
  version        TEXT NOT NULL,
  status         TEXT NOT NULL,                 -- enabled | disabled | uninstalled
  granted_scopes TEXT NOT NULL DEFAULT '[]',    -- APP_SCOPES keys the admin approved
  settings       TEXT NOT NULL DEFAULT '{}',
  secrets_enc    TEXT,                          -- encryptJson; never sent to a browser
  installed_by   TEXT NOT NULL,
  installed_at   TEXT NOT NULL,
  updated_by     TEXT,
  updated_at     TEXT NOT NULL,
  disabled_at    TEXT, disabled_by TEXT,
  uninstalled_at TEXT, uninstalled_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_installs_live ON plugin_installs(plugin_id) WHERE status <> 'uninstalled';
CREATE INDEX IF NOT EXISTS idx_plugin_installs_status ON plugin_installs(status);
```

### Permissions

New actions in `lib/platform/authz.js`:
```js
const SUPPORT = [...existing, "apps.read"];
const ADMIN   = [...existing, "apps.manage"];
```

| Action | owner | admin | staff | support | operator-support | signed out | another store's owner |
|---|---|---|---|---|---|---|---|
| `apps.read` (list, detail) | 200 | 200 | 200 | 200 | 200 | 401 | 401 |
| `apps.manage` (install, on/off, uninstall, settings) | 200 | 200 | 403 | 403 | 403 | 401 | 401 |
| Activity list (`audit.read`) | 200 | 200 | 403 | 403 | 403 | 401 | 401 |

**Rows for the `docs/ARCHITECTURE.md` matrix:**
- `apps.read` (see installed apps and the catalog): allow, allow, allow, allow, deny, via support grant.
- `apps.manage` (install, turn on or off, uninstall, settings; with line 2 placements, line 3 webhooks, line 4 tokens): allow, allow, deny, deny, deny, deny (a grant is support only).

**Least-trusted tests:**
- **Support reads:** support (and operator-support) GET `/api/admin/apps` and `/api/admin/apps/[id]`. Canaries: a secret setting's value, `secrets_enc`, and another store's install. Top-level keys are pinned.
- **Pages:** both pages are run as support in the page harness.
- **Stray controls:** the shell drill's stray-control pass covers both pages through `ADMIN_PAGES`.

### File plan
1. `migrations/tenant/0030_plugin_installs.sql`
2. `lib/platform/authz.js` (actions, `APP_SCOPES`, `scopeAllows`; see the line 4 design, which defines the table now so the install dialog can word scopes)
3. `lib/types/ecosystem.ts` (rewrite the plugin section: scopes = `APP_SCOPES` keys; slot kind `declarative` only; no `iframe_widget` or `script_tag`)
4. `lib/plugins/manifest.js`, `lib/plugins/catalog.js`, `lib/plugins/first-party/trust-badges/manifest.js`, `lib/plugins/settings.js` (validate and split secrets), `lib/plugins/installs.js` (list, get, install, enable, disable, uninstall, settings, kill-switch check, audit, `invalidateTenantCache("plugins")`)
5. `app/api/admin/apps/route.js` (GET `apps.read`; POST `{install}` `apps.manage`), `app/api/admin/apps/[id]/route.js` (GET `apps.read`; POST `{enable}|{disable}|{uninstall}|{settings}` `apps.manage`)
6. `lib/admin/nav.js` (the Apps item)
7. `app/(console)/admin/(authed)/apps/page.js`, `app/(console)/admin/(authed)/apps/[id]/page.js`, `components/admin/apps/{AppsList,AppCatalog,InstallDialog,AppDetail,AppSettingsForm,AppDangerZone,AppActivity}.js`
8. `scripts/support/{admin-routes,admin-pages,support-reads}.js`, `scripts/test-apps.js`, `package.json` `test:apps`
9. `scripts/drills/apps/run.mjs`, `scripts/drills/apps/stage-install.mjs`, `scripts/drills/run-isolated.mjs` (`apps`). The drill: owner installs Trust badges, edits settings, turns it off and on, uninstalls; staff and support see no write control.
10. `docs/UI.md` (Apps: list and detail), `docs/ARCHITECTURE.md` (tables and matrix rows)

### Checks first
- `node scripts/test-authz.js && node scripts/test-permissions.js && node scripts/test-support-reads.js && node scripts/test-console-shell.js`. Record the passes; the shell test probably pins the nav list, so expect to update it.
- `node scripts/test-schema-compat.js`
- `ls migrations/tenant | tail -3` (0030 must still be free)
- `grep -n "^  [a-z_]*: {" lib/registry/settings.js`: pick the list kind for "up to 4 {icon, label}" (`entries` or `pairs`); don't add a new kind if one fits.
- `grep -n "ff_\|KEY_RE" lib/platform/flags.js`: confirm `ff_plugin-trust-badges` matches `KEY_RE`.

### Risks
1. Secrets in settings are the first merchant-entered third-party secrets outside Integrations. The reviewer must check they never reach a response, a log or an audit diff, including on validation errors.
2. The nav change ripples into the shell drill's pinned expectations; budget for updating them.

**Drill:** `drill:apps` (stage install)

---

## Line 2: a plugin adds a block to a named storefront slot, rendered without running the plugin's own JavaScript

**Fit:** Phase 4 line 2. Needs line 1. One opus builder (Edge storefront), then ui-designer for the Placements card.

### Slot rendering contract
- **Slots are a fixed table in `lib/plugins/slots.js`** (pure). Each slot has an id, the page it sits on, the context it hands to data resolvers, and a max of 3 blocks. Phase 4 slots:

  | Slot | Where | Context passed | Phase 9 user |
  |---|---|---|---|
  | `storefront.pdp.under_price` | both PDP layouts | public product fields | review stars |
  | `storefront.pdp.under_atc` | both PDP layouts | public product fields | Trust badges, delivery estimate |
  | `storefront.pdp.below_fold` | both PDP layouts | public product fields | review list, guarantee note |
  | `storefront.order.status` | `orders/[orderId]` and `account/orders/[orderId]` | id, status, fulfillment status, created time (no contact) | Shiprocket tracking |
  | `storefront.footer.above` | storefront layout | none | — |
- **Blocks are Storeasy-owned primitives.** A manifest block is `{ id, label, primitive, slots: [allowed], settings: [...], data?: (ctx) => props }`.
  - `primitive` names a component in `components/plugins/blocks/index.js`. Phase 4 ships `badge_row` and `notice`, the two that Trust badges uses. Phase 9 adds its own primitives (`rating_summary`, `tracking_timeline` and so on) through the same map.
  - Primitives are server components only: no `"use client"`, no event handlers, no `<script>`, no iframe, no `dangerouslySetInnerHTML` except the registry `sanitize()` output for `rich_text`.
- **Data comes only through validation.** A block's props are the placement's settings plus the optional `data(ctx)` output. Both are checked against the primitive's declared prop shape (`lib/plugins/blocks.js`), using the registry setting checks:
  - text is plain, capped and stripped of control characters (React escapes it);
  - `rich_text` goes through `sanitize()`;
  - links must pass `isStorefrontHref`;
  - icons come from a fixed enum;
  - numbers are bounded;
  - unknown keys are dropped;
  - no `className`, `style` or attribute passthrough.

  Validation runs on save (refused in plain words) and again at render, where a failing block is skipped and `slog("plugin_block_invalid")` is written.
- **`data(ctx)` is first-party, in-repo, Edge-safe code.** "No plugin JavaScript" means no third-party code on the server and no plugin code in the browser. The resolver gets a 300 ms budget (`Promise.race`); a throw or timeout skips the block. External (custom) apps cannot add blocks in Phase 4.
- **`<PluginSlot name ctx />`** (server component):
  - reads every live placement for the store in one `cachedTenantRead("plugins", ["placements"])`, wrapped in React `cache()` per request, joined to enabled installs and filtered by the kill switch;
  - renders each block in `<div data-plugin-slot data-plugin data-block>`;
  - renders nothing at all for an empty slot;
  - treats a database one migration behind ("no such table" via `lib/schema-shape.js`) as no blocks.
- **Founder preview.** In the founder's preview (`isFounderPreview`), an enabled install's placements that are switched off render with the existing `FounderNote` ("Turned off: shoppers don't see this").

### Features (floor)
1. **Trust badges declares two blocks:**
   - "Badges" (`badge_row`; slots `pdp.under_atc` or `pdp.below_fold`);
   - "Guarantee note" (`notice`: title, text, an optional store link; slots `pdp.below_fold` or `footer.above`).
2. **The detail page's "Where it shows" card** (`apps.read` to see, `apps.manage` to change). One row per manifest block:
   - a slot picker among the block's allowed slots;
   - a Live / Off switch (default Off);
   - order (move up and down within the slot);
   - block settings;
   - "Preview on store" (opens the founder preview at a page that has the slot).
3. Placements are created **Off** when the plugin is installed, one per block.
4. Turning an install off or uninstalling it hides its blocks at once (`invalidateTenantCache("plugins")` on every install or placement write).
5. Outlets go in `PdpClassic` and `PdpEditorial`, both order pages, and the footer.
6. Audit `apps.placement` with `{ block, slot, state }`.

### Data: `migrations/tenant/0031_plugin_placements.sql` (additive)
```sql
CREATE TABLE IF NOT EXISTS plugin_placements (
  id         TEXT PRIMARY KEY,          -- "ppl_" + 16 hex
  install_id TEXT NOT NULL,
  block_id   TEXT NOT NULL,             -- the manifest block id
  slot       TEXT NOT NULL,             -- one of the block's allowed slots
  state      TEXT NOT NULL DEFAULT 'off', -- off | live
  settings   TEXT NOT NULL DEFAULT '{}',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_placements_block ON plugin_placements(install_id, block_id);
CREATE INDEX IF NOT EXISTS idx_plugin_placements_live ON plugin_placements(state, slot);
```
Line 1's install code calls `ensurePlacements(install)` only when this table exists (schema-shape check), so lines 1 and 2 merge in either order.

### Permissions
- `GET /api/admin/apps/[id]/placements` (`apps.read`): owner, admin, staff, support, operator-support 200; signed out 401.
- `POST` (`apps.manage`): owner and admin 200; staff, support and operator-support 403.
- **Anonymous shopper (least-trusted) tests** on the rendered storefront:
  - store A's live block appears on A's PDP;
  - it is absent on store B's;
  - it is absent when the placement is Off, the install is off or uninstalled, or the kill switch is set;
  - a label of `<script>alert(1)</script>` renders escaped;
  - a `javascript:` link is refused on save and dropped at render;
  - slot markup contains no `<script`, `on*=`, `<iframe` or external `src`;
  - the anonymous HTML never contains the founder-preview note.

### File plan
1. `migrations/tenant/0031_plugin_placements.sql`
2. `lib/plugins/slots.js`, `lib/plugins/blocks.js` (primitive prop shapes and `validateBlockProps`), `lib/plugins/placements.js` (read live, list, update, ensure); `lib/plugins/manifest.js` (blocks validation at the anchor); trust-badges manifest (`blocks`)
3. `components/plugins/PluginSlot.js`, `components/plugins/blocks/{index,BadgeRow,Notice}.js`
4. `components/pdp/PdpLayouts.js`, `app/(storefront)/orders/[orderId]/page.js`, `app/(storefront)/account/orders/[orderId]/page.js`, `components/Footer.js` (check the footer's real file name)
5. `app/api/admin/apps/[id]/placements/route.js`, `components/admin/apps/PlacementsCard.js` (at the AppDetail anchor)
6. `lib/types/ecosystem.ts` (`SlotId`, `BlockPrimitive`)
7. `scripts/test-plugin-slots.js`:
   - render contract and sanitizing;
   - anonymous shopper, cross-store, off and kill-switch cases;
   - a transitive import scan from `PluginSlot.js` that finds no `node:` import except `tenant-context`'s `async_hooks` (the `test-commerce-blocks.js:447` pattern);
   - a static check that no file in `components/plugins/` has `"use client"`.
8. `scripts/support/{admin-routes,support-reads}.js`, `package.json` `test:plugin-slots`, `scripts/drills/apps/stage-slots.mjs` (owner turns Badges live; an anonymous browser sees it on a PDP; turning it off hides it)
9. `docs/UI.md`, `docs/ARCHITECTURE.md` ("Plugin slots")

### Checks first
- `node scripts/test-sections-render.js && node scripts/test-commerce-blocks.js`
- `grep -n "node:" lib/platform/flags.js lib/platform/control.js`: if the flag read isn't Edge-safe, the storefront enforces the kill switch through the cached placement read instead. Setting the flag calls `invalidateTenantCache("plugins")` for every store with an install, or within the 60 s TTL; say which in the report.
- `grep -rn "isFounderPreview\|FounderNote" components/sections/parts.js`
- `grep -ln "products/" scripts/drills/*/run.mjs`: find which drill already opens a PDP, to reuse its fixture.

### Risks
1. **Performance:** the footer outlet adds a read to every storefront page. It must hit the per-request `cache()` and tagged cache, and do zero work when the store has no live placements. Measure PDP render time before and after in the suite.
2. The order pages use the Node runtime and a signed-link gate. The slot must render only after the existing token check, never before it.

**Drill:** `drill:apps` (stage slots)

---

## Line 3: a plugin receives store webhooks (order created, fulfilled) through an outbox with retries and signed deliveries

**Fit:** Phase 4 line 3. Needs line 1 (not line 2). One opus builder (security-critical egress), then ui-designer.

### Features (floor)
1. **Custom apps** (external plugins).
   - "Create custom app" on `/admin/apps` (`apps.manage`) takes:
     - a name;
     - an HTTPS endpoint URL;
     - topics (`order.created`, `order.fulfilled`);
     - permissions to approve (`orders.read` is required by the order topics; `customers.read` is optional and unchecked by default, with plain words that customer names, emails, phones and addresses go to this app).
   - Creating one makes an install with `kind='custom'`, `plugin_id='custom:<id>'` and an endpoint.
   - The signing secret (`whsec_…`) is shown once with a copy button.
   - Max 10 custom apps per store.
2. **Webhooks card** on the detail page:
   - endpoint URL and status (Active / Paused, with the reason);
   - topics;
   - edit the endpoint (re-validated; a host change is audited as an allowlist change);
   - **Rotate secret** (the old secret keeps signing alongside the new one for 24 h);
   - **Send test event** (a `ping` topic);
   - **Pause** / **Resume**.
3. **Deliveries table:** the last 50 deliveries with filters.
   - Columns: topic, event id, status (Delivered / Retrying / Failed / Skipped), attempts, last HTTP status, next retry, duration.
   - **Resend** on Failed or Skipped (`apps.manage`).
   - Payload view only for roles without PII redaction (support and operator-support see status only).
4. **Events.**
   - `order.created` is emitted from `runOrderEffects` (`lib/payment-settle.js`), which covers a prepaid order once paid and a COD order once placed. Key: `order.created:<orderId>`.
   - `order.fulfilled` is emitted from `reconcileOrderProjection` (`lib/order-projection.js`) when `fulfillment_status` moves to `fulfilled` from anything else. Key: `order.fulfilled:<orderId>`, once per order ever.
   - An emit never fails the flow it rides on (the `enqueueDurable` style).
5. **Fan-out.** The `plugin_fanout` job writes one delivery per subscriber:
   - enabled custom apps whose endpoint is active, subscribed to the topic and holding `orders.read`;
   - enabled first-party installs whose manifest has `events[topic]`.

   Then it enqueues one `plugin_delivery` job per delivery. Job payloads carry ids only (the jobs table rule: no PII).
6. **First-party (internal) deliveries** call the manifest handler with a narrow context: `{ event, install: { id, settings }, secrets(), fetch: safeFetch bound to the manifest's egress, log }`. They use the same rows, retries and log. Phase 9 WhatsApp and Shiprocket use this. A test-only fixture plugin proves it in Phase 4.
7. **Signing** (Standard Webhooks v1, checked against the current spec):
   - headers `webhook-id` (the delivery id, stable across retries, so receivers use it as their idempotency key), `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`;
   - two signatures, space-separated, during a rotation overlap;
   - `whsec_` plus 32 random bytes base64, stored with `encryptSecret`.

   The docs tell receivers to accept a 5-minute window.
8. **Body:** `{ id: "evt_…", type, created_at, store: "<host>", data: { order: {...} } }`.
   - The `customer` block is included only when the app holds `customers.read`; scopes are re-checked at send time, not at emit time.
   - Max 256 KB; line items are capped at 100, with `line_items_truncated: true`.
9. **Retries:** own schedule on the delivery row.
   - Waits: 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, 24 h (8 attempts, about 45 h), each with ±20% jitter.
   - Any 2xx counts as delivered. 3xx (redirects aren't followed), 4xx, 5xx, timeouts and refused egress retry. A 410 pauses the endpoint at once.
   - After the last attempt the status is Failed. No operator alert; Storeasy infrastructure errors still throw and dead-letter.
10. **Auto-pause:** an endpoint whose deliveries have all failed for 72 h (`failing_since`) is paused (`apps.endpoint_auto_paused`, actor system).
    - Owners and admins are emailed (best effort).
    - The dashboard attention list shows "An app's webhook address isn't answering".
    - While paused, new deliveries are recorded as Skipped (Resend works).
11. **Turning things off:** an install that is off, uninstalled or kill-switched turns its pending deliveries into Skipped on their next attempt. Events from while it was off are not backfilled.
12. **Retention and privacy:**
    - events and deliveries older than 30 days are pruned during fan-out (up to 500 rows per run);
    - `redactCustomer` (`lib/privacy.js`) also strips the customer block from that customer's `plugin_events` payloads;
    - `export.js` lists the new tables (without `secret_enc`).

### Outbox delivery: egress guard (`lib/plugins/egress.js`, Node-only)
- `safeFetch(url, { allowHosts, body, headers, timeoutMs: 15000 })` uses `node:https.request`, not global fetch, so DNS is checked at connect time.
- **URL rules:** `https:` only; port 443 only; no userinfo; the host is a name, not an IP literal; the host is not `localhost`, `*.localhost`, `*.local`, `*.internal` or `*.home.arpa`; the host must be in `allowHosts`.
- **Allowlist per plugin:**
  - a custom app's list is the single host approved when the endpoint was saved (`plugin_endpoints.host`);
  - a first-party plugin's list is its manifest `egress`;
  - `*.myshopify.com`, `shopify.com` and `*.shopify.com` are always refused (the Shopify boundary).
- **DNS rebinding guard:** a `lookup` option wraps `dns.lookup`. It handles `all: true` (Node's `autoSelectFamily` default passes it) and fails the connection if *any* resolved address is in a `net.BlockList`:
  - IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4;
  - IPv6: ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32, 64:ff9b::/96;
  - IPv4-mapped `::ffff:x.x.x.x` is checked as its IPv4 address.
- **Request and response handling:** redirects are never followed; the response body is read up to 4 KB and discarded; only a short error string is stored.
- **Save-time check:** saving an endpoint runs the same checks, including a DNS resolve, and refuses in plain words. Send time is the real gate.
- **Tests and production:** tests may reach `http://127.0.0.1:<port>` only with `STOREASY_PLUGIN_EGRESS_LOCAL=1`, which is refused when `NODE_ENV=production` (fail closed, with a unit test).

### Data: `migrations/tenant/0032_plugin_webhooks.sql` (additive)
```sql
CREATE TABLE IF NOT EXISTS plugin_endpoints (
  id               TEXT PRIMARY KEY,         -- "pwe_" + 16 hex
  install_id       TEXT NOT NULL UNIQUE,
  url              TEXT NOT NULL,
  host             TEXT NOT NULL,            -- the approved host: this app's egress allowlist
  topics           TEXT NOT NULL DEFAULT '[]',
  secret_enc       TEXT NOT NULL,
  prev_secret_enc  TEXT,
  prev_secret_until TEXT,
  status           TEXT NOT NULL DEFAULT 'active', -- active | paused
  paused_reason    TEXT, paused_at TEXT,
  failing_since    TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_events (
  id              TEXT PRIMARY KEY,          -- "evt_" + 16 hex
  topic           TEXT NOT NULL,
  resource        TEXT,                      -- "order:ord_…"
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL,             -- snapshot; scope redaction at send time
  created_at      TEXT NOT NULL,
  fanned_out_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_events_created ON plugin_events(created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_events_resource ON plugin_events(resource);
CREATE TABLE IF NOT EXISTS plugin_deliveries (
  id              TEXT PRIMARY KEY,          -- "dlv_" + 16 hex; the webhook-id header
  event_id        TEXT NOT NULL,
  install_id      TEXT NOT NULL,
  target          TEXT NOT NULL,             -- http | internal
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed | skipped
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, last_attempt_at TEXT,
  last_status     INTEGER, last_error TEXT, last_ms INTEGER,
  delivered_at    TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(event_id, install_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_deliveries_install ON plugin_deliveries(install_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_deliveries_status ON plugin_deliveries(status, next_attempt_at);
```

**Idempotency at every hop:**
- event: `UNIQUE idempotency_key`;
- fan-out job: `plugin_fanout:<tenant>:<evt>`;
- delivery: `UNIQUE(event_id, install_id)`;
- delivery job: `plugin_delivery:<tenant>:<dlv>`;
- receiver: `webhook-id`;
- a delivered row completes without sending again.

### Permissions
- `GET /api/admin/apps/[id]/webhooks` (`apps.read`): all roles 200. The secret is never returned. Payloads are hidden for support and operator-support (`redactsPii`).
- `POST /api/admin/apps/[id]/webhooks` (`apps.manage`: `{endpoint}|{rotate_secret}|{test}|{pause}|{resume}|{resend}`): owner and admin only.
- `POST /api/admin/apps {create_custom}` (`apps.manage`).
- **Least-trusted tests:**
  - support GETs webhooks and deliveries. Canaries: the plaintext secret, `secret_enc`, a customer's email and phone from an event payload, and another store's delivery.
  - support POSTs each variant and gets 403.
  - the anonymous shopper has no new read.

### File plan
1. `migrations/tenant/0032_plugin_webhooks.sql`
2. `lib/plugins/topics.js` (pure: topic → required scope, payload builder, redaction by scope), `lib/plugins/sign.js` (WebCrypto HMAC; secret format), `lib/plugins/egress.js` (Node-only), `lib/plugins/events.js` (`emitPluginEvent`, `fanOut`, prune), `lib/plugins/deliveries.js` (deliver, schedule, auto-pause, resend), `lib/plugins/custom-apps.js` (create, endpoint save and validate, rotate, pause and resume); `lib/plugins/manifest.js` (events and egress at the anchor)
3. `lib/platform/worker.js` (`plugin_fanout`, `plugin_delivery` in `HANDLERS`, dynamic imports only), `lib/payment-settle.js`, `lib/order-projection.js`, `lib/privacy.js`, `lib/platform/export.js`, `lib/admin/dashboard.js`
4. `app/api/admin/apps/route.js` (`create_custom`), `app/api/admin/apps/[id]/webhooks/route.js`
5. `components/admin/apps/{CustomAppDialog,WebhooksCard,DeliveriesTable,SecretOnce}.js`
6. `lib/types/ecosystem.ts` (`WebhookTopic`: `order.created`, `order.fulfilled`, `ping`)
7. `scripts/test-plugin-webhooks.js`, which proves:
   - a signature known-answer test against the Standard Webhooks reference vector;
   - a rotation sends two signatures;
   - every blocked range, a DNS answer mixing public and private addresses, an IPv4-mapped IPv6 address, a redirect, port 8443, an IP-literal host, a Shopify host and an off-allowlist host are all refused;
   - the local-egress flag is refused in production;
   - the retry schedule, 410 pause and 72 h auto-pause;
   - a replayed emit or a re-run job sends no duplicate;
   - a customer block appears only with `customers.read`;
   - the fixture first-party handler runs;
   - an install that is off turns its deliveries into Skipped;
   - privacy redaction and pruning;
   - `egress.js` is unreachable from any `app/(storefront)` or `components/` import graph.
8. `scripts/support/{admin-routes,support-reads}.js`, `package.json` `test:plugin-webhooks`, `scripts/drills/apps/stage-webhooks.mjs` (create a custom app pointed at a local receiver under the test flag; place a COD order; the receiver verifies the signature; the Deliveries table shows Delivered)
9. `docs/ARCHITECTURE.md` (event flow; jobs `plugin_fanout`, `plugin_delivery`), `docs/APPS_WEBHOOKS.md` (receiver guide: headers, verification, retries; sonnet)

### Checks first
- `grep -l "worker.js\|jobs.js" scripts/test-*.js`, then run those suites, plus `node scripts/test-schema-compat.js`.
- `node -e "const {BlockList}=require('node:net');const b=new BlockList();b.addSubnet('10.0.0.0',8,'ipv4');console.log(b.check('10.1.2.3','ipv4'))"` (expect `true` on Node 26).
- `node -p "require('node:net').getDefaultAutoSelectFamily()"`: confirms the lookup hook gets `all: true`.
- `grep -n "export" lib/notifications.js | head`: find the owner and admin mail path for the auto-pause email.
- `grep -n "fulfillment_status" lib/order-projection.js`: read the previous status before the update so the transition is detected.

### Risks
1. **The egress guard is the security core of the phase.** It needs its own security review, not only the line review: DNS rebinding through `lookup`, IPv6 forms, redirects, and the production refusal of the local flag.
2. **Order PII now leaves Storeasy for third parties.** Consent wording, the redaction at send time and the privacy erase must all be reviewed together.
3. **Deliveries depend on the tick cadence.** With no external scheduler the 1-minute first retry slips. Check what `/api/jobs/tick` is scheduled at before promising times in the UI; word them as "about".

**Drill:** `drill:apps` (stage webhooks)

---

## Line 4: an external plugin gets a scoped token limited to the permissions the admin approved, and every call with it is audited

**Fit:** Phase 4 line 4. Needs line 3 (custom apps). One opus builder.

### Scoped-token design
- **Scopes** are defined once in `lib/platform/authz.js` (added in line 1), using the project's `<area>.<verb>` names. They are read-only in v1:
  ```js
  export const APP_SCOPES = Object.freeze({
    "storefront.read": "See your live store content, products and collections",
    "offers.read":     "See your offers and bundles",
    "orders.read":     "See your orders, without customer details",
    "customers.read":  "See customer names, emails, phones and addresses on orders", // needs orders.read
  });
  export const scopeAllows = (scopes, action) => Array.isArray(scopes) && scopes.includes(action);
  ```
- **Minting** (`apps.manage`, custom apps only):
  - the admin enters a name, picks a subset of the app's approved scopes and an expiry (30, 90 or 365 days; default 90);
  - the token is `sea_<tok_id>.<64 hex secret>` (`newId("tok")` plus `newToken()`);
  - it is shown once with a copy button and is never retrievable again;
  - an app has at most 5 active tokens.
- **Storage:** `plugin_tokens` in the store's own database holds `secret_hash = sha256Hex(secret)`. A KDF is not needed for 256-bit random secrets. Lookup is by id; the hash is compared in constant time.
- **Effective scopes** are `token.scopes ∩ install.granted_scopes`, worked out on every call. Narrowing the app's approval narrows every token at once.
- **A call is refused** (401, plain words) when the token is revoked, expired, unknown or from another store, or when its install is off, uninstalled or kill-switched. Because the database is resolved from the host, store A's token never resolves on store B.
- **Where tokens work:** `requireAppToken(request, action)` (`lib/plugins/api-auth.js`) is the only gate.
  - Tokens are read from `Authorization: Bearer` only, on `/api/apps/v1/*` only.
  - Cookies are ignored there, and admin routes ignore Bearer.
  - v1 is GET only (no CSRF surface) and sends no CORS headers (server to server).
- **Rate limit:** `rateLimitAsync` with name `apps-api-<tok_id>`, 120 per minute.
- **Audit per call (fail closed).** Each call (allowed, scope-denied or rate-limited) writes a row through `audit({ ..., strict: true })`:
  - `actor: { kind: "app", id: <install id> }`
  - `action: "apps.api_call"`
  - `resource: "GET /api/apps/v1/orders"`
  - diff `{ via: "tok_…", scope, status }`. Not the key `token`: `redactDiff` would blank it.

  If the row can't be written, the answer is 503 and no data is returned. Unknown or malformed tokens can't be attributed: they are `slog`'d and rate-limited by IP.
- **Revocation:** Revoke (AlertDialog) sets `revoked_at` and `revoked_by`; the row stays listed. Uninstalling an app revokes all its tokens; turning it off suspends them.
- `last_used_at` is updated at most once a minute per token.

### Features (floor)
1. **"API access" card** on a custom app:
   - approved scopes, editable (`apps.manage`; narrowing takes effect at once; widening asks for approval again in the same words as at creation);
   - tokens: name, `tok_` prefix, scopes, created by and when, expires, last used, status (Active / Expiring soon / Expired / Revoked);
   - Create token and Revoke.
2. **"Calls" list:** the last 100 calls from `audit_log` (time, method and path, status, token name), `audit.read` only. The store's Audit log tab shows the same rows.
3. **API v1** (`app/api/apps/v1/`), JSON with cursor paging (`?cursor=`, `limit` ≤ 100):
   - `me` (no scope): app name, effective scopes, store host;
   - `products` and `products/[handle]` (`storefront.read`; the effective catalog, live content only);
   - `collections` (`storefront.read`);
   - `offers` (`offers.read`);
   - `orders` and `orders/[id]` (`orders.read`; customer fields only with `customers.read`, otherwise redacted as for support via `redactOrderForRole`). `cart_id` and `idempotency_key` never appear.
4. **Plain-words errors:** 401 "This token isn't valid for this store", 403 "This app wasn't given permission to <scope words>", 429 with `Retry-After`.
5. **A suspended store** answers as `tenantHandler` already does for its other routes.
6. **Developer guide** `docs/APPS_API.md`: authentication, scopes, endpoints, paging, errors, limits.

### Data
`migrations/tenant/0033_plugin_tokens.sql` (additive):
```sql
CREATE TABLE IF NOT EXISTS plugin_tokens (
  id          TEXT PRIMARY KEY,            -- "tok_" + 16 hex; also inside the token string
  install_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  secret_hash TEXT NOT NULL,               -- sha256 hex of the secret part
  scopes      TEXT NOT NULL,               -- subset of the install's granted_scopes at mint time
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT, revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_plugin_tokens_install ON plugin_tokens(install_id, created_at);
```
`migrations/platform/0019_audit_actor_index.sql` (additive; serves the per-app call list):
```sql
CREATE INDEX IF NOT EXISTS idx_audit_tenant_actor_at ON audit_log(tenant_id, actor, at);
```

### Permissions

| Call | owner | admin | staff | support | operator-support | signed out | app token |
|---|---|---|---|---|---|---|---|
| `GET admin/apps/[id]/tokens` (`apps.read`; never hash or secret) | 200 | 200 | 200 | 200 | 200 | 401 | 401 |
| `POST admin/apps/[id]/tokens` `{create}\|{revoke}\|{scopes}` (`apps.manage`) | 200 | 200 | 403 | 403 | 403 | 401 | 401 |
| `GET admin/apps/[id]/calls` (`audit.read`) | 200 | 200 | 403 | 403 | 403 | 401 | 401 |
| `GET apps/v1/*` | 401 (cookies ignored) | 401 | 401 | 401 | 401 | 401 | 200 within scope, 403 outside |

**Rows for the `docs/ARCHITECTURE.md` route-class table:** "app-token | `apps/v1/*` | a Bearer token in `plugin_tokens`, its scopes ∩ the app's approval".

**Least-trusted tests:**
- `route-harness` gains the caller `app-token` (Authorization header, no cookies), and `test:permissions` expects 401 on every admin row.
- `test:support-reads` probes `tokens` with canaries `secret_hash` and a minted token's secret.
- v1 is called as anonymous, with store B's token, with a revoked, expired or suspended-app token, and with an out-of-scope token. A token without `customers.read` never sees order A's customer canaries.

### File plan
1. `migrations/tenant/0033_plugin_tokens.sql`, `migrations/platform/0019_audit_actor_index.sql`
2. `lib/platform/audit.js` (`strict` option; the default stays best-effort), `lib/plugins/tokens.js` (mint, verify, revoke, list, expiry), `lib/plugins/api-auth.js` (`requireAppToken`), `lib/plugins/api-reads.js` (v1 shapes over the existing readers, with redaction)
3. `app/api/admin/apps/[id]/tokens/route.js`, `app/api/admin/apps/[id]/calls/route.js`
4. `app/api/apps/v1/{me,products,products/[handle],collections,offers,orders,orders/[id]}/route.js` (`runtime = "nodejs"`, `tenantHandler`, not `storefrontHandler`)
5. `components/admin/apps/{ApiAccessCard,CreateTokenDialog,CallLog}.js`
6. `lib/types/ecosystem.ts` (`AppTokenScope`)
7. `scripts/support/{route-harness,admin-routes,support-reads,shopper-routes}.js`, `scripts/test-permissions.js` (the new caller), `scripts/test-maintenance.js` (add `apps` to the "not gated" family regex), `scripts/test-app-tokens.js`, `package.json` `test:app-tokens`
8. `scripts/drills/apps/stage-tokens.mjs` (mint a token; `curl`-style fetch of `orders` returns no customer fields; revoke; the next call gets 401; the call list shows both)
9. `docs/APPS_API.md` (sonnet), `docs/ARCHITECTURE.md`

**Before `test:security`:** run `git add` on every new route file first; the suite reads `git ls-files`.

### Checks first
- `time node scripts/test-permissions.js` before and after (one more caller on every row; Phase 3 risk 3 again).
- `node scripts/test-security.js && node scripts/test-maintenance.js && node scripts/test-support-reads.js`
- `grep -n "CLASS\|class:" scripts/support/shopper-routes.js | head`: confirm how a new route class is declared.
- `grep -n "audit_log" lib/platform/schema.sql lib/platform/migrate.js`: confirm platform migrations run after `schema.sql` on a fresh control-plane database, so index 0018 finds its table.
- `grep -rn "export async function \(productPage\|listProducts\|listOrders\)" lib/`: reuse the existing readers; do not write new SQL for v1.

### Risks
1. **Audit fail-closed couples API availability to control-plane writes,** one row per call. The rate limit bounds the volume. In-memory rate limits are per isolate unless Upstash is set; state that in the report.
2. **`customers.read` hands shopper PII to a third party.** The wording, default-off and per-call audit are the controls. The owner question below covers whether to offer it at all.

**Drill:** `drill:apps` (stage tokens)

---

## Events and side effects (all lines)

| Emitted | Where | Consumed by |
|---|---|---|
| audit `apps.install`, `.enable`, `.disable`, `.uninstall`, `.settings`, `.placement`, `.custom_create`, `.endpoint`, `.endpoint_secret_rotate`, `.endpoint_pause`, `.endpoint_resume`, `.endpoint_auto_paused`, `.delivery_resend`, `.test_event`, `.scopes`, `.token_create`, `.token_revoke`, `.api_call` | `audit_log` | merchant Audit log tab and app Activity; operator audit views |
| jobs `plugin_fanout`, `plugin_delivery` | platform `jobs` | worker; operator Queues page (infrastructure dead letters only) |
| `plugin_events`, `plugin_deliveries` | store database | Deliveries table; privacy erase; 30-day prune |
| slog `plugin_block_invalid`, `plugin_block_resolver_failed`, `plugin_delivery_attempt`, `plugin_egress_refused`, `plugin_endpoint_paused`, `app_token_refused` | logs | operators |
| owner and admin email on auto-pause; dashboard attention item | merchant | founders |
| `invalidateTenantCache("plugins")` | every install or placement write | storefront slot reads |

## Decisions for `docs/DECISIONS.md` (schema and permissions first)

1. **Plugin state lives in each store's own database.** Tenant migrations 0030 (installs), 0031 (placements), 0032 (endpoints, events, deliveries) and 0033 (tokens), all additive. One platform migration, 0018: an index on `audit_log(tenant_id, actor, at)`. No catalog table.
2. **One install table for first-party plugins and custom apps** (`kind`). Uninstall archives the row (`status='uninstalled'`). A partial unique index allows one live install per plugin. Reinstalling starts with fresh settings.
3. **The first-party catalog is code** (`lib/plugins/first-party/<id>/manifest.js`). Phase 4 ships one real plugin, Trust badges, so the install and slot lines are real end to end. Suites use fixture plugins through a test-only seam.
4. **Installing changes nothing on the storefront.** Each block gets a placement that starts Off, and only an admin's Live switch shows it ("never publish anything a founder did not publish").
5. **The outbox is store-database rows delivered by the existing job queue.** Job payloads hold ids only. Deliveries keep their own 8-attempt schedule (about 45 h) through requeue. An endpoint failure never dead-letters or alerts operators; Storeasy infrastructure errors still do.
6. **Tokens are stored as a SHA-256 hash** of a 256-bit secret in the store's database. They are shown once, expire after 90 days by default (30 or 365 to choose), and an app has at most 5 active.
7. **Permissions:** `apps.read` for every role; `apps.manage` for admin and owner, covering install, on/off, uninstall, settings, placements, webhooks, custom apps and tokens. An app's call list needs `audit.read`. Support access stays read-only.
8. **App scopes are a separate `APP_SCOPES` table in `authz.js`** with `<area>.<verb>` names. v1 is read-only: `storefront.read`, `offers.read`, `orders.read`, and `customers.read`, which is separate, needs `orders.read`, and is off by default. A call's scopes are the token's scopes intersected with the app's current approval.
9. **Tokens work only on `/api/apps/v1/*`** (Bearer, GET, no CORS). Admin routes never accept them, and v1 never accepts cookies.
10. **Every token call is audited, and fails closed:** no audit row means a 503 and no data. Denied and rate-limited calls are audited too.
11. **Order topics need `orders.read`.** The customer block is included only with `customers.read`, checked at send time.
12. **Slots render Storeasy-owned server-component primitives with validated props only.** No iframe or script slot kinds; `ecosystem.ts` is changed to match. External apps can't add blocks in Phase 4.
13. **Five slots:** `pdp.under_price`, `pdp.under_atc`, `pdp.below_fold`, `order.status`, `footer.above`. At most 3 blocks per slot.
14. **Signing follows Standard Webhooks v1** (HMAC-SHA256 over `id.timestamp.body`). The `whsec_` secret is encrypted at rest and rotates with a 24-hour overlap.
15. **The SSRF guard uses Node built-ins** (`https.request` plus a guarded `lookup` plus `net.BlockList`): HTTPS on port 443 only, no redirects, a 15 s timeout. No new dependency.
16. **Each plugin has its own egress allowlist.** A custom app gets the host approved when its endpoint was saved; a first-party plugin gets its manifest's `egress`. Shopify hosts are always refused.
17. **The operator kill switch is the existing feature flag `ff_plugin-<id>`.** No new operator screen.
18. **`order.created` fires from `runOrderEffects`** (paid, or COD placed). **`order.fulfilled` fires once per order,** on the projection's transition to fulfilled.
19. **Retention and privacy:** events and deliveries are kept 30 days, and the privacy erase also redacts event payloads.
20. **Custom apps are per store and created by the store's admin.** There is no marketplace and no `app.uninstalled` topic in Phase 4 (see Later).

**Later (not planned):**
- a remote-app marketplace and `app.uninstalled`;
- write scopes (drafts only) for apps;
- blocks from external apps;
- an operator view of a store's apps.

## Risks and open questions (most serious first)

1. **SSRF and DNS rebinding in the delivery worker** (line 3). The guard relies on Node's `lookup` hook being honoured for every connection attempt under `autoSelectFamily`, and on Vercel's Node runtime allowing `node:https` and `node:dns`. Run the checks-first commands, and get a dedicated security review before merge.
2. **Shopper PII to third parties** (lines 3 and 4). Payload redaction by scope, the consent wording, the privacy erase and the audit must all hold together. One miss leaks customer data off-platform.
3. **The cost of fail-closed audit** (line 4). Every API call writes to the control plane, so a control-plane outage stops the app API. This is intended, but it must be reported, and the rate limit is per isolate without Upstash.
4. **Storefront latency** (line 2). The footer outlet touches every page. It must be a cached no-op for stores without plugins; measure before and after.
5. **Shared-file conflicts while lines 2 and 3 run side by side.** Use the anchors in `manifest.js` and `AppDetail.js`, the stage files for the drill, and the pre-assigned migration numbers. `lib/types/ecosystem.ts` is the likeliest conflict; keep both sides.

## Open questions for the owner

1. The recorded product direction says "no public API goal", but line 4 needs external tokens. This plan builds the smallest version: per-store custom apps, a read-only v1 and server-to-server calls only. Is that what you want, or should tokens go only to apps Storeasy registers for you?
2. Should a store be allowed to give an outside app customer contact details (`customers.read`) in Phase 4? The plan offers it off by default, with explicit wording and every call audited. The alternative is to leave it out until a real app needs it.
