# P3 · FIX1 · The batch 1 review findings no other item owns

Branch `cms/p3-fix1`, cut from `5bbc819`. Plan: `docs/cms-reviews/P3-PLAN.md` (batch 2) and `P3-BATCHES.json`. Requirements it serves: PUB-04, PUB-09, PV-02, AU-04. No migration.

It fixes the "From review" findings in `P3-DIFF.md`, `P3-CLOSED.md`, `P3-SESSION.md` and `P3-VALIDATE.md` that no other batch 2 item owns. No tenant changes mode. Legacy tenants, today's releases, the editors and preview behave as before. The two changes a shopper's browser could ever meet are both opt-in or invisible: `/api/preview` answers differently only when the new editor's header is sent, and `/api/leads` on a store host now passes the rate limit first.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 139.3 s (ports 4900 to 4904 and 3900 set; no sqld was left running). `pnpm build` passes (3 Turbopack warnings about `next.config.mjs` tracing, unchanged by this item) |
| Browser verified | **NOT DONE / not applicable.** No screen uses `diff.js` or `documentsApi.js` yet (P3-PUBLISHUI, P3-EDITOR). No server was started; port 3900 was never used |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

### 1. `lib/documents/diff.js` (P3-DIFF review)

- **a. Pass 3 could name the wrong section as removed.** Live `[Text A, Text B]` with no ids; the draft removes A and edits B, which gains `sec_bbbb`. Before: "Text: title changed" (A compared against B) plus "Text 2: removed". Now pass 3 (pairing sections without ids) runs for a kind only when both sides have the same number of unmatched sections of that kind. Otherwise the kind reads as added plus removed: "Text: added", "Text 1: removed", "Text 2: removed". The row never claims A was edited into B. With equal counts (one id-less section against one stamped and edited), it still reads as one edit.
- **b. A null or empty side gave false meta rows.** A meta field blank on both sides (missing, null, `""`) is no change. A missing `redirect_from` is an empty list, so two empty sets are unchanged. Redirects are counted with repeats: a doubled address that collapses to one reads "an old address removed", and "reordered" means the same items in a new order. A missing side (`null`, a first publish or a page taken offline) is read as the type's empty body with no sections. So `diffBodies('page', null, emptyPage)` is `[]`, and `diffBodies('page', null, page)` gives only real rows ("Web address added", "Page title added", "Text: added").
- **c. Surviving mutations are now caught.** `[Banner sec_aa 'one']` to `[Banner sec_bb 'two']` gives "Banner: added" plus "Banner: removed". The review wrote `sec_a`/`sec_b`, but those are one character short of `SECTION_ID_RE` (`sec_` plus 2 to 16 characters), so they count as having no id; the test uses the smallest valid ids. The "some details changed" fallback is pinned, so a changed body never gives `[]`. The other survivors the review listed are also pinned: pass 1's kind check, an image description change, a binding change, extra section settings, and "Look: applied again" against "Look: a different look chosen". Skipping `upgradeBody` is an equivalent mutation today, because every section kind is at version 1.
- **d. Hidden on both screens is hidden.** A section with `show {mobile:false, desktop:false}` is left out of `firstPublishRows`, and `diffBodies` gives one row for that change: `{kind:"hidden", words:"Text: hidden"}`, without the extra "now hidden on phones, now hidden on computers". Shown again on computers only gives "Text: shown" plus "Text: still hidden on phones".
- **e. Wording.**
  - Reversing three sections names only those that moved: "Text 1: moved up" and "Text 3: moved down". The middle one stayed at its place and gets no row. Among runs of equal length, the kept run is the one holding the most sections still at their place. A "moved" row with no direction can no longer occur.
  - A stored `accent_label` equal to the one `validateBrand` works out from the accent (for example, a legacy brand validated on save) gives no row: it is dropped before the bodies are compared. A stored label that differs from the worked-out one does change what renders (`brandCssVars` uses a stored label as it is), so it still gives "Colours: text on accent changed". An accent change that only moves the worked-out label is the accent row alone.

### 2. Closed store tests (P3-CLOSED review), and the leads route

- `scripts/test-release-readers.js`: a v4 store with a release and a valid preview session gets `closedStoreGate() === null` and `isStoreClosed() === false`. The store is published through the real commit.
- `scripts/test-commerce.js`: the same store, published through `createDocument` plus `publish`. Card checkout (`razorpay_create`) is not refused as `STORE_CLOSED`, with or without the preview session, and COD, contact and quiz pass.
- `scripts/test-commerce.js`: `/api/leads` on an unknown host and on a suspended store's host answers today's plain `404 {"error":"Not found"}`, not tenantHandler's `404 TENANT_UNKNOWN` or `503 TENANT_SUSPENDED` body. The route still passes on only the closed store's 403. "Today's 404 / 503 bodies" in the brief is read this way: the 404 and 503 that tenantHandler answers are never passed on to a leads caller.
- `app/api/leads/route.js`: the rate limit now runs first, for every host. A store host reads its release pointer and `cms_state` (the closed gate) only within that budget. A test proves the order for real: with the limiter on, five calls on a closed store host reach the gate (403) and the sixth and seventh get 429.
- **Known legacy change (named here, as the review asks).** When `cms_state` can't be read on a store with no release (`CMS_MODE_UNAVAILABLE` or `UNKNOWN_CMS_MODE`), `closedStoreGate()` answers `{preview:false}`. Checkout, contact and quiz on that store then refuse with "This store isn't open yet." until the database answers again. Before P3-CLOSED, checkout didn't read `cms_state` at all. This fails closed by design. It happens only on a database fault: a store from before 0021 still reads as legacy.

### 3. The preview client (P3-SESSION review)

- **a.** A `showDesign` step that answers 404 or 5xx (or a 502 with no body) makes `startDocumentsPreview` return that error. It never reports `showDesign:true`, and the cookie URL is never fetched. The code already did this. The test is new; it fails when `if (!shown.ok) return shown;` is removed.
- **b.** The test now inserts a `created_by='unknown'` row first, then calls `revokePreviewSessionsFor` with no actor, with an actor that has no id, with an empty actor, and as a real person. The row stays unrevoked. It fails when `if (key === "unknown") return 0;` is removed. `lib/preview-sessions.js` needed no change.
- **c. The cookie fetch now uses `redirect: "manual"` and checks the answer.** A client can't tell a refused token from an accepted one while `/api/preview` answers both with the same 302: the cookie is httpOnly, and an opaque redirect hides everything. So the fetch sends a header, `x-storeasy-preview-confirm: 1` (exported as `PREVIEW_CONFIRM_HEADER`). With that header `/api/preview` answers in JSON, not with a redirect:
  - `200 {ok:true}` with the same cookie for a good token;
  - `403 {code:"PREVIEW_TOKEN_REFUSED", error:"This preview link has expired or isn't valid, so the preview didn't open. Close it and open the preview again."}` and no cookie for a refused one.

  The client counts only a 2xx `{ok:true}` as success. A refused token, any other status (a suspended store's 503, a 5xx), a 200 that isn't the confirmation, and a redirect (opaque, 3xx or status 0) are all errors, never `{ok:true}`. The fetch also no longer renders the storefront home page just to set a cookie. Without the header (links, the legacy Designer, every shopper) `/api/preview` answers exactly as before, and a test pins that.

  **Deviation:** `app/api/preview/route.js` is not on this item's file list. No batch 2 item owns it, and the brief's "a refused token returns an error" can't be met from the client alone. The change is additive and opt-in by header.
- **d. Error and refusal bodies keep every field.** Every field of the body other than `error` (which becomes `message`) is kept on the result as the server sent it. That covers `retryable`, `release`, `reason`, `missing`, `slug`, `document`, `conflicts`, plus today's `code`, `message`, `other`, `offer` and `current`. This holds for 409 conflicts and refusals, 422, 428, 501, and every other 4xx and 5xx. A body field can never overwrite the result's own keys (`ok`, `error`, `refused`, `conflict`, `issues`, `needsRevision`, `notBuilt`, `code`, `message`). Those keys, and `current`, `offer`, `other` and `documents` (which keep their checks), are the ones not copied. The contract test now checks this for every example outcome in `documents-api-shapes.js`. P3-STORE can read `retryable`; P3-PUBLISHUI can read `release` on 503 `PUBLISH_UNKNOWN`.
  - **Shape change for P3-CHECKS** (`lib/admin/documents-api-shapes.js` is theirs this batch, so it was not edited): none of the HTTP bodies changed. If that file documents the client's result shapes, add "every other body field is kept as sent" to the error, refusal, 422, 428 and 501 results. The `/api/preview` confirm answers above are outside that file's routes, so they are recorded only here.
- **e. Reworded known change (replaces P3-SESSION's wording for the owner's ruling).** Logout ends that person's previews on every device **on documents-mode stores only**. On a legacy store, the Designer's preview cookie has no session row. On the device that logs out it is cleared, but on another device it keeps working until it expires (up to an hour).

### 4. Drafts (P3-VALIDATE review)

- **A hard cap in draft mode** (`lib/registry/validate.js`). In a draft, each of these is an **error** (saveDraft answers 422 and stores nothing), not "incomplete":
  - the body, serialized, over 512 KB (UTF-8): `DRAFT_TOO_LARGE`;
  - any text anywhere in the body over 20,000 characters: `TOO_LONG_TO_SAVE`. This counts after sanitizing, as publish does, so a rich text that publishes is never refused. 20,000 is the largest publish limit (the custom section's content);
  - any declared list over 4 times its publish maximum, and a menu item's sub-items over 4 x 8: `TOO_MANY_TO_SAVE`.

  The over-limit "incomplete" note for the same field is replaced by the error, so the founder reads one message. Publish mode is unchanged. Each message is a plain sentence, for example: "This text is too long to save (25,000 characters, and a draft can hold up to 20,000). Nothing was saved: shorten it." The review's probe (an FAQ with 5,000 items, a title of 3,000,000 characters) is now refused on save.
- **`pickRailCollection` never counts `product_count` as available** (`lib/registry/starter.js`). Without `available_count` or `availableProducts`, how many products are available is unknown. The rail takes, in order:
  1. the first collection with a known count of at least `minItems`;
  2. the first with a known count above 0;
  3. the first whose count is unknown but that holds products;
  4. the first that holds products but is all sold out (today's fallback).

## Acceptance, with evidence

"Fails without" means the named test fails when the shipped file is swapped for its `5bbc819` version (or, for test gaps where the code was already right, under the named one-line mutation). Each was run.

| # | Acceptance | Kind | Evidence |
|---|---|---|---|
| 1 | The pass 3 repro names the right section as removed; [Banner sec_a] to [Banner sec_b] gives added plus removed; a changed body never gives [] | unit | `test-doc-diff.js`: "a removed id-less section is named as removed…" (fails on the old `diff.js`). "[Banner sec_aa 'one'] to [Banner sec_bb 'two']…" (fails with pass 3's condition replaced by `true`, and with pass 1's kind check dropped). "a changed body never gives []" (fails with the fallback row deleted) |
| 2 | diffBodies with a null or empty side gives no false meta or 'reordered' rows; hidden on both devices reads as hidden | unit | `test-doc-diff.js`: "a null or empty side gives no false meta or 'reordered' rows" and "a section hidden on both phones and computers reads as hidden…" (both fail on the old `diff.js`; also caught by mutations that remove the blank skip, the missing-list rule, the both-screens rule and the flip rule). "reversing three sections…" and "a stored accent_label…" fail on the old file too |
| 3 | A published v4 store's preview session passes closedStoreGate; leads on unknown and suspended hosts answer 404 / 503; the gate runs after the rate limit | unit | `test-release-readers.js` "a v4 store with a release and a valid preview session is open…" and `test-commerce.js` "a published documents store with a valid preview session is open…": both fail when `closedStoreGate`'s `src.releaseId == null` term is dropped (review mutation M13). `test-commerce.js` "/api/leads on an unknown and a suspended store host…" fails when the route passes on any answer (M9). "/api/leads runs the rate limit before the closed-store gate" fails on the old route (its source order check, and the 7-call run gets 403 seven times) |
| 4 | A failing showDesign step and a refused preview token are returned as errors; an 'unknown' author row is never revoked; error bodies keep retryable, release, reason, missing, slug and document | unit | `test-logout-preview.js`: "a showDesign step that answers 404 or 5xx…" (fails with `if (!shown.ok) return shown;` removed). "a refused preview token is an error…" (fails on the old client and route). "revokePreviewSessionsFor never sweeps rows with no known author" (fails with the `unknown` guard removed). "error and refusal bodies keep retryable, release, reason, missing, slug and document…" and the extended "call() maps every example outcome…" (both fail on the old client) |
| 5 | An oversized draft is refused on save; pickRailCollection never counts product_count as available | unit | `test-registry-contract.js`: "a draft has a hard cap…" and "an oversized draft is refused on save (saveDraft answers 422 and stores nothing)". The second runs the real `documents/service.js` `saveDraft` on a local file database: 422, and the revision and draft are unchanged. "pickRailCollection never counts product_count as available…". All three fail on the old `validate.js` and `starter.js` |
| 6 | pnpm test passes | unit | 81 of 81 suites, 139.3 s |

## Tests

| Suite | Before | After | Time (in `pnpm test`) |
|---|---|---|---|
| `pnpm test:doc-diff` | 33 | 41 | 0.4 s |
| `pnpm test:commerce` | 15 | 18 | 0.8 s |
| `pnpm test:release-readers` | 43 | 44 | 2.6 s |
| `pnpm test:logout-preview` | 32 | 36 | 1.0 s |
| `pnpm test:registry-contract` | 31 | 34 | 0.9 s |
| `pnpm test` | | 81 of 81 suites | 139.3 s |
| `pnpm build` | | passes | |

Mutations of `diff.js` run by hand, each applied alone and then put back. Each made at least one test fail:
- pass 3 condition replaced by `true`;
- fallback row deleted;
- pass 1 kind check dropped;
- image description ignored;
- bindings ignored;
- "applied again" folded into "a different look chosen";
- extra section settings ignored;
- pass 3 count rule removed;
- blank-both-sides skip removed;
- the redirect list compared raw;
- the both-screens rule removed;
- the flip rule removed;
- the in-place tie-break removed;
- the derived-label drop removed;
- the stored-label condition dropped.

## Known limits

- **Pass 3 now reads some real edits as added plus removed.** When a kind's unmatched counts differ (an id-less section was removed and another of the same kind edited in the same draft), the edited one reads as "added" and both old ones as "removed". This is honest, but less exact than "removed" plus "edited". Pairing by most similar content can't tell sections apart that differ only in the field that changed. Bodies saved through the documents service always have ids, so this only affects bodies migrated without ids.
- **"Text: hidden" for hidden on both screens** uses the same words as switched off. The panel can't tell the founder which of the two hid it.
- **Publish has no body size limit of its own.** A body over 512 KB with every field inside its publish limit (for example, two text sections of 100 paragraphs of 3,000 characters each) publishes, but can't be saved as a draft. A founder can't build one through saves, because the cap stops it first. A migrated body that big would need to be trimmed before its next save.
- **Leads rate-limit bucket.** Store-host calls to `/api/leads` now count against the same `leads` budget (5 an hour per address) as the marketing host. A store host that never takes leads now answers 429 instead of 404 after five calls an hour from one address.
- **A redirect counts as not confirmed.** If something between the browser and `/api/preview` dropped the confirm header and the route answered its old 302, the editor would say the preview didn't open, even though the cookie was set. Same-deploy console and route make this unlikely.
- **The confirm fetch was not run in a real browser.** It relies on Chrome keeping a `Set-Cookie` from a same-origin `fetch` answer, which is standard. No screen calls `startDocumentsPreview` until P3-EDITOR.

## Owner checks

- **Ruling on the reworded logout change (3e):** logout ends previews on every device on documents stores only; a legacy Designer cookie on another device lasts until it expires (up to an hour).
- **Ruling on the known legacy change (2):** a `cms_state` read fault on a store with no release refuses checkout, contact and quiz until the database answers (fail closed).
- **Accept the `/api/preview` deviation (3c):** a file outside this item's list, changed additively behind a header.
- **Desktop Chrome, at P3-EDITOR's drill:** open the editor preview on a documents-mode test tenant. The cookie is set through the confirm fetch, with no request for `/` in the network panel, and the frame shows the draft. A spoilt token shows "didn't open".
- **Draft cap words:** read the three messages in section 4 and confirm they suit a founder.
- **CI sqld download:** not touched. Nothing under `.github/` changed. Its source and checksum still need the owner's approval.

## Files

`lib/documents/diff.js`, `scripts/test-doc-diff.js`, `app/api/leads/route.js`, `scripts/test-commerce.js`, `scripts/test-release-readers.js`, `components/admin/editor/documentsApi.js`, `scripts/test-logout-preview.js`, `lib/registry/validate.js`, `lib/registry/starter.js`, `scripts/test-registry-contract.js`, `docs/cms-reviews/P3-FIX1.md`. Outside the list: `app/api/preview/route.js` (see 3c). `lib/preview-sessions.js` needed no change. Edge safety: `diff.js`, `validate.js` and `starter.js` use no `node:` API (`TextEncoder` is a web global). The diff edge walk and the registry checks pass.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:doc-diff && pnpm test:commerce && pnpm test:release-readers
pnpm test:logout-preview && pnpm test:registry-contract
TEST_PUBLISH_PORTS=4900,4901 TEST_PUBLISH_SERVICE_PORTS=4902,4903 pnpm test
pnpm build
```
