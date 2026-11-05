# P6 · ONBOARD · The first-run checklist on a documents store (GEN-04, PUB-12, US-01, US-41)

Branch `cms/p6-onboard`, cut from `eee9f2d` (`cms/phase-1`). Both base merges are there: P5-FIX2 (`441b44d`) and P5-DRILLS (`211c982`). All of batch 3 is merged, including P6-START-UI (`e3c4de6`), so `app/(console)/admin/(authed)/start/page.js` exists. It builds on P6-GEN-WRITE (`lib/documents/policy-pages.js`), P6-POLICY-START (`lib/first-run/policy-start.js`, `/api/admin/policy-start`), P6-BRAND (`config.onboarding.brand_step`) and P6-OPEN (`openingReport`). Plan: `docs/cms-reviews/P6-PLAN.md` revision 4 (decisions 9 and 10, owner answers OQ-P6-1, OQ-P6-2 and OQ-P6-3).

This is the author's own report. Reviewers should re-read the code.

## Files

All in the plan's list:
- `lib/admin/onboarding.js`: the "Start your store" step, the design step, the policies step with `actions`, and the Launch hint. Documents stores only.
- `components/admin/SetupAdmin.js`: renders a step's actions.
- `scripts/test-provision.js`: moved pins, 6 new tests (4 unit, 2 rendered), and a stronger legacy check.
- `scripts/test-legacy-routes.js`: one moved pin (`hrefs.brand`). The HREF_ALLOW regex is **not** changed: both literal expressions are still in onboarding.js.
- `scripts/test-design-doc.js`: two moved pins (the brand step's href on a documents store).
- This packet.

No migration and no new dependency. Nothing under `.github/` changed. No server op changed: the buttons use P6-POLICY-START's route as it is.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` (102 of 102 suites) and `pnpm build` |
| Browser verified | **NOT DONE.** No desktop Chrome drill was run for this item. The SetupAdmin render is proved in Node (Next's SWC, a hook driver and a fetch spy). P6-DRILLS stage G (batch 5) is the browser drill for the checklist starters. Owner check below |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

A founder on a new documents store follows the Setup checklist. Before this item it had three problems on such a store:
- It had no step for `/admin/start`, where the first store is made and the logo and colours are picked.
- The design step was done only when a design was live. A closed store has nothing live until it opens, so the step stayed open after the founder picked colours, and its hint said "then publish it".
- The policies step counted only published pages. On a closed store nothing is published, so the step could never be done, and it named an action ("from the editor") with no button behind it. Since the owner's answer to OQ-P6-1, missing policies block opening, so the checklist must offer the same fix as the "Before you open your store" panel.

## Design

### The review rule (owner answer, 2026-11-05)

A policy page counts when it is **live**, **in the publish set**, or **saved by the founder** (a draft whose last writer is not the policy starter: the founder saved it, pressed "I've read it", or it is their own cutover text). **An untouched starter draft never counts.** The checklist has no publish set, so on a closed store a kind counts when its `policyStatus` state is `live` or `saved`. This is the same `policyStatus(await readPolicyRows())` that PUB-12's `openingReport` uses (`lib/documents/policy-pages.js`), so the two cannot disagree. A test checks they agree at every stage.

### The steps (documents stores only)

- **Start your store** (new, first): `href: '/admin/start'`. Done when `doc_home` exists (any state), or when the catalog is empty and `config.onboarding.brand_step` is recorded (an object with `at`, saved or skipped). A read of `doc_home` that fails reads as absent: the step stays open. Hints: not done with products, "See the first version of your store, made from your products, then pick your colours and logo."; empty catalog, "Pick your colours and logo. Your home page fills in once your products come in."; done, "Your first home page is ready. Change anything from the editor."
- **Pick a theme & brand**: done when the live design has a brand or theme (as today) **or** the brand step is recorded. Links `/admin/start` on a closed and on an open store (the logo is changed there; the editor has no logo control). Hint: "Pick your colours and logo. They go live when you open your store." (closed) or "… They go live when you publish your design." (open).
- **Legal pages, closed store**: label "Add your legal pages". Done when privacy and returns each count (`live` or `saved`). Hint by state, in this order: done, "Your privacy and returns pages are ready."; a kind missing, "Your store can't open without a privacy page and a returns page. Start each from a template, then read it and save it."; otherwise the starter hint, "We started your privacy page from a template. It's a starting point, not legal advice: read it, change what you need and save it, or press I've read it if it is right as it is." (returns words for returns; with both starters, "your privacy page and your returns page … read each …").
- **Legal pages, open store**: today's label "Publish legal pages" and today's published rule (the live page list). Hints: done, "Your privacy and returns pages are ready."; a kind missing, "Shoppers need a privacy page and a returns page, and checkout links them. Start each from a template, read it, then publish it."; otherwise "Publish your privacy page and your returns page so shoppers can read them. Checkout links them." (the old hint, "… from the editor", was replaced so no documents-store hint sends the founder to the editor for a page).
- `href: documents ? PAGES_LIST_HREF : "/admin/storefront"` is kept exactly (HREF_ALLOW).

### `actions` (documents stores only)

The policies step gains `actions` (an array, empty when there is nothing to press):
- for each **missing** kind: `{ type: 'startPolicy', kind, label: 'Start a privacy page' | 'Start a returns page' }`;
- for each **starter** draft (closed store only): `{ type: 'link', href: editorHref(id), label: 'Read your privacy page' | 'Read your returns page' }` and `{ type: 'markPolicyRead', id, revision, label: "I've read it" }`.

An open store gets only the start actions (it keeps the published rule). Legacy items get **no `actions` key**.

### The Launch hint

`LAUNCH_HINTS.closedOpenSteps`: "Your store is private until your first publish: shoppers see "Opening soon". Publishing from the editor opens it, and first shows what is still missing under "Before you open your store". It can't open without a way to pay, a privacy page and a returns page." `closed` and `open` are unchanged.

### SetupAdmin.js

- A step with a non-empty `actions` list shows them under its hint, then one line: "These are starting points, not legal advice."
- `startPolicy` POSTs `/api/admin/policy-start` `{ kind }` with `fetch`, the same way `mark()` posts `/api/admin/setup`. On success it reads the checklist again (`GET /api/admin/setup`) and shows the answer's `message` in a toast.
- `markPolicyRead` POSTs `{ markRead: { id, revision } }` the same way, then reloads.
- A refusal shows the server's own words in the error banner (POLICY_PAGE_EXISTS, a 403, a 409 such as ALREADY_SAVED). A 409 also reloads the checklist, because the page's state changed. A failed request with no words shows "That didn't work, so nothing changed. Try again in a minute." (or the not-allowed words for a 403 with no body).
- A `link` action is a Next `Link`.
- Items with no actions (and `actions: []`) render exactly as before. A test compares the markup's sha256 with the component at `eee9f2d`.

### Legacy

Legacy output is byte-identical: the same items, in the same order, with the same keys, labels, kinds, hrefs, hints, gates and done rules. No `start` step, no `actions` key. Nothing new is read on a legacy store (no policy rows, no `doc_home` read).

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| On a closed documents store the checklist starts with 'Start your store' (href /admin/start, which hrefWorks finds), done once doc_home exists; on an empty catalog it is done once the brand step is recorded | DONE | test-provision "unit (P6-ONBOARD): a closed documents store's checklist starts with 'Start your store' …" (store `onb`: empty catalog, not done; after a real `saveBrandStep({ skip: true })` done; a product added, not done; `createDocument({ type: 'home' })`, done). The pinned ED05 test now expects `start` first and `/admin/start`, and hrefWorks checks it against `start/page.js` (CONSOLE_PAGES gained `"/admin/start": "start"`). Both fail without the change (run with onboarding.js and SetupAdmin.js stashed: 7 test-provision tests failed) |
| The design step is done after a brand-step save or skip with nothing live, links /admin/start on a closed and on an open store, and its closed hint no longer says 'then publish it' | DONE | test-provision "unit (P6-ONBOARD): the design step is done after a brand-step skip or save …" (store `onbui`, a real save with the slate palette, the store still closed; store `onb`, the skip). Open store: the moved pin in "a later doc_design publish writes theme_pin …" (`fresh`, open) now expects `/admin/start` and the open hint. test-design-doc's two moved pins (open `dd`, and `dn` with no design). All fail without the change |
| Closed store with no policy pages: not done, 'Add your legal pages', two startPolicy actions; a starter privacy draft (createDocument with POLICY_STARTER_ACTOR) still not done, privacy start replaced by 'Read your privacy page' (/admin/editor?doc=<id>) and "I've read it" with its id and revision, returns start stays; after markPolicyRead (body unchanged) privacy is saved; after a merchant saveDraft of that page and a founder-saved 'terms' draft it is done; PUB-12's policyStatus and onboarding agree | DONE | test-provision "unit (P6-ONBOARD, PUB-12 review rule) …": exact `actions` arrays at each stage, the draft hash before and after markPolicyRead, `policyStatus(...).privacy.state === 'saved'`, the returns starter made through the real `startPolicyPage` (slug `terms`) and then saved by the founder, `actions: []` and the ready hint at the end, the store still closed. `agreesWithOpening` runs `openingReport()` at each of the five stages: each kind counts in onboarding exactly when the report does not block on it, and the step is done exactly when neither blocks. Fails without the change |
| Rendered (SetupAdmin): 'Start a privacy page' and 'Start a returns page' show; pressing one POSTs /api/admin/policy-start { kind } then reloads; POLICY_PAGE_EXISTS shows its words; "I've read it" POSTs { markRead: { id, revision } } and reloads; the 'not legal advice' line shows; a step without actions renders as before | DONE | test-provision "rendered (P6-ONBOARD, SetupAdmin): the legal-pages step shows …": the real checklist of a new closed store (`onbx`) as `initial`, a fetch spy that answers with the real `startPolicyPage`, `markPolicyRead` and `buildChecklist`. It checks the call order (POST then GET), the toast (`startedMessage('privacy')`, `READ_MESSAGE`), the new buttons and the read link after the reload, POLICY_PAGE_EXISTS words from a stale screen, the ALREADY_SAVED 409 words, and a 403's words with no reload. "rendered (P6-ONBOARD, SetupAdmin): a checklist whose steps have no actions renders exactly as before …": the static markup's sha256 equals the `eee9f2d` component's, and `actions: []` renders the same. The first fails without the change; the second is a guard (it passes before and after, and fails if the no-actions markup changes) |
| The Launch hint on a closed documents store says publishing opens the store, shows what is missing first, and needs a way to pay, a privacy page and a returns page | DONE | test-provision "unit (P6-ONBOARD): the Launch hint on a closed documents store …". Fails without the change |
| No documents-store step hint tells the founder to add or publish a page 'in the editor'; every action href on the checklist is a real console page | DONE | `checkHintsAndLinks` in the P6-ONBOARD tests (store `onb` with nothing, and with both pages ready): no hint matches `/in the editor/` or "add/publish … page … editor", and every item href and every `link` action href passes hrefWorks. The pinned ED05 test also runs hrefWorks over action hrefs. The starter link (`/admin/editor?doc=<id>`) is checked in the policies test and the rendered test |
| Legacy checklist output is byte-identical (no actions key); test-legacy-routes HREF_ALLOW passes; pnpm test passes | DONE | test-provision "a legacy tenant's checklist output is unchanged" now also pins each item's key list in order (`id,label,kind,done,href,hint`, and `gated` for launch) and the done values, on top of the existing labels, kinds, hrefs, hints and gates. test-legacy-routes' legacy links and HREF_ALLOW scan pass with the regex unchanged. `pnpm test`: see Tests |

## Moved pins

Only documents-store expectations moved. Every legacy expectation is unchanged.
- `scripts/test-provision.js`, "unit (ED05 review, pinned): a closed documents store builds the onboarding checklist …": the step ids gain `start` first; the hrefs gain `start: "/admin/start"` and `brand` moves from `E.editorHref("doc_design")` to `"/admin/start"`; hrefWorks also runs over action hrefs. `CONSOLE_PAGES` gains `"/admin/start": "start"`.
- `scripts/test-provision.js`, "unit: a later doc_design publish writes theme_pin …": the design step's href moves to `/admin/start`, and its hint is `BRAND_HINTS.open`.
- `scripts/test-legacy-routes.js`, "readers + links: onboarding's legal-pages step …": `hrefs.brand` moves to `/admin/start`. Its `docs` store is open (a home page is published before the test), so the "drafts only" assertion stays as it is under the published rule.
- `scripts/test-design-doc.js`, "unit: onboarding, Help, the agency kit export …" (open store `dd`): the brand href moves to `/admin/start`.
- `scripts/test-design-doc.js`, "unit: onboarding on a documents store with no published design is not done …" (store `dn`): the brand href moves to `/admin/start` (the brief named only the first test-design-doc pin; this second one moves for the same reason).

The HREF_ALLOW regex in test-legacy-routes.js is unchanged: `href: documents ? PAGES_LIST_HREF : "/admin/storefront"` and `href: documents ? EDITOR_PATH : "/admin/storefront"` are both still literal in onboarding.js.

## Tests

- `node scripts/test-provision.js`: 39 passed (33 before this item, plus 6 new).
- `node scripts/test-legacy-routes.js`: 29 passed. `node scripts/test-design-doc.js`: 33 passed.
- With `lib/admin/onboarding.js` and `components/admin/SetupAdmin.js` put back to `eee9f2d` (git stash) and the new tests kept: test-provision 7 failed (the ED05 pin, the theme_pin pin and 5 of the 6 new tests; the 6th is the no-actions guard), test-legacy-routes 2 failed, test-design-doc 2 failed.
- `pnpm test` (CHECKOUT_MODE unset): "Running 102 test suites", 102 of 102 passed (199.8s).
- `pnpm build`: passes.
- Mutations, each run once and reverted. Each made test-provision fail:
  - a starter draft counted as done on a closed store: 1 failed (the PUB-12 review rule test);
  - the `actions` key added to legacy items too: 3 failed (the legacy byte-identity check among them);
  - SetupAdmin not reloading the checklist after an action: 1 failed (the rendered test);
  - the design step linking the editor again on an open store: 1 failed (the theme_pin pin).

## Known limits

- **The checklist shows a starter link and "I've read it" only on a closed store.** On an open store the step keeps the published rule, so "I've read it" would not change it. An open store with a starter draft gets the "Publish your privacy page …" hint and the pages list link.
- **A kind counts on the checklist as soon as a page of that kind is founder-saved, whatever its words.** This is the owner's rule (the founder's own save is the review). The checklist can't tell a careful read from a one-word edit.
- **The 'Start your store' step counts any `doc_home`.** An untouched empty home page the editor made (revision 1) also counts. The generator only refills a generator-owned or untouched-empty home, and `/admin/start` shows the state, so the founder is not stuck; the step just ticks a little early.
- **The slug rule is the shared one** (`/terms|refund|return/`). A page like `returning-customers` counts as a returns page, on the checklist and in PUB-12 alike (P6-POLICY-START's review note).
- **The design step on an open store is done from the live design or the brand-step record.** A founder who recorded the brand step but never published the design on an open store sees the step done while the shoppers still see the old design. The hint says the colours go live when the design is published.
- **The reload after an action is best effort.** If `GET /api/admin/setup` fails, the old checklist stays on screen with the success toast; a page reload shows the new state.
- **Two tabs.** A stale screen's button gets the server's refusal words (tested), not a fresh list, unless the answer is a 409.

From review:

- Test gap, open documents store start actions (lib/admin/onboarding.js policyActions): the brief says open stores get 'the start actions when a kind is missing', but no test covers that. Mutation M12 (`if (s.state === "missing" && starters)`, so an open store gets no start buttons) passed test-provision, test-legacy-routes and test-design-doc. The code is right at 26e7a1a. Add a pin on an open documents store with a missing privacy or returns page.
- Test gap, open documents store gets no starter read actions: mutation M1 (`{ starters: true }`, which gives an open store 'Read your ... page' and "I've read it") passed all three suites. The packet's first known limit says read actions appear only on closed stores, but nothing pins it.
- Test gap, open-store label and hints: mutation M7 (label 'Add your legal pages' on an open store too) and mutation M11 (POLICY_HINTS.openMissing and openPublish swapped) both passed every suite. The open store's 'Publish legal pages' label and its two hints are not pinned, although the brief says open stores keep today's label.
- Unproven claim in components/admin/SetupAdmin.js act(): 'if (res && res.status === 409) await reload();'. The packet says 'A 409 also reloads the checklist', but removing that line (mutation M2) passed test-provision. The stale2 rendered case checks only the ALREADY_SAVED words, not the follow-up GET. The brief does ask for the 409 words, which are tested, so this is a gap in the evidence, not a behaviour fault.
- Fault paths are not tested. brandStepRecorded's `s.at` check: mutation M4 survived. homeExists' failed read returning false: mutation M8, where a failed read counts as present, survived. Separately, when readPolicyRows throws, documentsPolicies returns null. On a closed store the step then shows POLICY_HINTS.missing ('Start each from a template ...') with actions [], so the founder sees missing-page words and no buttons, even when the pages exist. This is founder-only, and the step correctly stays not done.
- Open store with an unreviewed starter draft: the hint is POLICY_HINTS.openPublish ('Publish your privacy page and your returns page so shoppers can read them'), with no read or I've-read-it step. This invites publishing template legal text to shoppers unread. It is what the brief specifies (open stores keep the published rule) and the packet lists it as a known limit. Raise it with the owner as a product question.
- Verified: base eee9f2d contains the P5-FIX2 merge (441b44d), the P5-DRILLS merge (211c982) and start/page.js. The legacy branches are unchanged: no 'start' step, no actions key, short-circuits keep launch=null safe. Both HREF_ALLOW literal expressions are kept. The policy-start route body shapes ({kind}, {markRead:{id,revision}}) and its answers (ok, message, error) match what SetupAdmin sends and reads. onboarding.js is imported only by nodejs-runtime console routes and pages, so there is no edge-runtime risk. Full `pnpm test` with CHECKOUT_MODE unset: 102 of 102 suites passed (210.0s). Mutations M3 (every changed to some), M5, M9, M13 and M14 were each caught by test-provision. No browser drill was run; the packet lists it as an owner check. The worktree was removed and nothing was left running.

## Owner checks

- **Desktop Chrome and a phone: the Setup page on a new closed store.** Press "Start a privacy page" and "Start a returns page", read each page from "Read your … page", press "I've read it" on one, save the other in the editor, and see the step done. Check that the words make clear an untouched starter keeps the store from opening (P6-DRILLS stage G covers this in the browser).
- **The checklist words.** Read "Start your store", the design hint, the three legal-pages hints and the new Launch hint as a founder would.
- **The early tick of 'Start your store'** when the editor made an empty home page (known limit above). Accept it, or ask for the untouched-empty rule there too.
