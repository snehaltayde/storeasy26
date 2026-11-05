# Phase 6 build plan: First run (GEN-01, GEN-04, PUB-12, P0 only). Revision 4

**Base:** `cms/phase-1` only after **both** P5-FIX2 and P5-DRILLS have merged. Every brief checks for both merge commits and stops if one is missing.

**Revision 4 (owner answers, 2026-11-05):** the owner answered OQ-P6-1, OQ-P6-2 and OQ-P6-8, all three against revision 3's defaults. Missing policies now block opening, phase 6 offers policy starters, and the design Reset goes to the store's starting palette. One new item, P6-POLICY-START (batch 2). The gate becomes 102 suites. See "Owner answers (revision 4)" below.

**Revision 3 (verifier):** five batches, not four. P6-ONBOARD moved to its own batch 4, because test-provision's hrefWorks checks every checklist href against a real console page, and `/admin/start` only exists once P6-START-UI (batch 3) has merged. P6-DRILLS is batch 5. Other revision 3 fixes are listed under "Verifier fixes" below.

**P5-FIX2 files edited in phase 6** (all after P5-FIX2 has merged; each brief says the file was just changed by P5-FIX2 and to rebase on it):
- `app/(console)/admin/(authed)/editor/page.js`: P6-GEN (batch 2), then P6-NAV (batch 3, the starting brand for Reset);
- `scripts/test-editor-inspector.js`: P6-LOGO-REG (batch 1), then P6-NAV (batch 3, DesignForm and Reset tests);
- `components/admin/editor/fields/inspectorModel.js`: P6-NAV (batch 3, revision 4, `design.reset(start)` and `setToken`'s start brand);
- `components/admin/editor/DocumentEditor.js`: P6-NAV (batch 3, revision 4, one `startingBrand` prop into `context`).

No phase 6 item edits BundleControl.js, BundleForm.js, CommercePanels.js, test-bundle-form.js or test-commerce-exp.js.

**Gate:** 98 suites today. Once P6-FIXTURE merges it is **102**, adding test:first-run, test:brand-step, test:open-checks and test:policy-start (revision 4). P6-FIXTURE also adds `drill:p6` (not gated).

**Scope:**
- GEN-01: a deterministic first store from catalog and kit, with no AI.
- GEN-04: the brand step (logo, curated palette, one-line description).
- PUB-12: "Before you open your store", where payment, a left-out design and missing policies block (revision 4).
- GEN-06, partly (revision 4): "Start a privacy page" and "Start a returns page" create founder-review drafts from `lib/content/templates.js`, with the returns text bound to the engine's returns window. Never published by the system.
- US-01, US-04 and US-41, proved in a desktop Chrome drill.

**Out of scope:**
- GEN-05 (AI copy).
- The rest of GEN-06: about, contact and shipping drafts, binding the refund-timing, delivery and payment-method sentences to settings, and binding the legacy PageEditor's templates. Only the two starters above are built.
- TOK-04's picker and custom colours.
- A new kit.
- An inspector logo control.
- PWA icons from the logo.
- Founder self sign-up (OQ-06).

**Migrations:** none, and 0026 stays unassigned (the highest is `0025_media_archived.sql`). Ownership comes from `documents.updated_by`, `published_version_id`, `archived_at` and `draft_hash`. The brand-step record lives in control-plane config. If a builder finds it needs a table, it stops and asks. The orchestrator then assigns 0026, and the item adds the table to CONTENT_TABLES if its name matches the guard regex.

## Design decisions (revised)

### 1. Generator: pure planner, Node runner, one all-or-none writer

**Parts:**
- `lib/first-run/plan.js` is pure.
- `lib/first-run/generate.js` is the runner.
- `createFirstRunDocuments` in `service.js` is the only writer.

**Ownership rules:**
- **Generator-owned:** `updated_by='system:first-run' AND published_version_id IS NULL AND archived_at IS NULL`.
- **Untouched empty:** `revision=1 AND published_version_id IS NULL AND archived_at IS NULL AND draft_hash = documentHash(prepare(emptyBody(type)).body)`. The hash strips the random section ids, so it can be compared. This rule is turned off for the sync trigger.

**How it writes:**
- The ownership predicate is repeated in the guarded UPDATE.
- A not-live guard makes refills safe after a take-offline.
- A refill whose hash is unchanged is not written.
- Refills prune old versions as saveDraft does.

### 2. What gets generated

Only `doc_home` and `doc_design`. Header and footer stay null (auto mode, menus from the catalog). This is now proved by a test, including the case where the editor creates an empty header later.

No policies, announcement, badge or kit presets are generated, and lib/ai is never imported. Policy pages are only ever started by the founder's own click (decision 10). On an empty catalog the hero never says "opening soon".

### 3. Triggers and eligibility

**Eligible when** all of these hold:
- documents mode;
- no live release;
- `confirmedCatalogSync().confirmed`;
- `doc_home` is absent, generator-owned or untouched-empty.

A founder-written home means **no write at all**, not even the design. Console and editor triggers also need `canEdit` / storefront.write.

**Triggers:**
- **Worker:** best effort, skipped when less than 5 s of the slice is left.
- **POST `/api/admin/first-run`.**
- **The editor page server render:** only for actors who can edit.

Inline, CLI and connect-callback syncs are not hooked. Those stores generate when the founder opens `/admin/start` or the editor, and the plan says so.

### 4. Palettes

Six curated palettes. The default is slate on pulse-1. `paletteIdOfBrand` is used for preselection.

### 5. Logo

- A `logo` setting kind with control `'logo'`, library files only, and alt optional.
- `refsOfSetting` indexes the logo file.
- `resolvedLogo()` returns a value only for v4 documents stores.
- An empty alt falls back to **`siteName()`**, never `text1`.
- The logo renders in both header variants and both footer spots. Checkout keeps the text wordmark (known limit).

### 6. Brand step

**What it writes:**
- `/admin/start` writes the founder-owned doc_design draft.
- The description (160 characters max) and `config.onboarding.brand_step` go in **one** merged control-plane write.
- The description needs the settings permission.

**What the founder can do:**
- Remove the logo.
- Start from the current palette, which is preselected.

**What the page says:** what is live now and what waits for Publish.

### 7. PUB-12

**What blocks (owner answer OQ-P6-1):** payment problems (checkout off, Shopify mode, billing degraded), a left-out design draft, and missing policies (a privacy page and a returns page, each not live, not in the set and not founder-saved). Maintenance, test order, catalog and contact stay warnings behind one confirm.

**Payment** is worked out from `checkoutMode()` and `billingDegraded()` on their own. It never comes from `checkoutCapability().available`, so maintenance can no longer hide a real block. Maintenance is a separate warning.

**Design rule** (always enforced on an opening set):
- When an unpublished doc_design draft is left out, the publish returns 409 OPENING_NEEDS_DESIGN.
- When no design exists and `checkOpening` is sent, the server creates the slate draft through the first-run writer and offers it.

**Policies rule** (revision 4, under `checkOpening`): two items, `privacy` and `returns`, from `policyStatus` (decision 10).
- Live or in the set: ok.
- Founder-saved draft not in the set: info, "Your privacy page goes live too", and the report's offer adds it. This is founder-reviewed text that the panel names, not auto-publishing.
- Untouched starter draft: block, with a "Read it" link to the editor at that page and an "I've read it" action. It is never in an offer.
- Missing: block, with a "Start a privacy page" / "Start a returns page" action.
- The server answers 409 OPENING_NEEDS_POLICIES whatever `confirmOpen` says. Without `checkOpening` this rule does not run, the same pinned contract as the no-design case (existing first-publish suites never send the flag).
- The editor is the only founder-facing screen that publishes documents (ReleasesAdmin is the legacy store's, and there are no schedules yet), and it always sends `checkOpening`. So every opening a founder makes runs the policy and design rules. Only a direct API call without the flag skips them (owner check below).

**Other checks:** warnings need `confirmOpen` under `checkOpening`. Server order: payment, design, design creation, policies, confirm.

**Fix links:** every non-ok item has an href, `who: 'support'` or a non-empty `actions` list. Revision 3's policies exception is gone.

**Policy rule:** one shared module (`lib/documents/policy-pages.js`, privacy + `/terms|refund|return/`, plus `policyStatus`, `readPolicyRows` and the starter actor), used by PUB-12, the starters and onboarding. P6-GEN-WRITE builds it in batch 1, so batch 2 can import it.

**POLICY_PAGE_MISSING** only on sets that touch a policy page.

### 8. Editor panel

The proactive `openingChecks` read is mandatory. The founder sees one panel and one Open button, with the design and any founder-saved policy pages already in the set. Revision 4: the panel has the policy starter buttons and "I've read it" (P6-OPEN-UI), posting to `/api/admin/policy-start`. Open stays disabled while any block is left. The precheck lives in publishModel's flow.open (it always asks; the server answers `opening:false` on a live store). The flags travel as top-level `checkOpening`/`confirmOpen` modifiers through publishRequest, createStoreCall (editorModel.js) and store.js. New panel actions go through the existing `on.act`, so DocumentEditor.js is not edited. The panel has "Check again" and "I placed one", and shows even when every item is ok.

### 9. Onboarding and navigation

**Onboarding:**
- A "Start your store" step.
- The design step counts as done once the brand step is recorded, and links to `/admin/start` whether the store is open or closed.
- Closed-store labels and hints are reworded, so nothing tells the founder to "publish" before opening.
- Revision 4: the policies step uses the same `policyStatus` and review rule as PUB-12, and has "Start a privacy page" / "Start a returns page" buttons, plus "Read your … page" links and "I've read it" buttons for starter drafts (P6-ONBOARD, which renders them in SetupAdmin.js and tests the render in test-provision.js).

**Navigation:**
- A "Logo and colours" nav link.
- A DesignForm link. Its reset goes to the store's **starting palette** (owner answer OQ-P6-8): `startingPaletteId(config.onboarding)`, which is the brand step's recorded palette, else slate (the palette the generator and the PUB-12 design rule write). It is never the platform's lime default, and a first colour edit on a store with no brand starts from that palette too. P6-NAV threads it from editor/page.js through DocumentEditor's `context` to DesignForm, and changes inspectorModel.js's `design.reset`/`setToken`. Recording a known limit instead is no longer allowed.
- A Settings logo hint.
- One dashboard nudge instead of two.

### 10. Policy starters (revision 4, owner answer OQ-P6-2)

**Server op:** P6-POLICY-START (batch 2).
- `startPolicyPage({ kind })` in `lib/first-run/policy-start.js`, POST `/api/admin/policy-start`.
- Builds the page from `templatesFor({ returnsWindowDays: returnsWindowDays() })` through `pageBodyFromTemplate`, with slug `privacy-policy` or `terms`.
- Writes it with `createDocument({ type: 'page' })` under `POLICY_STARTER_ACTOR`, so `updated_by = 'system:policy-starter'`. That column is the "waiting for your review" mark: no schema change, no migration.
- Refuses with 409 POLICY_PAGE_EXISTS when a page of that kind already exists in any state (a double click's SLUG_TAKEN maps to the same answer). When the address is taken by something that is not a policy page of that kind (for example a campaign at `/terms`), it answers with SLUG_TAKEN's own words and an editor link to that document, so the founder can move it and try again.
- `markPolicyRead` ("I've read it") re-saves the current draft under the founder. The editor only saves after an edit, so this is how a founder accepts a starter unchanged. Both the panel and the checklist offer it.
- Never publishes.

**Buttons:** P6-OPEN-UI (batch 3) adds "Start a … page", "Read it" and "I've read it" to the PUB-12 panel. P6-ONBOARD (batch 4) adds "Start a … page", "Read your … page" and "I've read it" to the onboarding checklist.

**Returns text:** the engine's window is the tenant setting `returns_window_days` (`lib/returns.js:16`, `returnsWindowDays()`, default 14), counted from the **order date**, not delivery.
- `templates.js` gets `returnsSentence(days)` and `templatesFor()`. The starter is bound to `returnsWindowDays()` at the call.
- The static `PAGE_TEMPLATES` (the legacy PageEditor's) uses a sentence with no number. No number is hard-coded anywhere.
- The refund-timing sentence stays, because test-copy's ALLOWED entry must keep matching. It is a GEN-06 known limit.

**The review rule (OQ-P6-3):** a policy page counts when it is **live**, **in the publish set**, or a **draft whose last writer is not the policy starter**. That last case means the founder saved it, pressed "I've read it", or it is their own cutover text (`system:cutover`).
- A starter draft created but never saved by the founder never counts, unless the founder publishes it in the set.
- It is never put into an offer.
- Opening and onboarding share this rule through `policyStatus`.

## How each mustFix was answered

| # | Critic | mustFix | Answer |
|---|---|---|---|
| 1 | C1, C3 | Maintenance hides the payment block | **Fixed** (P6-OPEN). Payment comes from `checkoutMode()` and `billingDegraded()` on their own, and maintenance is its own warn item. A test covers maintenance plus disabled → 409, even with confirmOpen. |
| 2 | C1 | Lime after first Publish | **Fixed** (P6-OPEN 3b/3c, P6-GEN eligibility). A left-out design draft is refused whatever the flag says. With no design row and `checkOpening`, the server creates and offers a slate draft. Singletons cannot be archived (service.js CANNOT_ARCHIVE), so that case does not exist. Brand-step skip writes nothing, and the generator still inserts the design. The remaining gap (a non-editor caller with no flag and no design row) is pinned in the shapes as a contract and tested as a known limit. Full enforcement would break about 20 first-publish suites. |
| 3 | C1 | `emptyBody` has random ids, so deep-equal never matches; the column is `archived_at` | **Fixed** (P6-GEN-WRITE). The writer compares `draft_hash` with the empty body's documentHash (ids stripped), repeats that in the UPDATE predicate, and uses `archived_at IS NULL`. |
| 4 | C1 | Read-only sessions trigger writes | **Fixed** (P6-GEN). Console and editor triggers require canEdit / storefront.write. POST returns 403. A test shows a read-only actor generates nothing. |
| 5 | C2 | GEN-WRITE codes break test-api-shapes in batch 1 | **Fixed.** P6-GEN-WRITE owns the `p6` since value plus FIRST_RUN_ACTOR, FIRST_RUN_STORE_LIVE and FIRST_RUN_RACE, in documents-api-shapes, test-api-shapes and test-failure-matrix. P6-OPEN adds its codes in batch 2. DOCUMENTS_MODE_REQUIRED is dropped in favour of STORE_USES_LEGACY / STORE_MIGRATING. |
| 6 | C2 | Hidden dependency inside batch 2 | **Fixed.** P6-BRAND and P6-OPEN seed generated state with `createFirstRunDocuments` and `designBodyFor` (batch 1) and must not import generate.js. The round trip through `generateFirstStore` is proved in P6-DRILLS. |
| 7 | C2 | "No phase 6 item edits P5-FIX2 files" is false | **Fixed.** The statement is corrected, the base requires P5-FIX2 merged, and the two briefs name the file and say to rebase. |
| 8 | C2 | P6-DRILLS seeding cannot be built | **Fixed.** P6-DRILLS owns a new `--p6 --stage` flag in seed-design-documents.js (no other item touches it, and no suite pins its flags). run.mjs stops, seeds and starts per stage on the default database, with a fresh p6 tenant and a p6.localhost domain row. Order: P3 closed baseline, stage A, P3 rsc-probe re-run, stages B–F, then re-seed `--p3` and `check --p3`. P6-FIXTURE adds `drill:p6`. |
| 9 | C3, C4 | Payment links go to the wrong pages and echo developer words | **Fixed.** Checkout off → `/admin/settings#commerce`. Billing → `/admin/billing`. Shopify mode or maintenance → no link, "Ask Storeasy support". Cash on delivery only → `/admin/settings#payments`. Contact → `#store-profile`. Each item has its own founder copy, `reason` is never echoed, and a banned-copy scan checks the report. |
| 10 | C3 | Logo alt uses `text1`, not the store name | **Fixed** (P6-LOGO-RENDER). The layout passes `name: siteName()`, and a split-wordmark test covers it. |
| 11 | C4 | The policies "Fix this" link goes nowhere | **Revision 4: option (a), by owner answer OQ-P6-2.** Revision 3's option (b), an honest warning with no link, is withdrawn. Missing policies now block, and each kind has a working fix: "Start a … page" (P6-POLICY-START op, P6-OPEN-UI and P6-ONBOARD buttons), a "Read it" link to a starter draft, and "I've read it". The 7-day template text is replaced by text bound to `returnsWindowDays()`. |
| 12 | C4 (also C1 should) | The policy rules disagree | **Fixed.** `lib/documents/policy-pages.js` keeps today's privacy + `/terms|refund|return/`, and opening, onboarding and POLICY_PAGE_MISSING all use it. |
| 13 | C4 | Other onboarding hints still say "publish" | **Fixed** (P6-ONBOARD). On closed documents stores the policies label is "Add your legal pages", the design hint is reworded and the Launch hint is reworded. Legacy output is byte-identical. |
| 14 | C4 | Logo cannot be found after opening | **Fixed** (P6-NAV, P6-ONBOARD). A "Logo and colours" nav link, a DesignForm link, the design step always links `/admin/start`, and the Settings logo hint is changed on documents stores. |

**shouldFix taken (the cheap ones):**
- Hash-unchanged skip and pruning.
- Sync trigger does not refill revision-1 empty documents.
- Eligibility needs a founder-free `doc_home`.
- POLICY_PAGE_MISSING scoped to sets that touch a policy page; unpublish and undo dropped, so undo.js is not needed (known limit).
- `checkOpening` contract pinned.
- Planner: the `#new` validation check, pickRailCollection pre-filter and field mapping, no "opening soon" hero.
- Drill shows the Shopify push fails harmlessly, and the COD order is cancelled at once.
- Un-hooked sync paths stated.
- Description live-now copy.
- Toggle known limit.
- Route conventions (walk suites) in every route and page brief.
- HREF_ALLOW constraint.
- Golden outputs and local-tenants back-compat.
- Mode applied before sync.
- `drill:p6`.
- Logo control `'logo'` plus WAITING_KINDS.
- CHECKOUT_MODE unset, with first-publish suites listed by name.
- One merged config write, and the 160 versus 300 character cap explained.
- HEIC check reworded.
- An href or `who` on every item.
- Cancelled orders count.
- The all-ok panel is tested.
- Header and footer auto menus tested.
- Both header variants and both footer spots.
- contact and catalog listed as additions.
- Fixture keeps direct checkout.
- Single panel with design in the set.
- Check again and "I placed one".
- Result-based start-page copy, a generation-failed state, conditional empty-catalog copy, and the state order with SyncProgress reused.
- Remove logo, palette preselect.
- DesignForm reset to the store's starting palette (revision 4; was slate).
- One dashboard nudge.

**shouldFix not taken:**
- **The refill bumps the revision of an open editor draft.** Recorded as a known limit and owner check. It only happens when the catalog changed, now that unchanged refills are skipped.
- **Staff dead-ends on Settings and Billing.** Not needed. Only owners and admins can publish (STAFF_CANNOT_PUBLISH), and they can open those pages.
- **The `/admin` redirect.** Replaced by the single dashboard nudge, which is less risky.

**Uncovered points answered:**
- **Billing:** `billingDegraded` is true only for halted, cancelled or expired, so a new tenant with no billing snapshot is not blocked.
- **The closed page:** StoreClosed shows only the name, and the closed metadata is neutral, so the description does not leak while the store is closed.
- **US-04 with no collections:** now has explicit copy in P6-START-UI.
- **Non-editor first publish leaving the design out:** refused when a design draft exists. With no design row it is a pinned known limit.
- **Periodic syncs:** not checked. The hash skip makes repeated syncs harmless whatever their frequency.
- **The "reviewed" substitute for policies:** answered (OQ-P6-3, revision 4). Live, in the set, or founder-saved; an untouched starter draft never counts.

## Spec sections wrong against the code (flag to owner; no spec edits in phase 6)

- **GEN-01:** evidence `lib/brand.js:13` is now `:29`. The dependency map says "then publishes as a set", which is wrong: the generator never publishes (PUB-06). The founder's first Publish carries the set, enforced by PUB-12.
- **GEN-04:** evidence `provision.js:221` is reported stale (not re-verified). The logo today is the text pair in `config.site.logo`. Phase 6 puts it in doc_design for documents stores only.
- **GEN-04 vs the image kind:** "No alt falls back to the store name" contradicts the image kind, where alt is required. A logo kind is added.
- **PUB-12 "reviewed":** no such concept exists before GEN-06. Phase 6 defines it (revision 4, owner answer): live, in the set, or a draft last written by the founder. One rule is shared by opening and onboarding. The mark is `updated_by = 'system:policy-starter'`, not a column.
- **PUB-12 "The panel lists each item with a link to fix it":** **now met** (revision 4). The privacy and returns items have "Start a … page" actions, a "Read it" link to a starter draft and "I've read it". Every other non-ok item has an href or `who: 'support'`. Spec deviation kept: the policy fix is a button (an action), not an href, and support-only items have words, not a link.
- **PUB-12 "No way to pay blocks. The others warn":** phase 6 also blocks on missing policies and a left-out design (owner answer OQ-P6-1). The spec says policies warn.
- **GEN-06 "Today's template says 7-day returns while the engine defaults to 14":** confirmed and more. The evidence `lib/returns.js:15` is now `:16`. The window is the tenant setting `returns_window_days` (default 14), and the engine counts from the order date, while the template says "of delivery". Phase 6 binds the two starters to `returnsWindowDays()`. Payment-method binding stays GEN-06.
- **PUB-12 "no way to pay":** COD is always available in direct mode, so the block applies to checkout off, Shopify mode and billing degraded. Maintenance is a warning. Contact and catalog are added warnings.
- **PUB-12 Launch hint (`onboarding.js:93-99`):** contradictory on documents stores. Fixed by P6-ONBOARD.
- **GEN-02 "generation runs only after a confirmed sync":** nothing ran on sync completion before. P6-GEN adds the hooks; inline, CLI and connect-callback syncs are not hooked.

## Ownership and process

- **package.json:** P6-FIXTURE only (batch 1).
- **lib/documents/policy-pages.js:** P6-GEN-WRITE only (batch 1; moved from P6-OPEN in revision 4). **lib/content/templates.js:** P6-POLICY-START only (batch 2).
- **seed-design-documents.js:** P6-DRILLS only (batch 5).
- **Files edited in more than one batch:** documents-api-shapes.js, test-api-shapes.js and test-failure-matrix.js (P6-GEN-WRITE in batch 1, P6-OPEN in batch 2); test-design-doc.js (P6-LOGO-REG in batch 1, P6-LOGO-RENDER in batch 2, P6-ONBOARD in batch 4); test-brand-step.js (P6-BRAND in batch 2, P6-START-UI in batch 3); test-editor-inspector.js (P6-LOGO-REG in batch 1, P6-NAV in batch 3); editor/page.js (P6-GEN in batch 2, P6-NAV in batch 3); the four placeholder suites and drills/p6/run.mjs (P6-FIXTURE in batch 1, then their owner; test-policy-start.js goes to P6-POLICY-START in batch 2). No file is shared inside a batch. The batches.json revision script checks this.
- **MANUAL-CHECKS.md:** the orchestrator folds in each batch's owner checks; P6-DRILLS owns the file in batch 5.
- **Item notes:** each item writes `docs/cms-reviews/P6-<ID>.md`.
- **Merge order:** P6-FIXTURE first in batch 1.

## Verifier fixes (revision 3)

- **P6-OPEN-UI could not be built as written.** createStoreCall (editorModel.js ~l.332-349) hands store.publish only `confirmRepublish` and store.publishSet only the items. checkOpening and confirmOpen would be dropped. The flow, not store.js, knows the publish phases, and new panel handlers would have needed DocumentEditor.js. Fixed: precheck in flow.open, flags through publishRequest → createStoreCall → store as top-level extra keys, panel actions through `on.act` (not added to ACTION_TYPES, which test-publish-ui pins). editorModel.js was added to its files.
- **No wire shape for set-level flags.** publishSet's argument is an array, and unknown top-level keys are UNKNOWN_OPERATION. Fixed: P6-OPEN adds `checkOpening`/`confirmOpen` to the parser's MODIFIERS (publish and publishSet only), and adds `openingChecks` to test-api-shapes' pinned operations list.
- **The proactive panel had no way to add the design.** Fixed: openingReport returns an `offer` (doc_design with its revision and draftHash) and a defined design item (ok / info). The read never writes.
- **Policies item vs "every non-ok item has an href or who".** The brief and its acceptance contradicted each other. Fixed with a named exception. **Superseded in revision 4:** there is no exception now, because the policy items carry actions.
- **P6-ONBOARD sent founders to a dead end.** The hint "Add a privacy page ... in the editor" names an action that does not exist. Fixed: honest words matching PUB-12 (revision 4: the hint now points at the checklist's own "Start a … page" buttons). Also moved to batch 4, and told which existing pins it moves (test-provision ~l.651/665/671, test-legacy-routes ~l.763/766, test-design-doc ~l.727). test-design-doc.js was added to its files.
- **P6-NAV could not render the Settings hint by mode.** SettingsAdmin gets no mode today. Fixed: settings/page.js passes `documents` from getCmsMode (added to files). DesignForm tests go in test-editor-inspector.js (added). The lime "like #84cc16" hint is replaced too.
- **P6-GEN's editor trigger could break three render suites.** test-editor-routes pins one mode read and one documents read per render, and compiles every static import. Fixed: decide from the page's own reads, and import the generator dynamically only on the generate branch.
- **A logo-only design change had no publish-review row.** Fixed: P6-LOGO-REG owns diff.js and test-doc-diff.js for one plain logo row.
- **Palette theme shape.** designBodyFor uses `{ kit: 'pulse', version: 1 }`, not the `pulse-1` KIT_SURFACES key.
- **US-04 no-collections** added to drill stage E.

## Owner checks expected (not drillable)

- **Staging throwaway tenant (OQ-4), end to end:** connect → sync → `/admin/start` (inline syncs are not hooked, so check that generation happens on the page) → brand step → panel → COD test order to snehal@mediastic.in, cancelled → first publish.
- **Phone logo upload:** PNG, a large JPEG and an SVG. HEIC must be **refused in plain words** (`lib/media.js` accepts only png, jpeg, webp, gif and svg; no new dependency). Check the logo in header and footer on a phone and in Safari.
- **P3-CLOSED rsc-probe** on a local production build against a generated, unpublished store.
- **A real Razorpay-key tenant** shows the payment item as ok, with no "Cash on delivery only" line. Never enter card details.
- **The P4-PROVISION Setup page check,** re-run before and after first publish.
- **The editor's "Show them" toggle** on a closed store now changes nothing (known limit).
- **A sync-time refill while the editor is open** gives the "newer version elsewhere" conflict. Confirm the wording is acceptable.
- **A non-editor first publish without `checkOpening`** opens on the default (lime) brand when there is no design row, and with no policy pages. Accept this as a contract, or ask for full enforcement. Full enforcement would break about 20 first-publish suites.
- **Legal review of the privacy and terms templates** (OQ-25): read both starters as a founder would, on a store with a non-default `returns_window_days`. They say they are starting points, not legal advice.
- **A starter page left untouched** keeps the store from opening until it is saved or marked "I've read it". Check that the panel and checklist words make that clear on a phone.

## Owner answers (revision 4)

The owner answered on 2026-11-05. All three answers went against revision 3's defaults. Changes made:

1. **OQ-P6-1 (missing policies block too).**
   - Decision 7: missing policies block, alongside payment and a left-out design.
   - P6-OPEN: two items, `privacy` and `returns`, replace the single `policies` warn. New rule d gives 409 OPENING_NEEDS_POLICIES under `checkOpening`. The combined offer adds founder-saved policy drafts. The policies no-link exception is removed. New code in shapes. Acceptance rewritten.
   - P6-OPEN-UI: Open is disabled while privacy or returns blocks.
   - Maintenance, test order, catalog and contact stay warnings.
2. **OQ-P6-2 (offer policy starters).**
   - New item **P6-POLICY-START** (batch 2) builds the server op: `templates.js` returns text bound to `returnsWindowDays()`, `startPolicyPage` through `createDocument`, refusing if a page of that kind exists, `markPolicyRead`, and `/api/admin/policy-start`.
   - **P6-OPEN-UI** adds the panel buttons, and **P6-ONBOARD** adds the checklist buttons (it now edits SetupAdmin.js).
   - P6-GEN-WRITE now builds `policy-pages.js` (moved from P6-OPEN) with `policyStatus`, `readPolicyRows` and the starter actor, so batch 2 can import it.
   - P6-FIXTURE pre-registers `test-policy-start.js`, so the gate is 102.
   - **OQ-P6-3 adjusted:** the review rule in decision 10.
3. **OQ-P6-8 (Reset goes to the starting palette).**
   - P6-PALETTE adds `startingPaletteId(onboarding)`.
   - P6-BRAND's Skip keeps an earlier paletteId.
   - P6-NAV edits inspectorModel.js, DocumentEditor.js and editor/page.js in batch 3, and its known-limit fallback is removed. There is no file clash in batch 3: P6-OPEN-UI and P6-START-UI touch none of these.
4. **Drills.**
   - Stage B proves Reset goes to the starting palette.
   - Stage C proves opening stays blocked until both policies exist, and that the starter buttons make review drafts whose returns text says the seeded window (10 days).
   - Stage D seeds policies, so payment is the only block there.
   - New stage G covers the checklist starters, including the checklist's "I've read it".
5b. **Verifier pass on revision 4 (2026-11-05).**
   - P6-ONBOARD: the checklist's starter drafts also get an "I've read it" action (markPolicyRead). Without it, a founder who agrees with a starter could only mark it reviewed from the publish panel, because the editor saves only after an edit. SetupAdmin's rendered tests are placed in test-provision.js, because no suite renders SetupAdmin today.
   - P6-POLICY-START: an address taken by a non-policy document gives SLUG_TAKEN's words and an editor link, instead of a wrong "You already have a privacy page". Acceptance added.
   - P6-LOGO-REG: its brief no longer says DocumentEditor.js is untouched in phase 6. P6-NAV adds the `startingBrand` prop in batch 3.
   - Decision 7 says the editor is the only founder screen that publishes documents, so the `checkOpening` contract covers every founder opening.
   - Checked against the code: `returnsWindowDays()` is at `lib/returns.js:16` (default 14, counted from `order.created_at`), and the account order page uses it too. The `documents_slug` unique index skips archived rows, so an archived privacy page does not block a starter. `saveDraft` always rewrites `updated_by`, so markPolicyRead works. Checkout links `/privacy/` and `/terms/`, so the `terms` returns starter is linked. The Settings anchors `#commerce`, `#payments`, `#store-profile` and `#catalog-sync` exist. No two items in a batch share a file. package.json has one owner (P6-FIXTURE), and there are no migrations (the highest is 0025).
5. **Spec mismatches:** PUB-12's "link to fix it" is now met for policies. Two new deviations are listed: policies block, and GEN-06's evidence line and day-counting.

## Open questions

- **OQ-P6-1: block or warn.** **Answered (2026-11-05):** "opening the store is BLOCKED by payment problems (checkout off, Shopify mode, billing degraded), a left-out design draft, AND missing policies (privacy and returns pages not live, in the set, or founder-saved). Maintenance, test order, catalog and contact stay warnings behind one confirm. Policies blocking must come with a working fix link, so a founder is never stuck."
- **OQ-P6-2: policy starters.** **Answered (2026-11-05):** "phase 6 OFFERS policy starter drafts: 'Start a privacy page' and 'Start a returns page' create founder-review drafts from lib/content/templates.js, after fixing its returns text so it matches the engine's real returns window … Never auto-published; the draft is marked for review." The server op is in P6-POLICY-START, and the buttons are in P6-OPEN-UI (panel) and P6-ONBOARD (checklist).
- **OQ-P6-3: what counts as "reviewed".** **Answered with OQ-P6-2:** live, in the publish set, or a draft whose last writer is not the policy starter. An untouched starter draft never counts unless the founder publishes it in the set (decision 10).
- **OQ-P6-4: existing closed documents tenants.** Default: tenants who already wrote a home get no generation at all. At their first editor Publish (with checkOpening) they are offered a slate design draft instead of lime.
- **OQ-P6-5: which sync counts as confirmed.** Default: the latest complete sync, which is today's rule and M9's default.
- **OQ-P6-6: new dependencies.** None are needed; HEIC support would need one, so it is not built.
- **OQ-P6-8: what the design settings' Reset goes back to.** **Answered (2026-11-05):** "'Reset' in the design settings must go back to the store's generated neutral palette (the GEN-01/GEN-04 palette recorded for the store), never the platform's lime default, even if that widens P6-NAV's work." Built in P6-PALETTE (`startingPaletteId`), P6-BRAND (the record is kept on Skip) and P6-NAV (decision 9). This number follows the owner's question list. OQ-P6-7 is not part of this plan.
