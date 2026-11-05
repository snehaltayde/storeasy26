# P6 · POLICY-START · "Start a privacy page" and "Start a returns page" (PUB-12, GEN-06 partly, US-41)

Branch `cms/p6-policy-start`, cut from `7506c9e` (`cms/phase-1`). Both base merges are there: P5-FIX2 (`441b44d`) and P5-DRILLS (`211c982`). It builds on P6-FIXTURE (`536935f`, the documents fixtures and banned-copy rules) and P6-GEN-WRITE (`37efcd3`, `lib/documents/policy-pages.js`). Plan: `docs/cms-reviews/P6-PLAN.md` revision 4 (decision 10, owner answers OQ-P6-2 and OQ-P6-3).

This is the author's own report. Reviewers should re-read the code.

## Files

All in the plan's list:
- `lib/content/templates.js`: `returnsSentence`, `templatesFor`, `POLICY_STARTERS`. `PAGE_TEMPLATES = templatesFor()`.
- `lib/first-run/policy-start.js` (new): `startPolicyPage`, `markPolicyRead`, `starterBody`, and the founder words.
- `app/api/admin/policy-start/route.js` (new): `POST`.
- `scripts/test-policy-start.js`: replaces P6-FIXTURE's placeholder (27 tests).
- This packet.

No migration and no new dependency. Nothing under `.github/` changed. `PageEditor.js` and its page are not edited. `test-copy.js`, `test-page-editor.js` and `test-themes.js` are not edited. Nothing imports `lib/documents/opening.js`, `lib/first-run/brand-step.js` or `generate.js`.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` (102 of 102 suites) and `pnpm build` |
| Browser verified | **NOT DONE, nothing to see yet.** This item has no screen. P6-OPEN-UI (batch 3) adds the buttons to the "Before you open your store" panel, and P6-ONBOARD (batch 4) adds them to the checklist. Their drills (P6-DRILLS stages C and G) cover the browser |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

The owner answered OQ-P6-1 and OQ-P6-2: a store can't open without a privacy page and a returns page, and phase 6 offers to start them. A founder who has neither must never be stuck. This item builds the server side: one call makes a draft page from a template, for the founder to read and save. It also fixes the template's returns text, which said "within 7 days of delivery". The engine's real window is the store's `returns_window_days` setting (default 14), counted from the order date (`lib/returns.js` `returnsWindowDays()` and `returnEligibility`, which reads `order.created_at`). The old text was wrong on both the number and the starting day.

## Design

### templates.js (pure, client-safe)

- `returnsSentence(days)`: a whole number 1 to 365 gives "Unopened products can be returned within <days> days of your order." ("1 day" for 1). Anything else (0, negative, 366+, a fraction, a string, null) gives "Unopened products can be returned within our return window, counted from the day you order."
- `templatesFor({ returnsWindowDays, plain = false })`: the template list, built fresh on each call. Both returns sentences use `returnsSentence`: the terms template's "Refunds & returns" section and the FAQ's "What's the return policy?" answer.
- `PAGE_TEMPLATES = templatesFor()`. The legacy PageEditor can't read the setting, so it now shows the sentence with no number instead of "7 days". The export keeps its name and shape, so PageEditor and `test-page-editor`'s stub still work.
- `POLICY_STARTERS = { privacy: 'privacy', returns: 'terms' }` (frozen). The returns starter is the terms template (slug `terms`, title "Terms of service"), which `isReturnsSlug` matches.
- No number of return days is written anywhere in the file. A test scans the source for it.
- **`plain` (a change from the brief, see "Deviation" below):** with `plain: true`, the terms template's refund-timing sentence is "Refunds go back to the original payment method." without "within 5–7 working days". Without it (the default, and `PAGE_TEMPLATES`), the sentence is unchanged, so test-copy's ALLOWED entry (`/\d–\d working days/`) still matches. The FAQ's delivery and payment-method sentences are unchanged in both cases. No starter uses the FAQ.

### Deviation from the brief: the refund-timing sentence in the returns starter

The brief says to keep the refund-timing sentence as it is, and also requires that banned-copy `scanText` finds no BANNED hit in either starter body. Those two can't both hold: "within 5–7 working days" is caught by the BANNED rule "unset promise: delivery or refund days". That rule exists so the system never writes a day count no setting backs. So the starters call `templatesFor({ returnsWindowDays: returnsWindowDays(), plain: true })`. The returns starter says "Refunds go back to the original payment method." and makes no unset promise. The source keeps the literal sentence for the legacy list, so test-copy passes unchanged. The founder can add their own refund timing in the editor. The reviewer or owner should confirm this choice (owner check below).

### lib/first-run/policy-start.js (Node)

Both functions return `{ status, body }`, which the route sends as it is. Refusals are answers, not DocumentError codes (the file is outside `lib/documents`, so test-api-shapes' DocumentError scan doesn't apply). An error that isn't a refusal (the database didn't answer, the mode couldn't be read) is thrown, and the route's catch handles it.

**`startPolicyPage({ kind, actor })`, in order:**
1. `kind` must be `'privacy'` or `'returns'`, else 400 `UNKNOWN_POLICY_KIND` ("We can only start a privacy page or a returns page…").
2. `canEdit(actor)` (storefront.write, `lib/admin/entity-entry.js`), else 403 `READ_ONLY` with ENTRY_WORDS' read-only words. Staff may start a page. They can't publish it.
3. Documents mode only (`getCmsMode`). Legacy gives 409 `STORE_USES_LEGACY`: "This store still uses the current Storefront editor, so no page was started here. Its page templates are in Storefront." A legacy store keeps PageEditor's templates. Migrating gives 409 `STORE_MIGRATING` with `MIGRATING_MESSAGE`. The mode is checked here because `createDocument` doesn't check it.
4. `policyStatus(await readPolicyRows())[kind]`. Any state but `missing` gives 409 `{ code: 'POLICY_PAGE_EXISTS', error: 'You already have a privacy page: <title>. Open it to read it.', document: { id, title, state }, href: editorHref(id) }`. Nothing is written. An archived page doesn't count, so it doesn't block. A campaign or journal post isn't type `page`, so it doesn't count either.
5. The body: `starterBody(kind)` takes the template from `templatesFor({ returnsWindowDays: returnsWindowDays(), plain: true })`, read at the call. It goes through `pageBodyFromTemplate({ family: 'page', name: <template title>, sections })`, which gives fresh section ids, uses the registry adapter and re-validates. Then `meta.slug` is set to the template slug and `meta.description` to its description. Both keys are already in `emptyBody('page').meta`.
6. `createDocument({ type: 'page', body, actor: POLICY_STARTER_ACTOR })`, so `updated_by = 'system:policy-starter'`. That column is the "waiting for your review" mark. There's no schema change.
7. A slug clash (`SLUG_TAKEN`): the policy rule is read again. If a page of that kind now exists (a double click), the answer is `POLICY_PAGE_EXISTS` naming it. Otherwise the address belongs to something else, such as a campaign at `/terms`. Then the answer is 409 `SLUG_TAKEN` with the service's own words ("Another page already uses /terms: <title>"), `document: { id, title }` and `href: editorHref(<that id>)`. The founder can move that page's address and press Start again, and a test shows this works. Nothing is written.
8. Success: `{ ok: true, document: { id, revision, slug, title, kind }, href: editorHref(id), message }`. The message is "We started your privacy page from a template. It's a starting point, not legal advice: read it, change what you need and save it." ("returns page" for returns).

The page is never published and never put in a set. The module imports no publish, Shopify, AI, opening, brand-step or generate code (a test checks the imports).

**`markPolicyRead({ id, revision, actor })`** ("I've read it"):
- Order: 400 with no id, then 403 for read-only, then the mode (409), then one read of `type, archived_at, updated_by`.
- 404 when the page is gone. 409 `DOCUMENT_ARCHIVED` when it is archived. 409 `NOT_A_STARTER` when it isn't type `page`. 409 `ALREADY_SAVED` ("This page was already saved by you.") when its last writer isn't `system:policy-starter`.
- Then `saveDraft({ id, revision, body: <its current draft>, actor })` under the founder. The body and draft hash are unchanged, the revision goes up by one, and `updated_by` becomes `merchant:<id>`, so `policyStatus` gives `saved`.
- A stale revision gives saveDraft's 409 `DOCUMENT_CHANGED`, sent as documents-api sends it (`{ error: e.message, code, ...extra }`, with `current`). A missing revision gives 428 `REVISION_REQUIRED`.

### THE REVIEW RULE

A policy page counts for opening and onboarding when it is **live**, **in the publish set**, or a **draft whose last writer is not the policy starter**. That last case means the founder saved it in the editor, pressed "I've read it", or it is the founder's own text from the cutover (`system:cutover`). A starter draft that was created but never saved by the founder does not count, unless the founder publishes it in the set. The rule lives in `lib/documents/policy-pages.js` (`policyStatus`, P6-GEN-WRITE). This item writes the `starter` mark, and `markPolicyRead` is how a founder accepts a starter unchanged (the editor only saves after an edit).

### app/api/admin/policy-start/route.js (nodejs)

- `POST { kind }` starts a page. `POST { markRead: { id, revision } }` marks a starter as read. Exactly one key per request. Anything else gives 400 `BAD_REQUEST` in plain words: an extra key, a non-integer revision, both actions at once, or bad JSON. An unknown kind string reaches the op and gives its own 400.
- Uses `requireAdmin(request, 'storefront.write')` and `tenantHandler(...)`.
- On success it writes a best-effort audit row (`storefront.write`, `document:<id>`) and an `slog` line.
- The catch follows the console conventions. First its own known answer (`CMS_MODE_UNAVAILABLE` gives 503), then `infraResponse(e)`, then a plain 500.
- It has no links to old screens.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| With `returns_window_days` 10, the returns starter's text has "within 10 days of your order" and neither "7 days" nor "14 days". With the setting unset it equals `returnsSentence(returnsWindowDays())`, compared with the engine's own function. `templatesFor` with 0, `'x'` and 400 gives the no-number sentence. Static `PAGE_TEMPLATES` has no "N days of" and no "7 days" | DONE | test-policy-start sections 1 and 2: "returnsSentence…", "templatesFor binds both…; 0, 'x' and 400…", "PAGE_TEMPLATES … no 'N days of'…", "with returns_window_days 10…" (both `starterBody` and the created document), "with the setting unset…" (14 read from `lib/returns.js` in the tenant). Also through the real route. With the old templates.js (stub exports added so the import loads), 8 tests fail. Without the `returnsWindowDays()` read in policy-start.js (mutation M5), 3 fail |
| `startPolicyPage({ kind:'privacy' })` on a closed documents store makes one type `page` document: slug `privacy-policy`, updated_by `system:policy-starter`, revision 1, `published_version_id` null, no release. The body validates in draft and publish mode with 0 errors. policyStatus gives `starter` for privacy and nothing goes live. The returns starter has slug `terms` and status `starter` | DONE | Section 3: the full row, one checkpoint version, no `releases` and no `publish_log` rows, no live release in `release_state`, the exact answer, `validateDocument` in both modes with no issues, meta keys equal to `emptyBody('page').meta`, fresh section ids, and policyStatus for both kinds. The suite is new, so every test here fails without this change (the module didn't exist) |
| A second start of the same kind gives 409 POLICY_PAGE_EXISTS naming the first page, nothing written. The same for a founder-saved `refund-policy` page and kind returns. An archived privacy page doesn't block. A campaign at slug `terms` makes the returns start answer 409 with SLUG_TAKEN's words and an editor link to the campaign, nothing written. Legacy, migrating and read-only actors are refused with nothing written. An unknown kind is 400 | DONE | Section 4. Each refusal compares a full snapshot (documents, versions, releases, publish_log, document_refs) before and after. A double click (two calls at once) leaves one page and gives POLICY_PAGE_EXISTS. After the campaign moves to `terms-sale`, Start works. Mutations: without the pre-check (M1) the refund-policy test fails; with SLUG_TAKEN always mapped to POLICY_PAGE_EXISTS (M3) the campaign and double-click tests fail; without the mode check (M4) the legacy and migrating tests fail |
| markPolicyRead on a starter draft leaves the body unchanged, makes updated_by the merchant and policyStatus `saved`. On a founder-saved page it is 409. With a stale revision it is 409 and nothing changes | DONE | Section 5. Body and draft hash are equal, the row is `merchant:<id>` at revision 2, and the state is `saved`. ALREADY_SAVED is checked both on the marked page and on a founder's refund-policy page. The stale revision gives the same words as `Docs.saveDraft` (which documents-api sends) and the snapshot is unchanged. Also covered: 428, 404, archived, campaign, read-only, legacy, migrating. Without the starter check (M2) the founder-saved test fails |
| test-page-editor and test-themes pass unchanged. test-copy passes unchanged (its templates.js ALLOWED entry still matches). banned-copy `scanText` over both starter bodies finds no BANNED or CLAIMS hit | DONE | test-page-editor 61 passed, test-themes 10 passed, test-copy 54 passed, none edited. Section 7 scans both starter bodies on two stores with `shopper: true` (every BANNED rule plus CLAIMS) and finds nothing. With `plain` removed from the starter call (M6), the scan fails on "5–7 working days" (see Deviation) |
| The route passes the failure-matrix catch-order, console-fresh tenantHandler and legacy-routes literal-link walks. `pnpm test` passes (102 suites) | DONE | `pnpm test` with CHECKOUT_MODE unset: "Running 102 test suites", 102 of 102 passed. test-failure-matrix (125 passed), test-console-fresh and test-legacy-routes (29 passed) walk the new route. Section 6 runs the real route with real sessions: start, mark read, 400s, support session 403, no session 401, nothing written. `pnpm build` passes and lists `ƒ /api/admin/policy-start` |

## Tests

- `node scripts/test-policy-start.js`: 27 passed.
- `pnpm test`: 102 of 102 suites.
- `pnpm build`: passes.
- Mutations, each run once and then reverted. Each made the suite fail:
  - old templates.js: 8 failed;
  - M1, no pre-check: 1 failed;
  - M2, no starter check in markPolicyRead: 1 failed;
  - M3, every slug clash called POLICY_PAGE_EXISTS: 2 failed;
  - M4, no mode check: 2 failed;
  - M5, the window not read: 3 failed;
  - M6, no `plain`: 2 failed.

## Known limits

- **The starter text is fixed when the page is made.** A later change to `returns_window_days` doesn't change a saved page. The founder edits the page.
- **Not bound to a setting (GEN-06):**
  - the refund-timing sentence ("within 5–7 working days") in the legacy list. The starters leave the day count out (Deviation above);
  - the FAQ's delivery sentence ("3–5 working days");
  - the FAQ's payment-methods sentence;
  - the FAQ's "Start a return by replying to your order confirmation email", which doesn't name the account page's return request.
- **The legacy PageEditor shows the no-number returns sentence.** It can't read the setting. Binding the legacy editor is GEN-06.
- **The mode is read before the write.** `createDocument` has no documents-mode guard in its batch. If a store left documents mode between the read and the write, the draft could still land in the documents table. Founders can't trigger that move, and nothing reads the page on a legacy store.
- **The double-click case is proved by outcome only.** Two calls at once always leave one page and one POLICY_PAGE_EXISTS. Which path gave that answer (the pre-check or the SLUG_TAKEN mapping) depends on timing.
- **"Refunds go back to the original payment method."** This is the template's own claim, kept. For a cash on delivery order the founder may need to change it.
- **No screen yet.** The buttons come with P6-OPEN-UI and P6-ONBOARD.

## Owner checks

- **Legal review of both templates is an owner action (OQ-25).** Read the privacy and returns starters as a founder would, on a store with a non-default `returns_window_days`. The copy says they are starting points, not legal advice.
- **The returns starter has no refund timing.** Confirm "Refunds go back to the original payment method." with no day count is the wording you want, instead of the unset "within 5–7 working days" (Deviation above).
- **A starter page left untouched keeps the store from opening** until it is saved or marked "I've read it". Check that the panel and checklist words make this clear on a phone, once P6-OPEN-UI and P6-ONBOARD land.
