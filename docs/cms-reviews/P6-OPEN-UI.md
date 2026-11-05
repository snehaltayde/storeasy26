# P6 · OPEN-UI · The editor's "Before you open your store" panel (PUB-12, US-41)

Branch `cms/p6-open-ui`, cut from `dd9ff01` (`cms/phase-1`). Both base merges are there: P5-FIX2 (`441b44d`) and P5-DRILLS (`211c982`). It builds on P6-OPEN (`591a8ea`: the report, the publish rules, the `checkOpening`/`confirmOpen` modifiers and the `openingChecks` read) and P6-POLICY-START (`8ea6c88`: `POST /api/admin/policy-start`). Plan: `docs/cms-reviews/P6-PLAN.md` revision 4, decision 8 and decision 10.

This is the author's own report. Reviewers should re-read the code.

## Files

All in the plan's list:
- `components/admin/editor/publish/publishModel.js`: the precheck, the flags, the two new phases, the panel's own actions.
- `components/admin/editor/publish/PublishPanel.js`: the panel.
- `components/admin/editor/editorModel.js`: `createStoreCall` forwards the two flags. Its imports are unchanged.
- `components/admin/editor/store.js`: `publish()` and `publishSet()` take the two flags.
- `scripts/test-publish-ui.js`: 10 new tests, and 4 changed expectations (listed under Tests).
- This packet.

`DocumentEditor.js` is not edited, and no P5-FIX2 file is edited. Nothing under `.github/`. No migration, no new dependency, no route, no `lib/` change.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test` with `CHECKOUT_MODE` unset, on ports 6120 and 7120 to 7129: 102 of 102 suites passed in 240 s. `pnpm build` passed. Fix round 1: `pnpm test` 102 of 102 again (209 s) |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a unit or rendered test. The full panel flow in desktop Chrome is P6-DRILLS stage C (owner check below) |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

P6-OPEN built the server side of PUB-12. Until now the editor had no screen for it. A founder opening a closed store saw only the generic refused panel, with no button (P6-OPEN's first known limit). This item adds the one panel the plan asks for: "Before you open your store". The founder sees every item in plain words. The design and any founder-saved policy pages are already in the set. There is one Open button, and it stays off while anything blocks. The policy starter buttons (owner answer OQ-P6-2) are in the panel, so a founder with no policy pages is never stuck.

## Design

Everything goes through the flow's existing `on.open`, `on.confirm` and `on.act`, so `DocumentEditor.js` needs no change.

### The request (publishModel `publishRequest`, editorModel `createStoreCall`, store.js)

- `publishRequest(items, { set, confirmOpen })`: every `publish` and every `publishSet` carries `checkOpening: true` as a top-level `extra` key. `confirmOpen: true` is added only on "Open my store" / "Open my store anyway". A `publishSet` now has an `extra` (`{ checkOpening: true }`, before it had none).
- `createStoreCall`: `store.publish({ confirmRepublish, checkOpening, confirmOpen })` and `store.publishSet(items, { checkOpening, confirmOpen })`, read from `extra`. Nothing else changes.
- `store.js`: `publish()` sends them beside the revision. `publishSet()` sends them as its `extra`. Each key is sent only when it is `true`. With no flags the calls are byte-for-byte what they were (a test shows `publishSet` still sends no `extra` then).
- `openingChecks` itself is not a write to the open document, so `createStoreCall` hands it straight to the documents API.

### The precheck (`flow.open`)

1. Staff: nothing opens (unchanged).
2. Pin each document's revision and hash (unchanged).
3. **New:** `call("openingChecks", { ids })` for the set. The flow can't tell an open store from a closed one, so it asks. The server answers `opening: false` on an open store. **Fix round 1:** it does not ask when every document in the set is product or collection content (`isLiveRowType`). Those publish as live rows and never open the store: the server runs the opening rules only when the set is not rows-only (`lib/documents/publish.js`), but `openingChecks` answers `opening: true` for any set on a closed store. Without this skip, editing a product description on a closed store showed "Before you open your store", kept Publish off until the policy pages were done, and folded the design into the set so Open went on to open the store. A set with no known type (pinned with a revision but no `type`) still asks.
4. `opening: true` → the `opening` phase. A refused read (a legacy store), a failed read, a thrown call, or `opening: false` → the review, exactly as before. The publish's own 409s stay the backstop.

### Folding an offer (`foldOffer`)

The report's `offer`, and the offer of a 409, holds the set's own items plus the left-out design draft and each founder-saved policy draft. Folding adds each offered document that is not in the set yet, with the offer's revision and hash. The founder's own documents keep the hash they reviewed. A document folded in earlier takes the newer offer's hash, because the founder may have saved it since. A policy starter draft (the id of any `markPolicyRead` action in the report) is never added, even when an offer names it.

### Phases

| Answer | Phase | Notes |
|---|---|---|
| proactive `opening: true` | `opening` | the report's offer folded in |
| 409 `OPENING_CONFIRM_NEEDED` | `opening` | |
| 409 `OPENING_NEEDS_DESIGN` | `opening` | its offer (design) folded in; no second dialog |
| 409 `OPENING_NEEDS_POLICIES` | `opening` | its offer (saved drafts) folded in; offer null → `stuck`, Open off until a check |
| 409 `STORE_CANNOT_TAKE_PAYMENT` | `cannotOpen` | no Open button |

The plan's 'needsDesign' is not a phase of its own: it is `opening` with `outcome.reason: "design"`, as the brief's "no separate dialog" asks. In `opening`, every document of the set gets its change list, as the offer review does ("What goes live when your store opens"). Lists already loaded for the same hash are kept.

`canConfirm` in `opening`: not busy, not `stuck`, no item at level `block`, and every list loaded. `confirm()` in `opening` sends the whole set with `confirmOpen: true` (one document is a `publish`, more are a `publishSet`). `retry()` resends the last send's `confirmOpen`.

The offer (FIRST_PUBLISH_NEEDS_HOME, LINKS_TO_UNPUBLISHED), noHome, republish, blocked, checking and every other phase are unchanged. Their sends now carry `checkOpening: true`, so the offer of a home page can lead on into the opening panel.

### The panel's own actions (`flow.act`)

These are not issue actions, and `ACTION_TYPES` is unchanged (it stays pinned to the server's `PUBLISH_ACTION_TYPES`). They run only in `opening` or `cannotOpen`, and only when nothing else runs. The console POSTs go through `deps.fetch || globalThis.fetch`.
- `{ type: 'checkAgain' }`: `openingChecks` again, for the set as it is now. `opening: false` (the store opened meanwhile) goes back to the review. A failed read says so ("We couldn't check your store just now…") and leaves the panel as it was. A `cannotOpen` panel stays `cannotOpen` while payment still blocks, else becomes `opening`.
- `{ type: 'placedTestOrder' }`: `POST /api/admin/setup { step: 'test_order' }` (the route Setup uses, settings.write), then a check. A failure shows our own words, never the route's 422 text, which is developer words.
- `{ type: 'startPolicy', kind }`: `POST /api/admin/policy-start { kind }`, then a check. The answer's message is shown, with an "Open it" link to the new page.
- `{ type: 'markPolicyRead', id, revision }`: `POST /api/admin/policy-start { markRead: { id, revision } }`, then a check. The page then counts as founder-saved, the report offers it and it is folded into the set.
- **POLICY_PAGE_EXISTS** (batch 1 review: the shared rule counts any slug with "return" in it, e.g. `returning-customers`): the panel words it with the page's own title, "“Returning customers” already counts as your returns page, so we didn't start a new one. Open it to check it's the page you want.", with an "Open it" link to that page, and checks again. It is never a dead end.
- **Any other failure** (SLUG_TAKEN, legacy, a stale revision, a lost answer): its plain words and the panel as it was, with no new check. SLUG_TAKEN also gets "Open it" to the page holding the address. A 401 or a 403 without a code (the sign-in check, whose words are not for founders, for example "Your role (staff) can't do that") gets our own words.

### The panel (PublishPanel.js)

Titled "Before you open your store", with one lead line: the server's words on a 409, "Everything is ready." when every item is ok, else "Your store isn't open yet. Look over these, then open it."

Each item:
- its title and its plain message, always;
- block: a "Must fix" mark (danger); warn: a "Check" mark (warning); ok: a "Done" mark (success), message muted; info: no mark and no warning style;
- a link only when it has an href and is not `who: 'support'`, with its `linkLabel`, else "Fix this". A starter's link is "Read it" to `/admin/editor?doc=<id>`;
- a button per action through `on.act`: "Start a privacy page", "Start a returns page", "I've read it";
- on the warn `test_order` item, "I placed one" through `on.act`;
- beside the first item with policy buttons, one line: "These are starting points, not legal advice."

Below the items: "Fix the things marked “Must fix” first. Then your store can open." while anything blocks, or "The things marked “Check” don't stop your store opening…" when only warnings are left. Then "Check again" (through `on.act`), "What goes live when your store opens" with the change lists, and the footer: Cancel and one Open button, "Open my store anyway" when warnings are left, else "Open my store", disabled while anything blocks. In `cannotOpen` there is no Open button, only Close and "Check again".

The notice line can carry a link (`noticeLink`, "Open it").

**Done phase:** a store-level warning with no document (POLICY_PAGE_MISSING) goes through the existing IssueList. `labelOf(null)` is now "Your store", where it said "This page". The code is never shown.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| flow.open calls openingChecks before publishing; opening:true → 'opening' with the report's items and doc_design (from report.offer) in the set; opening:false or a failed read goes on as today | DONE | test-publish-ui "P6-OPEN-UI unit: flow.open asks openingChecks before anything goes out…" (first call is `openingChecks { ids: ['doc_home'] }`, design with the offer's revision and hash, nothing published until Open) and "…opening:false, a refused read, a failed read and a thrown read all go on to the review exactly as before". Every phase 3 to 5 case also runs with the stub answering `opening: false` (see Tests). Both fail without this change (phase is 'review') |
| OPENING_CONFIRM_NEEDED → 'opening'; STORE_CANNOT_TAKE_PAYMENT → 'cannotOpen' (Open off); OPENING_NEEDS_DESIGN → 'opening' with doc_design added (no second dialog); OPENING_NEEDS_POLICIES → 'opening' with saved drafts folded in, or Open off when offer is null; a starter draft id is never added | DONE | "P6-OPEN-UI unit: the publish's 409s map to the one panel…": each code through the real client mapper and the flow; the resend's `extra` is `{ revision, checkOpening, confirmOpen }`; a starter named by an offer stays out; `foldOffer` on its own. Fails without the change (those codes went to 'refused'). Mutations: without the starter filter 2 tests fail; without `stuck` 1 fails |
| Rendered: in 'opening' each item's message, a link only with an href (its linkLabel), 'Open my store anyway' resends with confirmOpen:true (store spy); all ok still renders the title with one 'Open my store'; 'cannotOpen' has no open button and shows the payment message | DONE | "P6-OPEN-UI rendered: each item's message, a link only with an href…" (the real store and `createStoreCall` with a spy documents api: the `publishSet` goes out with `{ checkOpening: true, confirmOpen: true }`; info lines have no warning style; the support item has no link) and "…with every item ok the panel still shows…; in 'cannotOpen' there is no open button…". Fail without the change. Mutation: without `confirmOpen` on Open, 4 tests fail |
| Rendered (OQ-P6-1/2): privacy and returns missing → Open off, 'Start a privacy page' and 'Start a returns page'; pressing one POSTs policy-start { kind } and re-calls openingChecks; a starter shows 'Read it' to /admin/editor?doc=<id> and "I've read it" POSTing { markRead: { id, revision } } and re-checking; the 'not legal advice' line shows; Open turns on only once both are ok or info | DONE | "P6-OPEN-UI rendered (OQ-P6-1/2): …" walks four reports with a fetch spy: missing → starter → saved → ok. The line shows once. Open is off on the first three and on at the last, and the Open sends the read privacy page with the store. Fails without the change |
| Rendered: 'Check again' re-calls openingChecks; 'I placed one' posts the manual test_order check-off and re-checks | DONE | "P6-OPEN-UI rendered: 'Check again' re-reads the report; 'I placed one' POSTs…" (fetch spy: `POST /api/admin/setup { step: 'test_order' }`, then a third read; a 422 shows our words and does not re-read). Fails without the change |
| Rendered: a done answer with a store-level POLICY_PAGE_MISSING warning shows plain words, not the code | DONE | "P6-OPEN-UI rendered: a done answer with a store-level POLICY_PAGE_MISSING warning…" (the shapes' `okPolicyPageMissing` plus a store-level one with no document: both messages show, the group is named "Your store", and `plain()` finds no code in the markup). Fails without the change: the group was named "This page" |
| FIRST_PUBLISH_NEEDS_HOME offer, noHome, REPUBLISH_CONFIRM_NEEDED and normal publish still pass; every publish and publishSet sends checkOpening:true top-level through createStoreCall and the store to the API body; ACTION_TYPES unchanged; pnpm test passes | DONE | "P6-OPEN-UI unit: checkOpening reaches the documents API body…" (the real `createDocumentsApi` with a fetch spy, the store and `createStoreCall`: `openingChecks` first, then a `publish` body with top-level `checkOpening` beside `revision`, then the home offer's `publishSet` body with top-level `checkOpening`; the store sends the keys only when set; noHome; republish resends `confirmRepublish` with `checkOpening`). The phase 3 to 5 cases all pass. ACTION_TYPES is pinned in "…'Check again'…" and the old "every action type of the contract" case passes. `pnpm test` 102 of 102. Mutations: reverting editorModel.js alone or store.js alone fails 2 tests each; dropping `checkOpening` from publishRequest fails 9 |
| Fix round 1: product and collection content on a closed store skip the opening panel and publish with checkOpening only; a set with a page in it still asks | DONE | "P6-OPEN-UI unit (fix round 1): product and collection content on a closed store skip the opening panel…": with the new-store report (privacy missing, design offered) scripted for `openingChecks`, a `product_content` set and a `product_content` plus `collection_content` set never ask it, go to the review with the same set (no design folded in), Publish is on, and the publish goes out with `{ revision: 2, checkOpening: true }` / `publishSet` with `{ checkOpening: true }`, no `confirmOpen`. A product plus home set still asks first and opens the panel. Fails with the round-0 publishModel.js ("openingChecks is not asked") |
| Browser: the full panel flow in desktop Chrome | NOT DONE | Owner check, covered by P6-DRILLS stage C |

## Tests

- `node scripts/test-publish-ui.js`: 53 passed (42 before, 11 new; the fix round 1 case is the 11th). With this branch's four component files put back to `dd9ff01`, 13 fail: the 10 new tests and the 3 changed flag expectations.
- `pnpm test` (`CHECKOUT_MODE` unset; ports 6120 and 7120 to 7129): 102 of 102 suites, 240 s. test-editor-shell (32), test-editor-store and the others pass unchanged.
- `pnpm build`: passes. Its one warning (next.config.mjs, "unexpected file in NFT list") is there on `dd9ff01` too.

**How the stub treats the new read.** `flow.open` now always calls `openingChecks`. In `stub()`, a script with no `openingChecks` entry answers it as an open store does (the shapes' `open` outcome, `opening: false`), and records that read in `call.checks`, not in `call.calls`. So every phase 3 to 5 case keeps its exact call list and also proves that `opening: false` goes on as before. A script that does script `openingChecks` records it in `calls` like any other op (the new tests do that).

**Existing expectations changed** (each named in the code with "P6-OPEN-UI"):
- "a fix runs getDocument, saveDraft …, then publish …" (l.254): the one call-list expectation that gets the `openingChecks` read added, as `call.checks` (`[['openingChecks', { ids: ['doc_home'] }, 0]]`: first, before every other call).
- The same case, l.260: the publish's `extra` is `{ revision: 4, checkOpening: true }` (was `{ revision: 4 }`).
- "publishBoth sends exactly the offer as publishSet …" (l.305): the set's `extra` is `{ checkOpening: true }` (was `undefined`).
- "Keep the live version calls keepLiveSection …" (l.491): the publish's `extra` is `{ revision: 4, checkOpening: true }` (was `{ revision: 4 }`).

The last three are required by the acceptance (every request carries the flag). No other existing expectation changed.

## Known limits

- **No design row yet: Open is pressed twice, in the same panel.** The proactive read never writes, so with no doc_design row the design item says "starting colours (Slate)" and nothing is offered. The first Open makes the server create the slate draft (P6-OPEN rule c) and answer OPENING_NEEDS_DESIGN. The panel folds the new draft in, loads its list and asks for Open again. It is the same panel, not a second dialog, and nothing is published in between.
- **"Read it" leaves the panel.** It is a plain link to `/admin/editor?doc=<id>`. If the panel is still open when the founder comes back, "Check again" picks up the save; if the editor closed it, the next Publish asks `openingChecks` again anyway. Which one happens is for the drill to show.
- **The shared returns rule (P6-GEN-WRITE) matches any slug with "return" in it.** An unrelated founder-saved draft such as `returning-customers` counts as the returns page. It then shows as "Your returns page … goes live too", named in its link ("Open “Returning customers”") and in "What goes live", and it goes live with the store if the founder presses Open. The panel names it everywhere, but it can't tell that the page is not a returns page. Changing the rule is outside this item (owner check).
- **The test order check-off needs settings.write.** Only owners and admins can publish, and they have it, so this does not reach staff. A failure shows our own words. The route's 422 text is never shown.
- **ALREADY_SAVED's words come from the server** ("This page was already saved by you."), which is not always true (batch 1 review of P6-POLICY-START). The panel shows them as they are.
- **Product and collection content skip the precheck by type** (fix round 1). The client decides from the types in the set; `openingChecks` itself still answers `opening: true` for a rows-only set on a closed store (a lib/ change to make it answer `false` was left out, as it needs the plan's say). Any other caller of `openingChecks` with a rows-only set would see the same report.
- **The test stub answers `openingChecks` by default** (Tests above). A future case that pins a call list and also scripts `openingChecks` sees the read in `calls`.

## Owner checks

- **The full panel flow in desktop Chrome** (P6-DRILLS stage C): a closed documents store with no policy pages → Publish shows "Before you open your store", Open off, both Start buttons and the "not legal advice" line → Start each → "Read it" opens the draft → "I've read it" → Check again → Open turns on, with the privacy and returns pages and the design in "What goes live" → "Open my store anyway" with the test order warning → the store opens with all of them. Also: "I placed one" (a COD test order to snehal@mediastic.in, cancelled after), and a Shopify-mode or checkout-off tenant shows no Open button.
- **Read every word of the panel as a founder on a phone** (`WORDS.opening*`, the item marks, the POLICY_PAGE_EXISTS wording), together with P6-OPEN's item words.
- **The returns rule's false match** (Known limits): accept that an unrelated page whose address has "return" in it can go live as the returns page when the founder presses Open, or ask for the rule in `lib/documents/policy-pages.js` to be narrowed.
- **Pressing Open twice with no design row** (Known limits): accept, or ask for the proactive read to create the slate draft (it would then write).
- **CI sqld download:** unchanged; nothing under `.github/` was touched. Its source and checksum still need your approval.

## Commands

```
node scripts/test-publish-ui.js
TEST_PUBLISH_PORTS=7120,7121 TEST_PUBLISH_SERVICE_PORTS=7122,7123 TEST_PUBLISH_UNDO_PORTS=7124 \
  TEST_PRODUCT_CONTENT_PORTS=7125,7126 TEST_MIGRATE_MAP_SQLD_PORT=7127 MIGRATE_DOCUMENTS_TEST_PORTS=7128,7129 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6120 DESIGN_PORT=6120 DESIGN_SQLD_PORT=7120 env -u CHECKOUT_MODE pnpm test
env -u CHECKOUT_MODE pnpm build
```
