# Storeasy CMS: Full Build Spec

3 November 2026. Written against commit `c47045f`. This spec is the end of brainstorming and the start of building.

**How to read it.** The owner reads sections 1 to 7 and 9 to 13, plus 8.4 and 14.3, to divide the work into phases. Engineers build from sections 7 and 8. Section 14 lists what was checked in code and what was not. This spec assigns no phases and no dates.

---

## 1. Summary

**What this is.** This spec describes one build: turning the Storeasy console into the single control panel a store founder uses to run their storefront, without a developer and with fewer paid apps.

**The core change.** Every piece of storefront content becomes a versioned document made of sections and blocks. A founder edits a document next to a live preview, presses one Publish button, and can press Undo. Publishing a typo fix ships only that typo fix.

**What makes it worth paying for.** Commerce blocks (offers, bundles, quiz, search, recommendations) become things a founder places on a page. Connecting Shopify generates a good first store. After that, product content can differ from Shopify, for our storefront only, without ever writing content back to Shopify.

**What this spec does not prove.** No founder has used this product. No user data exists. Every numeric target here is a hypothesis.

### Words used in this spec

| Word | Meaning |
|---|---|
| **Founder** | The store owner. No developer, little time. The primary user. |
| **Document** | One editable thing with its own draft, history and publish state: the home page, a campaign, a blog post, the product page layout, one product's content. |
| **Section** | A top-level piece of a page, such as a hero or a product rail. |
| **Block** | A smaller piece inside a section, such as a button or one FAQ item. |
| **Version** | A frozen, never-changed copy of a document. |
| **Release** | The record of which version of each page, layout, chrome and design document is live. It stays the single switch for those. Product and collection content have their own live row (section 8.4). |
| **Binding** | A rule that fills a section with live data, such as "the products in this collection". |
| **Overlay** | Founder edits to product content, kept separately from the Shopify data. |
| **Effective value** | What the shopper sees: the overlay value if one exists, otherwise the Shopify value. |
| **Protected module** | A functional piece, such as the purchase box, that founders can place around but not remove or change. |
| **Tenant** | One store on the platform, with its own database. |
| **Cutover** | The moment one existing tenant moves from the old tables to documents (MIG-03). |

---

## 2. Problem Statement

**There is no user research.** No founder interviews, usage data, support tickets or surveys exist. This problem statement comes from reading the code. It describes what the product does today, not what founders have said about it.

**The target user changed.** The October audit (`docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md`) was written for marketing teams. The owner has since decided the primary user is the founder. The audit is still useful on surfaces and publication rules, and superseded on the user.

**Five problems, from the code:**

1. **Publishing is all or nothing.** Publish snapshots every draft on the site into one release (`lib/releases.js:46`, `lib/releases.js:359`). A typo fix on a policy page also ships a half-finished home page. Any one blocking error stops all publishing (`components/admin/ReleasesAdmin.js:102`).

2. **Undo does not really undo.** Rollback only moves the live pointer and leaves drafts untouched (`lib/releases.js:442-451`). The next Publish ships the undone change again. Rollback is also whole-site, and it reverts brand, navigation and overrides as well.

3. **Simple edits take too long and fail silently.** Changing the hero and getting it live takes 7 clicks, 2 screens and a dialog (see section 14). Clicking the Publishing link before Save loses the edit with no warning (`components/admin/cms/useDirtyGuard.js:5`). When the live preview cannot update, the editor says nothing (`components/admin/cms/Designer.js:289-297`). Four of the six home section types fail validation the moment they are added (`components/admin/cms/Designer.js:502-509`, confirmed by running the validator). The preview frame on a normal desktop screen is about 342px wide, narrower than the "Mobile" option, because the console caps the page at 1024px (`components/console/nav/ConsoleShell.js:127`). The 342px figure was computed from classes, not seen in a browser.

4. **The paid-app features exist but founders and shoppers rarely meet them.** Shoppers see offers only after adding to cart (`lib/cart.js:114`). Bundles and quizzes have no index page, no sitemap entry and no way onto a page except a hand-typed link (`app/sitemap.js:32-40`, `lib/cms/registry.js:40-171`). No commerce engine is a section. The founder cannot put a bundle on the home page today.

5. **A new store starts wrong.** Onboarding is done by hand by an operator (`docs/onboarding.md:3-5`, `app/api/connect/shopify/start/route.js:7-23`). After connect, the store has a lime look, a text-only logo, no about or policy pages, and shopper-visible strings such as "Something dropped the weights" and "pnpm sync" (`app/(storefront)/error.js:22`, `app/(storefront)/page.js:97-114`).

**Why customization is not safe yet.** The owner wants "cannot easily make something ugly". The code cannot promise that today. Storefront components hold about 630 to 700 hard-coded colour classes against about 100 to 115 token-based accent classes. A dark background passes the contrast gate while product titles render at 1.12:1 (see section 14).

**Why this matters now.** The owner has made the CMS the top priority. The bet is that founders will edit the store themselves and trust Storeasy enough to cancel paid apps. Neither half has been tested.

---

## 3. Decisions Already Made

These are binding. This spec does not reopen them.

1. **The primary user is the store founder.** No developer, little time. They choose Storeasy because it is easy and fast, content changes easily, and built-in cart, account page, offer engine, fast search, bundles, AI experiments and first-party data save them third-party app costs.
2. **Never write content back to Shopify.** Content exists for our own storefronts. Only orders and admin-related data are pushed to Shopify.
3. **Shopify metafields and metaobjects may be read** as binding sources.
4. **Customization means endless composition inside strong design tokens**, so a founder cannot easily make something ugly.
5. **Product content.** Primary data is pulled from Shopify. After that, every piece of product content can differ and is changed from our backend, for our storefront only. Price, variants and inventory stay Shopify-owned. The agreed direction is a per-field overlay in a separate layer, because sync overwrites the products row and edits cannot live there.
   - Unedited fields keep following Shopify.
   - Edited fields win permanently.
   - If Shopify changes an edited field, the editor shows a notice and never overwrites.
   - "Reset to Shopify" restores the field.
   - The storefront labels nothing to shoppers. The console labels "differs from Shopify".
6. **Product title is specified as overridable, with the URL handle tied to Shopify.** The owner said "every piece of content" and did not object to the recommendation. This is recorded as an **assumption to confirm** (see OQ-01), including the risk of confusion when matching orders in Shopify admin.
7. **The hosting phase stays last. The CMS is top priority.** The owner will divide this spec into phases after reading it. This spec gives a dependency map only.

---

## 4. Goals

**All targets are hypotheses.** No user data exists. Each target should be reset after the first timed sessions.

| # | Goal | Measure | Hypothesis target | Baseline today |
|---|---|---|---|---|
| **G1** | A founder can do everyday edits alone and fast | The five timed tasks (section 10) | Hero, typo and undo each under 60 seconds. Bundle on home under 2 minutes. New offer under 3 minutes. 4 of 5 test founders finish each task with no help. | Hero 7 clicks, typo 7 clicks, bundle on home at least 15 clicks plus typing (estimated), all from code reading. Not timed with people. |
| **G2** | Publishing is trustworthy | Automated tests plus publish log | 100% of single-document publishes change only that document. 100% of Undos leave the next Publish unable to re-ship the undone change without an explicit "publish again" confirmation. | Whole-site publish only. Undo re-ships on next Publish. |
| **G3** | Nothing fails silently | Failure matrix test (see PV-01, DOC-04) | Every listed save, preview and publish failure shows a plain message. Zero silent paths in the matrix. | All failed preview pushes are silent (`components/admin/cms/Designer.js:289-297`). |
| **G4** | Connecting Shopify gives a good store | Timed first run on 5 real catalogs, plus founder rating | From finished sync to a private generated store in under 2 minutes, on catalogs of different types. 4 of 5 founders say they would adjust it rather than start over. | No generator exists. |
| **G5** | Founders would cancel a paid app | Interview after the timed session, plus the commitment step in section 12 | 3 of 5 test founders name at least one paid app they would cancel and agree a named date for moving one real store. | Not known. Reviews and loyalty have no replacement (section 9). |

---

## 5. Non-Goals

| Non-goal | Why |
|---|---|
| **Custom content types for founders** | Parked. The document model must allow them later (DOC-11), but no founder-facing builder ships in this build. |
| **Public content API** | Parked. Content exists for our own storefronts. |
| **Ranked assignment rules** ("all products tagged X use layout Y") | Parked. Explicit assignment plus a default is enough for a founder. |
| **Approval enforcement and more approval features** | Parked. The approvals already built stay in code with no further investment (DOC-13). |
| **Content write-back to Shopify** | Decision 2. Enforced by test (SHOP-01). |
| **Free-form CSS or pixel-level design** | Decision 4. All visual values come from tokens. |
| **Composing checkout, payment, cart totals or account security** | These must stay protected. Founders get tokens and copy only, plus approved slots in the cart. |
| **Rebuilding hosting, or adding page-level CDN caching** | Hosting stays last (Decision 7). Page caching is also blocked today by cart-in-layout, cookies, experiments and windows (`app/(storefront)/layout.js:152-153`). |
| **Real-time co-editing** | A founder is usually alone. The revision check plus a clear conflict message is enough. |
| **Locales and translation** | No evidence of need, and it would add a dimension to every document. The document model does not block it. |
| **Video** | Media is images only today (`lib/media.js:15-21`), and the database blob store is the wrong place for video. |
| **New offer types, abandoned-cart flows, shopper subscriptions** | Not in the brainstorm direction. The app replacement matrix (section 9) states these gaps openly. |
| **Reviews and loyalty, unless the owner rules otherwise** | Not in the brainstorm direction, but evidence shows this is a real blocker to cancelling apps. See OQ-07. |
| **Rewriting old release rows** | Old rows stay exactly as they are. Legacy tenants read them through a frozen reader, and restore in document mode copies from them (section 8.12). |
| **Chat widgets and other third-party embeds** | Not in the brainstorm direction. Only GA4 and Meta forwarding exist today. Section 9 states the loss, and OQ-21 asks about an approved slot. |
| **Linked shared sections** | Copying a blueprint is simpler and enough for now. |

---

## 6. User Stories

Each story is from the founder's point of view. Requirement IDs show where it is built.

### Getting a store

- **US-01.** As a founder, I want to connect Shopify and see a good store made from my catalog and brand, so that I adjust something instead of starting blank. (GEN-01, GEN-04, GEN-07)
- **US-02.** As a founder, I want my generated store to stay private until I press Publish, so that shoppers never see something half-finished. (PUB-06)
- **US-03.** As a founder, I want to see honest sync progress, so that I know whether the store is working or stuck. (GEN-02)
- **US-04, empty case.** As a founder whose Shopify store has no products or no collections, I want a clear explanation and a usable starting store, so that I do not see a broken page or developer commands. (GEN-01, GEN-02, GEN-03)
- **US-05, error case.** As a founder whose sync failed, I want a plain message and a retry, so that I am not left wondering. (GEN-02)
- **US-39.** As a founder who dislikes the generated store, I want to see other starting designs built from my own catalog and pick one. (GEN-07)
- **US-40.** As a founder who already wrote policies and pages in Shopify, I want them brought in as drafts, so that I do not retype them or end up with generic legal text. (GEN-11)
- **US-41, error case.** As a founder about to open my store, I want to be told what is missing, so that shoppers do not reach a store with no way to pay and no policies. (PUB-12)

### Everyday edits

- **US-06.** As a founder, I want to click the hero in the preview and type, so that I do not hunt through menus. (ED-04)
- **US-07.** As a founder, I want my edits saved automatically, so that clicking away never loses work. (ED-03)
- **US-08.** As a founder, I want to fix a policy typo in a normal text editor, so that I never see HTML. (AU-01)
- **US-09.** As a founder, I want to publish just this page, so that my half-finished home page stays private. (PUB-02)
- **US-10.** As a founder, I want to undo a publish with one button, so that a mistake costs me nothing. (PUB-04)
- **US-11.** As a founder, I want to see that a change really went live, so that I trust what happened. (PUB-11)
- **US-12, error case.** As a founder who entered something invalid, I want to be told in plain words next to the field, and have it fixed for me when possible. (AU-02, AU-06)
- **US-13, error case.** As a founder, if the preview cannot update, I want to be told why, and I want the rest of the page to keep working. (PV-01, PV-02)
- **US-14, error case.** As a founder with two tabs open, I want a clear choice when my versions conflict, so that neither version is lost silently. (DOC-02, ED-03)
- **US-15, error case.** As a founder whose page links to something unpublished or deleted, I want to be told before I publish, and offered a fix. (PUB-03, PUB-05)
- **US-42.** As a founder who has wrecked a page, I want to throw away my changes and go back to what is live. (ED-03)
- **US-43.** As a founder fixing a typo on a page with half-done work, I want to see what will ship and keep the rest back. (PUB-09)

### Layout and look

- **US-16.** As a founder, I want to add, move, hide and duplicate sections, so that I can compose any page, within limits that keep it looking right. (ED-02, AU-07, DOC-03)
- **US-17.** As a founder, I want every section I add to look good straight away, so that I am never left with a broken block. (AU-04)
- **US-18.** As a founder, I want to choose a palette and fonts and have the whole store follow, so that nothing clashes. (TOK-01, TOK-02, TOK-04, TOK-06)
- **US-19, error case.** As a founder choosing a colour that would be unreadable, I want the editor to correct it or explain, so that I cannot ship unreadable text. (TOK-02)
- **US-20.** As a founder, I want to change how a section looks on phones, so that the mobile store looks right. (TREE-04, TREE-05, TREE-06)
- **US-21.** As a founder, I want to arrange my product pages around the buy box, so that my product story fits my brand without breaking purchase. (SURF-01, SURF-03)
- **US-44.** As a founder editing a product page, I want to know whether a change affects this product or all of them. (SURF-03)

### Product content

- **US-22.** As a founder, I want to rewrite a product's title, description and images for my store only, so that my storefront can say what I want while Shopify stays as it is. (OVL-01, OVL-04)
- **US-23.** As a founder, I want fields I never touched to keep following Shopify, so that I do not maintain two catalogs. (OVL-02)
- **US-24.** As a founder, I want a notice when Shopify changes a field I edited, so that I can choose what to do and nothing is overwritten. (OVL-04)
- **US-25.** As a founder, I want "Reset to Shopify" on each field. (OVL-04)
- **US-26.** As a founder, I want to find the right order in Shopify admin even if I renamed the product here. (OVL-06)
- **US-27, sold-out and deleted case.** As a founder, if a product is deleted in Shopify, I want my edits kept and flagged, so that I lose nothing if it comes back. (OVL-02)

### Selling

- **US-28.** As a founder, I want to put a bundle on my home page by picking it from a list. (COM-02)
- **US-29.** As a founder, I want to start an offer by picking real products and using plain words. (COM-03)
- **US-30.** As a founder, I want shoppers to see my offer on the product page, not only in the cart. (COM-04)
- **US-31.** As a founder, I want to place my quiz and recommendations on any page. (COM-07, COM-08)
- **US-45.** As a founder, I want returning shoppers to see products based on what they bought. (COM-09)
- **US-46.** As a founder, I want shoppers to find products fast, so that I can cancel my search app. (COM-11)
- **US-47.** As a founder, I want to see repeat rate and where customers come from, so that I can stop paying for an analytics app. (COM-16)
- **US-32.** As a founder, I want to know whether a block earned money, so that I can cancel the app it replaced with confidence. (COM-12)
- **US-33, sold-out case.** As a founder, when a bundled product sells out, I want the bundle to say so and stop accepting adds, and I want to be told in the editor. (COM-01, COM-02)
- **US-49, sold-out and empty case.** As a founder, when my catalog changes, I want ordinary sections to stay presentable and tell me what happened. (DOC-03, PV-09)
- **US-34, disabled or expired case.** As a founder, when my offer ends or my bundle is off, I want the block to disappear for shoppers and the editor to tell me why. (COM-01)
- **US-35, sold-out gift case.** As a founder, I do not want shoppers promised a free gift that is out of stock. (COM-05, COM-06)

### Knowing what is live

- **US-36.** As a founder, I want a list of everything with unpublished changes. (PUB-09, PUB-13)
- **US-48.** As a founder, I want to see what recently went live and undo it, from wherever I am. (PUB-04)
- **US-37.** As a founder, I want it clear what goes live immediately and what waits for Publish. (PUB-10)
- **US-38.** As a founder, I want one place to change everything, so that I do not have to learn which of 23 sidebar items owns what. (ED-02, ED-06)

---

## 7. Requirements

**How priority works in this spec.** Priority is measured against this full build, not against a first release. The owner sets phases separately.

- **P0: the build fails without it.** One of the five timed tasks becomes impossible, or a binding decision is broken, or a shopper or a founder's data is put at risk, or other P0 work cannot be built without it.
- **P1: the build is weaker without it.** The product still works and the five tasks still pass, but a promise from the brainstorm is unmet.
- **P2: valuable, and can slip** without harming the promise of this build.

**Additions.** Anything marked **Addition** goes beyond the brainstorm direction, because the evidence forced it. The reason is given.

**Evidence.** References are `path:line` at commit `c47045f`. "Ran" means the code was executed read-only.

**Counts.** 161 requirements: 58 P0, 90 P1, 13 P2.

| Prefix | Workstream |
|---|---|
| DOC | Document model and registry |
| PUB | Publishing, undo and per-document release |
| ED | Unified editor shell |
| PV | Preview |
| AU | Authoring: rich text, drag-and-drop, friendly validation |
| TOK | Design tokens and composition guardrails |
| TREE | Section and block tree, per-device settings, bindings |
| SURF | Composable surfaces with protected commerce modules |
| COM | Commerce blocks |
| OVL | Product content overlay |
| SHOP | Shopify boundary enforcement |
| META | Metafield and metaobject binding |
| GEN | First-run store generation |
| MED | Media |
| PERF | Performance of live reads |
| MIG | Moving existing tenants to documents |

---

### 7.1 Document model and registry (DOC)

#### DOC-01 · P0 · One document store

**Behaviour.** All presentation content lives in documents. Each document has a stable id separate from its URL, a type, one draft, one revision number, and a list of frozen versions. Today's 8 fixed blocks and page rows become documents (mapping in section 8.3). The schema reserves `blocks` inside every section from day one, even before nested blocks ship (TREE-02).

**Acceptance.**
- [ ] A home page, a campaign, a blog post, the product page layout and one product's content are all rows of the same table, read and written through the same code.
- [ ] A page keeps its document id when its slug changes.
- [ ] Document ids for backfilled content are deterministic, so running the backfill twice produces the same ids.
- [ ] Negative: a version row cannot be updated or deleted through the document service. Only retention (PERF-05) removes versions, and only unreferenced ones.
- [ ] Negative: a type not registered in the registry is rejected at write.

**Evidence.** `lib/schema.sql:259-263`, `lib/schema.sql:267-274`, `lib/cms/defaults.js:69`, `components/admin/cms/PageEditor.js:231`.

#### DOC-02 · P0 · One write service, with a revision check on every write

**Behaviour.** Every change to a document goes through one service. It validates, sanitizes, stores and bumps the revision in one atomic write. Every write names the revision it started from, including delete and reset. The existing rules stay: a missing revision is refused with 428 unless a privileged path forces it, and a stale revision returns 409 with the current document so both versions survive. Four writers bypass this today and must move: experiment adopt, AI insight apply, agency kit apply, theme kit apply. Their stored payloads use the old hero shape, so one pure adapter (`legacyHeroToSettings`, plus an announcement equivalent) converts them at this boundary.

**Acceptance.**
- [ ] A stale save returns 409 with the current document, and the founder's text stays in the editor.
- [ ] Saving a document is one write. Partial save across blocks is impossible.
- [ ] The four named callers use the service. A test greps for direct writes to document tables outside the service and fails if it finds any.
- [ ] Adopting an experiment variant keeps the hero's buttons and badge. Today they are replaced by defaults.
- [ ] Old-shape experiment, AI proposal and kit payloads produce a valid hero section, by fixture.
- [ ] Negative: delete with no revision returns 428.
- [ ] Negative: two first-time creates racing produce 409, not 422.

**Evidence.** `lib/admin/cms-api.js:76-84`, `lib/cms/store.js:114-156`, `lib/experiments.js:291`, `lib/experiments.js:312-318`, `lib/ai/insights.js:243-244`, `lib/platform/agency.js:306-318`, `lib/themes/kits.js:108-112`.

#### DOC-03 · P0 · The registry is the real single source of truth

**Behaviour.** One declaration per section and block type holds its settings, defaults, required fields, cross-field rules, limits, allowed children, bindings, reference fields, media fields, migrations and placeholder. It also holds the composition guards that make Decision 4 true for layout as well as colour: `maxPerDocument` (hero: 1), `allowedPositions`, `minItems` (a rail below 3 products shows a founder note) and, on product layouts, `maxBeforeProtected` (start at 1, hypothesis). Validation, editor controls, link checks, reference healing, media scanning and the "add section" default all derive from it. The renderer is found by type from one map. Every renderer emits a stable section id attribute and a field attribute for each editable text, and is keyed by id, never by position. Duplicate concept names (`rich_text` and `rich`, `image_with_text` and `image`, `title` and `heading`) merge here, because bodies written at backfill are frozen.

Every section has defined behaviour when the catalog changes. Shopper behaviour ships here. Founder notes arrive with PV-02 and PV-09.

| Case | Shopper sees | Founder sees in preview |
|---|---|---|
| Rail with some sold-out products | Cards labelled "Sold out", sorted last unless the order is hand-picked | Nothing extra |
| Rail with every product sold out | Rail stays, all labelled | A note |
| Rail below `minItems` | Renders with no empty slots | A note suggesting more products |
| Rail bound to an empty collection | Hidden | The reason (PV-09) |
| Any image missing, including a collection grid with no images | A token-coloured fallback, never a broken image | A note on the field |
| Hero button linked to a sold-out product | Hero stays. The product page says sold out. | A note |
| A page that renders no sections | A neutral message and a link to collections | A note |

**Acceptance.**
- [ ] Adding a section type requires exactly one declaration and one renderer. A test adds a fake type and proves validation, editor controls, link checks and preview selection work with no other file changed.
- [ ] A test fails if a registered type has no renderer, or a renderer has no registered type.
- [ ] `validate.js` and `HomeSections.js` no longer contain per-kind branches for new documents. The old code stays only inside the legacy reader.
- [ ] Every registered section renders at 375, 768 and 1440 wide against a worst-case fixture (120-character title, long product names, no image, tall image, one item, maximum items, sold out), with no horizontal overflow and no clipped text. Rendered checks use `test-registry-contract`. Overflow needs the browser runner in section 8.15.
- [ ] The shopper behaviour in each row of the state table has a rendered test.
- [ ] Negative: a second hero, or a section outside its allowed positions, is refused with a plain message at add and at move.
- [ ] Negative: a field not declared in the registry is rejected with a clear error, never silently stripped.
- [ ] Negative: a registered type with a default that fails its own rules fails the registry test.

**Evidence.** `lib/cms/registry.js:1-6` claims this today and is false. `lib/cms/validate.js:52-116`, `lib/cms/validate.js:105-116`, `components/sections/HomeSections.js:116`, `components/ContentPage.js:26-48`.

#### DOC-04 · P0 · One structured validation result, and errors that say what kind they are

**Behaviour.** Save, preview and publish all use one result: `{ documentId, sectionId, blockId, field, code, severity, message, autoFix }`. All issues are collected, not just the first. Validation problems return 422. Infrastructure problems return 5xx with a code. A database error must never look like a validation error.

**Acceptance.**
- [ ] Every issue names a section id and field when one applies, so the editor can jump to it.
- [ ] A forced database failure returns 5xx, not 422.
- [ ] A failure matrix test lists every known save, preview and publish failure and proves each gives a founder-readable message.
- [ ] Negative: position-based strings such as "Section 2 (banner): ..." no longer reach the editor for new documents.

**Evidence.** `lib/cms/validate.js:54-55`, `lib/cms/store.js:315`, `lib/admin/cms-api.js:173`, `docs/cms-reviews/S59-live-preview.md:52-55`.

#### DOC-05 · P0 · Drafts are tolerant, publish is strict

**Behaviour.** A draft may be incomplete. A newly added banner with no text saves fine and is marked incomplete. Publish runs full validation. Two things are not relaxed at draft time: structure (known types, valid shape) and HTML sanitizing, which runs on every write. Because save is today the only full gate and old content renders raw, publish must re-run validation and sanitizing.

**Acceptance.**
- [ ] A document with one incomplete section saves, previews, and blocks only its own publish.
- [ ] Publish re-validates and re-sanitizes every section.
- [ ] Negative: a script tag sent in a draft save is stripped before storage.
- [ ] Negative: a document with an incomplete enabled section that is new or changed cannot be published through any path, including schedule and API. Issues the live version already has follow the `inherited` rule in PUB-03.

**Evidence.** `lib/releases.js:147-215` does not re-run validators. `components/sections/HomeSections.js:69`, `components/ContentPage.js:32`, `lib/cms/validate.js:60`.

#### DOC-06 · P1 · One section library for all document types

**Behaviour.** Home and page section families share one library with per-document-type allowed lists, using the merged names from DOC-03. Page documents keep their narrow container setting so migrated pages look the same. Old kind names stay readable forever through the legacy reader. Link rewriting, such as campaign UTM tags, works from typed link fields, not per-kind code.

**Acceptance.**
- [ ] A campaign page can contain a product rail and a collections grid.
- [ ] Migrated pages render the same as before, proved by the equivalence check in section 8.11.
- [ ] Negative: a section type not allowed on a document type is rejected with a plain message.

**Evidence.** `lib/cms/registry.js:44`, `lib/cms/registry.js:125`, `lib/cms/store.js:311-345`, `app/(storefront)/campaigns/[slug]/page.js:38-42`.

#### DOC-07 · P0 · The hero is a real section, with an image

**Behaviour.** The hero becomes a registered section at position 0 of the home document, with an image option. It can be moved within its allowed positions or hidden, and a home page has at most one. The announcement becomes its own document. Old releases keep the old hero path. Experiments that target the hero keep working by targeting the hero's section id, with running variant payloads translated at cutover (section 8.11).

**Acceptance.**
- [ ] A migrated hero renders the same as before.
- [ ] A founder can add an image to the hero.
- [ ] A founder can save a home draft with zero enabled sections. An explicit empty value replaces code defaults, so a saved empty draft never falls back to defaults. Today an empty list does fall back.
- [ ] Negative: publishing `doc_home` with zero enabled sections is refused with "Your home page is empty. Add a section or restore the last published version." Today's guard at `lib/releases.js:172` must not be lost.
- [ ] Negative: a running hero experiment still assigns and renders after migration, and its old flat payload merges at the right level.

**Evidence.** `app/(storefront)/page.js:56-86`, `lib/cms/validate.js:33-40`, `lib/content/resolve.js:92-93`, `lib/experiments.js:312-318`, `lib/releases.js:172`.

#### DOC-08 · P0 · Earlier versions, and restore to draft

**Behaviour.** Each document keeps every published version, up to 20 automatic checkpoints, and every version saved by Undo. The editor has an "Earlier versions" list showing date, who, and "Restore to draft". Restore loads a version into the draft. It never goes straight live. Names are plain, not raw actor ids. PUB-04 sends the founder here to find edits that Undo moved aside, so Undo cannot pass without this list. Checkpoints cap at 20 from day one. Published, migrated and Undo-saved versions are kept until PERF-05 sets numbers.

**Acceptance.**
- [ ] Restoring a version puts it in the draft, and the founder then publishes it.
- [ ] A version saved by Undo appears in the list.
- [ ] Negative: a version saved by Undo survives 100 later autosaves, by test.
- [ ] Negative: pruning never removes a version referenced by a release, by the publish log, or by a pending schedule.

**Evidence.** `lib/cms/history.js:8-34`, `components/admin/cms/Designer.js:515-524`.

#### DOC-09 · P1 · Blueprints

**Behaviour.** A blueprint is a saved document tree without ids. It works for any document type, including home. Using one makes a copy with fresh ids. Code templates and `cms_templates` rows both become blueprints.

**Acceptance.**
- [ ] Creating from a blueprint re-validates and mints new ids.
- [ ] Changing a blueprint later does not change documents already made from it.
- [ ] Negative: updating a blueprint with a stale revision returns 409. Today there is no check.

**Evidence.** `lib/cms/templates-store.js:23`, `lib/cms/templates-store.js:42-71`, `lib/content/templates.js:7-113`.

#### DOC-10 · P1 · Slug is a field, and redirects publish with it

**Behaviour.** A page's URL state lives in the version body's `meta` (section 8.5), so it is versioned with the content. Changing a page's slug offers a redirect from the old URL. The redirect takes effect in the same publish as the new slug, for all page types. Redirect input is validated before anything is saved. Public URLs do not change during migration. The shared slug namespace across page types stays, because changing it adds migration risk with no founder benefit.

**Acceptance.**
- [ ] After publishing a slug change, the old URL redirects to the new one.
- [ ] Undo of that publish restores the old URL and removes the redirect.
- [ ] Two pages can swap slugs in one set publish.
- [ ] Negative: a publish or Undo that would leave two live pages at one slug is refused with a plain message naming the other page. Today readers silently take the first match.
- [ ] Negative: an invalid redirect value leaves the document unsaved. Today the page saves first and then returns 422.

**Evidence.** `lib/cms/store.js:398-412`, `lib/content/resolve.js:131`, `app/(storefront)/journal/[slug]/page.js:16`, `lib/content/presentation.js:30-34`.

#### DOC-11 · P1 · Document type is data

**Behaviour.** Document types are registered, not hard-coded in switches. No founder-facing custom type builder ships. A new type can be added later by declaration.

**Acceptance.**
- [ ] A test registers a fake document type, then creates, previews and publishes it through the normal service.
- [ ] Negative: writing a document with an unregistered type is refused.

**Evidence.** Custom types are parked, but the direction says the model must allow them.

#### DOC-12 · P1 · Tenant export includes everything new, and closes today's gaps

**Behaviour.** The fixed export list gains every new table. It also closes existing gaps. The code comment says "Every table a tenant OWNS", but the list misses `order_items`, `page_redirects`, `bundles`, `quizzes`, `cms_templates`, `cms_history`, `cms_approvals`, `experiments`, `automations`, `ai_insights`, `customers`, `customer_wishlists` and `return_requests`, among others. Each is added or put on a written exclusion list with a reason. `customers` needs a privacy decision.

**Acceptance.**
- [ ] A test fails if a table holding tenant content is missing from the export list and not on an explicit exclusion list.
- [ ] Negative: preview and cache tables are excluded on purpose, and the exclusion is written down.

**Evidence.** `lib/platform/export.js:23-48` compared with table names in `lib/schema.sql` and `migrations/tenant/*.sql`.

#### DOC-13 · P1 · Approvals and agency flows keep working

**Behaviour.** Approvals get no new investment, but they must not break. A compatibility function produces an aggregate hash over all drafts for `approveCandidate`, `currentApproval` and the agency `/approve` page. The approvals UI moves behind a team setting so founders do not see it by default.

**Acceptance.**
- [ ] The existing approvals tests pass after cutover, or the failing flow is stubbed by name and that is recorded.
- [ ] Negative: a founder with no team setting sees no "Approve this candidate" control.

**Evidence.** `lib/cms/approvals.js:22-53`, `app/api/admin/releases/route.js:76-82`, `lib/platform/agency.js:329-334`, `components/admin/ReleasesAdmin.js:201`.

#### DOC-14 · P2 · Blog post details

**Addition.** The direction says a blog post is a document. The evidence shows journal rows have no cover image, author, excerpt or tags, and that the shared renderer adds a legal footer. A blog is not credible without these.

**Behaviour.** The journal document type gains cover image, author, excerpt and tags, and renders as an article.

**Acceptance.**
- [ ] A journal index shows cover and excerpt.
- [ ] Negative: a post with no cover renders cleanly.

**Evidence.** `app/(storefront)/journal/page.js:12-21`, `lib/cms/store.js:347-352`.

#### DOC-15 · P1 · History covers every writer

**Behaviour.** Reset, delete and all programmatic writers appear in "Earlier versions" with a plain name. Old `cms_history` rows are not required (section 8.13).

**Acceptance.**
- [ ] An AI apply, a kit apply and a reset each appear in history.
- [ ] Page history holds the validated stored value, not the raw client payload as it does today.
- [ ] Negative: no history row shows a raw actor id to a founder.

**Evidence.** `lib/cms/history.js:8-34`, `lib/admin/cms-api.js:155-160`.

---

### 7.2 Publishing, undo and per-document release (PUB)

#### PUB-01 · P0 · A release becomes a small list of document versions

**Behaviour.** A new release row holds a version 4 list: for each document, which version is live, plus small page index data and redirects. It does not hold document bodies. The single live pointer stays the one switch for these documents. The reader checks the version number **before** any helper runs. Version 4 goes to the new reader. Versions 1, 2 and 3 go to a frozen legacy reader. Everything that keeps shoppers safe stays exactly as it is: `live`, `none` and `error` stay distinct, and an error never serves drafts or defaults.

**Acceptance.**
- [ ] A test passes a version 4 row through every `resolved*` getter and gets correct content. Without the branch, today's code would silently render an empty default site.
- [ ] Hashing still uses `stableStringify` and `sha256Hex`.
- [ ] A new required singleton can ship without breaking older rows. Each list carries a manifest number, and a singleton missing from a list is an error only if the singleton's `sinceManifest` is at or below that number. Otherwise it reads as code default. A test registers a new singleton, then reads an older version 4 row.
- [ ] Negative: a release pointing to a missing document version gives the error page, never a draft and never a code default.
- [ ] Negative: a release with an unknown future version number gives the error page.
- [ ] Negative: a singleton the manifest says must exist, but which is missing from the list, is an error. "Use the code default" must be written explicitly as `null`.

**Evidence.** `lib/content/presentation.js:9`, `lib/content/resolve.js:61-67`, `lib/releases.js:296-329`, `scripts/test-releases.js:383`.

#### PUB-02 · P0 · One Publish button inside the editor

**Behaviour.** Pressing Publish in the editor opens the small panel in PUB-09 and then publishes this document and nothing else. The server builds a new release from the current live one with only this document's entry changed, then flips the pointer only if neither the pointer nor this document has moved. If another document was published in between, the server rebuilds and retries. If this document changed since the founder last saw it, or another publish of it won, the founder gets a 409. Review stays bound to content: the panel sends each document's `draft_hash`, and a mismatch returns 409, as `expectedDraftHash` does today. Staff can edit and preview, and see Publish disabled with a plain reason. Unpublishing a page is also a publish.

**Acceptance.**
- [ ] A typo fix on a policy page leaves a half-finished home draft unpublished, proved by test and in a browser drill.
- [ ] Two concurrent publishes of different documents both succeed and both end up live.
- [ ] The version, release, pointer flip and log are written in one atomic batch.
- [ ] Negative: two concurrent publishes of the same document give one success and one 409, and the loser's content is not live.
- [ ] Negative: an autosave landing between the publish read and the batch makes the publish lose, and it returns 409.
- [ ] Negative: a response lost after commit, followed by a transport retry, reports success and writes no duplicates.
- [ ] Negative: a staff member calling the API directly gets 403, with storage unchanged.
- [ ] Negative: publishing with a stale revision or a changed hash returns 409 and changes nothing, per document in a set publish.

**Evidence.** `lib/releases.js:347-352`, `lib/releases.js:359-366`, `lib/db.js:19-31`, `lib/db.js:48`, `app/api/admin/releases/route.js:50`. A grep finds no `.transaction(` or `.batch(` in `lib` or `app`, so the atomic path is unproven here. See section 8.6.

#### PUB-03 · P0 · Publish checks are scoped to the document, and block only what would really break

**Behaviour.** Publish checks this document fully: all section validation, all links, all references, image existence. It checks references against what will be live after this publish. A problem in another document never blocks this one. Every problem links to the field that has it.

Three levels of problem:

| Level | What it covers | Effect |
|---|---|---|
| **Blocks** | Something a shopper would see broken with no safe fallback: an empty required text, a missing purchase box, a hand-placed link to a missing page, an empty home page | Publish stops, with a plain message and a fix link. Each row also offers "Hide this section and publish", because only enabled sections block. |
| **Warns** | Anything with a safe render fallback: a deleted product in a list, a disabled or expired bundle, missing alt text | Publish goes ahead. The row offers one-click "Remove it". |
| **Inherited** | A problem in a section whose id-stripped hash equals the live version. The founder did not cause it, and old content was never held to these rules. | Warning with a fix link. It does not block. |

Structure and sanitizing always run and always block. For the design document, contrast blocks only for changed tokens.

**Acceptance.**
- [ ] Publishing a page linking to an unpublished campaign is stopped with a plain message and an offer to publish both (PUB-05).
- [ ] Coverage includes today's gaps: image-with-text links, product rail collections, page content, media existence, redirects.
- [ ] A typo fix publishes on a migrated document that has inherited issues, by fixture.
- [ ] Negative: a broken link in the home draft does not stop publishing a policy page.
- [ ] Negative: a product deleted in Shopify does not stop a hero typo on the same page if that product is only in a list.

**Evidence.** `lib/releases.js:147-215`, `lib/releases.js:157`, `components/admin/ReleasesAdmin.js:102`, `components/admin/ReleasesAdmin.js:143`, `docs/cms-reviews/S53-0B2.md:49-50`.

#### PUB-04 · P0 · Undo, per document

**Behaviour.** Undo puts the previous live version of this document back live, using a publish log. It also sets the draft to that restored version, so the next Publish cannot ship the undone change. The undone version stays in history. If the founder has newer unpublished edits, they are saved first as a version the cap cannot prune, and the founder is told where to find them (DOC-08). Undo works when old references have gone stale: the page degrades at render rather than refusing to undo. Price, stock and other Shopify-owned data are never rewound.

A first-ever publish has no earlier version:
- **Singletons (home, header, footer, design and so on).** Undo is not offered. The note says: "This is the first published version. Edit it, or go back to your starting design." No path returns a singleton to a platform code default.
- **Pages, campaigns and posts.** Undo becomes "Take this page offline". The confirm lists every live document that links to it, from `document_refs`. The list keeps a disabled entry, so a code-default page cannot reappear in its place. The draft keeps its text, and publishing that same content again needs an explicit "publish again" confirmation.
- **A migrated version is a floor.** Undo there says there is nothing earlier to undo. It never takes a live migrated page offline.

Founders can find Undo from anywhere. The shell has a "Recently published" list, read from `publish_log` plus offer changes (COM-03), showing the plain document name, what changed, when, and an Undo button per row. The message after each Publish carries Undo as well.

**Acceptance.**
- [ ] After Undo, shoppers see the previous version, and pressing Publish does not re-ship the undone change.
- [ ] Undo is reachable from the editor, and from "Recently published", in one click plus a plain confirm that names what will change.
- [ ] Undo works repeatedly, stepping back through publishes.
- [ ] Undo on one document leaves every other document live as it was.
- [ ] Product and collection content undo the same way, by rewriting or removing their live row.
- [ ] Negative: newer unpublished edits are never lost. They appear in "Earlier versions" and survive later autosaves.
- [ ] Negative: an autosave racing an Undo makes the Undo re-read, and it destroys nothing.
- [ ] Negative: staff cannot Undo.
- [ ] Negative: Undo with no earlier publish shows a plain message rather than an error.

**Evidence.** `lib/releases.js:442-451`, `scripts/test-releases.js:106`, `migrations/tenant/0007_releases.sql:7-24`, `lib/content/resolve.js:146`, `lib/cms/defaults.js:13`. The draft rule is an assumption to confirm (OQ-02).

#### PUB-05 · P0 · Publish several documents together

**Behaviour.** The same publish can carry a chosen set of documents, atomically, in one batch. This covers three needs: "publish both" when a page links to an unpublished page, "publish all changes", and the very first publish of a generated store. Sets are capped (start at 200 documents, hypothesis), because atomicity forbids splitting a batch. Above the cap, "publish all" publishes content pages atomically and product documents in separately atomic batches, and tells the founder so.

**Acceptance.**
- [ ] A set publish either makes all of its documents live or none of them, including product and collection content in the set. A lost pointer race leaves no product live row written.
- [ ] Undo after a set publish offers to undo the whole set or one document. Whole-set Undo is all-or-none, and returns 409 if any member was published since.
- [ ] Negative: one invalid document in the set stops the set, and the message names that document.

**Evidence.** Forced by per-document publishing plus the generator. See also `lib/releases.js:147-215` and section 8.6.

#### PUB-06 · P0 · Private until the first Publish

**Addition.** Today a store with no release serves every saved draft directly to shoppers, while editor messages say "Saved as a draft". That conflicts with the Publish model and with a generated store.

**Behaviour.** A tenant whose CMS mode is `documents` and whose live state is `none` is closed. Table presence never selects behaviour, because the expand step adds tables to every tenant before cutover. A legacy or migrating tenant in state `none` keeps today's path until its cutover batch runs. The content source gains a fourth state, `{mode:"closed"}`. Every resolved getter then returns neutral empties, the sitemap returns only `/`, metadata is neutral, and the manifest and offline routes use neutral brand values, so no draft leaks outside the layout. Shoppers see a closed page with new copy that says "Opening soon", not the maintenance wording "Scheduled maintenance" and "will be right back". Console users see the store through the normal preview session. The maintenance bypass is not reused, because it checks only that a cookie exists. Drafts render only with a verified preview token, as today.

An already-launched tenant in the "no release" state is migrated by publishing what shoppers see today (section 8.11), so its store does not close.

**Acceptance.**
- [ ] A generated store is not visible to an anonymous shopper before the first Publish.
- [ ] Editor copy is true for every state.
- [ ] A verified console session can place a COD test order while the store is closed.
- [ ] Negative: an anonymous POST to `/api/checkout` on a closed store is refused.
- [ ] Negative: an anonymous shopper never receives a draft from any state: not from the page, metadata, sitemap, manifest or offline route.
- [ ] Negative: a request carrying `_admin=anything`, `_platform=anything` or `_mx=anything` with no valid session gets the closed page and no draft string, by test.
- [ ] Negative: an anonymous request with `RSC: 1` and a router-state header claiming the layout is already loaded gets no real page content on a closed store, by test. A check that lives only in the layout fails this: with maintenance on, this request returned the real `/contact` page with no cookies (side-session probe on a local production build, branch `claude/musing-williamson-4c86b3`). The closed check must run before routing or in the data layer.
- [ ] Negative: migrating a live "no release" tenant leaves shoppers seeing the same store.
- [ ] Negative: running the expand step on a live tenant in state `none` does not close it.

**Evidence.** `lib/content/resolve.js:61-63`, `components/admin/cms/Designer.js:416`, `app/(storefront)/layout.js:205-219`, `app/sitemap.js:27-32`, `app/manifest.webmanifest/route.js:15`, `app/(storefront)/offline/route.js:17`, `app/(storefront)/journal/[slug]/page.js:14`, `lib/commerce/adapter.js:47-50`.

#### PUB-07 · P1 · Publish later

**Behaviour.** A founder can schedule one document. When the job fires, the server builds the release from whatever is live at that moment plus this document's chosen version, and re-checks references. If it fails, the founder is told and nothing changes. The console promises a time window, not an exact minute, because the tick runs about every 5 minutes on a best-effort cron and is inert until configured.

**Acceptance.**
- [ ] A schedule does not overwrite a newer publish of a different document. Today it does.
- [ ] Cancelling works until the job is leased.
- [ ] Negative: a schedule whose references have gone stale fails visibly and leaves the live store unchanged.

**Evidence.** `lib/releases.js:381-407`, `lib/platform/worker.js:77-80`, `.github/workflows/jobs-tick.yml:1-10`, `components/admin/ReleasesAdmin.js:263`.

#### PUB-08 · P1 · Whole-store restore as an advanced tool

**Behaviour.** The existing release list and rollback remain, under an Advanced area, for support and operators. They are not the founder's Undo, and Advanced is hidden unless a support or team setting is on. In a document-mode tenant, restore never points the live pointer at an old row. It builds a new version 4 release from the target (versions 1 to 3 through the backfill mapper) and flips it with the same check as any publish. In the same batch it updates each document's published state and writes one `restore` log row per changed document, so restore behaves like an ordinary publish for Undo, the badge and the reader. It refuses a release that never went live, and keeps drafts unchanged. **It does not rewind product or collection content, and the screen says so** (section 8.4, OQ-18). The legacy reader serves only legacy tenants and reversal.

**Acceptance.**
- [ ] Restoring a version 3 release gives the same pages as the legacy reader, by fixture.
- [ ] The badge and Undo are correct straight after a restore.
- [ ] A test proves product and collection live rows are unchanged by restore.
- [ ] Negative: restoring a scheduled, never-published release is refused. Today it is accepted.
- [ ] Negative: a founder with no support or team setting does not see Advanced.

**Evidence.** `lib/releases.js:444-451`, `lib/content/resolve.js:223-228`, `lib/content/presentation.js:11-21`, `components/admin/ReleasesAdmin.js:306`.

#### PUB-09 · P0 · See what will ship, and keep part of it back

**Behaviour.** Publish opens a small panel listing this document's changed sections in plain words, with one Publish button. This is the confirm, and it stays within ED-04's 3 clicks. Each row has "Keep the live version of this section", which copies that section from the published version into the draft. Founders never see a hash. The old diff vocabulary is reused and its deep links point to the new editor. Without this, per-document publishing just moves the half-finished problem down one level: a hero typo would ship last week's half-done section on the same page.

**Acceptance.**
- [ ] A founder can publish a hero edit without shipping a half-done section elsewhere on the same page.
- [ ] The list comes from comparing each document's draft with its published version.
- [ ] Negative: moving to version 4 does not mark every tenant as having changes, and migrated documents show no changes unless drafts really differ. This includes drafts that differ from the snapshot only by lazily stamped section ids, by fixture (section 8.2).

**Evidence.** `lib/releases.js:220-281`, `lib/releases.js:226-238`, `components/admin/cms/labels.js:6-7`, `components/admin/cms/labels.js:50`.

#### PUB-10 · P1 · The console says what goes live how

**Behaviour.** Each area states its rule, and this table is the contract. Offers stay immediate because money rules have their own lifecycle (see OQ-03).

| Area | How it goes live | How to undo |
|---|---|---|
| All documents: home, pages, campaigns, posts, header, footer, announcement, design, product and collection layouts, product content | Publish | Undo |
| Offers | Their own switch, immediately. Placing them on a page is a document edit and needs Publish. | Turn off, or "Go back to previous offer settings" (COM-03) |
| Bundles, quizzes (the records) | Their own switch, immediately. Placing them on a page is a document edit and needs Publish. | Turn off |
| Experiments | Their own start and stop | Stop |
| Store name, support contact, legal name, maintenance, pixels | Immediately, from Settings (OQ-04) | Change it back |
| Catalog, price, stock | Automatically from Shopify | In Shopify |

**Acceptance.**
- [ ] Each editor shows the rule that applies to it.
- [ ] Negative: no screen says "everything here saves as a draft" while some of it goes live immediately.

**Evidence.** `components/admin/OffersAdmin.js:18`, `components/admin/CommercePanels.js:229`, `components/admin/CommercePanels.js:412`, `app/(console)/admin/(authed)/storefront/page.js:65`.

#### PUB-11 · P0 · See it live, and get back to the editor

**Behaviour.** After Publish, the founder gets a link that opens the real public page and is not caught by the preview cookie. The preview cookie is host-wide and decided from cookies alone, the root layout cannot read query parameters, and the repo has no middleware, so a clean link would still render drafts. The link therefore opens `/api/preview?exit=1&to=<path>`. The editor listens for that action and re-mints its session on its next frame refresh. Every section 10 timer stops on this page, and task 5 depends on seeing the old version, so a false "it worked" or a false "Undo failed" breaks trust. While a preview cookie is active, the existing draft banner stays, in founder wording with a "See the live store" link. A console user viewing the live store sees an "Edit this page" link that opens that document.

**Acceptance.**
- [ ] The page opened by the link shows live content at open, and the draft banner is absent. Later reloads after the editor re-mints show the banner again.
- [ ] The open editor shows "reconnecting" while it re-mints, not stale live content.
- [ ] "Edit this page" opens the document for the current route.
- [ ] Negative: the link never carries a preview token.
- [ ] Negative: the draft banner and "Edit this page" never render for a shopper. A forged cookie reveals only a link that then requires login.

**Evidence.** `app/api/preview/route.js:28-31`, `app/api/preview/route.js:40-48`, `lib/content/resolve.js:46-60`, `app/(storefront)/layout.js:85-92`, `app/(storefront)/layout.js:241-247`, `components/admin/ReleasesAdmin.js:346`, `components/console/nav/ConsoleShell.js:53`.

#### PUB-12 · P0 · Before you open your store

**Addition.** Per-document checks drop today's store-level warning for missing privacy and terms pages, and GEN-06 deliberately leaves unreviewed policies out. Checkout policy links render only if policies exist. So a store could open with no legal pages and nothing checking that shoppers can pay.

**Behaviour.** The first Publish opens a "Before you open your store" panel: a working payment method, privacy and returns pages reviewed, a test order placed. No way to pay blocks. The others warn. On later publishes, a set that changes policy pages keeps today's store-level warning.

**Acceptance.**
- [ ] The panel lists each item with a link to fix it.
- [ ] A store where `checkoutCapability()` reports no way to pay cannot open until that is fixed, and the message says what to do.
- [ ] Negative: a founder can open with a warning still showing, after a plain confirm.

**Evidence.** `lib/releases.js:211-212`, `components/checkout/CheckoutFlow.js:404`, `lib/commerce/adapter.js:31-74`, `lib/admin/onboarding.js:93-99`.

#### PUB-13 · P1 · A store-wide list of unpublished changes

**Behaviour.** The shell shows which documents have unpublished changes, each with the same plain description as PUB-09 and a link to the editor at that document. "Publish all changes" starts from this list.

**Acceptance.**
- [ ] Each item links to the editor at that document.
- [ ] Negative: a document whose draft equals its published version never appears.

**Evidence.** `lib/releases.js:220-281`.

---

### 7.3 Unified editor shell (ED)

#### ED-01 · P0 · A full-width editor

**Behaviour.** The editor has its own layout outside the console's 1024px cap. Tree on the left, preview in the centre, inspector on the right. The console navigation collapses. Device buttons set real widths. **Check this in a browser first.** It is the cheapest and most visible fix, and the 342px figure was computed, not observed.

**Acceptance.**
- [ ] At 1440px wide, the Desktop preview is at least 900px wide.
- [ ] At 1280px wide, the tree is at least 220px, the preview at least 600px and the inspector at least 280px.
- [ ] Below 1280px, the tree collapses to a drawer and the preview keeps at least 600px.
- [ ] Desktop, Tablet and Mobile previews each render at their stated width, or are visibly scaled and labelled.
- [ ] Negative: Desktop is never narrower than Mobile.

**Evidence.** `components/console/nav/ConsoleShell.js:127`, `components/admin/cms/Designer.js:1003`, `components/admin/cms/SurfaceDesigner.js:335`.

#### ED-02 · P0 · One editor for every document

**Behaviour.** One shell edits every document type. Entering it opens the home document. A switcher with search reaches the home page, pages, layouts, products, header, footer and design, because a store may have many posts and thousands of products. A rich-text-only document, such as a policy, opens in a full-width writing view with the text as the main pane. Within a document, the founder can add from a library, select, move up or down, hide, duplicate and delete. The brainstorm named Designer, HomeEditor, Theme, Brand and Navigation. **The evidence adds** Product pages, Page templates, the presentation half of Catalog, and the Product and Collection designers.

| Concept | Today lives in | Owner after this build |
|---|---|---|
| Hero | Designer, Home page, Theme preset, Experiments, AI Insights | Home document |
| Announcement | Designer, Navigation | Announcement document |
| Home sections | Designer (6 kinds), Home page (4 kinds) | Home document |
| Collections index | Home page only | Collections index document |
| Menus, header and footer layout | Navigation, Theme | Header and footer documents |
| Product modules, badge | Catalog, Product designer | Product content document |
| Product layout choice | Product designer, Theme, Catalog | Product content document, picking a layout |
| Global accordions | Product pages | Product layout document |
| Colours, fonts, spacing, looks | Brand, Theme | Design document |
| Collection pins | Catalog | Collection content document |
| Pairs, cart upsell | Upsells | Product content document, Cart document |

**Acceptance.**
- [ ] One client store and one save, preview and history path serve every document type. Today there are 7 save paths and 3 preview implementations.
- [ ] Home, announcement, pages and design each have their editor destination in the shell.
- [ ] Search in the switcher finds a page or product by its name.
- [ ] Negative: a click in the preview on another document's content switches to that document with a visible note. It never edits the wrong document.

**Evidence.** `components/admin/cms/Designer.js:49`, `components/admin/cms/Designer.js:378`, `components/admin/cms/HomeEditor.js:214`, `components/admin/cms/NavigationEditor.js:36`, `components/admin/cms/PdpExtrasEditor.js:51`, `components/admin/cms/SurfaceTemplatesCard.js:125`, `components/admin/cms/SurfaceDesigner.js:101`, `components/admin/cms/PageEditor.js:242`.

#### ED-03 · P0 · One save model: drafts save automatically

**Addition.** The brainstorm asked for one Publish button. The evidence forces automatic saving: in-app navigation loses edits today, and screens mix three save models.

**Behaviour.** Edits save to the draft automatically, after a short pause. A status shows "Saving", "Saved" or "Could not save" with the reason. There is no per-card Save button. Publish first flushes any pending save, and further autosaves wait until it returns. A failed save keeps the founder's text and retries.

Autosave removes the founder's old escape, which was not saving, so the editor gives a new one. "Go back to the live version" appears when the draft differs from the published version. One click plus a plain confirm writes the current draft as a checkpoint and sets the draft to the published body. It works on the whole document. PUB-09 covers one section at a time.

**Acceptance.**
- [ ] Typing and then clicking any link loses nothing.
- [ ] Navigation, pages, design and layouts all preview unsaved work within one pause. Today only hero, announcement and home sections do.
- [ ] Closing the tab within the pause flushes with `fetch keepalive`, and warns if that cannot be confirmed.
- [ ] An offline or failed save stays visible until resolved.
- [ ] On a 409, the editor stops autosaving that document and says "This page was changed in another tab or by <name>", with two choices: "Use the newer version" and "Keep mine". Whichever is not chosen is saved as an earlier draft.
- [ ] Negative: a second tab with an older revision sees that choice, not a silent overwrite.
- [ ] Negative: autosave and "Go back to the live version" never change what shoppers see.

**Evidence.** `components/admin/cms/useDirtyGuard.js:5`, `components/admin/cms/Designer.js:962`, `components/admin/cms/DesignerTabs.js:22`, `components/admin/cms/SurfaceDesigner.js:129`, `components/admin/cms/HomeEditor.js:23`.

#### ED-04 · P0 · Click to edit

**Behaviour.** Clicking anything in the preview selects it, opens its inspector and focuses that element's field, using the field attribute from DOC-03. Sections added before their first save are selectable, because the client mints their id at add time.

**Acceptance.**
- [ ] Changing the hero title and button text and publishing takes at most 4 clicks plus typing: click the title, type, click the button, type, press Publish, confirm in the panel. The title alone takes 3.
- [ ] Clicking a paragraph in a policy opens the editor at that paragraph.
- [ ] Fixing a policy typo from the live page takes at most 4 clicks plus typing: "Edit this page", click the paragraph, type, Publish, confirm in the panel.
- [ ] A newly added section is selectable in the preview immediately.
- [ ] Selection survives a preview refresh.
- [ ] Negative: a click in the preview during editing never navigates the frame away.

**Evidence.** `components/admin/cms/Designer.js:225`, `components/admin/cms/Designer.js:329`, `components/admin/cms/Designer.js:344`, `lib/cms/registry.js:29`, `components/preview/PreviewBridge.js:46`.

#### ED-05 · P0 · Old screens go when a tenant cuts over

**Behaviour.** When a tenant moves to documents, the old editors disappear for that tenant and their URLs redirect to the new editor. A founder must never land on a screen whose saves are refused. HomeEditor's one unique capability, collections index curation, moves first. ReleasesAdmin becomes the advanced area of PUB-08. Removing the old components from the codebase waits for the rules in section 8.13.

**Acceptance.**
- [ ] Every old URL redirects to the matching editor destination.
- [ ] Setup steps, diff links and help links point to the new destinations.
- [ ] Negative: old API write paths refuse writes for a tenant in document mode (MIG-03).

**Evidence.** `components/admin/cms/HomeEditor.js:30-36`, `components/admin/cms/PreviewFrame.js:10`, `components/admin/ReleasesAdmin.js:223`, `lib/admin/onboarding.js:82`.

#### ED-06 · P1 · A shorter sidebar

**Behaviour.** The sidebar's 23 items shrink. All content editing collapses into one "Store editor" entry. Bundles, Quiz and Offers become first-class, no longer at the bottom of Catalog. The exact layout is a design decision at build time.

**Acceptance.**
- [ ] A founder can reach all five benchmark tasks from the top level of the sidebar.
- [ ] Negative: no feature is lost. Each old item has a mapped destination, in a checked list.

**Evidence.** `components/console/nav/SidebarNav.js:63-115`, `app/(console)/admin/(authed)/catalog/page.js:61`.

#### ED-07 · P1 · Pickers instead of typed identifiers

**Behaviour.** One link picker replaces every link field. It chooses a collection, product, page, bundle, quiz or external URL, and stores a typed reference. RefPicker extends to pages, bundles and quizzes. Founders never type a handle, a GID or a comma-separated list. Slugs are derived from titles, and remain editable as a "web address". Every picker has an empty state with a create action.

**Acceptance.**
- [ ] No input in the editor, offers, bundles, quiz or upsell screens asks for a handle, a GID or a path.
- [ ] A Shopify handle rename keeps every picked link working.
- [ ] Negative: a picked item that was deleted shows as "missing" with a fix, and does not disappear silently.

**Evidence.** `components/admin/cms/RefPicker.js:13`, `components/admin/cms/Designer.js:738`, `components/admin/CommercePanels.js:175`, `components/admin/OfferForm.js:172`, `components/admin/OfferForm.js:232`, `components/admin/UpsellsAdmin.js:162-180`.

#### ED-08 · P1 · Founder language

**Behaviour.** A written glossary replaces internal words everywhere founders see them. Hide session ids, hashes, `sec_` ids, "kit", "family", "snapshot", "immutable release", "handle", "CTA", "href" and "WCAG AA".

| Internal word | Founder sees |
|---|---|
| Document | Page, or the item's name |
| Slug | Web address |
| Checkpoint | Earlier draft |
| Blueprint | Saved layout |
| Orphaned | No longer in Shopify |
| Binding | "Shows products from" |
| Version | "Published on <date>" |
| Session undo | An arrow icon labelled "Undo typing" |
| Publish Undo | "Undo last publish" |

**Acceptance.**
- [ ] A copy check lists banned words and scans founder-facing screens.
- [ ] Negative: no founder-facing error contains a hash, a stack trace or an internal id.

**Evidence.** `app/(console)/admin/(authed)/storefront/page.js:65`, `components/admin/ReleasesAdmin.js:34`, `components/admin/cms/Designer.js:859`, `components/admin/ThemeAdmin.js:133`.

#### ED-09 · P1 · Undo and redo while editing

**Behaviour.** Session undo and redo cover every edit in every document, including text. This is separate from publish Undo, and the labels make the difference clear.

**Acceptance.**
- [ ] Undoing a hero edit works. Today it does not, because hero edits bypass the undo stack.
- [ ] Negative: session undo never changes what is live.

**Evidence.** `components/admin/cms/Designer.js:457`, `components/admin/cms/Designer.js:795`.

#### ED-10 · P1 · Quick edits from a phone

**Addition.** The brainstorm does not mention phones. A founder will likely fix a typo or start an offer from a phone. There is no data to confirm this, so it is a hypothesis (OQ-12).

**Behaviour.** On a phone, the inspector is a bottom sheet, Publish stays in view and tap targets are at least 44px. Full composition remains a desktop job.

**Acceptance.**
- [ ] The typo, hero text and undo tasks can be completed on a 375px screen.
- [ ] The offer form, including pickers and the plain sentence, can be completed on a 375px screen.
- [ ] Negative: tapping a section does not leave the inspector about 70vh offscreen, as the current stacked layout would.

**Evidence.** `components/admin/cms/Designer.js:936`, `components/admin/cms/Designer.js:1003`, `components/console/Button.js:22`, `components/console/Button.js:57`. Code reading only.

#### ED-11 · P1 · Every concept has one owner

**Behaviour.** The shell owns every row of the ED-02 table, in its full form: composable collections index, header and footer, product and collection layouts, cart slots. Nothing writes a concept outside its owner.

**Acceptance.**
- [ ] Every row in the ED-02 table has one editor destination and no second way to edit it.
- [ ] Negative: a test finds no route that writes a concept outside its owner, other than the migrated programmatic writers going through DOC-02.

**Evidence.** The ED-02 table, delivered by SURF-03, SURF-06, SURF-07, SURF-08, OVL-07 and COM-10.

#### ED-12 · P0 · A plain editor for every migrated type

**Addition.** Cutover moves all content at once and removes the old screens, so a tenant's menus, collections index, product modules and upsells must stay editable from day one. The composable versions of those screens are P1. This requirement is the floor: without it a migrated founder cannot edit their menu.

**Behaviour.** Each document type in section 8.3 that is not covered by ED-02 gets a registry-driven settings form in the shell, with the same capability as today's screen. No composition is required. It uses the normal autosave, Publish and Undo.

**Acceptance.**
- [ ] Each type in section 8.3 has a working form: collections index, header, footer, product layout, collection layout, cart, product content, collection content.
- [ ] Each thing a founder can change on today's screen for that type can be changed in the form, from a checked list.
- [ ] Negative: a type with no form stops cutover (MIG-03).

**Evidence.** `components/admin/cms/NavigationEditor.js:36`, `components/admin/cms/HomeEditor.js:30-36`, `components/admin/CatalogAdmin.js:206`, `components/admin/UpsellsAdmin.js:162-180`.

---

### 7.4 Preview (PV)

#### PV-01 · P0 · The preview says what state it is in

**Behaviour.** The preview always shows one of: up to date, updating, or could not update, with the reason in plain words and a link to the field. A failure can never leave the frame stale with no message. This fixes the bug seen live, whose real cause was silence, not the highlight (see section 14).

**Acceptance.**
- [ ] Each of these failures shows a message: incomplete section, bad link, expired session, network failure, server error.
- [ ] Negative: the label never says "shows your edits" when the frame holds older content. Today it can.

**Evidence.** `components/admin/cms/Designer.js:289-297`, `components/admin/cms/Designer.js:910`, `lib/admin/cms-api.js:92`, `lib/admin/cms-api.js:104-108`.

#### PV-02 · P0 · One broken section never blocks the rest

**Behaviour.** An incomplete or invalid section renders as a labelled placeholder in preview, and every other section updates normally. Shoppers can never see a placeholder, because placeholders render only in preview mode. On a live page, a section with an inherited problem renders as it does today (PUB-03).

**Acceptance.**
- [ ] With an empty banner on the page, a hero edit still appears in the preview.
- [ ] A new image-with-text section with no image shows a placeholder, not nothing.
- [ ] Negative: a placeholder never renders on a live page.

**Evidence.** `lib/admin/cms-api.js:104-108`, `components/sections/HomeSections.js:74`, `components/sections/HomeSections.js:116`.

#### PV-03 · P0 · Preview shows the live store plus this draft

**Behaviour.** Today a preview shows every draft on the site at once, which misleads once publishing is per document. The new preview shows live content plus the saved drafts of the documents chosen, by default only the one being edited. This works for every document type. The signed, tenant-bound, httpOnly preview cookie stays. When another document has unpublished changes that affect this view, such as design, header or footer, the preview says "Your new colours are not shown here. Show them", as a one-click overlay toggle. Retiring the separate per-session candidate table waits for ED-03, because only autosave makes the saved draft the unsaved state.

**Acceptance.**
- [ ] With drafts on both home and a campaign, editing the campaign shows the live home page.
- [ ] The saved draft of every document type can be previewed.
- [ ] Two editor tabs in one browser each preview their own document. The preview says when another tab's draft is also shown (section 8.8).
- [ ] Negative: a founder with an unpublished palette is told when the preview is not showing it.
- [ ] Negative: a shopper with no valid cookie can never read a draft.
- [ ] Negative: a token from one tenant is refused on another.

**Evidence.** `lib/content/resolve.js:47-60`, `lib/cms/candidates.js:20-29`, `lib/releases.js:486-498`, `app/api/preview/route.js:46-52`, `components/admin/cms/SurfaceDesigner.js:319`.

#### PV-04 · P1 · The preview session renews itself

**Behaviour.** While the editor is open, the session renews before it expires, without a visible interruption.

**Acceptance.**
- [ ] A tab left open for over an hour still previews drafts.
- [ ] Negative: an expired token never silently shows live content as if it were the draft. Today a reload does exactly that, stuck at "Connecting".

**Evidence.** `lib/releases.js:457`, `components/admin/cms/Designer.js:253`, `components/admin/cms/Designer.js:905`, `app/(storefront)/layout.js:252`.

#### PV-05 · P1 · Faster than a full reload

**Behaviour.** Three tiers. Text and token changes patch the frame directly. Structural changes use a soft refresh without a document reload. A full reload is the fallback. Today each edit causes a full page load, and Save causes two. Targets are hypotheses until measured on a hosted store (OQ-19).

**Acceptance.**
- [ ] A text change appears in under 150ms (hypothesis).
- [ ] A section add or move appears in under 1.5 seconds on a hosted store (hypothesis).
- [ ] Scroll position stays where it was.
- [ ] Negative: patched content matches what a full render would give. A test compares both.
- [ ] Negative: no editor code reaches the public shopper bundle.

**Evidence.** `components/preview/PreviewBridge.js:66`, `components/admin/cms/Designer.js:276-297`, `components/admin/cms/Designer.js:306`, `components/admin/cms/Designer.js:415`, `docs/cms-reviews/S59-live-preview.md:64`.

#### PV-06 · P1 · Preview a real product or collection

**Behaviour.** Layout documents preview against a real product or collection the founder picks, including sold-out and long-title examples. The existing context picker is reused.

**Acceptance.**
- [ ] Switching product context keeps unsaved layout edits.
- [ ] Negative: an empty catalog shows a clear message, not a crash.

**Evidence.** `components/admin/cms/SurfaceDesigner.js:68-69`.

#### PV-07 · P1 · A clean preview frame

**Behaviour.** Header and footer are selectable. All navigation in edit mode is blocked. Selection and scroll are restored. Consent banner, pixels and experiment exposure pings are off in preview.

**Acceptance.**
- [ ] A click in the header selects the header document.
- [ ] Negative: a preview view records no analytics event and no experiment exposure.

**Evidence.** `app/(storefront)/layout.js:254`, `app/(storefront)/layout.js:269`, `app/(storefront)/page.js:54`, `components/admin/cms/Designer.js:250`, `components/admin/cms/Designer.js:306`.

#### PV-08 · P1 · Experiments do not hide what you are editing

**Behaviour.** Running experiments are inert in preview, with a visible notice that one is running on this section.

**Acceptance.**
- [ ] A title edit always appears in preview, even while a hero test runs.
- [ ] Negative: preview never counts as an exposure.

**Evidence.** `app/(storefront)/page.js:43-44`, `lib/experiments.js:312-318`.

#### PV-09 · P1 · Empty sections explain themselves

**Behaviour.** A section with no data shows the founder why in preview, such as "This collection has no products". Shoppers see nothing.

**Acceptance.**
- [ ] A rail bound to an empty collection explains itself in preview.
- [ ] Negative: shoppers never see the explanation.

**Evidence.** `components/sections/HomeSections.js:20`, `components/sections/HomeSections.js:116`.

---

### 7.5 Authoring: rich text, drag-and-drop and friendly validation (AU)

#### AU-01 · P0 · A real rich text editor

**Behaviour.** A rich text editor replaces all 7 raw HTML inputs across 6 surfaces. It stores sanitized HTML, the same format existing rows hold, so no format migration is needed and the storefront renderer stays as is. It offers only what the sanitizer allows. Links use the link picker. The editor ships in the console bundle only. Server-side sanitizing remains the guarantee. **Recommendation:** Tiptap. Check its React 19 compatibility and bundle size before committing. No rich text dependency is installed today.

**Acceptance.**
- [ ] A founder can bold, list, link and head text without seeing a tag.
- [ ] Existing HTML content opens and round-trips with no visible change.
- [ ] A round trip produces the same sanitized HTML, and the editor and storefront share the same `.rte` styles.
- [ ] Negative: pasted Word or web content is cleaned, and any script is removed on the server.
- [ ] Negative: no client-only sanitizing path exists.

**Evidence.** `components/admin/cms/Designer.js:701`, `components/admin/cms/HomeEditor.js:567`, `components/admin/cms/PageEditor.js:470`, `components/admin/cms/PageEditor.js:525`, `components/admin/cms/PdpExtrasEditor.js:171`, `components/admin/CatalogAdmin.js:206`, `components/admin/cms/SurfaceDesigner.js:445`, `lib/sanitize.js:13-24`, `package.json:81`.

#### AU-02 · P0 · Problems shown in plain words, next to the field

**Behaviour.** Each issue from DOC-04 appears beside its field in plain words, with a link from the Publish panel. A red border with no message is not allowed. When the highlight no longer matches the title, the field shows a plain note. This is the interim fix for the highlight until AU-03 removes the mismatch.

**Acceptance.**
- [ ] Every registry validation rule has a plain message, checked by test.
- [ ] Publish errors deep-link to the field.
- [ ] Editing a hero title so the highlight stops matching shows a note on the field.
- [ ] Negative: no message uses the words "CTA", "href", "handle" or "slug".

**Evidence.** `components/admin/cms/Designer.js:560`, `components/admin/cms/Designer.js:795`, `components/admin/ReleasesAdmin.js:143`, `lib/releases.js:158`, `app/(storefront)/page.js:19-29`.

#### AU-03 · P1 · A highlight that cannot stop matching

**Behaviour.** The founder selects words in the title to highlight. The stored form makes a mismatch impossible, because the accent is a range or mark inside the title text, not a separate string. **The reported bug is not a validation bug, so this is not a validator fix.** Today a mismatch passes validation and the accent silently vanishes. PV-01 and PV-02 fix the reported failure, and AU-02's note covers the highlight until this ships, so the visible damage is a lost accent.

**Acceptance.**
- [ ] Editing a highlighted title keeps the same word range if those words remain. Otherwise it clears the highlight, with a visible note.
- [ ] Migrating `title` and `highlight` renders identically, including titles where the old highlight did not match.
- [ ] Negative: no stored state can hold a highlight that is not in the title, including experiment, AI and kit payloads after DOC-02's adapter.

**Evidence.** `lib/cms/validate.js:24-42`, `app/(storefront)/page.js:19-29`, `docs/cms-reviews/S59-live-preview.md:53-54`. Ran: `validateBlock("hero", {title:"New title", highlight:"old words"})` returns `ok:true`.

#### AU-04 · P0 · Added sections start good

**Behaviour.** Adding any section gives a complete, good-looking section. It uses real catalog data where possible, or clearly marked starter text and an incomplete state otherwise. Registry defaults must pass their own rules, or be marked as a known incomplete state.

**Acceptance.**
- [ ] Each of the section types can be added and shown in preview with no error.
- [ ] A product rail added to a store with collections picks a real one.
- [ ] Negative: adding a section never freezes the preview. Today 4 of 6 home kinds do.

**Evidence.** Ran: banner, rich_text, image_with_text and product_rail fail validation with registry defaults. `components/admin/cms/Designer.js:502-509`, `lib/cms/registry.js:70-114`.

#### AU-05 · P0 · Fix the page editor data loss

**Addition.** A confirmed data-loss bug. It should be fixed regardless of the rebuild, and it can ship independently.

**Behaviour.** A text section with paragraphs but no heading is treated as empty, dropped from the save payload, and the form then marks itself clean. On reload the paragraphs are gone. It must stop. The client fix alone would turn this into a 422, because the server also refuses a text section with no heading. So the server rule relaxes: a text section needs a heading or at least one paragraph. `components/ContentPage.js` renders the heading only when there is one.

**Acceptance.**
- [ ] A text section with paragraphs and no heading survives save and reload, and renders with no empty heading tag.
- [ ] Negative: a text section with neither heading nor paragraphs is refused with a plain message.
- [ ] Negative: no save reports success while dropping founder content.

**Evidence.** `components/admin/cms/PageEditor.js:68-69`, `components/admin/cms/PageEditor.js:239`, `components/admin/cms/PageEditor.js:260`, `lib/cms/store.js:315`, `components/ContentPage.js:49-50`.

#### AU-06 · P1 · Never change content silently, and fix what can be fixed

**Behaviour.** Fields show character counters from registry limits, and over-limit text is flagged rather than cut. The editor fixes what it safely can and says so: a missing slash on a link, spaces in a URL, a stray domain matching the store. HTML the sanitizer removes produces a notice.

**Acceptance.**
- [ ] A 150-character title is flagged, not cut to 120 as it is today.
- [ ] Each automatic fix is shown and can be reversed.
- [ ] Negative: no automatic fix changes a founder's words.

**Evidence.** `lib/cms/validate.js:7`, `lib/cms/validate.js:25`, `lib/cms/validate.js:31`, `lib/cms/validate.js:60`, `lib/cms/validate.js:114`.

#### AU-07 · P1 · Drag and drop in the tree

**Behaviour.** Sections and blocks can be dragged in the tree. Keyboard move stays, reusing the existing focus handling. Touch works. Arrow controls stay in place, which is why this is not P0. **Recommendation:** `@dnd-kit`, after a React 19 check. No drag dependency is installed today.

**Acceptance.**
- [ ] Reordering works by mouse, touch and keyboard, and survives reload.
- [ ] Negative: a protected module cannot be dragged out of its allowed area.

**Evidence.** `components/admin/cms/Designer.js:488`, `components/admin/cms/Designer.js:584`, `components/admin/cms/Designer.js:627`.

#### AU-08 · P1 · The same sortable list everywhere

**Behaviour.** One sortable primitive replaces arrows, comma text and textarea lines across menus, accordions, product modules, FAQ items, collection pins, upsell targets, bundle items and quiz questions.

**Acceptance.**
- [ ] Each listed list reorders with the same control.
- [ ] Negative: no list requires editing comma-separated text.

**Evidence.** `components/admin/CatalogAdmin.js:323`, `components/admin/UpsellsAdmin.js:175`, `components/admin/cms/PageEditor.js:509`, `components/admin/cms/NavigationEditor.js:229`.

---

### 7.6 Design tokens and composition guardrails (TOK)

#### TOK-01 · P0 · The storefront actually uses the tokens

**Addition.** The brainstorm assumed strong tokens exist. They do not yet apply. Decision 4 cannot hold until this sweep is done, and every tone, palette and dark option depends on it.

**Behaviour.** First define the semantic roles and their CSS variables: surface, muted surface, text, muted text, border, accent, text on accent, sale, success, danger. Today only accent, header, hero, background, foreground and radius tokens exist, so classes such as `text-zinc-500` have no role to map to. Then replace hard-coded colours, radii and literal sizes in storefront components with these tokens. Include the rich text styles, which link in lime on every tenant today. Protected surfaces (cart, checkout) are included, for colour and shape only.

**Acceptance.**
- [ ] A lint-style test fails on hard-coded colour classes in storefront components, with a written, short allowlist.
- [ ] With the default look, the store is visually unchanged, checked by screenshots taken before the sweep starts.
- [ ] Shared exit check with TOK-02: two test themes, one light and one dark, render home, product, collection, cart and checkout with every text and background pair readable.
- [ ] Negative: no shopper-facing text renders under 4.5:1 in either test theme.

**Evidence.** `app/globals.css:58-71`, `app/globals.css:93`, `app/globals.css:127`, `components/ProductCard.js:59`, `components/Footer.js:83`, `components/cart/CartDrawer.js:34`, `components/checkout/CheckoutFlow.js:247`. Counted at about 630 to 700 hard-coded colour classes, depending on which files are counted.

#### TOK-02 · P0 · A full pairing check

**Behaviour.** Replace the single foreground-on-background check with a matrix of every role pair the renderers use. At save it returns warnings with a nearest-passing suggestion, so autosave never fails midway through a custom colour. Blocking happens at publish, and only for changed tokens (PUB-03).

**Acceptance.**
- [ ] Each role pair used by a renderer is listed and tested.
- [ ] Hero and header token pairs are included. Today they are unchecked.
- [ ] Negative: publishing a dark background with dark product titles is refused. Today it passes at 1.12:1.
- [ ] Negative: publishing a black accent that gives a 2.08:1 hero highlight is refused or corrected. Today it gets no warning.

**Evidence.** `lib/brand.js:136-142`, `app/(storefront)/page.js:25`, `app/(storefront)/page.js:59`, `components/sections/HomeSections.js:25`. Contrast figures from a run of the brand functions.

#### TOK-03 · P0 · Brand and theme become one design document

**Behaviour.** Brand and theme move from the control-plane tenant config into a design document in the tenant database. Otherwise one document spans two databases with no atomic write. The design document gets drafts, revisions, Publish and Undo like everything else, and it holds the logo (GEN-04). All readers move: layout, maintenance page, web manifest, offline route, console brand and theme pages, kit apply, agency export, setup checklist, help. Operator fleet screens iterate tenants without opening their databases, so after a design publish the service writes a display-only `config.theme_pin = {kit, version}` to the control plane, best effort, for those screens. It is never read for rendering.

Publishing a palette is checked only against the design document, so a new palette can change live sections elsewhere. The design Publish panel lists the live sections that will change as a result, and an invalid tone falls back to default at render (TOK-05).

**Acceptance.**
- [ ] Publishing and undoing design works like any other document.
- [ ] The published version is seeded from the live release's brand, and the draft from tenant config, since these can differ.
- [ ] A guard test finds no `config.brand` or `config.theme` read outside the allowlisted operator display.
- [ ] Negative: two admins saving design at once get a 409. Today the last one silently wins.
- [ ] Negative: the maintenance page, manifest and offline route all render the published design.

**Evidence.** `app/api/admin/brand/route.js:47-54`, `lib/platform/control.js:173-187`, `lib/releases.js:131-132`, `app/manifest.webmanifest/route.js:15`, `app/(storefront)/offline/route.js:17`, `app/(console)/admin/(authed)/brand/page.js:19`, `app/(console)/admin/(authed)/theme/page.js:21`, `lib/themes/kits.js:117`, `lib/platform/agency.js:271`, `lib/admin/onboarding.js:53`, `app/api/admin/help/route.js:37`, `app/api/platform/themes/route.js:21`, `app/api/platform/overview/route.js:60`, `app/api/platform/tenants/[id]/route.js:55`, `components/platform/TenantDetail.js:55`, `scripts/test-themes.js:103-115`.

#### TOK-04 · P1 · Curated palettes first

**Behaviour.** Founders choose from the curated palettes (GEN-04 ships the first set) plus one accent. Custom colours are an advanced option, with automatic correction through TOK-02.

**Acceptance.**
- [ ] Every curated palette passes the full matrix, by test.
- [ ] Negative: no palette can produce a failing pair.

**Evidence.** `components/admin/BrandAdmin.js:31`, `lib/brand.js:12-28`.

#### TOK-05 · P1 · Section tones

**Behaviour.** Each section can choose a tone: default, muted, accent or inverted. Tones are computed from the palette, and offered only when valid for it. Adjacent sections cannot both use accent or inverted tones. The editor shows a plain note and a one-click change. The banner's fixed colour goes.

**Acceptance.**
- [ ] A section's tone recolours its heading, text, links and buttons together.
- [ ] Negative: an invalid tone for the current palette is not offered.
- [ ] Negative: changing palette re-checks saved tones and flags any that fail. A tone that fails on a live page renders as default.
- [ ] Negative: two adjacent accent or inverted sections get the note.

**Evidence.** `lib/cms/registry.js:40`, `components/sections/HomeSections.js:52`.

#### TOK-06 · P1 · A real type system

**Behaviour.** Approved font pairings replace the two hard-loaded fonts. A heading and body scale replaces today's scale, which only affects text with no explicit size. Fonts load efficiently and never block text.

**Acceptance.**
- [ ] Changing the type setting visibly changes headings, body and product titles.
- [ ] Negative: no font outside the approved list can be set.

**Evidence.** `app/globals.css:82`, `app/(storefront)/layout.js:27`, `lib/themes/kits.js:27`.

#### TOK-07 · P1 · Spacing and container steps

**Behaviour.** Each section chooses spacing (tight, normal, roomy) and container width (narrow, normal, wide). Values are named steps from tokens, never free numbers.

**Acceptance.**
- [ ] Each step visibly changes every section type.
- [ ] Negative: no free numeric spacing input exists.

**Evidence.** `lib/brand.js:28`, `app/(storefront)/page.js:58`, `components/sections/HomeSections.js:22`.

#### TOK-08 · P1 · Controls do what they say

**Behaviour.** Each token has a written scope, and a test proves it reaches that scope. Today "Button shape" does not touch Add to cart, and applying a look with brand silently resets two settings.

| Token | Must reach |
|---|---|
| Button shape | All shopper-facing buttons, including Add to cart and checkout |
| Radius | Cards, inputs, images |
| Spacing | Every section type |
| Type | Headings, body, product titles, prices |

**Acceptance.**
- [ ] Each table row has a rendered test.
- [ ] Negative: applying a look never silently resets a setting the founder chose.

**Evidence.** `components/ProductPurchase.js:180`, `components/admin/BrandAdmin.js:206`, `lib/themes/kits.js:35`, `lib/themes/kits.js:105`, `lib/platform/control.js:185`.

#### TOK-09 · P1 · Image and text guardrails

**Behaviour.** Image settings offer named aspect ratios and a focal point, and renderers output width and height. Text fields have soft limits with a "may wrap awkwardly" note, on top of the hard limits. Alt text defaults from the product title, the section heading or the store name, and missing alt is a warning, never a block.

**Acceptance.**
- [ ] An image of any shape renders inside its chosen ratio with no layout shift.
- [ ] A 120-character hero title triggers a note.
- [ ] Negative: a missing alt text does not block publish, and the image still has a default alt.

**Evidence.** `components/sections/HomeSections.js:79`, `app/(storefront)/page.js:63`.

#### TOK-10 · P1 · Try a look before applying it

**Behaviour.** Tokens patch the preview live. A look can be tried and reverted without saving. Applying it edits the draft, and Publish still decides.

**Acceptance.**
- [ ] Trying a look changes the preview only.
- [ ] A failing colour shows its reason at once, not only at Save. Today the error is ignored until Save.
- [ ] Negative: try and revert leaves the draft byte-identical.

**Evidence.** `app/api/admin/brand/route.js:36`, `components/admin/BrandAdmin.js:81-85`, `components/admin/ThemeAdmin.js:40`, `components/admin/ThemeAdmin.js:77`.

---

### 7.7 Section and block tree, per-device settings, bindings (TREE)

#### TREE-01 · P0 · Bindings are a table, and an unknown source is an error

**Behaviour.** Each binding source is declared with its arguments and its resolver. Commerce blocks register here. Today an unknown source silently returns collections. That silent fallthrough goes. Identical queries stay batched, and data still resolves per section instance. Prices and stock are never stored in a document.

**Acceptance.**
- [ ] Adding a source needs one declaration, and a test proves it.
- [ ] Two instances of a section resolve independently, with identical queries batched.
- [ ] Negative: an unknown source fails the registry test, and at runtime renders nothing and logs. It never returns collections.
- [ ] Negative: no version body holds a price or stock value, by test.

**Evidence.** `lib/cms/section-data.js:21-61`, `lib/cms/section-data.js:42`.

#### TREE-02 · P1 · Nested blocks

**Behaviour.** Sections can hold blocks. Depth is two levels: section, then block. Each section type declares allowed blocks and limits. Block ids use the same rules as section ids: unique across the document, deterministic on upgrade, fresh on duplicate. Existing `sec_` ids stay valid.

**Acceptance.**
- [ ] A section can hold, reorder and duplicate its blocks.
- [ ] Duplicating a section gives all its blocks fresh ids.
- [ ] Diff and comparison treat id-only differences as no change.
- [ ] Negative: a block type not allowed in a section is refused with a plain message.
- [ ] Negative: a third level is refused.

**Evidence.** `lib/cms/registry.js:14-33`, `lib/cms/schemas.js:23-26`, `lib/releases.js:226-238`.

#### TREE-03 · P1 · A starter block library

**Behaviour.** Starter blocks: heading, text, button, image, badge, product card, collection card, FAQ item. Once nesting ships, the commerce sections in COM may also be allowed as nested blocks, with no migration. The list stays small enough to finish.

**Acceptance.**
- [ ] Each block has a renderer, defaults, a placeholder and tests from the registry.
- [ ] Negative: no block accepts free CSS or raw HTML outside the rich text field.

**Evidence.** `lib/cms/registry.js:40-171`.

#### TREE-04 · P1 · Per-device settings

**Behaviour.** Settings the registry marks as responsive can hold a mobile value that differs from the base value. This is done in CSS, with no device detection on the server. Inherited and customized values look different, and a value can be reset to inherit.

**Acceptance.**
- [ ] Changing a mobile value shows in the Mobile preview only.
- [ ] Negative: no layout shift between server output and client.
- [ ] Negative: a setting not marked responsive offers no mobile value.

**Evidence.** `components/admin/cms/Designer.js:71`, `lib/cms/registry.js:40`.

#### TREE-05 · P1 · Show or hide by device

**Behaviour.** Every section and block can be hidden on mobile or on desktop. Hiding on both devices becomes the normal Hide, so a section can never be invisible with no note.

**Acceptance.**
- [ ] A section hidden on mobile does not appear there, and still appears on desktop.
- [ ] Hiding a section on both devices shows it as hidden in the tree.
- [ ] Negative: a required protected module offers no hide option.

**Evidence.** `lib/cms/registry.js:40`.

#### TREE-06 · P1 · A separate mobile image

**Behaviour.** Image settings can hold a different image for mobile, delivered with a `picture` element. Only the image for the current width is downloaded.

**Acceptance.**
- [ ] A phone-width view downloads only the mobile image.
- [ ] Negative: with no mobile image set, the desktop image is used.

**Evidence.** `components/sections/HomeSections.js:79-84`.

#### TREE-07 · P1 · Limits that keep documents sane

**Addition.** Today 500 sections pass validation. There is no cap.

**Behaviour.** Each document type has a limit on sections, and each section on blocks, in the registry. Start at 15 sections for home and 40 for other documents as hypotheses, and check them against real tenants before enforcing.

**Acceptance.**
- [ ] Going over the limit gives a plain message at add time.
- [ ] Negative: existing content over the limit still renders and can be edited down.

**Evidence.** Ran: `validateBlock("home_sections", ...)` with 500 sections returned `ok:true`.

---

### 7.8 Composable surfaces with protected commerce modules (SURF)

#### SURF-01 · P1 · Protected modules stay protected

**Behaviour.** Purchase box, cart lines, totals, checkout, payment, identity, consent and order access are protected. The registry marks a module as protected and states where it is required. Founders cannot delete, duplicate or configure the money or identity logic inside them. Composition never reaches price calculation or payment. Before SURF-03 there is nothing composable around these modules, so they stay protected by not being editable. **This ships with or before SURF-03, never after it.**

**Acceptance.**
- [ ] A required module cannot be removed through the editor or the API.
- [ ] A product layout without a purchase box cannot be published.
- [ ] The existing add-to-cart, availability, totals, consent and account access tests pass after every surface change.
- [ ] Negative: no block can change a cart total, a discount calculation or a payment path.
- [ ] Negative: no setting on a protected module accepts rich text or a link into the checkout flow.

**Evidence.** `components/pdp/PdpLayouts.js:8-14`, `components/pdp/PdpLayouts.js:85-155`, `lib/cart.js:111-115`, `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md:127`.

#### SURF-02 · P1 · The surface contract is written down and in code

**Behaviour.** Each shopper surface has one class, held in the registry and used by the editor.

| Surface | Today | Target |
|---|---|---|
| Home | Fixed hero plus sections | Composable |
| Product page | Layout choice only | Composable around the purchase box |
| Collection page | Layout choice only | Composable around the grid and filters |
| Collections index | Fixed, curation only | Composable |
| Campaign, about, general pages | Narrow page kinds | Composable |
| Contact | Page kinds plus form | Composable around the protected form |
| Journal article | Shared renderer | Composable |
| Policies | Shared renderer | Simple document, rich text |
| Header, footer, announcement | Layout choice, settings | Settings and layout choice |
| Search, bundle, quiz, wishlist, journal index | Fixed | Template choice with approved modules |
| Cart drawer | Protected, one upsell slot | Protected with approved slots |
| Checkout, confirmation, order, account pages | Protected | Protected. Tokens and copy only. |
| 404, error, offline, maintenance | Fixed | Copy control only |
| Platform marketing pages | Platform-owned | Out of scope |

**Acceptance.**
- [ ] The editor shows the right controls for each class, driven by the contract.
- [ ] Negative: a surface with no class fails a test.

**Evidence.** `app/(storefront)/layout.js:266`, `components/ContentPage.js:9-61`, `lib/cms/defaults.js:45-51`. Audit delivery tiers at `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md:131-151`.

#### SURF-03 · P1 · Composable product page

**Behaviour.** The product layout is a document. Gallery, purchase box, details, accordions and pairs are modules that can be arranged around the purchase box. Sections can go above and below, up to the layout's `maxBeforeProtected` limit above it. Today's Classic and Editorial layouts become seeded starting documents. The purchase box is already one clean component, which helps.

Layout and product content are separate documents shown on one screen, so the editor states the scope at all times: "Changes here show on all 120 products using this layout", or "Changes here show on Whey Protein only".

**Acceptance.**
- [ ] A migrated product page renders the same as before under both layouts.
- [ ] A founder can add a section below the purchase box.
- [ ] The scope line is always visible and names the count. The Publish panel for a layout names the number of products affected.
- [ ] A click in the preview on content owned by the other document switches to it with a visible note.
- [ ] Negative: going past `maxBeforeProtected` is refused with a plain message, so Add to cart stays near the top on a phone.
- [ ] Negative: price, variant selection and availability still come live from commerce, never from the document.

**Evidence.** `components/pdp/PdpLayouts.js:8-14`, `components/pdp/PdpLayouts.js:85-155`, `lib/cms/validate.js:192-206`.

#### SURF-04 · P1 · Composable collection page

**Behaviour.** The same approach, around a protected product grid with filters. Standard and Sidebar become seeded starting documents.

**Acceptance.**
- [ ] A migrated collection page renders the same as before.
- [ ] A founder can add a banner or intro above the grid.
- [ ] Negative: pagination, sort, filters and pinned order keep working.

**Evidence.** `app/(storefront)/collections/[handle]/page.js:162-193`.

#### SURF-05 · P1 · Pages and campaigns use the full library

**Behaviour.** Campaign, about, general and contact pages use the full library, including commerce blocks. Date windows stay evaluated per request. Public URLs stay. Campaigns stay noindex. UTM tags carry through every link in a campaign, not only rich text and FAQ.

**Acceptance.**
- [ ] A campaign can show a product rail and a bundle.
- [ ] All links in a campaign carry UTM parameters.
- [ ] Negative: a campaign outside its window returns 404, as it does today.
- [ ] Negative: the contact form cannot be removed from the contact page.

**Evidence.** `app/(storefront)/campaigns/[slug]/page.js:10-46`, `app/(storefront)/contact/page.js:45-64`, `lib/cms/store.js:364-378`.

#### SURF-06 · P1 · Composable collections index

**Behaviour.** The collections index becomes a composable document. Its featured, ordered and hidden curation moves into a section. Sections can be added around it.

**Acceptance.**
- [ ] A migrated index renders the same as before.
- [ ] Negative: a hidden collection stays hidden.

**Evidence.** `lib/cms/validate.js:121-155`, `app/(storefront)/collections/page.js:16`, `components/admin/cms/HomeEditor.js:587`.

#### SURF-07 · P1 · Header, footer and announcement as full documents

**Behaviour.** Each is its own document, so a menu fix does not ship a half-done footer. Automatic and custom menu modes stay. Layout choices move into these documents. The block `surface_templates` retires for new content. ED-12 gives the plain form that cutover needs. This requirement is the finished editor, with menu drag and drop and layout previews. The logo is GEN-04.

**Acceptance.**
- [ ] `null`, empty list and absent menu values each keep their meaning through migration: derive from catalog, explicitly empty, and code default.
- [ ] A menu change can be previewed and published on its own.
- [ ] Negative: a footer draft does not ship with a header publish.

**Evidence.** `lib/cms/validate.js:208-239`, `components/Header.js:41-46`, `components/admin/cms/NavigationEditor.js:182`, `lib/cms/defaults.js:45-51`.

#### SURF-08 · P1 · A different layout for one product or collection

**Behaviour.** A product or collection can pick a named layout on its own content document. Otherwise it uses the default layout. The `products` and `collections` maps inside `surface_templates` move onto each entity at backfill (MIG-01), so two products no longer contend as one document.

**Acceptance.**
- [ ] Existing per-entity assignments migrate with no visible change.
- [ ] Negative: deleting a layout that is in use is refused, and the message lists where it is used.

**Evidence.** `lib/cms/validate.js:157-190`, `lib/cms/defaults.js:53-69`.

#### SURF-09 · P1 · Cart drawer slots and editable copy

**Behaviour.** The cart drawer stays protected and gains approved slots: upsell and progress. All its fixed strings become editable or neutral, including "Add some gains" and "prices incl. GST".

**Acceptance.**
- [ ] Each slot can be turned on and off.
- [ ] Negative: slots cannot change lines, totals or actions.
- [ ] Negative: tax wording does not assert anything the store has not set.

**Evidence.** `components/cart/CartDrawer.js:158`, `components/cart/CartDrawer.js:339-343`, `components/cart/CartDrawer.js:366`.

#### SURF-10 · P2 · Template choices for search, bundle, quiz, wishlist and journal index

**Behaviour.** At least two materially different layouts each, around their protected logic.

**Acceptance.**
- [ ] Each choice renders with real data and passes its existing tests.
- [ ] Negative: choosing a template cannot change search, quiz or bundle logic.

**Evidence.** `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md:141-145`.

#### SURF-11 · P2 · Copy control for error pages

**Behaviour.** 404, error, offline and maintenance pages have editable copy. Correct status codes stay.

**Acceptance.**
- [ ] Each page shows edited copy.
- [ ] Negative: a 404 still returns 404.

**Evidence.** `app/(storefront)/error.js:22`.

#### SURF-12 · P1 · Fix the false /cart link

**Addition.** A small verified defect that breaks the promise of friendly publish checks.

**Behaviour.** There is no `/cart` route, but the link checker accepts it, so a `/cart` link passes publish and then 404s. Either add a cart page or refuse the link.

**Acceptance.**
- [ ] A `/cart` link either works or is refused with a plain message.
- [ ] Negative: a `/cart` link never passes publish and then returns 404, by test.

**Evidence.** `lib/releases.js:145`, `app/(storefront)/layout.js:266`.

---

### 7.9 Commerce blocks (COM)

**Rule for this whole workstream.** Money rules stay live. Content about them is versioned. A block holds a reference to an offer, bundle or quiz. It resolves the current state at render and never computes money. See OQ-03. In this build, commerce blocks are top-level section kinds, so they do not wait for nesting (TREE-02). "Block" in this workstream means that.

#### COM-01 · P0 · One contract for binding and state

**Behaviour.** Each commerce block binds to a record by id. Each declares what happens in every state. Shoppers get a safe result, and the founder gets a reason in preview. Publish warns about disabled, expired or missing bindings, with one-click "Remove it" (PUB-03). It does not block, because a founder may be scheduling ahead. The table is the contract for each block as it ships. At P0 that means bundle card and grid.

| Block | Disabled or not started | Expired or missing | Sold out | No results |
|---|---|---|---|---|
| Offer callout | Hidden | Hidden | Hidden if the target is gone | Hidden |
| Bundle card or grid | Hidden | Hidden, publish warning | Shown, "Currently unavailable", add disabled | Grid hides itself |
| Quiz | Hidden, publish warning | Hidden | Results filter sold-out products | Existing browse-all fallback |
| Recommendations | Not applicable | Falls to next source | Filtered out | Hidden |
| Upsell slot | Hidden | Hidden | Filtered out | Hidden |

**Acceptance.**
- [ ] Each table cell for the bundle card and grid has a rendered test. Each later block adds its row's tests when it ships.
- [ ] A founder sees the reason in preview for every hidden state.
- [ ] Negative: no block runs pricing logic. A test checks that they do not import the offer engine's pricing functions.
- [ ] Negative: a block bound to a deleted record does not throw.

**Evidence.** `lib/offers/store.js:4-6`, `lib/bundles.js:40-52`, `app/(storefront)/bundles/[slug]/page.js:49-52`, `lib/cart.js:111-115`.

#### COM-02 · P0 · Bundle card and bundle grid sections

**Behaviour.** Bundle card and bundle grid are top-level section kinds in this build. A founder picks a bundle from a list and places it on any composable page. The block shows items, saving, and an add button through the existing cart path. Sold-out handling reuses today's honest states. The price and saving come from the server. A founder can create a bundle inline from the picker, giving only a name, products from VariantPicker and a price. The slug is derived, and the typed handle-or-GID input is removed.

**Acceptance.**
- [ ] Putting a bundle on the home page takes a pick, not a typed link.
- [ ] Inline create asks only for name, products and price.
- [ ] Adding from the block produces the same cart as the bundle page.
- [ ] A grid of bundles resolves with bounded queries, not per-component queries per bundle.
- [ ] Negative: a sold-out component disables add and says so.
- [ ] Negative: a disabled bundle disappears for shoppers.

**Evidence.** `lib/bundles.js:166-178`, `components/BundleAddButton.js:13-20`, `app/(storefront)/bundles/[slug]/page.js:74-76`, `components/admin/CommercePanels.js:153-175`, `components/admin/CommercePanels.js:261`.

#### COM-03 · P0 · Start an offer in plain words, safely

**Behaviour.** The offer form uses pickers and plain words. No raw target kinds, no pasted GIDs. Founders pick products or collections, then see a plain sentence such as "Buy 2 of Whey, get 1 free". The real simulator shows the result on the store's own products. Offers stay live on save (OQ-03), so the riskiest action a founder takes needs its own safety:

- The primary button reads "Start offer" or "Update live offer", and sits below the sentence and simulator result.
- Editing a live offer shows the old and new sentences side by side.
- The last previous config is kept per offer, with "Go back to previous offer settings". "Turn off" is always visible.
- A form-level warning, not a validator change, appears for more than 50% off, or a free item worth more than a threshold.
- Offer changes appear in "Recently published" (PUB-04).

**Acceptance.**
- [ ] Each of the four offer types can be created without typing an identifier.
- [ ] The sentence matches the simulator's result.
- [ ] Simulator examples use this store's products, not "Sim Whey".
- [ ] "Go back to previous offer settings" restores the last config and is live on the next cart read.
- [ ] Negative: validation and engine behaviour are unchanged, proved by `test-offers` and `test-offers-admin`.
- [ ] Negative: money messages do not hard-code the rupee sign where the store's currency differs.

**Evidence.** `components/admin/OfferForm.js:15-16`, `components/admin/OfferForm.js:30`, `components/admin/OfferForm.js:172`, `components/admin/OfferForm.js:232`, `components/admin/OffersAdmin.js:18-20`, `lib/offers/simulate.js:14-36`, `lib/offers/engine.js:138`.

#### COM-04 · P1 · Offer callout and coupon reveal

**Behaviour.** New blocks show relevant offers on product pages and elsewhere. They use a read-only "offers relevant to this product" query, built on the existing target matching. A card badge is optional.

**Acceptance.**
- [ ] A product targeted by an offer shows the callout.
- [ ] A coupon reveal copies the code.
- [ ] Negative: the callout never states a discount different from what the cart applies, proved by a test using the real engine on the same fixture.

**Evidence.** `lib/cart.js:114`, `lib/offers/simulate.js:72`, `components/ProductCard.js:46-50`.

#### COM-05 · P1 · Free gift and free shipping progress

**Behaviour.** A progress slot in the cart and a block for pages. Today the only nudge is for free shipping.

**Acceptance.**
- [ ] Progress updates as the cart changes.
- [ ] Negative: progress hides when the gift is unavailable (COM-06).

**Evidence.** `components/cart/CartDrawer.js:339-343`, `lib/offers/engine.js:189-204`.

#### COM-06 · P1 · A free gift that is sold out

**Addition.** A pre-existing money-adjacent defect: the engine grants a gift with no stock check, and the order writes it as a line.

**Behaviour.** Define and implement what happens: no gift is granted and nothing is promised. The founder is told. This changes engine behaviour, so the owner confirms the rule (OQ-23).

**Acceptance.**
- [ ] A cart past the threshold with a sold-out gift gets no gift line, and shows no promise.
- [ ] Negative: an in-stock gift behaves as it does today, by `test-offers`.

**Evidence.** `lib/offers/engine.js:189-204`, `lib/orders.js:249-262`, `lib/offers/config.js:37-44`.

#### COM-07 · P1 · Quiz block, and a better quiz

**Behaviour.** Quiz embed and quiz button blocks. Options can have images. Results can be added to cart. Tags come from a picker over the real catalog. Copy becomes friendly. Recommendation stops scanning all products in JavaScript. Scoring logic stays deterministic and protected.

**Acceptance.**
- [ ] A quiz can be placed on any composable page.
- [ ] Results can be added to the cart.
- [ ] Negative: the results page shows no raw tags and no developer-toned copy.
- [ ] Negative: email capture still needs consent.

**Evidence.** `lib/quiz.js:31-35`, `lib/quiz.js:96-113`, `components/QuizRunner.js:61-81`, `components/admin/CommercePanels.js:386`, `app/api/quiz/[slug]/route.js:25-47`.

#### COM-08 · P1 · Recommendations rail

**Behaviour.** A rail with sources: manual, same collection, bestsellers from orders. Each falls back to the next when empty.

**Acceptance.**
- [ ] Each source returns products with bounded queries.
- [ ] Negative: sold-out products are filtered.
- [ ] Negative: an empty result hides the rail.

**Evidence.** `lib/cms/placements.js:93-129`, `lib/reporting.js:208-211`.

#### COM-09 · P1 · Recommendations for returning shoppers

**Behaviour.** A per-viewer source uses signed-in order history and the merged wishlist, with consent-gated events where allowed. It loads by client fetch, so pages stay shareable. Grep finds no personalization today, so this is entirely new.

**Acceptance.**
- [ ] A signed-in returning shopper sees a product from a collection they have bought from.
- [ ] Negative: without consent or sign-in, the rail falls back to a non-personal source and stores nothing.
- [ ] Negative: one shopper's recommendations never appear for another, by test.

**Evidence.** `lib/customers.js:186-204`, `lib/wishlist.js:3-9`, `app/api/track/route.js:57-61`.

#### COM-10 · P1 · Upsell and pairs

**Behaviour.** Pairs on product pages and the cart upsell become a block and a slot. **Addition:** per-product cart rules ("if the cart contains X, offer Y"), because one global slot does not replace an upsell app. Lazy fetch stays, so the cart hot path stays clean.

**Acceptance.**
- [ ] A rule shows the right upsell for the cart's contents.
- [ ] Adding uses the normal cart path.
- [ ] Negative: an item already in the cart is not offered.
- [ ] Negative: the upsell fetch does not block cart rendering.

**Evidence.** `lib/cms/placements.js:2-5`, `lib/cms/placements.js:133-176`, `components/cart/CartDrawer.js:12-59`.

#### COM-11 · P1 · Search block and good SQL search

**Behaviour.** Decision 1 names fast search. SQL is the declared supported engine, and Typesense is optional. So search must be good with SQL alone. Add a search box block, plus pagination on results, which cap at 36 today.

**Acceptance.**
- [ ] A founder can place a search box on a page.
- [ ] Results beyond 36 can be reached.
- [ ] p95 SQL search response is under 300ms (hypothesis) on the PERF-04 fixture.
- [ ] A fixed relevance fixture of real queries returns the expected product in the top 3.
- [ ] Negative: with Typesense off, search still works, by test.
- [ ] Negative: a one-letter typo never dead-ends. It finds the product, suggests a close title, or falls to the browse-all link that exists today.

**Evidence.** `lib/repo.js:231-274`, `lib/typesense-search.js:13-29`, `app/(storefront)/search/page.js:18-26`, `app/(storefront)/search/page.js:66-75`.

#### COM-12 · P1 · Proof that a block earned money

**Behaviour.** New events for block views, clicks and adds, consent-gated like all others. A simple report per block: views, adds, orders, revenue. Founders need this evidence before cancelling an app.

**Acceptance.**
- [ ] A bundle block shows views, adds and revenue.
- [ ] The report states its coverage, as reporting already does.
- [ ] Negative: without consent, no event is stored and no identity is minted.

**Evidence.** `lib/track/names.js:5-15`, `app/api/track/route.js:57-61`, `lib/reporting.js:41-86`.

#### COM-13 · P1 · Experiments on a block

**Behaviour.** An experiment targets a section or block id with a patch of fields, starting with the hero's existing fields. Adopting becomes a draft edit through the write service. Publishing a change to a block under test warns the founder. The statistics rules stay. Experiment copy moves to founder language, and an honest time estimate is shown.

**Acceptance.**
- [ ] Adopting keeps all fields that were not in the variant.
- [ ] Negative: a publish that changes a tested block warns first.
- [ ] Negative: verdict rules stay blocked while running or under-sampled, by `test-growth`.

**Evidence.** `lib/experiments.js:26`, `lib/experiments.js:166-190`, `lib/experiments.js:219-276`, `components/admin/ExperimentsAdmin.js:117-120`, `components/admin/ExperimentsAdmin.js:227`.

#### COM-14 · P1 · Bundles worth finding

**Behaviour.** Bundles gain an image and copy, an entry in the sitemap, and view and add events. Enabled quizzes are listed in the sitemap too (default, OQ-24). Pages use the store's currency rather than hard-coded INR.

**Acceptance.**
- [ ] A bundle page shows its image.
- [ ] Negative: a disabled bundle is not in the sitemap.

**Evidence.** `lib/bundles.js:86-96`, `app/sitemap.js:32-40`, `app/(storefront)/bundles/[slug]/page.js:25`.

#### COM-15 · P2 · Shopper variant choice in bundles

**Behaviour.** A bundle component can be a product with allowed variants, so shoppers can pick a size or flavour. This needs a bundle model change. Owner rules on scope (OQ-08).

**Acceptance.**
- [ ] A shopper picks variants, and the order holds those variants.
- [ ] Negative: a variant that is not allowed cannot be added.
- [ ] Negative: existing fixed-variant bundles keep working.

**Evidence.** `lib/bundles.js:34-57`, `components/admin/CommercePanels.js:175`.

#### COM-16 · P1 · First-party reports

**Behaviour.** Add repeat rate, new versus returning, and traffic source to reporting. Today these are missing, and there is no page-view event.

**Acceptance.**
- [ ] Each metric states its consent coverage.
- [ ] Negative: no report shows personal data to staff without the existing permission.

**Evidence.** `lib/reporting.js:90-270`, `lib/track/names.js:5-15`.

#### COM-17 · P2 · Search synonyms, pins and filters

**Behaviour.** Founders can add synonyms and pin results. Results gain filters. None of this exists today.

**Acceptance.**
- [ ] A synonym changes results in both SQL and Typesense modes.
- [ ] Negative: pins never surface unavailable products above available ones without saying so.

**Evidence.** `lib/repo.js:231-274`, `app/(storefront)/search/page.js:18-26`.

---

### 7.10 Product content overlay (OVL)

#### OVL-01 · P0 · The boundary of what can differ

**Behaviour.** "Every piece of content" needs an exact line, because some Shopify values also drive money and filtering.

| Field | Who owns it | Note |
|---|---|---|
| Title | Overlay allowed | Assumption to confirm, OQ-01 |
| Description (rich and plain) | Overlay allowed | One logical field. Plain text is derived at save, so the page and SEO never disagree. |
| Gallery and lead image | Overlay allowed | One ordered list of url and alt. Images have no stable id today, so per-image overrides are not possible. |
| SEO title, SEO description, share image | Overlay allowed | New fields, OVL-08 |
| Display vendor, display type label | Overlay allowed | Display only |
| Badge, modules | Overlay | Already ours, moved into the document by OVL-07 |
| Keep variant images in cart | Overlay | Founder setting read by OVL-10 |
| Price, compare-at price, variants, inventory, availability | Shopify only | Decision 5 |
| Handle | Shopify only | Decision 6 |
| Tags, product type used for logic | Shopify only | They drive offers, quiz and filters. Logic always reads the raw value. |
| Options, variant titles | Shopify only | Variant matching uses them. |

**Acceptance.**
- [ ] The editor offers overlay controls only for allowed fields.
- [ ] Negative: an API write naming a Shopify-only field is refused.
- [ ] Negative: an empty title is refused.

**Evidence.** `lib/cart.js:75-76`, `lib/cart.js:106-107`, `lib/offers/engine.js:6-16`, `lib/quiz.js:100-106`, `lib/repo.js:212-226`, `components/ProductPurchase.js:31-38`, `lib/sync.js:111-131`. The field list awaits owner confirmation (OQ-01).

#### OVL-02 · P0 · A separate layer that sync cannot touch

**Behaviour.** Each edited product has a product content document, keyed by its Shopify id. Publishing writes one row to a live content table. Null in a column means "follow Shopify". An empty string is a real value where allowed. Sync keeps writing only the catalog tables, and the overlay needs no sync change. Edits survive product deletion and draft status. They are flagged "No longer in Shopify", and they apply again if the product returns.

**Orphans and archive.** Archiving is refused on a document with a live version, which must be unpublished first through `storefront.publish`. Archiving a product document deletes nothing and keeps the same id, and it un-archives automatically when the product returns. For an orphan, the editor shows the stored base value, disables Reset and the Shopify notice, and offers "Discard edits" (publish capability), which removes the live row and releases its draft media references.

**Acceptance.**
- [ ] A full sync and a product webhook after an edit change nothing the shopper sees for edited fields, and do change unedited fields.
- [ ] Changing a field in Shopify that was never edited appears on the storefront after sync.
- [ ] Publishing one product changes one row and creates no new release row.
- [ ] Negative: overlay values never appear in any release row (section 8.4 explains why).
- [ ] Negative: an unpublished edit never reaches shoppers.
- [ ] Negative: a product deleted and returned with the same id keeps its edits, even if its document was archived. A new id leaves them orphaned and visible as such.

**Evidence.** `lib/sync.js:93-125`, `lib/sync.js:181-187`, `lib/sync.js:290-308`, `lib/catalog-overrides.js:71-88`, `lib/releases.js:98-102`.

#### OVL-03 · P0 · One effective read, with logic staying on raw values

**Behaviour.** Today there is no central product read. All shopper-facing reads move to one edge-safe module that joins the live content table and picks the effective value. Because search, pairs and collection lists filter and sort by title in SQL, this is a SQL join, not a JavaScript merge after the query. Offer targeting, quiz scoring and facets keep reading raw values. The shape makes misuse visible: it returns `display_type` and `display_vendor`, with raw values only as `logic_type` and `logic_tags`, so a component reading `product_type` gets undefined and a test catches it.

Reads to move: product cards, product page, cart, order creation via cart, wishlist, quiz results and quiz email, bundle components, placements and pairs, search, search dropdown, card type label, product page vendor line and breadcrumb, metadata, JSON-LD including brand, view events. Console pickers search and show the effective title, using published values and not drafts, with the Shopify title as secondary text when it differs.

**Acceptance.**
- [ ] A table-based guard test: in storefront paths, only the effective module may reference `products` or `product_images`, with an explicit allowlist of queries that read no content columns (`app/sitemap.js:19`, `lib/customers.js:228`, `lib/cms/placements.js:62`). A column-name scan is not enough, because `selectAll()` and spread column constants defeat it.
- [ ] An edited title appears consistently on card, product page, cart, checkout, confirmation and order page.
- [ ] An edited display type or vendor appears on the card, search dropdown, product page and JSON-LD.
- [ ] A founder who renamed a product finds it by that name in bundle, offer and upsell pickers.
- [ ] Orders freeze the effective title the shopper saw. Past orders do not change.
- [ ] The effective join stays edge-safe, and is cheap on the cart path. Measured in PERF-04.
- [ ] A tenant that has not yet run the migration keeps working: the module falls back to a raw read on "no such table" (MIG-05).
- [ ] Negative: an edited display type never changes which offers apply or which filter a product falls under.
- [ ] Negative: a draft edit never reaches cart, search, sitemap or email.

**Evidence.** `lib/repo.js:25-85`, `lib/repo.js:171`, `lib/cart.js:56-77`, `lib/wishlist.js:25-28`, `lib/quiz.js:98-102`, `lib/bundles.js:48`, `lib/cms/placements.js:8`, `lib/cms/placements.js:75-77`, `lib/cms/placements.js:111-124`, `lib/orders.js:144`, `lib/orders.js:235-243`, `components/ProductCard.js:9`, `components/ProductCard.js:54-56`, `components/SearchBox.js:222-223`, `components/pdp/PdpLayouts.js:17-20`, `app/(storefront)/products/[handle]/page.js:63`, `app/(storefront)/products/[handle]/page.js:122`, `lib/admin/refs.js:176-212`.

#### OVL-04 · P0 · The product editor

**Behaviour.** A new editor inside the shell. Each allowed field shows its current value, with a "differs from Shopify" label when edited. If Shopify has changed an edited field since it was edited, a notice shows the new Shopify value and the choices: keep mine or use Shopify's. It never overwrites. "Reset to Shopify" works on each field, and like any edit it goes live with Publish. Price, variants and stock are shown read-only with a link to Shopify. Browsing uses the paginated catalog read, not today's 30-row route. Today's copy, "Shopify owns these", is rewritten.

A notice that shows only when the founder happens to open that product fails exactly when it matters: a corrected ingredient or size claim. So the product list has filters "Changed in Shopify since you edited" and "No longer in Shopify", and the shell shows a count.

The notice works by storing the Shopify value's hash, and the value itself, when the field is first edited, and comparing with the current raw row. The comparison runs on the product list's own read, for edited products only. No sync change is needed.

**Acceptance.**
- [ ] Every overlay field has Reset, and the "differs" label is correct after edit, reset and sync.
- [ ] A Shopify change on an edited field shows the notice, and on an unedited field does not.
- [ ] Both filters and the count are correct after a sync.
- [ ] All products are reachable in a catalog over 30.
- [ ] Negative: Shopify changing an edited field never changes the storefront. The notice and filters never change it either.
- [ ] Negative: an image URL changing only in its query string does not trigger a notice. URLs are normalized first. Needs a dev-store check, see section 14.
- [ ] Negative: shoppers never see a "differs" label.

**Evidence.** `components/admin/CatalogAdmin.js:14-15`, `components/admin/CatalogAdmin.js:169`, `app/(console)/admin/(authed)/catalog/page.js:57`, `app/api/admin/catalog/route.js:14-16`, `lib/admin/refs.js:176-212`, `lib/sync.js:115`.

#### OVL-05 · P0 · Search shows what the store shows

**Behaviour.** SQL search reads and sorts on the effective title. The Typesense index builder reads the same effective values, through one function used by full and partial indexing, so a full sync no longer restores Shopify titles. The old Shopify title stops matching (OQ-09). Partial reindexing after a publish is OVL-17.

**Acceptance.**
- [ ] After publishing a new title, search finds it in SQL mode straight away.
- [ ] Negative: a full sync does not restore the Shopify title in search.
- [ ] Negative: a draft is never indexed.

**Evidence.** `lib/sync.js:215-263`, `lib/sync.js:420`, `lib/repo.js:247-274`, `lib/typesense-search.js:13-29`.

#### OVL-06 · P0 · Orders can be matched, and reports stay whole

**Addition.** This is the concrete mitigation for the Decision 6 risk. A title edit would otherwise split one product's revenue into two report rows.

**Behaviour.** Line items gain `catalog_title` and `sku`, frozen at the time of the order on cart items, order snapshots and order items. The console order page shows "Shopify title: X, SKU: Y" when it differs from what the shopper saw, next to the existing Shopify link. Top products and AI insights group by product id and display the current title. Old orders with no `catalog_title` show as they do today.

**Acceptance.**
- [ ] An order for a retitled product shows both titles in the console.
- [ ] Renaming a product keeps one row in top products.
- [ ] Negative: past order snapshots are not rewritten.
- [ ] Negative: an overlay title is not sent in the Shopify push (SHOP-02).

**Evidence.** `lib/cart.js:130-144`, `lib/orders.js:167-170`, `lib/schema.sql:146-159`, `app/(console)/admin/(authed)/orders/[id]/page.js:102`, `lib/reporting.js:210-211`, `lib/ai/insights.js:62`, `lib/platform/agency.js:472`.

#### OVL-07 · P0 · Modules, badge, pairs and layout move into the product document

**Behaviour.** `product_overrides`, per-product pairs, and per-product layout assignment become fields on the product content document, so a product has one owner. Cutover moves this data (section 8.3), so it cannot wait: without it migrated products lose these or keep a second writer. Migration causes no visible change, and does not mark tenants as having changes. The founder edits these through ED-12 first.

**Acceptance.**
- [ ] A migrated product shows the same modules, badge and pairs.
- [ ] Negative: a version 1 release that reads these tables live still works (section 8.12).

**Evidence.** `lib/catalog-overrides.js:22-69`, `lib/cms/placements.js:31-52`, `lib/releases.js:98-119`.

#### OVL-08 · P1 · SEO fields

**Behaviour.** New overlay fields with this fallback chain: overlay SEO value, then the Shopify `seo` value if added to sync (read only), then the title and a trimmed description, which is today's only behaviour. No Shopify SEO values are synced today, so founders' existing SEO text is silently ignored.

**Acceptance.**
- [ ] Each fallback step renders correct meta tags and JSON-LD.
- [ ] Negative: no draft value appears in public metadata.

**Evidence.** `lib/shopify-admin-catalog.js:12-13`, `lib/shopify-admin-catalog.js:119-120`, `app/(storefront)/products/[handle]/page.js:20-28`, `app/(storefront)/products/[handle]/page.js:60-62`.

#### OVL-09 · P1 · Free gifts show effective content

**Behaviour.** Gift lines resolve title and image from the variant through the effective read at cart time. The title in the offer config becomes a fallback.

**Acceptance.**
- [ ] A retitled gift product shows its new title in cart and checkout.
- [ ] Negative: a gift with a missing product uses the config title and does not break the cart.

**Evidence.** `lib/offers/config.js:37-44`, `lib/offers/engine.js:191-193`, `lib/orders.js:249-256`.

#### OVL-10 · P1 · Which image the cart shows

**Behaviour.** The cart prefers a variant's image today. The rule becomes: an overlay gallery with a lead image replaces the cart thumbnail, unless the founder turns on "keep variant images" (stored as `keep_variant_images`). Otherwise variant images stay.

**Acceptance.**
- [ ] A product with an edited gallery shows the expected image in cart.
- [ ] Negative: a product with no overlay behaves exactly as today.

**Evidence.** `lib/cart.js:69`, `lib/cart.js:96-99`.

#### OVL-11 · P1 · Analytics stay joined up

**Behaviour.** Send the effective title as `item_name`, and add a stable Shopify product id parameter to all events. Default pending OQ-10. Today item ids are inconsistent through the funnel: product id on lists and product pages, variant id in cart and purchase, handle in search.

**Acceptance.**
- [ ] One product can be followed through the whole funnel using the stable id.
- [ ] Negative: existing event names and consent rules are unchanged.

**Evidence.** `app/(storefront)/products/[handle]/page.js:110-111`, `components/cart/CartContext.js:58`, `lib/events.js:374-375`, `components/analytics/SearchResults.js:20`, `lib/tracking.js:99-104`.

#### OVL-12 · P1 · The sitemap notices edits

**Behaviour.** `lastModified` is the later of the Shopify update time and the overlay publish time.

**Acceptance.**
- [ ] Publishing an overlay moves the product's date.
- [ ] Negative: a draft does not.

**Evidence.** `app/sitemap.js:48-58`, `lib/sync.js:115`.

#### OVL-13 · P1 · Overlay images are safe and tracked

**Behaviour.** Overlay image values may only be Shopify CDN URLs or `/api/media` paths. Every other URL would fail in `next/image`. Overlay images join the media reference index.

**Acceptance.**
- [ ] A media file used only in an overlay cannot be deleted without a warning.
- [ ] Negative: an arbitrary external URL is refused with a plain message.
- [ ] An overlay image at an `/api/media` URL renders through `next/image` on the edge runtime, by test.

**Evidence.** `next.config.mjs:6-11`, `lib/media.js:168-186`.

#### OVL-14 · P2 · Collection content overlay

**Behaviour.** Collection title, description and image can differ, by the same mechanism. Decision 5 names products only, so the owner rules on this (OQ-05). Rich description would be overlay-only, because only plain text is synced.

**Acceptance.**
- [ ] A retitled collection shows on index, page, nav and metadata.
- [ ] Negative: collection membership and handle stay Shopify-owned.

**Evidence.** `lib/repo.js:98-153`, `lib/shopify-admin-catalog.js:151`, `lib/shopify-admin-catalog.js:189`.

#### OVL-15 · P2 · Product URLs survive a Shopify rename

**Addition.** Decision 6 ties the URL to Shopify. A rename in Shopify 404s old product URLs today, and that hurts founder trust.

**Behaviour.** When sync sees a handle change for a product id, it records a redirect in a catalog-side table read live. It cannot go in the release list, because sync does not publish releases.

**Acceptance.**
- [ ] The old URL redirects after a rename.
- [ ] Negative: a redirect never shadows a real product.

**Evidence.** `lib/sync.js:93-125`, `lib/releases.js:120-122`, `lib/wishlist.js:51-53`.

#### OVL-16 · P2 · See every Shopify image

**Behaviour.** Lift the 10 and 12 image cap in sync, and request Shopify media ids. A founder with 15 images sees 10 today.

**Acceptance.**
- [ ] A product with 15 images syncs all of them.
- [ ] Negative: existing galleries do not reorder.

**Evidence.** `lib/shopify-admin-catalog.js:19`, `lib/shopify-admin-catalog.js:126`, `lib/shopify.js:79-80`.

#### OVL-17 · P1 · Publishing updates Typesense straight away

**Behaviour.** Publish, Undo and restore write rows to a tenant table, `search_outbox`, inside the same batch. A job updates only those products (the `after()` fast path, then the tick as backstop). It never drops and recreates the index, because that would send search to the fallback during a rebuild. Every full sync drains the outbox after import. A product that no longer exists is deleted from the index by its stored handle. The jobs queue alone is not enough here: it lives in another database, and `enqueueDurable` returns null on failure. If OQ-16 says Typesense is on for a tenant, this must ship before title overrides reach that tenant's shoppers.

**Acceptance.**
- [ ] After publishing a new title, search finds it in Typesense mode after the job.
- [ ] A queue failure after commit still converges, by test.
- [ ] The console shows "search update pending" if an outbox row is older than a stated window.
- [ ] Negative: a typo fix does not rebuild the index.

**Evidence.** `lib/platform/jobs.js:1-10`, `lib/platform/jobs.js:68-83`, `.github/workflows/jobs-tick.yml:1-6`, `lib/sync.js:228`, `lib/sync.js:234-246`, `lib/platform/worker.js:60-90`.

---

### 7.11 Shopify boundary enforcement (SHOP)

#### SHOP-01 · P0 · Allowlists turn Decision 2 into a failing test

**Behaviour.** A test scans all GraphQL documents for mutations, against this list: `draftOrderCreate`, `draftOrderComplete`, `orderCancel`, `webhookSubscriptionCreate`, `webhookSubscriptionUpdate`, `storefrontAccessTokenCreate`. Anything new fails the test. `scripts/spike-order-push.js` is a known, labelled exception. A second test checks the OAuth scope list: the allowed write scopes are exactly `write_orders` and `write_draft_orders`. The two duplicate scope lists merge into one export.

**Acceptance.**
- [ ] Adding `productUpdate` anywhere in `lib`, `app`, `components` or `scripts` fails the test.
- [ ] Adding any other `write_*` scope fails the test.
- [ ] There is one scope list in the codebase.
- [ ] Negative: a REST write to the Admin API is also caught. None exists today.

**Evidence.** `lib/shopify-push.js:155-168`, `lib/order-cancel.js:43`, `lib/platform/shopify-webhooks.js:111-121`, `lib/shopify-admin.js:105-106`, `lib/platform/oauth.js:70-78`, `scripts/shopify-oauth.js:16-24`, `scripts/spike-order-push.js:131-209`.

#### SHOP-02 · P0 · An order push cannot carry content

**Behaviour.** Line items contain only `variantId`, `quantity` and, for gifts, `appliedDiscount`. A test locks this. Today's test checks only counts and the gift discount.

**Acceptance.**
- [ ] A test with an overlaid title proves that no overlay string appears anywhere in the push payload.
- [ ] Negative: a new key on a line item fails the test.

**Evidence.** `lib/shopify-push.js:84-96`, `scripts/test-shopify-push.js:155-157`.

#### SHOP-03 · P1 · Remove the dead Shopify checkout link

**Behaviour.** `checkoutUrl` has no callers. It builds a Shopify cart link, and any future use would send shoppers to a checkout showing Shopify titles and skip the offer engine. Remove it.

**Acceptance.**
- [ ] `checkoutUrl` is gone and all tests pass.
- [ ] Negative: a grep for Shopify `cart/` checkout URLs in `lib`, `app` and `components` finds nothing.

**Evidence.** `components/cart/CartContext.js:105-110`.

#### SHOP-04 · P1 · Name every free-text route

**Behaviour.** Two routes exist for merchant-typed text to reach Shopify: the order discount's description, built from offer and bundle titles, and the staff note on order cancel. Both are order data, not content write-back, so they are consistent with Decision 2. A test and a comment document them.

**Acceptance.**
- [ ] The test lists every merchant text reaching Shopify: discount description, discount title, shipping title, note, tags, cancel staff note.
- [ ] Negative: a new free-text field fails the test.

**Evidence.** `lib/shopify-push.js:78-82`, `lib/shopify-push.js:98-129`, `lib/bundles.js:62-70`, `lib/order-cancel.js:48`, `app/api/admin/orders/[id]/route.js:45`.

#### SHOP-05 · P2 · One catalog source for new tenants

**Addition.** The Storefront source has variant and collection caps that the Admin source does not.

**Behaviour.** New tenants use Admin sync only.

**Acceptance.**
- [ ] A new tenant syncs through the Admin API.
- [ ] Negative: existing tenants are not switched without review.

**Evidence.** `lib/sync.js:47`, `lib/shopify.js:82`, `lib/shopify.js:116-119`, `lib/shopify-admin-catalog.js:52-62`.

#### SHOP-06 · P0 · The boundary test actually runs

**Addition.** Decision 2 is "enforced by test", but nothing makes the test run. The only workflow is the job tick, `package.json` has no aggregate test script, and `main` is 92 commits ahead of `origin`, so a push-triggered workflow would not run today either.

**Behaviour.** Add `pnpm test`, running all `test:*` suites. A workflow runs it on every push. Until the repo is pushed, the same command runs as a required local check before each commit.

**Acceptance.**
- [ ] A failing `test-shopify-boundary` fails the check.
- [ ] Negative: adding `productUpdate` on a branch produces a failing check.

**Evidence.** `.github/workflows/jobs-tick.yml`, `package.json:15-77`.

---

### 7.12 Metafield and metaobject binding (META)

**Nothing exists today.** No code in `lib`, `app`, `components`, `scripts` or `migrations` reads metafields. Decision 3 permits reading them. It does not require them for the five tasks, so this workstream is P1 and P2. Scope names and webhook behaviour come from general Shopify knowledge, and must be checked on a dev store (OQ-14).

#### META-01 · P1 · Sync product and collection metafields, read only

**Behaviour.** New read-only tables, written in the same sync path and included in every delete and prune path. Fetch metafields with a separate drain query, like the variant drain, rather than nesting them in the list query. First merge the two Admin field lists into one. Add the tables to export.

**Acceptance.**
- [ ] A metafield value appears after sync and after a product webhook.
- [ ] Deleting a product deletes its metafield rows.
- [ ] Negative: no code path writes a metafield to Shopify, by SHOP-01.
- [ ] Negative: a Shopify throttle does not fail the whole sync.

**Evidence.** `lib/shopify-admin-catalog.js:7-32`, `lib/shopify-admin-catalog.js:52-62`, `lib/shopify-admin-catalog.js:118-136`, `lib/sync.js:181-187`, `lib/sync.js:303-308`.

#### META-02 · P1 · Scopes and reconnect

**Behaviour.** If metafield reads need new scopes, existing tenants must reconnect. The console shows "Reconnect Shopify to use this" where needed. Webhook registration re-runs per tenant.

**Acceptance.**
- [ ] A tenant without the scope sees a plain reconnect prompt, and everything else keeps working.
- [ ] Negative: a missing scope never breaks catalog sync.

**Evidence.** `lib/platform/oauth.js:70-93`, `app/api/connect/shopify/callback/route.js:113-120`, `lib/platform/shopify-webhooks.js:82-96`.

#### META-03 · P1 · Metafields as binding sources

**Behaviour.** A registered binding source. The editor lets a founder pick from the metafield definitions found, not type a namespace and key. A missing value hides the block for shoppers, and preview explains why.

**Acceptance.**
- [ ] A text block on the product layout can show a metafield.
- [ ] Each supported value type renders safely, and rich text is sanitized.
- [ ] Negative: an unsupported type is not offered.
- [ ] Negative: a missing value renders nothing, and never renders an empty box.

**Evidence.** `lib/cms/section-data.js:35-43`, `lib/platform/shopify-webhooks.js:67-69`.

#### META-04 · P2 · Metaobjects as binding sources

**Behaviour.** The same for metaobjects, including new webhook topics.

**Acceptance.**
- [ ] A metaobject entry can fill a section.
- [ ] Negative: a deleted metaobject hides its binding, and the editor flags it.

**Evidence.** `lib/platform/oauth.js:70-78`.

---

### 7.13 First-run store generation (GEN)

#### GEN-01 · P0 · A good store from catalog and kit, with no AI needed

**Behaviour.** After a confirmed sync, a deterministic generator creates draft documents: hero from the store name and a real product image, sections from the catalog's collections and products, menus from the catalog, and footer. It works with no AI key and with a spent AI budget. It uses the document write service and fills required content, so the first publish is valid. A generated store never uses the lime default: it applies a neutral curated palette and renders a clean typographic wordmark until the founder adds a logo (GEN-04). The store stays private until first Publish (PUB-06).

**Acceptance.**
- [ ] Running it on catalogs of different shapes produces a valid, complete draft store: one product, few products, many products, all sold out, no images anywhere, very long titles.
- [ ] The result passes full publish validation.
- [ ] Running it with no `ANTHROPIC_API_KEY` works.
- [ ] Negative: no generated store uses `lib/brand.js:13`'s lime accent.
- [ ] Negative: an empty catalog produces a usable store with no developer commands and a clear next step.
- [ ] Negative: it never overwrites a document a founder has edited. Running it twice is safe.
- [ ] Negative: it invents no reviews, certifications or claims.

**Evidence.** `lib/cms/defaults.js:10-29`, `lib/brand.js:13`, `lib/schema.sql:4-66`, `lib/ai/insights.js:181-191`, `docs/CMS_CLAUDE_DIRECTION_BRIEF.md:29`.

#### GEN-02 · P0 · An honest first sync

**Behaviour.** Initial sync runs as resumable, page-sized jobs through the queue, not only in a best-effort `after()`. Queueing alone does not solve this: the worker runs inside a 60-second route, there is no sync handler, and today's sync holds the whole catalog in memory, so a big catalog is killed, re-leased and restarted from zero. Each job fetches and writes one page, stores its cursor in `sync_runs.cursor`, and enqueues the next. Prune and search indexing run only in a final step after a complete generation. Progress reads from `sync_runs`. The console shows progress, and failure with a retry. Generation runs only after a confirmed sync.

**Acceptance.**
- [ ] A founder sees progress during a first sync of a large catalog.
- [ ] A failed sync shows a plain message and a retry.
- [ ] A job killed mid-page resumes from the stored cursor, with no duplicate or pruned rows.
- [ ] Negative: generation never runs on a failed or partial sync.
- [ ] Negative: a sync over the 60-second route limit still finishes.

**Evidence.** `app/api/connect/shopify/callback/route.js:19`, `app/api/connect/shopify/callback/route.js:127-144`, `docs/onboarding.md:51-53`, `lib/platform/worker.js:60-105`, `app/api/jobs/tick/route.js:15`, `lib/platform/jobs.js:17`, `lib/sync.js:369-392`, `migrations/tenant/0002_sync_runs.sql:11`.

#### GEN-03 · P0 · No wrong-brand or developer text reaches shoppers

**Addition.** A generated store cannot look right while these strings remain.

**Behaviour.** A written inventory of shopper-visible fixed copy. Neutralize or make editable each item. Known items: "Something dropped the weights", "Catalog synced from the live Shopify store", the default tagline, "ludicrous speed", "pnpm sync", `pnpm migrate`, "Add some gains", and default shipping values shown as if the store set them. S51 and S55 found more leaks of this kind, so expect others.

**Acceptance.**
- [ ] A test fails if a banned string appears in storefront code.
- [ ] Negative: an empty catalog shows shoppers no developer command.

**Evidence.** `app/(storefront)/error.js:22`, `components/Footer.js:64`, `components/Footer.js:147`, `lib/site.js:36`, `lib/cms/defaults.js:13`, `app/(storefront)/collections/page.js:35`, `app/(storefront)/page.js:97-114`, `components/cart/CartDrawer.js:158`, `lib/shipping.js:16-20`.

#### GEN-04 · P0 · A short brand step: logo and palette

**Why P0.** Section 2 says a new store starts wrong because of its lime look and text-only logo. A generated store that keeps both does not fix that problem, and G4 expects founders to accept it. This is a judgement call: no timed task needs it, so the owner may re-rate it.

**Behaviour.** A short step asks for a logo, a palette from a small curated set, and a one-line store description. It can be skipped. The logo image and its alt text are stored in `doc_design`, and header and footer render them. Each palette passes the TOK-02 matrix.

**Acceptance.**
- [ ] Skipping it still gives a valid store with a neutral palette and a typographic wordmark.
- [ ] The answers change the generated store visibly.
- [ ] A logo image appears in header and footer at the right size.
- [ ] Negative: a logo with no alt text falls back to the store name.
- [ ] Negative: every curated palette passes TOK-02, by test.

**Evidence.** `lib/platform/provision.js:221`, `lib/site.js:33-56`, `lib/brand.js:13`, `components/Header.js:41-46`.

#### GEN-05 · P1 · AI improves the copy

**Behaviour.** AI rewrites hero and section copy from catalog facts and the brand step. It extends the existing boundary: facts from the tenant database only, the PII guard, merchant text treated as data, drafts only, validated through the registry. Handle truncated output and refusals explicitly, which today's hand-parsed JSON does not. Failure falls back to GEN-01. Model and API usage are chosen at build time against current documentation (OQ-13).

**Acceptance.**
- [ ] AI copy cites real catalog facts.
- [ ] Budget use is metered through the existing ledger.
- [ ] Negative: a refusal, truncated output or spent budget leaves the deterministic store in place, with a plain note.
- [ ] Negative: product text containing instructions does not change behaviour, by test.

**Evidence.** `lib/ai/insights.js:41-137`, `lib/ai/insights.js:141-176`, `lib/ai/insights.js:195-201`, `package.json:81-91`.

#### GEN-06 · P1 · Draft policies from real settings

**Behaviour.** Generate about, contact, shipping, returns, terms and privacy drafts, bound to real store settings, and flag them for founder review. Where the founder's own Shopify text was imported (GEN-11), that text is preferred over a template. Today's template says 7-day returns while the engine defaults to 14. **Never auto-publish legal text.** Policies are excluded from the first-publish set until reviewed, and PUB-12 says so.

**Acceptance.**
- [ ] Returns text matches the returns setting. Payment text matches configured payment methods.
- [ ] Negative: an unreviewed policy is not included in "publish all", and the founder is told why.
- [ ] Copy says these are starting points, not legal advice. Legal review of the templates is an owner action (OQ-25).

**Evidence.** `lib/content/templates.js:34-35`, `lib/content/templates.js:95`, `lib/returns.js:15`, `lib/releases.js:206-213`.

#### GEN-07 · P1 · Starter compositions

**Behaviour.** Kits grow from tokens plus a hero preset into token sets plus starter document sets. At least three different starters (hypothesis). The founder sees them as live previews built from their own catalog, and picks one. A "Start again from a starting design" action in the shell writes all current drafts as checkpoints first, and never changes what is live until Publish. Without it, the only way to start over is by hand, section by section. The scrubbed agency kit format is a useful precedent.

**Acceptance.**
- [ ] Two different starters on the same catalog differ in section order and token set, by data comparison.
- [ ] A founder can pick a starter after generation, and earlier drafts remain in "Earlier versions".
- [ ] Negative: choosing a starter never changes what shoppers see before Publish.
- [ ] Negative: every starter passes publish validation and the contrast matrix.

**Evidence.** `lib/themes/kits.js:27-67`, `lib/themes/kits.js:98-118`, `lib/platform/agency.js:225-281`.

#### GEN-08 · P1 · A founder-language setup checklist

**Behaviour.** Keep the derived-state model, and rewrite the steps for founders. Remove "operator" hints. A generated store counts as brand done. Links point to the new editor. Pointing a domain is operator-only until GEN-09 ships, so that step says honestly: "We set up your domain for you. Request it here", with a working request path and the expected turnaround.

**Acceptance.**
- [ ] Each step links to a working destination.
- [ ] Negative: no founder-facing step uses the word "operator" or asks for something the founder cannot do.

**Evidence.** `lib/admin/onboarding.js:32-108`, `lib/admin/onboarding.js:73-78`, `components/admin/SetupAdmin.js:13-17`, `components/admin/SettingsAdmin.js:160`.

#### GEN-09 · P1 · Self-serve sign-up, a shared Shopify app, and domains

**Addition, and the biggest contradiction with the direction.** "Connect Shopify and immediately get a store" assumes a founder can connect by themselves. Today they cannot. There is no sign-up, the connect route is operator-gated, each tenant has its own custom-distribution app, database creation can shell out to a CLI on the operator's machine, and pointing a domain is operator-only. This sits outside the CMS, and it may need Shopify app review. GEN-01 to GEN-08 work after an operator-driven connect, so they do not depend on this. Owner rules on timing (OQ-06).

**Behaviour.** A founder can sign up, connect Shopify through one shared app, reach the generated store, and point their own domain without an operator.

**Acceptance.**
- [ ] A new founder reaches the private generated store with no operator step.
- [ ] A founder adds a domain, sees the exact DNS record, and sees verified or not, with no operator.
- [ ] Database creation uses the API.
- [ ] Negative: one founder cannot reach another tenant's data or connect a shop already claimed.

**Evidence.** `app/api/connect/shopify/start/route.js:7-23`, `lib/platform/provision.js:23-25`, `lib/platform/provision.js:87-90`, `docs/onboarding.md:3-5`, `docs/onboarding.md:14-22`, `components/platform/PlatformAdmin.js:92-128`, `lib/admin/onboarding.js:73-78`, `components/admin/SettingsAdmin.js:160`.

#### GEN-10 · P2 · Know the bestsellers on day one

**Behaviour.** The default Admin sync has no bestseller signal, and order history is not synced. Fetch a best-selling list once at first run, through the existing read scope, for the generator's first rails.

**Acceptance.**
- [ ] A store with sales history leads with its bestsellers.
- [ ] Negative: a store with no sales still generates.

**Evidence.** `lib/shopify.js:59-103`, `lib/sync.js:47`, `lib/shopify-admin-catalog.js:7-32`.

#### GEN-11 · P1 · Bring in what the founder already wrote

**Addition.** Every founder on this path already has policies, pages and possibly a blog in Shopify. Generic returns or privacy text replacing their real text is a legal and trust risk, and retyping pages contradicts "adjust rather than start blank". A one-time read is not write-back, so Decision 2 holds.

**Behaviour.** At first run, read Shopify shop policies, pages and blog articles once, read-only, into draft documents. Add the read scopes this needs to the single scope list in SHOP-01, verified on a dev store (OQ-14). Old Shopify page, blog and policy paths redirect to the new document URLs in the first publish, so moving the domain does not lose ranked pages. The owner decides whether this is required for launch (OQ-22).

**Acceptance.**
- [ ] A store with Shopify policies opens them as drafts, flagged for review.
- [ ] Old Shopify paths redirect after the first publish.
- [ ] Negative: nothing is written to Shopify, by SHOP-01.
- [ ] Negative: an import never overwrites a document a founder has edited.
- [ ] Negative: a tenant without the scope still generates a store, with a plain note.

**Evidence.** `lib/platform/oauth.js:70-78` holds no content read scope. `components/admin/cms/PageEditor.js:102`. Shopify scopes and paths come from general knowledge, and must be checked on a dev store (OQ-14).

#### GEN-12 · P1 · More brand sources

**Behaviour.** Sources beyond the founder's answers, such as Shopify's shop brand fields, need checking (OQ-14). Colour sampling from the logo, if used, must run client-side or through a model, because the runtime has no image library.

**Acceptance.**
- [ ] A sampled or imported colour is offered as a suggestion, not applied silently.
- [ ] Negative: a suggested colour still passes TOK-02.

**Evidence.** `lib/integrations.js:113`, `lib/media.js:9-10`.

---

### 7.14 Media (MED)

**Decision taken in this spec.** Media stays as blobs in tenant databases for now, per MED-02. Move only on measurement. `/api/media/<id>` URLs must stay valid forever, because old immutable releases embed them.

#### MED-01 · P0 · Phone photos just work

**Addition.** A hero with an image is P0, and today a founder's phone photo is rejected above 1.5MB.

**Behaviour.** The uploader resizes and compresses images in the browser before upload, as it already does for thumbnails. Server limits stay as the safety check. The founder sees progress, not a size error.

**Acceptance.**
- [ ] A 5MB phone photo uploads with no error, with a long edge of at least 1920px after resize and within the server limit.
- [ ] MediaPicker and MediaAdmin use one upload path. Today MediaPicker's copy skips dimensions and thumbnails.
- [ ] Negative: a file that is not an image is refused with a plain message.
- [ ] Negative: SVG sanitizing and magic-byte checks still run on the server.

**Evidence.** `lib/media.js:9-10`, `lib/media.js:15-21`, `components/admin/cms/MediaPicker.js:47`, `components/admin/MediaAdmin.js:73`.

#### MED-02 · P1 · Stay in the database, with a stated trigger to move

**Behaviour.** Measure database size, media read latency and cost per tenant. Write down the trigger, which starts as a hypothesis, such as a tenant passing a set total media size. If bytes move later, the route stays and becomes a redirect or proxy.

**Acceptance.**
- [ ] A measurement exists on at least one real tenant.
- [ ] Negative: no plan breaks an existing `/api/media/<id>` URL.

**Evidence.** `migrations/tenant/0008_media_pages.sql:3-25`, `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md:163`.

#### MED-03 · P0 · A reference index, and archive instead of delete

**Why P0.** Today's safe-delete scan reads draft tables and release bodies. A version 4 release holds no bodies, so after cutover a file used only in a new document version would show as unused and could be deleted from a live page. Cutover cannot happen without this.

**Behaviour.** When a version is written, its media references are extracted into an index. Usage reads the index instead of scanning every release. A referenced file can be archived but not deleted. The index covers every retained version, overlays, brand and site config, and derivative files. Backfill also extracts references from every retained old release row (`release:<id>`), from drafts, and from tenant config (`config:brand`, `config:site`), because those releases embed URLs that must stay valid.

**Acceptance.**
- [ ] A file used only by an old published version shows as used.
- [ ] A file used only in a version 3 rollback target is reported as used after cutover, and refuses forced deletion.
- [ ] Undo to an old version finds its images.
- [ ] Negative: `force: true` cannot delete a file that a retained version uses.
- [ ] Negative: a scan of all release bodies no longer runs on media screens for version 4 tenants.

**Evidence.** `lib/media.js:150-206`, `lib/media.js:176-177`.

#### MED-04 · P1 · Responsive images for shoppers

**Behaviour.** Generate width variants at upload. Storefront images use `srcset` with explicit dimensions. Today shoppers always download originals.

**Acceptance.**
- [ ] A phone downloads a smaller image than a desktop.
- [ ] Negative: old `/api/media` URLs with no variants still render.

**Evidence.** `components/sections/HomeSections.js:79-84`, `components/ContentPage.js:43`, `components/admin/MediaAdmin.js:169-174`.

#### MED-05 · P1 · Correct caching on media

**Behaviour.** The route handles `If-None-Match` with 304. It stops loading the whole blob just to answer that. Whether the host's CDN caches these responses is tested as part of the hosting phase, because it is not known today.

**Acceptance.**
- [ ] A conditional request returns 304 without reading the blob.
- [ ] Negative: one tenant's media id returns 404 on another tenant's host.

**Evidence.** `app/api/media/[id]/route.js:9-33`, `lib/media.js:136-141`.

#### MED-06 · P1 · Export says what happens to media

**Behaviour.** Export today contains metadata only. State that clearly, and offer a way to get the bytes.

**Acceptance.**
- [ ] The export explains media handling and includes or links the bytes.
- [ ] Negative: offboarding does not silently lose images.

**Evidence.** `lib/platform/export.js:24`, `lib/platform/export.js:49`, `lib/platform/export.js:67-68`, `lib/platform/export.js:81`.

---

### 7.15 Performance of live reads (PERF)

**What is and is not known.** Parsing is probably not the cost. A synthetic 5.9MB snapshot parsed in about 2ms on one Mac under Node. The unmeasured cost is moving the whole release row from Turso on each request. **Do not justify this redesign on parse time.** It is justified by per-document publishing. Faster reads are a side benefit that must be measured.

#### PERF-01 · P0 · Read only what the route needs

**Behaviour.** A live page reads the pointer, the small release list, and only the versions this route needs: chrome documents plus the route's own document. Footer links and checkout read page index data held in the release list, and never load bodies. Journal posts are not in the list, because 1,000 posts would otherwise grow what home reads, and every release row, by about 300KB (inferred). They live in a generated journal index version that only the journal index, journal article and sitemap routes load (section 8.4).

**Acceptance.**
- [ ] A query-count test shows a home page reads the pointer, release and a bounded number of versions, independent of how many blog posts exist.
- [ ] The sitemap with 200 posts issues no per-post read in live mode.
- [ ] The byte size of the release list does not change with post count, by test.
- [ ] Negative: adding 1,000 journal documents does not change the home page's read size.

**Evidence.** `lib/content/resolve.js:46-65`, `lib/content/resolve.js:151-162`, `lib/releases.js:296-329`, `app/(storefront)/layout.js:91-102`, `app/sitemap.js:27-32`, `app/(storefront)/journal/page.js:14-19`.

#### PERF-02 · P1 · The console stops hashing the store on every click

**Behaviour.** Every console page navigation runs a full snapshot today, for one badge. Replace it with a per-document comparison of stored hashes. For a tenant in document mode, the old snapshot reads frozen tables and would be wrong, so that tenant's badge moves to this query at cutover (section 8.13). This requirement adds the query budget test, and relief for tenants still in legacy mode.

**Acceptance.**
- [ ] The Publishing badge costs one indexed query.
- [ ] Negative: the badge is never wrong after publish, undo or restore.

**Evidence.** `app/(console)/admin/(authed)/layout.js:32-34`, `app/api/admin/releases/route.js:26`, `lib/cms/approvals.js:39`, `lib/releases.js:221`.

#### PERF-03 · P1 · Cache immutable versions

**Behaviour.** Versions never change, so they can be cached safely by tenant and version id, in a bounded in-process cache with a size limit. Preview bypasses it. The pointer stays fresh on every request, so Publish feels immediate. The pointer's staleness budget is zero until measurement argues otherwise (PERF-07).

**Acceptance.**
- [ ] A repeated request on a warm instance reads no version rows.
- [ ] Publish shows on the next request on any instance.
- [ ] Negative: the cache cannot serve one tenant's content on another's host, by test.
- [ ] Negative: the cache cannot exceed its size limit.

**Evidence.** `lib/db.js:65`, `lib/platform/control.js:34`, `lib/content/resolve.js:46`.

#### PERF-04 · P1 · Measure first, then set budgets

**Behaviour.** Agree a fixture: catalog size, page count, post count. Use real tenant sizes if the owner allows access (OQ-11). Take a local baseline now. Measure before and after on the hosted runtime: read time, bytes moved, first byte, edge memory. Extend the existing perf report. Only then fix the budgets. Hosted numbers need a hosted runtime, which Decision 7 defers, so this asks the owner for a private staging deploy of one test tenant (OQ-19).

**Acceptance.**
- [ ] Before and after numbers exist on the hosted runtime.
- [ ] Budgets are written down, and fail a check when exceeded.
- [ ] Negative: no budget is claimed from local measurements alone.

**Evidence.** `scripts/perf-report.js`. No real tenant sizes were available to the mapping pass.

#### PERF-05 · P1 · Retention

**Behaviour.** Today releases are never pruned. The 20-checkpoint cap applies from day one (DOC-08). Set retention for release rows, published and Undo-saved versions, and logs after measuring. Never delete anything referenced by a live or scheduled release, or by the undo path. Keep version 1 to 3 rows while they remain rollback targets. Numbers await measurement (OQ-15).

**Acceptance.**
- [ ] A dry run lists what would be removed.
- [ ] Negative: a referenced version cannot be pruned, by test.

**Evidence.** `lib/releases.js:376-379`, `lib/releases.js:435`, `lib/media.js:176-177`.

#### PERF-06 · P1 · Remove repeated and unbounded reads

**Behaviour.** Wrap the product read in a per-request cache, since it runs twice per render. Bound the quiz's full product scan and the bundle page's per-component reads. Check whether route handlers get any benefit from the shared content cache.

**Acceptance.**
- [ ] A product page reads the product once.
- [ ] Negative: quiz and bundle grid query counts stay flat as the catalog grows.

**Evidence.** `app/(storefront)/products/[handle]/page.js:15`, `app/(storefront)/products/[handle]/page.js:82`, `lib/quiz.js:96-113`, `lib/bundles.js:166-178`, `app/api/upsell/route.js:16`.

#### PERF-07 · P2 · A short pointer cache, if measurement argues for it

**Behaviour.** If the pointer read is a meaningful part of page time, add a short cache. The owner sets the staleness budget (OQ-15), since Publish must feel immediate.

**Acceptance.**
- [ ] The founder's own next view after Publish is never stale.
- [ ] Negative: with the budget at zero, behaviour equals PERF-03.

**Evidence.** `lib/releases.js:299`.

---

### 7.16 Moving existing tenants to documents (MIG)

**This is the riskiest work in the build.** The steps and tables are in section 8.11. Rollout is one tenant at a time, with no dual-write period.

#### MIG-01 · P0 · Backfill and dry run

**Behaviour.** A script maps each tenant's content to documents using the tables in sections 8.3 and 8.11, with deterministic ids and hashes. The dry run reports the mapping, unresolved references, any hero or section that would change, and how many sections per document would fail strict validation.

**Acceptance.**
- [ ] Each row of the state table in 8.11 and each mapping trap has a fixture.
- [ ] Running the backfill twice produces the same result.
- [ ] Bodies use the merged kind names (DOC-03).
- [ ] Negative: migration publishes nothing new. A draft that differs from the live release stays a draft.

**Evidence.** `migrations/README.md`, `lib/content/resolve.js:92-93`, `lib/releases.js:43-45`.

#### MIG-02 · P0 · Equivalence check

**Behaviour.** Before the pointer flips, old and new outputs are compared. Every `resolved*` getter is compared as data. On canaries, the rendered pages of a fixed route list are compared, with a signed, operator-only preview session pinned to the unflipped release.

**Acceptance.**
- [ ] The comparison runs with no cart cookie and no experiment unit, and with catalog sync paused for that tenant.
- [ ] It compares normalized DOM, stripping scripts, hashed assets and id attributes, with allowed differences listed in `test-migrate-documents`.
- [ ] Negative: any other difference stops the cutover.
- [ ] Negative: the pin cannot be set or used outside operator tooling.

**Evidence.** `lib/content/resolve.js:46-65`, `app/(storefront)/layout.js:85-92`, `app/(storefront)/layout.js:240-262`.

#### MIG-03 · P0 · Cutover and refusal states

**Behaviour.** The tenant's CMS mode lives in the tenant database (`cms_state`), because control-plane config is cached per instance for 30 seconds, up to 5 minutes during an outage, and could not lock old writes. The cutover batch writes the pointer and the mode together. Pending schedules are checked after the lock. The script re-runs safely from any step. Provisioning sets `documents` mode once this ships. `_default` reads as legacy unless its own `cms_state` row says otherwise.

**A tenant cannot be cut over until every document type in 8.3 that holds content for that tenant has a working editor (ED-02, ED-12).**

**Acceptance.**
- [ ] A cutover without a working editor for a type holding content is refused, by test.
- [ ] Old write paths check the mode inside the same statement or batch as their write, and refuse with a plain message.
- [ ] In document mode, `POST /api/admin/releases` with `publish` or `schedule` returns 409 with a pointer to the editor, and `rollback` runs the new restore (PUB-08). Otherwise it would snapshot frozen tables and flip the store back to pre-cutover content.
- [ ] Each reader of a frozen table in section 8.13 reads its new source, and a guard test covers reads as well as writes.
- [ ] Negative: a pending scheduled release or an `error` live state stops cutover.
- [ ] Negative: a crash between any two steps leaves shoppers on the old store, or cleanly on the new one.

**Evidence.** `lib/platform/control.js:34`, `lib/platform/control.js:37`, `lib/platform/control.js:153`, `lib/platform/control.js:173-187`, `app/api/admin/releases/route.js:58-69`, `lib/cms/store.js:230`, `lib/db.js:81-83`.

#### MIG-04 · P0 · Per-tenant reversal

**Behaviour.** An operator can move one tenant back. The pointer returns to the last version 3 or lower release recorded at cutover, and the mode returns to `legacy`. Overlay rows are copied aside to `_reversed_<date>` tables and removed from the live tables, because the effective read has no mode check and old editors could not see or reset them. Search outbox rows are written for affected products, and the count is reported.

**Acceptance.**
- [ ] After reversal, shoppers see Shopify values for previously overlaid products, and no overlay is left unmanaged.
- [ ] Old editors work at once.
- [ ] The operator is told, by count, what was edited in document mode and does not flow back.
- [ ] Negative: re-cutover restores overlays from document versions.

**Evidence.** Section 8.9. `lib/content/resolve.js:223-228`.

#### MIG-05 · P0 · Schema before code

**Addition.** The effective read joins the live content table on every card, product page, cart and search path, and order creation inserts new columns. Tenant migration runs per tenant and is failure-isolated, so one failed tenant would get "no such table" in `getCart`, and in order insertion after payment.

**Behaviour.** A release that depends on new schema deploys only after `pnpm tenant:migrate -- --all` exits 0 and a new `--check` mode confirms every tenant ledger holds the required migration. `--check` fails the deploy otherwise.

**Acceptance.**
- [ ] A test runs cart, product page, search and order creation against a tenant at the older schema.
- [ ] Negative: `--check` fails when one tenant is behind.

**Evidence.** `scripts/tenant-migrate.js:4-5`, `migrations/README.md`, `lib/cart.js:56-59`, `lib/orders.js:249-266`, `lib/releases.js:303`.

#### MIG-06 · P2 · Contract: remove the old tables

**Behaviour.** Old tables are dropped last and separately, under the rule in section 8.11. Nothing is harmed if this waits, because they stay read-only.

**Acceptance.**
- [ ] A check lists every condition in the contract rule before any table is dropped.
- [ ] Negative: a table read by a version 1 rollback target cannot be dropped.

**Evidence.** `lib/content/presentation.js:9-34`.

---

## 8. Technical Design

The stack stays: Next.js 16 App Router, React 19, JavaScript ESM, pnpm, Turso/libSQL with Kysely, one database per tenant, Tailwind v4. The storefront runs on the edge runtime. Consoles run on Node.

This section is a recommended design, not a description of existing behaviour. Table and file names are proposals. Migration file numbers are assigned as each is built. The next free tenant migration is 0018.

### 8.1 What must be preserved

These have test code, which was not run at `c47045f` (run first, section 8.15). The new design keeps each one.

| Keep | Why | Evidence |
|---|---|---|
| Published content never changes | Undo and trust depend on it | `lib/releases.js:1-11` |
| Canonical hash, `stableStringify` plus `sha256Hex` | Same content, same hash | `lib/releases.js:27-39` |
| One atomic switch for visibility of page, layout, chrome and design documents | Shoppers never see a mix of those. Product and collection content have their own live row (section 8.4). | `lib/releases.js:347-352` |
| `live`, `none` and `error` stay distinct, and reads fail closed | Shoppers never get drafts because a read failed | `lib/releases.js:287-329`, `lib/content/resolve.js:64` |
| Sanitizing on the server | HTML is rendered raw on this trust | `lib/cms/validate.js:60`, `components/sections/HomeSections.js:69` |
| The `storefront.publish` capability split | Staff can edit but not publish | `app/api/admin/releases/route.js:50` |
| Tenant-bound signed preview through an httpOnly cookie. The token gains a session id (section 8.8). | Preview never leaks to a public URL | `lib/releases.js:486-498`, `app/api/preview/route.js:33-47` |
| Stable `/api/media/<id>` URLs | Old releases embed them | `lib/media.js:23` |
| Durable section ids, and rebuilding handles from catalog ids | Renames do not break links | `lib/cms/registry.js:14-33`, `lib/cms/store.js:31-67` |
| Per-instance data with batching | Duplicate sections stay independent | `lib/cms/section-data.js:21-61` |
| Parse one operation, then authorize it | Mixed payloads cannot mutate | `lib/admin/cms-api.js:26-55` |
| Revision rules: 428, 409 with current value, both versions survive | No silent overwrite | `lib/admin/cms-api.js:76-84`, `lib/admin/cms-api.js:168-173` |

### 8.2 Data model

**New tenant tables.** All are additive.

```sql
-- One row per document. Holds the working draft.
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,    -- doc_home, doc_header, doc_p_<hash>, doc_prod_<hash>
  type            TEXT NOT NULL,       -- registered document type
  slug            TEXT,                -- route documents only. Cache of the draft's body.meta.slug.
  entity_id       TEXT,                -- Shopify id for product_content, collection_content
  label           TEXT NOT NULL,       -- console name
  draft           TEXT NOT NULL,       -- JSON tree, may be incomplete, always sanitized
  draft_hash      TEXT NOT NULL,       -- canonical body with section and block ids stripped
  revision        INTEGER NOT NULL DEFAULT 1,
  schema_version  INTEGER NOT NULL,
  published_version_id TEXT,           -- null if never published
  published_hash  TEXT,                -- same rule as draft_hash: cheap "has unpublished changes" check
  undone_version_id TEXT,              -- set when Undo took a first publish offline; see 8.6
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT
);
CREATE UNIQUE INDEX documents_slug ON documents(slug) WHERE slug IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX documents_entity ON documents(type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX documents_dirty ON documents(id)
  WHERE archived_at IS NULL AND type NOT IN ('blueprint') AND draft_hash IS NOT published_hash;

-- Frozen copies. Never updated.
CREATE TABLE document_versions (
  id              TEXT PRIMARY KEY,    -- ver_<16hex>
  document_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- published | checkpoint | migrated | undo_saved
  body            TEXT NOT NULL,       -- canonical JSON
  body_hash       TEXT NOT NULL,       -- with ids, for integrity
  schema_version  INTEGER NOT NULL,
  note            TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX document_versions_doc ON document_versions(document_id, created_at);

-- Append only: Undo adds a row and never updates one. Undo walks this.
-- Today there is no pointer history at all.
CREATE TABLE publish_log (
  id              TEXT PRIMARY KEY,
  set_id          TEXT NOT NULL,       -- groups a multi-document publish
  document_id     TEXT NOT NULL,
  action          TEXT NOT NULL,       -- publish | unpublish | undo | scheduled | restore | migrated
  from_version_id TEXT,
  to_version_id   TEXT,
  release_id      TEXT,                -- null for product and collection content
  undoes_log_id   TEXT,                -- on an undo row: the row it undoes
  saved_version_id TEXT,               -- on an undo row: where newer edits were saved
  actor           TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX publish_log_doc ON publish_log(document_id, created_at);

-- Extracted at version write. Replaces scanning release bodies.
CREATE TABLE document_refs (
  version_id      TEXT NOT NULL,       -- or 'draft:<document_id>', 'release:<id>', 'config:brand', 'config:site'
  ref_type        TEXT NOT NULL,       -- media | product | collection | page | bundle | offer | quiz
  ref_id          TEXT NOT NULL,
  PRIMARY KEY (version_id, ref_type, ref_id)
);
CREATE INDEX document_refs_target ON document_refs(ref_type, ref_id);

-- Per-document schedule. The job row stays in the existing jobs queue.
CREATE TABLE document_schedules (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  run_after       TEXT NOT NULL,
  status          TEXT NOT NULL,       -- pending | done | failed | cancelled
  error           TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);

-- What shoppers see for an edited product. Null means follow Shopify.
CREATE TABLE product_content_live (
  product_id      TEXT PRIMARY KEY,    -- Shopify id
  document_id     TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  title           TEXT,
  description     TEXT,
  description_html TEXT,
  featured_image  TEXT,
  featured_image_alt TEXT,
  gallery         TEXT,                -- JSON list of {url, alt}
  seo_title       TEXT,
  seo_description TEXT,
  og_image        TEXT,
  display_vendor  TEXT,
  display_type    TEXT,
  badge           TEXT,
  modules         TEXT,                -- JSON. Selected only by the product page.
  layout_document_id TEXT,
  pairs           TEXT,                -- JSON list of product ids
  keep_variant_images INTEGER,         -- OVL-10
  published_at    TEXT NOT NULL
);

-- Same idea for collections. Starts with pins and layout. Text fields await OQ-05.
CREATE TABLE collection_content_live (
  collection_id   TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  pinned          TEXT,
  layout_document_id TEXT,
  published_at    TEXT NOT NULL
);

-- The tenant's CMS mode. Lives here, not in cached control-plane config (8.11).
CREATE TABLE cms_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  mode            TEXT NOT NULL,       -- legacy | migrating | documents
  cutover_release_id TEXT,             -- last pre-cutover release, for reversal
  updated_at      TEXT NOT NULL
);

-- Which documents one preview session overlays (8.8). Excluded from export.
CREATE TABLE preview_sessions (
  sid             TEXT PRIMARY KEY,
  overlay         TEXT NOT NULL,       -- JSON: document id -> last editor heartbeat
  pin_release     TEXT,                -- operator tooling only, for the equivalence check
  expires_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Products whose search document must change. Written in the publish batch (OVL-17).
CREATE TABLE search_outbox (
  product_id      TEXT NOT NULL,
  handle          TEXT,                -- for deleting a product that no longer exists
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  done_at         TEXT
);
CREATE INDEX search_outbox_pending ON search_outbox(created_at) WHERE done_at IS NULL;
```

**Added columns.**

```sql
ALTER TABLE order_items ADD COLUMN catalog_title TEXT;
ALTER TABLE order_items ADD COLUMN sku TEXT;
ALTER TABLE offers ADD COLUMN previous_config TEXT;   -- COM-03
```

Each `ADD COLUMN` goes in its own numbered file. SQLite has no `ADD COLUMN IF NOT EXISTS`, and a failed file re-runs whole (`lib/platform/migrate.js:72-76`), so two in one file could leave a tenant permanently failing.

**Existing tables kept.** `releases` and `release_state` stay. Their columns do not change. Only the `content` in new rows changes shape. `cms_approvals` stays. `media` stays, with new width variant rows.

**Metafields (META).** Tables `product_metafields` and `collection_metafields`, keyed by owner id, namespace and key, with type and value. They are read-only, written only by sync.

**Checkpoints.** Autosave writes the draft row on each pause. A checkpoint version is written at most once per few minutes per document (exact value at build time), and capped at 20 per document, as today's history is. Published, migrated and `undo_saved` versions are not counted against that cap.

**Hashes.** `draft_hash` and `published_hash` are computed with section and block ids stripped, because lazy id upgrades make drafts differ from snapshots by id only (`lib/releases.js:226-238`). Otherwise every such tenant would show false "unpublished changes" after migration.

### 8.3 Document types and where content comes from

| Document type | Id | Comes from today | Notes |
|---|---|---|---|
| `announcement` | `doc_announcement` | `cms_blocks.announcement` | |
| `header` | `doc_header` | `nav_header`, `surface_templates.header` | Keep null versus empty list: null becomes `{mode:"auto"}`, `[]` becomes `{mode:"custom",items:[]}` |
| `footer` | `doc_footer` | `nav_footer`, `surface_templates.footer` | Same |
| `design` | `doc_design` | Tenant config `brand`, `theme` | Moved from the control plane. Also holds the logo image and alt text. |
| `home` | `doc_home` | `hero`, `home_sections` | Hero becomes section 0 |
| `collections_index` | `doc_collections_index` | `collections_index` | |
| `product_layout` | `doc_product_layout`, plus named ones | `pdp_extras`, `surface_templates.pdp` | This one is the default. Named layouts come from per-entity maps. |
| `collection_layout` | `doc_collection_layout`, plus named ones | `surface_templates.collection` | Same |
| `cart` | `doc_cart` | `placements` of kind `cart_upsell` | |
| `page`, `campaign`, `journal` | `doc_p_<hash of slug>` | `cms_pages` by family | Ids deterministic from slug at backfill, stable after |
| `journal_index` | `doc_journal_index` | Generated from live posts | System document. Founders never edit it. Holds slug, document id, version id, title, excerpt and windows per post. |
| `product_content` | `doc_prod_<hash of id>` | `product_overrides`, `pdp_pairs` placements, `surface_templates.products` | Created at first edit or backfill |
| `collection_content` | `doc_coll_<hash of id>` | `collection_overrides`, `surface_templates.collections` | Same |

Blueprints use their own document type and are never published. `cms_templates` rows and `PAGE_TEMPLATES` become blueprints.

### 8.4 How documents map onto releases

**A version 4 release row holds only references.**

```json
{
  "v": 4,
  "m": 1,
  "documents": {
    "doc_home": { "version": "ver_1a2b", "hash": "9f…" },
    "doc_announcement": null,
    "doc_design": { "version": "ver_3c4d", "hash": "aa…" },
    "doc_p_7e8f": { "version": "ver_5e6f", "hash": "bb…" }
  },
  "pages": [
    { "document": "doc_p_7e8f", "slug": "about", "type": "page", "title": "About", "description": "", "enabled": true, "effective_at": null, "window_start": null, "window_end": null }
  ],
  "redirects": [ { "document": "doc_p_7e8f", "from_slug": "old", "to_slug": "about" } ],
  "indexes": { "journal": { "version": "ver_7a8b", "hash": "cc…" } }
}
```

**Rules.**
- A listed document with `null` means "use the code default". This keeps today's "absent means default" meaning, but makes it explicit.
- `m` is the manifest number. A singleton declares `sinceManifest`. One missing from the list is an **error** if `sinceManifest` is at or below `m`, and reads as code default otherwise. This closes the trap where a version 4 row read by old helpers renders an empty, default-looking site with no error (`lib/content/presentation.js:9`, `lib/content/resolve.js:67`), without breaking older rows or rollback targets when a new singleton ships.
- The `pages` list carries page and campaign entries, so chrome and lists never load bodies. Journal posts are not in it. They live in the generated `journal_index` version, which only the journal index, journal article and sitemap routes load. Publishing a post writes a new index version in the same batch.
- `pages` and `redirects` entries are built from each document's version `meta` (section 8.5) and owned by that document. A build replaces only the entries owned by documents in the set, so Undo removes a redirect with no extra work. A page beats a redirect at the same slug, as `lib/cms/store.js:398-402` does today.
- A publish or Undo checks that each slug is unique across the resulting list and the journal index.
- `content_hash` is the hash of this list. Each entry's hash binds it to exact content.

**Product and collection content are not in this list. This is a deliberate departure from "a release is a set of document versions".** They are still versioned documents with their own Publish and Undo. Their live state is one row in `product_content_live` or `collection_content_live`. The reasons, from the evidence:

1. Title must be filterable and sortable in SQL for search, pairs and lists (`lib/repo.js:247-274`, `lib/cms/placements.js:111-124`). A JSON list cannot do that.
2. Each entry would add to every release row, for every edited product (estimated about 400KB for 5,000 edited products, by arithmetic). The list must stay small, because it is read on every request. The same reasoning moves journal posts out of the list.
3. Rollback semantics stay simple. Product Undo is per product.

**Consequence, for the owner to accept (OQ-18).** Whole-store restore (PUB-08) does not rewind product or collection content. The advanced screen says so. A set publish containing product content is still all-or-none (section 8.6).

### 8.5 Document body and registry shape

```json
{
  "schema": 1,
  "type": "page",
  "meta": { "slug": "about", "title": "About", "description": "", "enabled": true, "effective_at": null, "window_start": null, "window_end": null, "redirect_from": [] },
  "sections": [
    {
      "id": "sec_ab12cd34",
      "kind": "product_rail",
      "v": 3,
      "enabled": true,
      "settings": { "title": "Bestsellers", "tone": "muted", "spacing": "normal" },
      "mobile": { "spacing": "tight" },
      "show": { "mobile": true, "desktop": true },
      "bindings": { "products": { "source": "collection_products", "args": { "collection_id": "gid://shopify/Collection/1", "limit": 8 } } },
      "blocks": []
    }
  ]
}
```

- **`meta`** holds a route document's URL state, so it is versioned with the content and Undo can restore an old slug. `documents.slug` is a cache of the draft's value. Singletons leave `meta` empty.
- **Links are typed:** `{ "type": "collection", "id": "gid://…" }` or `{ "type": "url", "href": "https://…" }`. The handle is resolved at render. So every link heals itself on rename, and UTM rewriting is generic.
- **Ids.** `sec_` format stays. Blocks use `blk_` with the same rules. The client mints ids when a section is added, so a section is selectable before its first save.
- **Old field names** are never rewritten inside old snapshots. New bodies use new names, and migration maps between them.

```js
// lib/cms/registry: one declaration per type
defineSection({
  kind: "product_rail",
  version: 3,
  label: "Product rail",
  documentTypes: ["home", "page", "campaign", "journal", "product_layout", "collection_layout"],
  settings: [
    { key: "title", kind: "text", max: 80, softMax: 50, required: false, default: "Bestsellers" },
    { key: "tone", kind: "tone" },
    { key: "spacing", kind: "spacing", responsive: true },
  ],
  bindings: { products: { sources: ["collection_products", "newest_products"], required: true } },
  blocks: { allowed: [], max: 0 },
  maxPerDocument: null,         // hero: 1
  allowedPositions: null,       // hero: top of the page only, for example
  minItems: 3,                  // below this, a founder note
  rules: (section) => [],       // cross-field checks, returning structured issues
  refs: (section) => [],        // references and media, for the index and publish checks
  migrate: { 2: upgradeFromV2 },
  placeholder: "Pick a collection to show its products",
  protected: false,
});
```

Setting kinds: text, number, headline, rich_text, link, media, collection, product, products, variant, bundle, offer, quiz, page, choice, tone, spacing, alignment, paragraphs, qa_list. New kinds add a control in one place.

The registry stays free of React, so Node, edge and tests can all import it. Renderers live in one map (`components/sections/index.js`), and a test keeps the two in step.

### 8.6 Write, publish and undo

**All writes run on Node console routes.** The storefront never writes content.

**Draft save.**
1. Parse one operation, then authorize it.
2. Check the revision.
3. Validate structure, sanitize HTML. Collect issues, but do not refuse for incompleteness.
4. Update the row with `WHERE revision = expected`. Zero rows means 409.
5. Return the normalized document and the issues. The client must not replace the text the founder is typing in.

**Publish one document, or a set.** A set is always one batch. Sets are capped (PUB-05).
1. Flush any pending save. Further autosaves wait until this returns. Pass each document's revision and the `draft_hash` shown in the panel.
2. Read each document at that revision. A moved revision or a different hash means 409.
3. Run full validation and re-sanitize. Classify issues (PUB-03). Check references against the live list plus this set. Check slugs are unique across the result.
4. Hash the canonical body with ids stripped. If it matches what is already live, skip this document. If it matches `undone_version_id`, require an explicit "publish again" confirmation.
5. Read the live pointer `L` and its list `M`, and remember each document's entry in `M`. In document mode `M` is always version 4, because restore materializes (section 8.12).
6. Generate release, log and version ids once per list build, so a transport retry reuses them. Build the new list `M2`, changing only entries owned by these documents, including the journal index if a post changed. Run it with `libsql.batch(stmts, "write")`, because the client defaults to deferred (`node_modules/@libsql/client/lib-esm/http.js:90`):
   - insert version rows and refs. Every insert in this batch is `INSERT OR IGNORE`, because `lib/db.js:48` retries batches on errors including "timed out", when the first attempt may have committed;
   - insert the release row with `published_at` null;
   - flip: `UPDATE release_state SET live_release_id = :new, updated_at = :now WHERE id = 1 AND live_release_id IS :L AND (SELECT revision FROM documents WHERE id = :d) = :rev`, with one revision term per document in the set, so an autosave landing after the read also loses;
   - `UPDATE releases SET published_at = :now WHERE id = :new AND published_at IS NULL AND (SELECT live_release_id FROM release_state WHERE id = 1) = :new`;
   - insert the log row, update `documents.published_*`, write product and collection live rows, and write `search_outbox` rows, each guarded by `WHERE (SELECT live_release_id FROM release_state WHERE id = 1) = :new`;
   - end by selecting the pointer.
7. If the final pointer is `:new`, it worked, including after a lost response and a retry. Otherwise read the new pointer `L'` and list `M'`. If `M'` already holds this build's version ids, it worked and another publish has since built on it. Otherwise, for every document in the set, if `M'` differs from the entry remembered in step 5, or its revision moved, return 409 with the current document. Otherwise re-run step 3 against `M'`, build a new release id, and retry, up to three times. A losing release row is harmless, and `listReleases` excludes rows where `published_at` and `scheduled_for` are both null.
8. After success: audit, drain the outbox through `after()`, return the result.

**Unproven, test first.** No code in `lib` or `app` uses `.batch(` or `.transaction(` today. This plan uses `batch` only, not interactive transactions, because the latter would be new behaviour through the Kysely dialect and the `wrapClient` proxy. Build a concurrency test before anything depends on it. It must show that a batch is atomic through `lib/db.js`'s wrapper against a real libSQL server, not only against a local file, and it must simulate a lost response followed by a retry.

**Publish product or collection content only.** The same steps 1 to 4. Then one batch: insert version, upsert or delete the live row, insert log, update document, write `search_outbox`. Each is guarded on the document's `published_version_id` and revision, and the batch ends by selecting them. No release row is written.

**Undo.**
1. Find the latest log entry for this document with action `publish`, `unpublish`, `scheduled` or `restore` that no `undo` row references. If there is none, or a `migrated` row comes first, say there is nothing earlier to undo. A migrated row is a floor.
2. Its `from_version_id` is the target. For a null target, a singleton has no Undo (PUB-04), a route document is taken offline, and product or collection content loses its live row.
3. Skip reference checks. Old versions were valid, and stale references degrade at render. Warn when Undo leaves a product or collection pointing at a layout that is no longer live, by count from `document_refs`. Still check slug uniqueness. On a conflict, refuse with a plain message naming the other page.
4. If the draft differs from both the currently live version and the target, write it as an `undo_saved` version first.
5. In one batch, with the same guards as a publish (pointer and revision, or `published_version_id` and revision for live-row documents): build a new list with the target, or rewrite or delete the live row and write `search_outbox`. Set the draft to the target's body with revision plus one. For a null target, keep the draft body, record `undone_version_id`, and write the list entry as `enabled: false`. Insert an `undo` log row with `undoes_log_id` and `saved_version_id`.
6. Tell the founder what happened, and if edits were saved, where they are. A racing autosave makes the batch lose, and Undo re-reads from step 1.

A second Undo steps further back, because the first entry is now referenced by an undo row. **Whole-set Undo** selects the log rows by `set_id`, runs in one batch, is all-or-none, and returns 409 if any member was published since.

**Schedule.** A row in `document_schedules` plus a new `publish_document` job in `lib/platform/worker.js`. When it fires, it runs the publish steps from step 3 against the frozen version id. A failure marks the row failed and notifies the founder through `send_notification`. No exact-minute promises are made.

### 8.7 Read path on the edge runtime

**Per request:**

1. Check the preview cookie, as today. If valid, use the preview path (section 8.8).
2. Read the pointer, the release row and `cms_state.mode` together, by a join. The release list can be cached by release id, because it is immutable. Then only the pointer needs a round trip. A missing `cms_state` table reads as `legacy`.
3. Branch **before any helper runs**. `content.v` 4 goes to the new reader. 1 to 3 go to the legacy reader, which serves only legacy tenants and reversal. No release with mode `documents` returns `{mode:"closed"}` (PUB-06). No release with mode `legacy` or `migrating` keeps today's draft path. Anything else is an error.
4. Work out which documents this route needs: `doc_header`, `doc_footer`, `doc_announcement`, `doc_design` in the layout, plus the route's own document in the page. A product page must read the product row before it knows its layout: `product_content_live.layout_document_id` or the default.
5. Fetch those versions from the cache or by `id IN (…)`. A listed version that is missing is `ContentUnavailableError`, never a fallback. A `layout_document_id` not in the live list renders the default layout and logs. It never throws, because Undo and restore can cause this, and the product editor says "this layout is no longer live".
6. Upgrade: run the registry's pure `migrate` on each section whose `v` is below current, and cache the upgraded form. The stored body is never rewritten. Undo loads the upgraded form into the draft.
7. Fill bindings by the existing per-instance, batched resolver.
8. Render. Windows are still evaluated per request with the current time.

**The cache.** A bounded, byte-limited map inside each instance, keyed by tenant and version id. Versions are immutable, so entries never go stale, and eviction is the only removal. The size limit is a hypothesis until edge memory is measured. Module-level state already exists in this runtime, in `lib/db.js` and `lib/platform/control.js`.

**Round trips.** One for the pointer, one for chrome in the layout, one for route documents in the page, and one more for a non-default product layout, each per-render cached, plus catalog reads as today. The layout has no pathname and the repo has no middleware, so layout and page load separately. Fix budgets only after PERF-04. React's per-render cache stays. Route handlers such as `/api/upsell` must also use the instance cache, since the render cache likely gives them no benefit (not tested).

**Worker and scripts.** Effective catalog reads work with no cookies, so the worker, the edge runtime and scripts all share them.

### 8.8 Preview

- A preview session says which documents to overlay. The token becomes `p.<exp>.<sid>.<hmac>`, over tenant, sid and exp, so the regex at `lib/releases.js:492` changes. A row in `preview_sessions` holds the overlay. It is not a public URL parameter, and a server render sees only the cookie. The cookie is browser-wide, so the overlay is the union of documents with a live editor tab, kept by a heartbeat with a short expiry. When the union holds more than one document, the editor says "this draft is also open in another tab".
- With a valid cookie, the reader uses the live list, and for each overlaid document uses the draft instead of the published version. Everything else is live. Before first publish, there is no live list, so all drafts show.
- Drafts render in tolerant mode: an invalid section renders its placeholder.
- **Retiring candidates.** Today's per-session candidate table existed because drafts required an explicit Save. With autosave (ED-03), the draft is the unsaved state, so preview reads it directly and a second store of nearly the same data is not needed. Trade-off: preview now shows content an instant after the pause rather than purely in memory, and tier 1 patches cover the gap. The table stays until all tenants are cut over.
- **Refresh tiers.** The bridge posts field patches for text and CSS variables for tokens (`brandCssVars` is pure). Structural changes use a soft refresh inside the frame. Full reload is the fallback. Whether soft refresh behaves in an iframe under this layout has not been tested.
- **Session renewal.** The editor renews the token before expiry, keeping the same `sid`. Today's session key is a hash of the whole token, which changes on renewal (`lib/cms/candidates.js:24-29`).
- **See it live.** `/api/preview?exit=1&to=<path>` clears the cookie (PUB-11). The editor notices and re-mints on its next frame refresh.

### 8.9 Overlay read

One edge-safe module, for example `lib/catalog/effective.js`, is the only way shopper paths read content columns.

```sql
SELECT p.id, p.handle, p.price_min, p.available,
       p.tags AS logic_tags, p.product_type AS logic_type,     -- raw, for logic
       COALESCE(c.title, p.title)                   AS title,
       COALESCE(c.featured_image, p.featured_image) AS featured_image,
       CASE WHEN c.featured_image IS NOT NULL
            THEN c.featured_image_alt ELSE p.featured_image_alt END AS featured_image_alt,
       COALESCE(c.display_type, p.product_type)     AS display_type,
       COALESCE(c.display_vendor, p.vendor)         AS display_vendor
FROM products p
LEFT JOIN product_content_live c ON c.product_id = p.id
WHERE ...
```

- Card reads select only card columns. `modules` and `description_html` are read only by the product page.
- `COALESCE` treats an empty string as a real value. Empty title is refused at validation. Alt follows its image, so an overlay image never pairs with Shopify's alt text for a different image.
- `getCart` returns `catalog_title` from the raw `p.title` and `sku` from the variant, next to the effective `title`.
- The offer engine, quiz scoring and facets receive raw `logic_tags`, `logic_type` and `handle`.
- **Preview of an overlay.** The product page merges the draft over the effective row in the page layer, only when this document is in the preview's overlay set. The cart, search and sitemap stay on the live table, even in preview.
- **Detecting Shopify changes.** At first edit of a field, the document stores `{ value, base_hash, base_value }`. The product list and the editor compare `base_hash` with the current raw value, for edited products only. Sync does not change.
- **Reset.** Removes the field from the draft. After publish, the column is null.

### 8.10 Search indexing

- **One document builder.** `buildSearchDoc(row)` is used by full and partial indexing. It reads effective values.
- **SQL mode.** Queries use `COALESCE(c.title, p.title)` in `WHERE` and `ORDER BY`. This is the supported engine, so it must be right with Typesense off.
- **Typesense mode (OVL-17).** Publish, Undo and restore write `search_outbox` rows inside their batch, because enqueueing afterwards to the control plane can fail silently (`lib/platform/jobs.js:68-83`). A `reindex_products` job drains the outbox: the `after()` fast path, with the tick as backstop. It upserts documents, and deletes by stored handle when a product is gone. It never drops the collection. Full sync still rebuilds using the same builder, deletes first and reads rows before import (`lib/sync.js:228`, `lib/sync.js:234-246`), so it drains the outbox after import.
- **Known gap left in place.** Webhook writes do not reindex today, so prices and stock in Typesense go stale between full syncs (`lib/sync.js:197-202`). The new job makes the fix easy, but it is not required by this build.

### 8.11 Migrations

**Rules from `migrations/README.md` apply.** Never edit an applied file. Expand, then backfill, then contract. Idempotent where possible, because `executeMultiple` is not transactional. Each tenant runs separately.

**Mode switch.** The `cms_state` table in the tenant database takes `legacy`, `migrating` or `documents`. It lets the rollout move one tenant at a time. There is no dual-write period, which avoids a whole class of bugs. It is not tenant config: config is cached per instance for 30 seconds, up to 5 minutes during an outage, and `patchTenant` clears only the local instance (`lib/platform/control.js:34-38`, `lib/platform/control.js:153`), so other instances would keep accepting old writes after the lock, and those writes would be lost. Old write paths check the mode in the same statement or batch as their write. Reads may keep a cached copy only for console UI. Brand and theme writes go to another database, so they check the mode first, and backfill reads design last. That small window is accepted, and step 7 would catch the difference.

**New tenants and `_default`.** Provisioning sets `documents` once this ships. `_default` reads as `legacy` unless its own `cms_state` row says otherwise. `test-tenancy` covers both.

**Deploy order (MIG-05).** A release that depends on new schema deploys only after `pnpm tenant:migrate -- --all` exits 0 and `--check` confirms every tenant ledger.

**Steps per tenant.** The script re-runs safely from any step.

1. **Expand.** `pnpm tenant:migrate` adds tables. Nothing reads them yet, and table presence selects no behaviour.
2. **Back up.** Take an authorized backup. Run `scripts/restore-drill.js` once on a canary first.
3. **Dry run.** `scripts/migrate-documents.js --tenant X --dry-run` reports the mapping, unresolved references, any hero or section that would change, and per document, what would fail strict validation (these become `inherited` warnings, PUB-03).
4. **Lock.** Set the mode to `migrating`. Old write APIs return a plain "updating, try again shortly".
5. **Refuse if unsafe.** Checked after the lock, so nothing can race it. A pending scheduled release stops the cutover. It would otherwise later flip an old whole-site snapshot over the new content. An `error` live state also stops it. Either one returns the tenant to `legacy`.
6. **Backfill.** Use the table below. Backfill is idempotent, using deterministic ids and hashes. It extracts references from every retained release row, from drafts and from tenant config into `document_refs` (MED-03). It translates running `experiments.variants` payloads through the adapter in DOC-02.
7. **Check equivalence (MIG-02).** Compare old and new outputs for every `resolved*` getter as data. On canaries, compare the normalized DOM of a fixed route list, rendering the unflipped release through `preview_sessions.pin_release`. Allowed differences are listed in `test-migrate-documents`. Any other difference stops the cutover.
8. **Cut over.** In one batch, insert the version 4 release, flip the pointer with the guarded update, and set `cms_state` to `documents` with `cutover_release_id`. Pointer and mode are in the same database, so they move together.
9. **Verify.** Load the public routes. Confirm no founder sees "unpublished changes" that are not real.

| Tenant state today | Published versions from | Drafts from | Shoppers afterwards |
|---|---|---|---|
| Live on release version 2 or 3 | The live release | Draft tables and tenant config | Same store |
| Live on release version 1 | The live release, plus live tables for overrides, pins, placements and redirects, which version 1 never froze | Same | Same store |
| No release, store open to shoppers | **The draft tables, because they are what shoppers see today** | Draft tables | Same store. This is not publishing anything new. |
| No release, store not launched | Nothing | Draft tables | Closed until first Publish |
| Pending scheduled release | Refused | Refused | Resolve the schedule first |
| Live read in error | Refused | Refused | Repair first |

Whether a "no release" store is open or not launched is confirmed by the operator per tenant. An earlier mapping note said "no release gets drafts only". That would close a store that is live on drafts today, so this spec corrects it.

**Migration must publish nothing new.** A draft that differs from the live release stays a draft, and shows as an unpublished change.

**Mapping traps to test by fixture.**
- `null`, empty list and absent values stay distinct.
- An empty `home_sections` falls back to defaults today, so the migrated body materializes what shoppers see.
- Sections with no id get the same `sec_l<i>` used at read, so ids do not change.
- Page sections with no kind normalize to text.
- Code default pages for `_default` and BeastLife tenants keep rendering (`lib/cms/store.js:225-232`, `lib/content/pages.js:16-203`).
- Agency-written `home_sections` without ids, stamped version 2 (`lib/platform/agency.js:228-251`).
- A highlight that did not match stays unaccented.
- Stored payloads outside the content tables keep the old shape: running experiment variants, AI proposals, agency kit payloads and code kit presets (`lib/experiments.js:312-318`, `lib/ai/insights.js:243-244`, `lib/platform/agency.js:309-317`, `lib/themes/kits.js:108-112`). Each gets a fixture through `legacyHeroToSettings`.
- `doc_home` merges two blocks, and old snapshots hold only customized ones. If one half is customized, the document must materialize the default half, so a `null` entry cannot represent it. A materialized default hero title stores a `{store_name}` binding rather than literal text, so it keeps following Settings (`lib/content/resolve.js:80`, `lib/content/resolve.js:92-93`, `lib/cms/defaults.js:13`). Each half-customized combination gets a fixture.
- Per-entity template maps and pins become fields on content documents.
- `lib/releases.js:43-45`: snapshots store only customized blocks, so defaults can drift. Migrated `null` entries keep that behaviour for now, except `doc_home` as above. Generated stores materialize everything.

**Reversal, per tenant (MIG-04).**
1. Copy `product_content_live` and `collection_content_live` to `_reversed_<date>` tables, delete the live rows, write `search_outbox` rows for affected products, and report the count. The effective read has no mode check, so otherwise retitled products would keep their edited titles while old editors could not see or reset them.
2. Point `release_state` back at `cutover_release_id`.
3. Set the mode to `legacy`.
4. Old tables are untouched, so old editors work at once.
5. **Honest limit:** edits and publishes made in document mode do not flow back. They stay in the document tables. If reversal happens, an operator must re-enter them or re-cut over later, which restores overlays from document versions.

**Contract, last and separately.** Old tables are dropped only when all of these hold: every tenant is in document mode, the reversal window the owner sets has passed, and **no version 1 release remains a rollback target**, because version 1 reads `product_overrides`, `collection_overrides`, `placements` and `page_redirects` as live tables. Until then they stay, read-only.

### 8.12 Compatibility with existing releases and content

**Old rows are never rewritten.** A frozen `lib/content/legacy-release.js` holds these rules, with its own regression suite.

| Rule | Evidence |
|---|---|
| A release with no version is an error | `lib/releases.js:322` |
| Version 1: overrides, pins, placements and redirects return null and fall back to live tables | `lib/content/presentation.js:9-34` |
| Version 2 and up: use frozen arrays, and a missing array means empty | `lib/content/presentation.js:13-14` |
| Home sections may lack ids, keyed `i-<n>` | `components/sections/HomeSections.js:18`, `lib/cms/section-data.js:22` |
| Page sections may lack kind and id: normalized to text and stamped `sec_l<i>` | `lib/cms/schemas.js:43-44` |
| An absent block means default | `lib/content/resolve.js:67` |
| Unknown kinds are filtered out | `lib/content/resolve.js:98` |
| Missing `surface_templates` means platform defaults | `lib/content/resolve.js:181-201` |
| Id-bearing collection references heal from the catalog | `lib/content/resolve.js:95-98` |

All existing renderers and kind names stay while such rows are rollback targets.

**Restoring an old release (PUB-08).** In a document-mode tenant, restore never points at an old row. Reading modules, badge, pins and pairs from an old snapshot would rewind them, and the next publish would silently switch them back. So restore materializes the target (versions 1 to 3 through the backfill mapper, version 4 as is) into a new version 4 release, ignoring product and collection sets, and flips it by the same guarded batch. Reused versions use `kind = migrated`, by hash if identical. The batch also updates `documents.published_*` and writes one `restore` log row per changed document. Draft rows are not changed. As with Undo, the screen warns when this leaves a product or collection pointing at a layout that is no longer live, by count. The legacy reader serves only legacy tenants and reversal.

**Tests with real shapes.** Fixtures of version 1, 2 and 3 rows render through the new resolver, using the design harness data and hand-made rows. A version 4 row goes through every getter. A version 5 row is an error.

### 8.13 What is retired, and when

| Item | Replaced by | Can go when |
|---|---|---|
| `HomeEditor`, `PreviewFrame`, `DesignerTabs` | Editor shell | Shell covers home, and no tenant is in legacy mode |
| `Designer`, `SurfaceDesigner`, `SurfaceTemplatesCard`, `PdpExtrasEditor`, `NavigationEditor`, `BrandAdmin`, `ThemeAdmin`, `PageEditor` | Editor shell | Shell covers that document type, and no tenant is in legacy mode |
| `ReleasesAdmin` as primary publish path | Editor Publish | At cutover. It stays under Advanced. |
| Presentation half of `CatalogAdmin` | Product editor | At OVL-04 and OVL-07 |
| `surface_templates` block | Fields on documents | Stops being written at cutover. It stays readable forever in the legacy reader. |
| `cms_blocks`, `cms_pages`, `cms_templates` | `documents` | Contract rule in 8.11 |
| `product_overrides`, `collection_overrides`, `placements`, `page_redirects` | Documents, live tables, release list | Contract rule in 8.11, including no version 1 rollback target |
| `cms_history` | `document_versions` | Contract rule. Backfill is optional and lossy, since page values were raw. |
| `cms_preview_candidates` | Draft plus overlay preview | Contract rule |
| `snapshotContent`, `releaseDiff`, `validateRelease` | Per-document equivalents, plus an aggregate hash for approvals | Stay for legacy tenants. Removed at contract, except the aggregate. |
| Per-kind branches in `validate.js`, `HomeSections.js`, `ContentPage.js`, `store.js` | Registry-driven code | Only inside the legacy reader after cutover |
| `/api/admin/storefront` | `/api/admin/documents` | No tenant in legacy mode |
| `checkoutUrl` | Nothing | Now (SHOP-03) |

**Readers of frozen tables.** Without this list these would silently return stale content after cutover. A guard test extends DOC-02's write check to reads (`getBlock`, `getHero`, `getNav`, `listContentPages` and raw `cms_*` selects) outside the legacy module, with an allowlist.

| Reader | Today reads | New source, in document mode |
|---|---|---|
| AI insights context (`lib/ai/insights.js:81-82`) | `getHero` | Home document |
| Agency kit export (`lib/platform/agency.js:268-271`) | Hero, announcement, home sections, `config.brand` | Home, announcement and design documents |
| Console view (`lib/cms/view.js:12-37`) | All draft blocks and pages | Documents |
| Setup checklist (`lib/admin/onboarding.js:9`, `:27`, `:53`) | `listContentPages`, `config.brand` | Documents |
| Catalog route (`app/api/admin/catalog/route.js:58`) | `surface_templates` | Product content document |
| Publishing badge (`app/(console)/admin/(authed)/layout.js:32-34`) | `snapshotContent` | The `documents_dirty` query |
| Approvals (`lib/cms/approvals.js:39`) | `snapshotContent` | The aggregate hash (DOC-13) |
| Media usage (`lib/media.js:150-206`) | Draft tables and release bodies | `document_refs` (MED-03) |

**`/api/admin/releases` in document mode.** `publish` and `schedule` return 409 with a pointer to the editor, because `createRelease` would snapshot the frozen tables and flip the store back to pre-cutover content. `rollback` runs the new restore. `preview` and `approve` keep working. `cancel` applies only to releases scheduled before cutover, and those stop cutover anyway.

### 8.14 API shape

`PUT /api/admin/documents` takes exactly one operation key, parsed before authorization, as the current CMS API does. Same test style as `scripts/test-cms-api.js`.

| Operation | Capability | Notes |
|---|---|---|
| `getDocument`, `listDocuments`, `listHistory`, `listChanges` | `storefront.read` | |
| `saveDraft`, `discardDraft`, `createDocument`, `createFromBlueprint`, `restoreVersion`, `resetField` | `storefront.write` | Revision required. `discardDraft` writes a checkpoint, sets the draft to the published body, and never changes what shoppers see. |
| `archive` | `storefront.write` | Revision required. Refused on a document with a live version, which must be unpublished first. |
| `publish`, `publishSet`, `unpublish`, `undo`, `schedule`, `cancelSchedule`, `discardOrphanEdits` | `storefront.publish` | Revision required. `publish` and `publishSet` also carry the reviewed `draft_hash` per document. |

Status codes: 400 mixed or malformed, 403 not permitted, 409 stale with the current document, 422 validation with structured issues, 428 revision missing, 5xx infrastructure with a code.

### 8.15 Test strategy

**Existing suites that must stay green: every `test:*` script in `package.json`.** These were not run while writing this spec. Run them to establish a baseline before the first change. Those most at risk:

| Suite | Guards |
|---|---|
| `test-releases`, `test-content`, `test-cms`, `test-cms-api` | Release states, fail-closed, revisions, route-level authorization |
| `test-sections`, `test-surfaces`, `test-refs`, `test-themes` | Registry, surfaces, pickers, kits. `test-sections` holds an exact kind list that must change. `test-themes` asserts the control-plane theme, which TOK-03 moves. |
| `test-storefront`, `test-commerce`, `test-commerce-exp`, `test-orders`, `test-offers`, `test-offers-admin`, `test-shipping` | Cart, checkout, offers, bundles and quizzes must not change, except where COM-06 and COM-07 say so |
| `test-shopify-push`, `test-platform-sync`, `test-sync-generations`, `test-order-projection` | Shopify boundary and sync. GEN-02 changes how sync runs. |
| `test-privacy`, `test-security`, `test-tenant-boundary`, `test-tenancy`, `test-authz` | Consent, sanitizing, isolation, capabilities |
| `test-customers`, `test-identity` | Account and identity access, named by SURF-01 |
| `test-jobs` | The queue used by GEN-02, PUB-07 and OVL-17 |
| `test-admin-console` | Console routes. It will need changes at ED-05. |
| `test-growth`, `test-events`, `test-reporting`, `test-agency`, `test-provision`, `test-tenant-ops` | Experiments, events, reports, agency, provisioning, export |

**New suites to add.**

| Suite | Proves |
|---|---|
| `test-documents` | Write service, revisions, tolerant drafts, sanitizing, versions, retention rules |
| `test-registry-contract` | One declaration plus one renderer, the fake-type test, defaults valid, unknown source fails |
| `test-publish` | Single and set publish, same-document races, lost response then retry, undo chains and floors, empty home refused, inherited issues, schedule against newer publish, atomic batch through `lib/db.js` |
| `test-release-readers` | Version 1, 2, 3 and 4 fixtures through every getter, missing version, unknown version, the empty-site trap |
| `test-migrate-documents` | The state table in 8.11, each mapping trap, idempotence, equivalence differences, cutover gate, reversal leaving no unmanaged overlay, no new content published |
| `test-effective-catalog` | Guard scan for raw reads, consistent titles across reads, logic stays raw, draft isolation, sync survival |
| `test-shopify-boundary` | Mutation allowlist, scope list, push payload shape, free-text routes |
| `test-tokens` | Hard-coded class scan, pairing matrix, token scope table |
| `test-commerce-blocks` | State cells in COM-01 as each block ships, query bounds, callout matches engine |
| `test-generator` | Catalog shapes, no AI, empty catalog, safe to re-run, publishable result |
| `test-media-refs` | Index contents, archive rule, resize path |
| `test-failure-matrix` | Each known failure gives a plain message (G3) |

**Runners.** Suites today are plain `node scripts/test-*.js`, and components are JSX in `.js` files, which plain Node cannot import. So rendered and browser acceptance items cannot run as things stand. This build adds one JSX-capable runner (for example Vitest with `react-dom/server`) for rendered tests, and one browser runner (for example Playwright against the design harness) for overflow, layout shift, image downloads, screenshots and tab close. Check each before committing to it. At build time, each acceptance item is tagged unit, rendered, browser or manual drill. Any item with no runner becomes a named manual drill with recorded evidence.

**Browser drills.** Every founder-facing journey needs a recorded browser run on the design harness (`pnpm dev:design`). Packets S57 and S59 were written accounts with no recording, and `docs/` holds no image or video artifacts. New drills commit a recording or screenshots per journey. Each review packet separates implemented, locally tested, browser verified, staging verified and production enabled, per the existing working contract (`docs/CMS_CLAUDE_DIRECTION_BRIEF.md:81`).

**Harness fix, needed before the first drill and the section 10 benchmark.** The harness runs the storefront on Node through a temporary code flip, because edge and file databases do not mix (`docs/cms-reviews/S57-browser-drill.md:3-6`). So drills have never exercised the edge runtime that the read path, instance cache and effective catalog depend on. `runtime` is a static literal, so the fix is to point the harness at a local libSQL server, so it runs with no code edit. Edge-safe claims in OVL-03, PERF-03 and section 8.7 need a run on that setup. Seeding already applies all migrations (`scripts/seed-design-preview.js:61`). An existing harness database needs a re-seed after each new migration.

**Known gaps in verification today.**
- **No CI gate.** The only workflow is `jobs-tick.yml`. Nothing runs tests on push, and there is no aggregate test script. SHOP-06 fixes this.
- **No browser test suite** is in the repo. No Playwright dependency exists. Drills are manual until the runner above is added.
- **Review packets are the author's own reports.** The S59 packet's stated cause of the 422 was wrong (section 14). Reviewers should re-read the code.
- **Nothing has been measured on the hosted runtime:** read latency, preview latency, edge memory.
- **Real tenant sizes are unknown.** Only the design harness was read.
- **`libsql.batch` is unused today**, so atomicity through this project's wrapper is unproven.

---

## 9. App Replacement Matrix

**Honest position today: nothing here lets a founder cancel a paid app without losing something.** The "after this build" column assumes all P0 and P1 work ships. No app prices are claimed, because none are in the evidence. Storeasy's own plans are ₹999 and ₹2,999 per month (`lib/platform/billing.js:39-41`). Which apps founders run is unknown. Test this cheaply (section 12).

**Before cancelling, a founder's theme app embeds stop showing on this storefront** (inferred, test first). The code has no way to add a third-party script, so this applies to chat and every other storefront add-on, not only reviews.

| Paid app category | Storeasy today | After this build | Honest gap after this build |
|---|---|---|---|
| **Page builder** | Partial. 10 section kinds, no nesting, no per-device settings, no drag-and-drop, hero not composable. | Composable home, product, collection and content pages, inside tokens. | No free-form design, by Decision 4. No video. Fewer blocks than a mature builder. |
| **Upsell and cross-sell** | Partial. Pairs on product pages, one global cart slot. No rules, no measurement. | Per-product cart rules, measured revenue per block. | No post-purchase upsell. No discount tied to an upsell. |
| **Cart drawer or side cart** | Built in. Drawer with one upsell slot and a free-shipping nudge. | Approved upsell and progress slots, editable copy. | No third-party cart add-ons. Slots are limited by design. |
| **Customer accounts** | Built in. Sign-in, order history, wishlist merge. | Unchanged. Tokens and copy only. | Whether this matches a founder's account app is unknown. No store credit. |
| **Wishlist** | Built in, with merge at sign-in. | Unchanged. | No shared lists or back-in-stock mail. |
| **Bundles** | Partial. Fixed-variant, fixed-price sets. One page per bundle, no block. | Bundle card and grid on any page, with images and events. | **Replaces a simple fixed-set app only.** Not a replacement for stores needing shopper variant choice unless COM-15 ships (OQ-08). No mix-and-match or volume builder. |
| **Search** | Partial. SQL `LIKE` by default. Typo tolerance only with platform Typesense. | Search block, pagination, effective titles in search, a relevance fixture and a speed target. | SQL has no real typo tolerance. Synonyms, pins and filters are P2. Whether Typesense is on is unconfirmed (OQ-16). |
| **Quiz** | Partial. Deterministic, text-only options, no block, no add to cart. | Quiz block, images, add to cart. | No lead list. No branching logic. |
| **A/B testing** | Partial. Hero copy only. One metric. An honest statistics engine exists. | Targets a block's fields. | One metric. A small store will wait a long time for a result, at 200 per variant by default. |
| **Analytics** | Partial. Reconciled sales, funnel, search terms, campaigns, devices. Consented only. GA4 and Meta forwarding. | Revenue per block, repeat rate, new versus returning, traffic source. | No cohorts or LTV. Consent limits coverage. |
| **AI experiments and insights** | Partial. AI Insights proposes and applies hero and announcement drafts. No code links it to experiments. | Depends on OQ-20. By default, an AI proposal can start a draft experiment through COM-13. | Decision 1 names this, and the term is undefined until OQ-20 answers. |
| **Chat and third-party embeds** | **None.** Only GA4 and Meta forwarding exist. | **None, unless OQ-21 changes this.** | Theme app embeds do not carry over (inferred). |
| **Offers and discounts** | Partial. Four offer types plus bundles. No coupon limits. No free-shipping offer type. Cart-only visibility. | Plain-language setup, on-page callouts, progress nudges. | No usage or per-customer limits. No segments. New types are out of scope. |
| **Reviews** | **None.** No table, UI, import or rating in JSON-LD. | **None, unless OQ-07 changes this.** | **A real blocker.** Inferred, not tested: Shopify theme widgets do not render on this storefront, so a founder moving to Storeasy loses their reviews display. |
| **Loyalty** | **None.** No points, referrals or tiers for shoppers. | **None, unless OQ-07 changes this.** | Same blocker. |
| **Email and SMS marketing flows** | Not covered. Two automation triggers only, no abandoned cart. | Not covered. | Out of scope. Founders will count this when cancelling apps. |
| **Subscriptions** | Not built. | Not built. | Out of scope. |

---

## 10. Success Metrics

**All thresholds are hypotheses.** No baseline from real founders exists. The first sessions set the real numbers.

### Primary benchmark: the five timed founder tasks

**Method.** A moderated session with 5 founders, or people who match the description, on a seeded test store (`pnpm dev:design`). Each task is timed from the moment it is read out to the moment the change is visible on the public page. No help is given. A task counts as helped if the moderator speaks. Record the screen. Repeat after each major change to the editor.

| # | Task | Done means | Baseline from code reading (clicks, not time) | Hypothesis target |
|---|---|---|---|---|
| 1 | **Change the hero** title and button text | New text live, checked on the Mobile preview | 7 clicks, 2 screens, 1 dialog | Under 60 seconds, at most 4 clicks plus typing |
| 2 | **Put a bundle on the home page**, using an existing bundle | Bundle visible on live home, checked on the Mobile preview | Impossible as a block. At least 15 clicks plus typing as a banner link (estimated). | Under 2 minutes |
| 3 | **Start an offer**: buy 2, get 1 free on a chosen product | Offer applying in a real cart | About 5 or more clicks, raw target values (estimated) | Under 3 minutes |
| 4 | **Fix a typo** on a policy page, starting from the live page | Fix live, and a half-finished home draft not live | 7 clicks, and it ships all other drafts | Under 60 seconds, at most 4 clicks plus typing |
| 5 | **Undo** the last change, once from the same document and once starting from a different one, where the founder does not remember which document changed | Previous version live, and the next Publish does not re-ship it | 3 clicks after finding the release by time and hash, and the next Publish re-ships it | Under 60 seconds |

**Pass.** 4 of 5 participants finish each task unaided, within target. Below that, fix before adding features.

### Leading indicators

| Metric | How measured | Hypothesis target |
|---|---|---|
| Publish success rate | `publish_log` plus validation failures, per tenant | Over 90% of publish attempts succeed first try |
| Share of publishes that are single-document | `publish_log`, grouped by `set_id` | Most are. If not, the per-document model is not matching how founders work. |
| Undo use | `publish_log` | Used, and followed by a successful publish. Heavy use may mean preview is not trusted. |
| Preview failures shown | Console event on a failed preview update | Falls over time. Zero silent failures, by test. |
| Time to first publish after connect | Timestamps: first sync done, first publish | Same day (hypothesis) |
| Commerce block placement | Count of documents referencing a bundle, offer, quiz or rail (`document_refs`) | At least one per active store within 30 days |
| Raw-identifier inputs left | Static check | Zero |
| Live read cost | PERF-04 on the hosted runtime | Budget set after the first measurement |

### Lagging indicators

| Metric | How measured | Hypothesis target |
|---|---|---|
| Founders editing alone | Publishes by the founder's own account, with no support contact that week | Weekly on 50% of active stores |
| Paid apps cancelled | Ask at day 30 and day 90. No system can see this. | At least one per store, on 3 of 5 stores |
| Revenue through commerce blocks | COM-12, with its coverage stated | Reported for every store with consented traffic |
| Support requests for content changes | Count, in whatever support channel exists | Falls as the editor ships |
| Store retention | Billing state per tenant | Set once there are enough stores to measure |

---

## 11. Dependency Map

**No phases and no dates.** This shows what must exist before what, and what can run side by side. The owner phases from here.

### What each requirement needs

| Requirement | Needs first | Why |
|---|---|---|
| **DOC-01 to DOC-05** | Nothing | The foundation |
| **DOC-06, DOC-07** | DOC-01, DOC-03 | Merged library and hero section are registry declarations |
| **DOC-08** | DOC-01 | Lists versions |
| **DOC-09, DOC-11** | DOC-01, DOC-03 | |
| **DOC-10** | DOC-01, PUB-02 | Slug and redirects publish together |
| **DOC-12** | DOC-01 | New tables to export |
| **DOC-13** | PUB-01 | Aggregate hash for approvals |
| **DOC-14** | DOC-06 | |
| **DOC-15** | DOC-08 | |
| **PUB-01** | DOC-01 to DOC-05 | The new reader |
| **PUB-02, PUB-09** | PUB-01. Built as one unit, because the panel is the confirm. | |
| **PUB-03, PUB-05** | PUB-01, PUB-02, DOC-03, DOC-04. Built as one unit, because "publish both" is a check's fix. | Issues link to fields from the registry |
| **PUB-04** | PUB-02, DOC-08 | Undo sends founders to "Earlier versions". Whole-set Undo also needs PUB-05. |
| **PUB-06** | PUB-01, and the `cms_state` table from the expand step in 8.11 | New reader state, selected by mode |
| **PUB-07** | PUB-02, PUB-03 | |
| **PUB-08** | PUB-01, MIG-01's mapper | Restore materializes old rows |
| **PUB-10** | ED-02 | Editors state the rule |
| **PUB-11** | PUB-02, PV-03 | |
| **PUB-12** | PUB-05, PUB-06 | |
| **PUB-13** | PUB-09, ED-02 | |
| **PV-01, PV-02** | DOC-04, DOC-05, PUB-01 | Tolerant drafts and structured errors |
| **PV-03** | DOC-01, PUB-01 | Overlay on the new list, reading the saved draft |
| **PV-04, PV-07, PV-08** | PV-03 | |
| **PV-05** | PV-03, ED-02. Its hosted target also needs OQ-19. | |
| **PV-06** | PV-03, SURF-03 | |
| **PV-09** | PV-02, TREE-01 | |
| **ED-01** | Nothing | |
| **ED-02** | DOC-01, DOC-02, DOC-03, PV-03 | One store over one model |
| **ED-03** | ED-02, PUB-02 | Publish flushes saves. Retiring the candidate table needs both PV-03 and ED-03. |
| **ED-04** | ED-03, DOC-03, PUB-09 | Field attribute, and the 3-click publish |
| **ED-05** | ED-02, ED-12. Ships together with MIG-03. | |
| **ED-06 to ED-09** | ED-02 | |
| **ED-10** | ED-02, ED-03 | |
| **ED-11** | SURF-03, SURF-06, SURF-07, SURF-08, OVL-07, COM-10 | The full form of each concept |
| **ED-12** | ED-02, DOC-03 | Forms generated from the registry |
| **AU-01** | ED-02 for the final home. The editor component can be built earlier. | |
| **AU-02** | DOC-04, ED-02 | Shows structured issues |
| **AU-03, AU-04** | DOC-03, DOC-07 | Headline field kind and valid defaults |
| **AU-05** | Nothing | |
| **AU-06** | DOC-04, AU-02 | |
| **AU-07** | ED-02, TREE-02 | |
| **AU-08** | AU-07 | |
| **TOK-01** | Nothing | Defines the roles and touches storefront components only |
| **TOK-02** | TOK-01 | The matrix runs over TOK-01's roles. They share one exit check. |
| **TOK-03** | DOC-02, PUB-02. Not TOK-01. | The version 4 reader needs `doc_design` from the first cutover. |
| **TOK-04 to TOK-10** | TOK-01, TOK-02. TOK-05 and TOK-07 also need DOC-03. | Tones and steps are setting kinds |
| **TREE-01** | DOC-03 | Bindings live in the registry |
| **TREE-02 to TREE-07** | DOC-03, ED-02 | |
| **SURF-01** | DOC-03. Ships with or before SURF-03. | Protected flag in the registry |
| **SURF-02** | DOC-03 | |
| **SURF-03 to SURF-08** | SURF-01, DOC-06, TREE-02, ED-02, PV-03 | |
| **SURF-09** | SURF-01, TOK-01 | |
| **SURF-10** | SURF-02 | |
| **SURF-11** | DOC-01 | |
| **SURF-12** | Nothing | |
| **COM-01, COM-02** | TREE-01, DOC-03, ED-02, PUB-03 | Top-level section kinds, so not TREE-02 |
| **COM-03** | RefPicker as it is. Its entry in "Recently published" needs PUB-04. | |
| **COM-04, COM-05, COM-07, COM-08, COM-09, COM-10, COM-11, COM-14** | COM-01. COM-05 also needs COM-06. COM-09 also needs OQ-17. | |
| **COM-06** | OQ-23 | Engine change |
| **COM-12** | Event names only | |
| **COM-13** | COM-01, DOC-02, DOC-07 | |
| **COM-15** | COM-02 | |
| **COM-16** | Nothing | |
| **COM-17** | COM-11 | |
| **OVL-01** | Owner answer on OQ-01 | Field list |
| **OVL-02** | OVL-01, DOC-01, DOC-02, PUB-02 pattern | Versioned document, live row |
| **OVL-03** | OVL-02, MIG-05 | The read needs the table, on every tenant |
| **OVL-04** | OVL-02, ED-02, AU-01 | |
| **OVL-05** | OVL-03 | Search reads effective values |
| **OVL-06** | MIG-05 only. **Must ship before any title override reaches shoppers.** | |
| **OVL-07** | OVL-02, OVL-03, ED-12 | |
| **OVL-08 to OVL-12** | OVL-02, OVL-03 | |
| **OVL-13** | OVL-02, OVL-03, MED-03 | |
| **OVL-14** | OVL-02, OQ-05 | |
| **OVL-15, OVL-16** | Nothing | Sync changes |
| **OVL-17** | OVL-05, PUB-04. If OQ-16 says Typesense is on, it ships before title overrides reach those shoppers. | |
| **SHOP-01 to SHOP-06** | Nothing | Tests on existing code. SHOP-02 extends once OVL-03 exists. |
| **META-01, META-02** | Nothing in the CMS. Dev-store checks (OQ-14). | |
| **META-03, META-04** | META-01, TREE-01, ED-02 | |
| **GEN-01, GEN-04** | DOC-02, DOC-03, DOC-07, GEN-02, TOK-01, TOK-02, TOK-03, MED-01, PUB-05, PUB-06, and the header and footer document types. Built as one first-run flow. | Writes valid documents with a brand, then publishes as a set |
| **GEN-02** | Nothing to build. Its durable path needs a running tick (OQ-19). | Job queue plus console state |
| **GEN-03** | Nothing | Copy work |
| **GEN-05, GEN-07** | GEN-01 | |
| **GEN-06** | GEN-01, PUB-05 | |
| **GEN-08** | ED-02 | Links point to the new editor |
| **GEN-09** | Outside the CMS. Owner ruling OQ-06. Touches hosting, which stays last. | |
| **GEN-10** | GEN-01 | |
| **GEN-11** | GEN-01, SHOP-01, OQ-14, OQ-22 | |
| **GEN-12** | GEN-04, OQ-14 | |
| **MED-01** | Nothing | |
| **MED-03** | DOC-01, DOC-03 | Reads `document_refs`, extracted through the registry |
| **MED-02, MED-04, MED-05, MED-06** | Nothing | MED-05's CDN test belongs with hosting |
| **PERF-01** | PUB-01, DOC-01 | |
| **PERF-02** | PUB-09 | Uses the same stored hashes |
| **PERF-03, PERF-05, PERF-07** | PERF-01, PERF-04, and a hosted runtime (OQ-19) | |
| **PERF-04** | Nothing for the local baseline. A hosted runtime for the after numbers (OQ-19). | |
| **PERF-06** | Nothing | |
| **MIG-01** | DOC-01 to DOC-05, DOC-07, MIG-05 | |
| **MIG-02** | MIG-01, PUB-01, PV-03 | The pin renders an unflipped release |
| **MIG-03** | See the cutover gate below. | |
| **MIG-04** | MIG-03 | |
| **MIG-05** | Nothing | |
| **MIG-06** | Every tenant cut over, and the rule in 8.11 | |

Every requirement ID in section 7 is a subject of one row above. This was checked by a script when this spec was last edited, and it should be checked again after any change.

### The cutover gate

**Moving a real tenant (MIG-03) needs all of:** DOC-01 to DOC-05, DOC-07, PUB-01 to PUB-06, PUB-09, ED-02, ED-03, ED-05, ED-12, TOK-03, OVL-02, OVL-03, OVL-07, MED-03, MIG-01, MIG-02, MIG-05, and DOC-13 for any tenant using approvals.

ED-12's plain forms are the floor, so the composable versions of those screens (SURF-06, SURF-07, SURF-08, COM-10, all P1) do not hold up cutover. New tenants can use documents before old tenants move.

### The critical chain

```
DOC-01 → DOC-02 → DOC-03 → DOC-04 → DOC-05
                     ↓
PUB-01 → PUB-02 + PUB-09 → PUB-03 + PUB-05 → PUB-06 → PUB-12
   ↓          ↓
   ↓       PUB-04 (also DOC-08)
   ↓
PV-03 → ED-02 → ED-03 → ED-04
          ↓
        ED-12, AU-01, AU-02

DOC-03 → TREE-01 → COM-01 → COM-02 (also ED-02, PUB-03)
DOC-02 + PUB-02 → OVL-02 → OVL-03 → OVL-04 (also ED-02), OVL-05
GEN-02 + PUB-05 + PUB-06 + TOK-03 → GEN-01 + GEN-04
The cutover gate → MIG-03 + ED-05
```

### Can start now, in parallel, with no foundation

These do not depend on the document model. Each stands on its own.

- **ED-01** full-width shell, after a browser check of the 342px claim
- **AU-05** page editor data loss
- **DOC-04's error split** (validation versus infrastructure) in the current API
- **SHOP-01 to SHOP-04, SHOP-06** boundary tests, dead code and the test gate
- **TOK-01** tokenisation sweep, after taking the screenshot baseline
- **GEN-02, GEN-03** resumable sync and neutral copy
- **MED-01** phone photo upload
- **COM-03** offer form. **COM-06** once OQ-23 is answered.
- **MIG-05, then OVL-06** the deploy rule, then order columns and reports
- **PERF-04** local baseline
- **The harness fix** in section 8.15, so drills run on the edge runtime with no code edit
- **The riskiest-assumption test** in section 12

### Can run side by side once the foundation exists

- **PUB** and **TOK-02 to TOK-10**
- **ED** and **OVL-02, OVL-03**: the editor UI for products waits for ED-02, but the read layer does not. OVL-07 waits for ED-12.
- **COM** blocks and **SURF** composition, sharing TREE-01
- **MED-03** and **ED-12**, both needed by the cutover gate
- **META** and everything else, except META-03 on ED-02
- **GEN** starters and **PV** speed work

---

## 12. Risks

### Riskiest assumption

**Founders will edit the store themselves and trust Storeasy enough to cancel paid apps.** The whole build rests on this, and no data exists. Two sub-risks: founders may prefer to pay someone to edit, and they may keep apps because reviews and loyalty are missing.

**How to test it cheaply, before most of this is built.**

1. **Recruit 5 founders** on Shopify, ideally paying for at least two apps. Ask for their real app list and monthly bills. This alone answers which categories matter.
2. **Run the five tasks on a clickable prototype of the shell,** built on the design harness, with the real preview. Time them. This tests whether the shape works before the data model exists. Also run them on today's console for a real baseline.
3. **Show the matrix in section 9.** Ask which apps they would cancel, and what stops them. Ask whether a missing reviews feature ends the conversation.
4. **Ask for a commitment,** such as moving one real store by a named date.

**Decision rule, a hypothesis.** If fewer than 3 of 5 would cancel at least one app, or if reviews stop most of them, reopen OQ-07 and the commerce block priorities before investing further. This needs only time with founders, not engineering.

### Other risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **Migration changes a live store** | High | Medium | Equivalence check, one canary, no dual-write, per-tenant reversal, nothing new published (MIG, 8.11). |
| **Cutover strands a founder with no way to edit something** | High | Medium | Cutover is refused until every type holding content has an editor (MIG-03, ED-12). Old screens redirect (ED-05). |
| **A store opens with no way to pay or no policies** | High | Medium | "Before you open your store" (PUB-12). |
| **`libsql.batch` atomicity behaves differently through the wrapper or over HTTP** | High | Medium | Prove with a concurrency test first (8.6). Unused in the code today. |
| **The token sweep breaks the look of live stores** | Medium | High | Screenshot baseline taken before the sweep, compared on both kits. Sweep before adding options. It touches many files. |
| **Scope.** 161 requirements is a lot. | High | High | Priorities and the dependency map exist so the owner can cut. Foundation first, then the five tasks. Do not widen before the benchmark passes. |
| **A title override confuses order fulfilment** | Medium | Medium | OVL-06 ships before any override reaches shoppers. Shopify packing slips still show the Shopify title. If Shopify emails customers on these orders, they see that title too (not verified, OQ-14). |
| **Per-document publishing creates inconsistent stores** (home links to an unpublished campaign) | Medium | Medium | Reference checks and "publish both" (PUB-03, PUB-05). Undo can degrade, and shows a warning. |
| **Undo surprises a founder with newer work,** because it replaces the draft. | Medium | Low | Newer edits are saved first as a version the cap cannot prune, and the founder is told (PUB-04, DOC-08). Assumption to confirm, OQ-02. |
| **Edge memory or Turso latency undermines the read design** | Medium | Unknown | Measure first (PERF-04). The cache has a byte limit. It works correctly with no cache at all. |
| **Autosave load on tenant databases, and conflict noise across tabs** | Low | Medium | Pause before saving, one row per document, checkpoints capped. |
| **Rich text or drag library is incompatible with React 19, or heavy** | Low | Low | Check before committing. Console bundle only. The storage format stays HTML, so the editor can be swapped. |
| **Self-serve first run blocked by Shopify app review** | High for the promise, none for the CMS | Unknown | GEN-09 is separate. Generation works with operator connect. Not verified against current Shopify rules (OQ-06). |
| **The 5-minute job tick is mistaken for exact scheduling** | Low | Medium | The console promises a window. A real scheduler belongs with hosting. |
| **Generated legal text is wrong** | High | Medium | Bound to settings, flagged for review, never auto-published (GEN-06). Legal review of templates is an owner action. |
| **Prompt injection through merchant product text in AI generation** | Medium | Low | Keep the existing data boundary, PII guard and registry validation (GEN-05). Drafts only. |
| **Experiment cookie classification under India's data law** | Medium | Unknown | Not a legal conclusion. Flagged in OQ-17 before experiments widen. |
| **Reviews gap stops migration from Shopify themes** | High | High | Inferred, not tested. Test in the founder sessions. Owner rules in OQ-07. |
| **Self-reported review packets hide defects** | Medium | Medium | The S59 packet's cause was wrong. Reviewers re-read code. Browser drills are required for founder-facing work. |

---

## 13. Open Questions

Each has a default, so building does not stall unless marked blocking. "Blocking" names what it blocks.

### For the owner

| ID | Question | Default in this spec | Blocking? |
|---|---|---|---|
| **OQ-01** | **Confirm: product title can be overridden, with the URL handle tied to Shopify.** You said "every piece of content" and did not object, but this is an assumption. The risk: Shopify admin, packing paperwork and Shopify-sent mail show the Shopify title while Storeasy shows the edited one. Mitigation is OVL-06. Also confirm the field boundary in OVL-01, especially that tags and product type stay Shopify-only for logic. | Title overridable. Field table as written. | **Blocking for OVL-01's title row only.** The other fields can proceed. |
| **OQ-02** | **Assumption to confirm.** Undo sets the draft to the restored version and keeps newer edits as a saved version. This follows from the agreed Undo: G2, PUB-04 and benchmark task 5 all rest on it, and the alternative re-ships the undone change on the next Publish. Tell us if you disagree. The one real question: should the founder be asked before newer edits are moved aside? | Yes to the assumption. The founder is told, and is not asked first, because nothing is lost. | Non-blocking |
| **OQ-03** | Should money rules (offers, bundles, quizzes) stay outside document versioning? So Undo on a page does not rewind an offer. | Yes. Records stay live, and pages hold references. | Non-blocking |
| **OQ-04** | Should store name, support contact and legal name stay "apply immediately" from Settings, or use Publish? | Immediately. The logo lives in the design document and uses Publish (GEN-04). | Non-blocking |
| **OQ-05** | Can collection title, description and image also differ from Shopify? Decision 5 names products only. | Pins and layout only. Text overlay is P2. | Non-blocking |
| **OQ-06** | When should self-serve sign-up, a shared Shopify app and self-serve domains happen? They touch hosting and may need Shopify review. Until then, an operator connects each store and sets up each domain, and the founder is told so honestly. | P1 and separate. Generator works without it. | **Blocking for the public promise "connect and go"**, not for the CMS. |
| **OQ-07** | **Reviews and loyalty: build, integrate, or leave out?** Founders may not cancel apps without these. Neither was in the brainstorm. | Left out of this build, and stated openly in section 9. | **Blocking for any claim that founders can cancel those apps.** Answer after the founder test. |
| **OQ-08** | Should shoppers be able to choose a variant inside a bundle? A founder replacing a bundle app will expect it. It needs a bundle model change. | P2 | Non-blocking |
| **OQ-09** | Should the old Shopify title still match in search after a retitle? | Effective title only. | Non-blocking |
| **OQ-10** | In GA4, should `item_name` be the edited title or the Shopify title? | Edited title, plus a stable product id parameter. | Non-blocking |
| **OQ-11** | Which tenant is the migration canary, and may engineers read real tenant sizes for PERF-04? `pavos` onboarding was recorded as mid-flight in earlier notes. Its current state was not checked. | Canary chosen with the owner. Design harness until then. | **Blocking for the first real cutover.** |
| **OQ-12** | Is phone editing important enough for ED-10? No data exists. | P1, quick tasks only. Ask in the founder sessions. | Non-blocking |
| **OQ-15** | How long should old releases and versions be kept, and how stale can the live pointer be? | Checkpoints cap at 20 from day one. Published, migrated and Undo-saved versions, and release rows, are kept until measured. Pointer staleness of zero. | Non-blocking |
| **OQ-16** | Is Typesense guaranteed on the platform, or is search SQL only? This changes what "fast search replaces an app" honestly means. Env files were deliberately not read, and the code comment calls the free cluster dead. | SQL must be good alone. Typesense optional. | Non-blocking, but affects section 9. |
| **OQ-17** | The experiment `_unit` cookie is set regardless of consent and treated as functional. Is this acceptable under the store's DPDP position, before experiments widen and before any returning-shopper use? This needs counsel, not engineering. | Unchanged for hero tests. No widening without an answer. | **Blocking for COM-09** and for widening in COM-13. |
| **OQ-18** | Product and collection content live outside the release, so whole-store restore does not rewind them (section 8.4). Accept? | Yes. The advanced screen says so. | Non-blocking |
| **OQ-19** | May a private staging deploy of one test tenant happen before the hosting phase, purely for measurement and the job tick? It is not the hosting phase. Without it, hosted numbers and a running tick wait for the hosting phase. | No deploy until you say so. PERF-04's after numbers, PV-05's hosted target, PERF-03, PERF-05, PERF-07 and GEN-02's durable path wait. | **Blocking for those items only.** |
| **OQ-20** | What does "AI experiments" in Decision 1 mean: AI proposes hero variants that run as experiments, or something else? No code links the two today. | AI Insights proposals can start a draft experiment through COM-13. | Non-blocking |
| **OQ-21** | Should founders get an approved embed slot for chat and other third-party scripts? Theme app embeds do not carry over (inferred). This trades founder freedom against page speed and privacy. | Left out of this build, and stated openly in section 9. | Non-blocking, but affects section 9. |
| **OQ-22** | Is importing the founder's Shopify policies, pages and blog (GEN-11) required for launch? | P1. Needs the read scope checked on a dev store. | Non-blocking |
| **OQ-23** | When a free gift is sold out, what should happen? This changes engine behaviour (COM-06). | No gift, and nothing promised. The founder is told. | Blocking for COM-06 only |
| **OQ-24** | Should enabled quizzes appear in the sitemap? | Yes. | Non-blocking |
| **OQ-25** | Who reviews the legal templates in GEN-06? | Review required before GEN-06 ships. | Blocking for GEN-06 only |

### For engineering, by test

| ID | Question | How to answer | Blocking? |
|---|---|---|---|
| **OQ-13** | Which AI model and API features suit store generation, at what cost? | Try against current documentation, on real catalogs. | Blocking for GEN-05 only |
| **OQ-14** | On a Shopify dev store: exact scope names for metaobjects and shop brand fields. Does a product metafield edit fire `products/update`? Query cost of metafields. Does Shopify email customers on orders completed from draft orders? Do CDN image URLs change their query string without a content change? Does a stored Shopify image URL break after the image is deleted? Exact read scopes and paths for Shopify policies, pages and articles (GEN-11). | One dev-store session | Blocking for META-02, GEN-11, GEN-12, and OVL-04's URL normalization |

---

## 14. Evidence Appendix

**How this was checked.** Four read-only code mapping passes covered the content core, the editor and console, product data and the Shopify boundary, and commerce surfaces and first run, all at commit `c47045f`. The spec author then re-read the files marked below and ran one read-only probe of the validator. No dev server was started, nothing was deployed, no secrets or env files were read, and no existing test suite was run for this spec. Three independent reviews (founder, engineering and completeness) then challenged the draft, and each finding's citations were opened in code before it was applied or rejected.

### 14.1 Key verified facts

| Fact | Evidence | How checked |
|---|---|---|
| A hero title and mismatched highlight pass validation | `lib/cms/validate.js:24-42` | **Ran** by spec author: `ok:true` |
| The validator has never had a highlight rule | `git log -G'highlight' -- lib/cms/validate.js` shows only the Session 23 commit | **Ran** by spec author |
| A mismatched highlight silently loses its accent | `app/(storefront)/page.js:19-29` | **Read** by spec author |
| The S59 packet states a highlight mismatch caused the 422 | `docs/cms-reviews/S59-live-preview.md:52-55` | **Read** by spec author. Contradicted by the two rows above. |
| 4 of 6 home kinds fail validation on add | `components/admin/cms/Designer.js:502-509`, `lib/cms/validate.js:55-88` | **Ran** by spec author: banner, rich_text, image_with_text and product_rail fail |
| 500 sections pass validation | `lib/cms/validate.js:44-118` | **Ran** by spec author |
| A failed preview push shows nothing | `components/admin/cms/Designer.js:289-297` | **Read** by spec author |
| Every non-conflict exception returns 422 | `lib/admin/cms-api.js:173` | **Read** by spec author |
| Publish ships all drafts | `lib/releases.js:46-139`, `lib/releases.js:359-398` | **Read** by spec author |
| Publish validation is narrow and does not re-run validators | `lib/releases.js:165-215` | **Read** by spec author |
| Rollback flips the pointer, accepts any release, and leaves drafts alone | `lib/releases.js:444-451`, `scripts/test-releases.js:106` | **Read** by spec author |
| Pointer flip has no expected-value check, and is two updates | `lib/releases.js:347-352` | **Read** by spec author |
| No `.transaction(` or `.batch(` in `lib` or `app` | Grep | **Ran** by spec author |
| A live page reads the pointer and the whole release row | `lib/releases.js:296-329`, `lib/content/resolve.js:46-65` | **Read** by spec author |
| With no release, drafts serve to shoppers | `lib/content/resolve.js:63` | **Read** by spec author |
| A valid preview shows all drafts | `lib/content/resolve.js:55-60` | **Read** by spec author |
| A version 4 row through today's helpers would look empty | `lib/content/presentation.js:9-34`, `lib/content/resolve.js:67` | **Read** by spec author. Reasoned, not run. |
| Unknown binding source returns collections | `lib/cms/section-data.js:36-42` | **Read** by spec author |
| Registry-only home kind loses custom settings | `lib/cms/validate.js:105-116` | **Read** by spec author. Not run with a temporary kind. |
| Experiment adopt writes the payload as the whole hero | `lib/experiments.js:291` | **Read** by spec author |
| Line items carry only variant, quantity and gift discount | `lib/shopify-push.js:84-96` | **Read** by spec author |
| Exactly six production mutations, none on content | `lib/shopify-push.js:155-168`, `lib/order-cancel.js:43`, `lib/platform/shopify-webhooks.js:111-121`, `lib/shopify-admin.js:105-106` | **Grep** by spec author |
| OAuth scopes hold no content write | `lib/platform/oauth.js:70-78` | **Read** by spec author |
| No metafield code exists | Grep across `lib`, `app`, `components`, `scripts`, `migrations` finds only `docs/shopify-order-sync.md` | **Ran** by spec author |
| Cart reads catalog titles directly | `lib/cart.js:56-77` | **Read** by spec author |
| Search index reads raw products | `lib/sync.js:225-240` | **Read** by spec author |
| SQL is the declared supported search engine | `lib/repo.js:231-235` | **Read** by spec author |
| Media bytes are DB blobs, 1.5MB raster limit | `lib/media.js:15-21`, `migrations/tenant/0008_media_pages.sql:3-25` | **Read** by spec author |
| Media route has immutable caching, no `If-None-Match` handling | `app/api/media/[id]/route.js:12-34` | **Read** by spec author |
| Derivatives are generated client-side. `sharp` is a dependency but used only in two scripts. | `lib/media.js:8-10`, `package.json:89`, grep | **Read** by spec author |
| Export list is fixed and misses `order_items`, `page_redirects` and at least ten other tenant tables, though its comment says "Every table a tenant OWNS" | `lib/platform/export.js:23-48` against table names in `lib/schema.sql` and `migrations/tenant/*.sql` | **Compared** in spec review |
| The maintenance bypass checks that a cookie exists, not that it is valid | `app/(storefront)/layout.js:208` | **Read** in spec review |
| Transport retries cover `batch` and include "timed out", though the comment says the request never reached Turso | `lib/db.js:15-31`, `lib/db.js:48` | **Read** in spec review |
| Control-plane config is cached per instance, up to 5 minutes in an outage | `lib/platform/control.js:34-38`, `lib/platform/control.js:153` | **Read** in spec review |
| Sync holds the whole catalog in memory, the tick route has a 60-second limit, and the worker has no sync handler | `lib/sync.js:369-392`, `app/api/jobs/tick/route.js:15`, `lib/platform/worker.js:60-105` | **Read** in spec review |
| Safe-delete media scan reads draft tables and release bodies, so it would miss files used only in version 4 documents | `lib/media.js:158-190` | **Read** in spec review. Consequence reasoned, not run. |
| Browser drills ran on Node through a temporary code flip, and `docs/` holds no recordings | `docs/cms-reviews/S57-browser-drill.md:3-6`, `docs/cms-reviews/S59-surface-designer.md:45`, `docs/cms-reviews/S61-chrome-variants.md:40`, `find docs` | **Read and listed** in spec review |
| `main` is 92 commits ahead of `origin` | `git rev-list --count origin/main..main` | **Ran** in spec review |
| Console main is capped at `max-w-5xl`, and the editor's grid sits inside it | `components/console/nav/ConsoleShell.js:127`, `components/admin/cms/Designer.js:1003` | **Read** by spec author. 342px is computed, not seen. |
| Sidebar has 23 items | `components/console/nav/SidebarNav.js:63-115` | **Read** in spec review |
| Connect is operator-gated, one custom-distribution app per tenant | `app/api/connect/shopify/start/route.js:7-23` | **Read** by spec author |
| Only one GitHub workflow exists, and it is the job tick | `.github/workflows/jobs-tick.yml` | **Listed** by spec author |
| No Playwright, rich text or drag dependency | `package.json:81-96` | **Read** by spec author |
| Hard-coded colour classes: about 630 to 700, against about 100 to 115 accent classes | Grep | **Counted** twice. A narrower path set by the spec author gave 626 and 103. A wider pass gave about 700 and 115. |
| Hero click path: 7 clicks, typo: 7 clicks | Mapping pass, tracing from `components/console/nav/SidebarNav.js:88` through `components/admin/ReleasesAdmin.js:319` | **Code trace only.** No browser. |
| Contrast figures: 1.12:1, 2.08:1, 3.11:1 | `lib/brand.js:136-142` | **Ran** in the mapping pass. Spec author did not re-run. |
| Synthetic parse: 5.88MB in about 2ms | Mapping pass probe on a Mac under Node 26 | **Ran** in the mapping pass. Says nothing about edge memory or Turso transfer. |
| Harness data: 2 releases, 1,094 and 1,374 chars | `.design-tenant.db`, read only | **Ran** in the mapping pass |
| Roughly 400KB per 5,000 edited products if placed in the release list | Arithmetic | **Inferred** |

All other `path:line` references in section 7 come from the mapping passes. They were confirmed to point at existing files within range by a script. Their content was not individually re-read by the spec author. Three independent reviews then checked many of them, and the wrong ones found were corrected. The rest remain unchecked by a person.

### 14.2 Not verified

**Not measured.**
- Real tenant release sizes, release counts and media volumes. Only the design harness was read. `pavos` and other Turso tenants were not read.
- Turso round-trip time, the cost of moving the release row from edge, and edge memory limits.
- Preview latency per edit, visual flash on reload, scroll preservation.
- Whether a soft refresh behaves inside the preview iframe.
- Quiz scans and bundle queries at catalog scale.

**Not seen in a browser.**
- The 342px Desktop preview, tablet overflow in the product designer, type scale reach, tap target sizes, all mobile behaviour. All computed from classes.
- The edge runtime. Every browser drill so far ran the storefront on Node.
- Visual quality of any storefront surface.
- Bundle and offer click counts, which are estimates.

**Not determined.**
- **The cause of the 422 seen live in the S59 drill.** The original request is gone. The code rules out a highlight check. Candidates: an empty title mid-edit, a bad link, an invalid section in the same push, or an infrastructure error returned as 422. The packet itself records `no such table` arriving as 422.
- Whether `ExperimentPing` records exposures from preview in practice. It renders with no preview check, but the ping was not traced.
- Whether React `cache()` memoizes in route handlers.
- Whether `libsql.batch` is atomic through this project's wrapper over the edge or HTTP client.
- Whether `generateMetadata` output is suppressed when the layout renders a closed page. PUB-06 avoids relying on it by making metadata neutral.
- Whether a libSQL batch has a statement limit that the set cap in PUB-05 must respect. The 200 is a hypothesis.
- Whether every `test:*` suite runs without network or secrets, which SHOP-06 needs.

**Not read in depth.**
- `lib/repo.js` internals beyond cited lines, Header and Footer variant code, line-by-line `CommercePanels`, `OfferForm`, `UpsellsAdmin`, `ExperimentsAdmin`, the `/approve` page body, seed scripts.

**Not knowable from this repo.**
- Environment settings: whether `TYPESENSE_HOST`, `ANTHROPIC_API_KEY` or `RESEND_API_KEY` are set in any deployment. Env files were deliberately not read.
- Shopify behaviour: scope names, webhook firing on metafield edits, query cost, customer emails on draft-completed orders, image URL stability, shared-app review. All from background knowledge.
- Whether Shopify theme-injected widgets could work on this storefront in any form. Inferred that they cannot. Not tested.
- Real paid-app prices, and which apps founders run.
- Any founder behaviour. No user data exists.

**Existing test suites** were not run for this spec. The October audit ran five of them at an older commit (`docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md:11-20`). That result is not current evidence.

### 14.3 Where the evidence contradicted the brainstorm

| Brainstorm said | Evidence says | What this spec does |
|---|---|---|
| Changing the hero made the highlight stop matching, and that caused the 422 and stale preview | A mismatch passes validation. No such rule has ever existed. The real bug is that all preview failures are silent and one invalid block fails the whole push. The specific 422 cannot be determined now. | PV-01, PV-02, DOC-04, AU-02's note, and AU-03. No validator fix. |
| Founder-facing Undo and restore can share one mechanism | Restoring an old row would rewind snapshot-held modules and pins, and the next publish would silently switch them back. | Restore materializes a new version 4 release instead (PUB-08, section 8.12). |
| Each live page parsing the whole snapshot is a cost | Parsing looks cheap in a synthetic test. Transfer is unmeasured. | The redesign is justified by per-document publishing, and PERF-04 measures first. |
| "A release becomes a chosen set of document versions" | Product content cannot fit: SQL search and sorting need a joinable table, and each edit would grow every release row. | Product and collection content are versioned documents, but with a live table instead of a release entry (8.4). Whole-store restore does not rewind them. |
| "Connect Shopify and immediately get a store" | No sign-up, an operator-gated connect, one custom app per tenant, a CLI for databases. | GEN-01 to GEN-08 work after operator connect. GEN-09 and OQ-06 surface the real gap. |
| Strong design tokens will prevent ugly stores | Tokens are mostly not applied. Controls reach less than their labels say. A dark theme passes the gate at 1.12:1. | TOK-01 and TOK-02 become P0 prerequisites. DOC-03 adds layout guards, because colour tokens alone do not stop ugly compositions. |
| "Every piece of product content" can differ | Tags, product type and handle drive offers, quiz and filters. Images have no stable id. Free gift text is copied into offers. SEO fields do not exist. | OVL-01 sets a boundary, with logic staying on raw values. |
| Undo is "rollback underneath" | Rollback is whole-site, leaves drafts so the change re-ships, can't name what was previously live, and accepts never-published releases. | Undo is per document with a new publish log (PUB-04). Rollback becomes an advanced tool (PUB-08). |
| Commerce blocks replace paid apps | Reviews and loyalty have no replacement at all. Inferred: theme widgets do not render here. | Stated openly in section 9. OQ-07 forces a ruling. |
| Publish is the model | With no release, every save goes straight to shoppers today. | PUB-06 makes new stores private. Existing open stores are migrated with no visible change. |
| Registry is on its way to source of truth | Its own header says nothing else may hard-code kinds, which is false. Page editor does not even import it. Failure modes are silent. | DOC-03 with a fake-type acceptance test. |
| Approvals stay in code without investment | They depend on a whole-draft hash that stops meaning anything after cutover. | DOC-13 keeps a small compatibility function. |
