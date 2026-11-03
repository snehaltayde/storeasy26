# P2-PREVIEW: preview saved drafts as an overlay on the live list

Branch `cms/p2-preview`, cut from `d36f683`. Plan: `docs/cms-reviews/P2-PLAN.md` (batch 4, sections 3, 4 and 6). Spec: PV-03, DOC-05, DOC-04 (section 7), section 8.8. Builds on P2-ATOM (tables, `emptyList`, commit), P2-REG (validator, placeholders), P2-GUARD (`lib/cms-mode.js`), P2-DOCS (the write service) and P2-READ (the v4 reader). Migration owned: `0022_preview_sessions.sql`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:preview-overlay` 20 passed, 0 failed (about 1 s; 1.2 s in the gate). `pnpm test`: 66 of 66 suites passed in 121.5 s. 20 deliberate breaks, all caught (see "Do the tests bite?"). `pnpm build` passed; the only warnings are the `next.config.mjs` trace warnings through `lib/platform/migrate.js` that were already there. `/api/admin/preview-session` is in the route list |
| Browser verified | Yes, on the design harness on this Mac (ports 3340 and 4340 to 4342), in the Claude desktop app's built-in browser (Chromium) at 1440 x 900, storefront on the edge runtime (`x-edge-runtime: 1`). Not Safari, not a phone. See "Browser evidence" |
| Staging verified | **NOT DONE. Staging is unverified.** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real store changed mode. The migration has not run anywhere but local test databases |

No real store moves to documents mode. Legacy stores keep today's releases, editors and preview: an old-format token on a legacy store still gives today's draft preview, and the new route refuses legacy stores.

## What and why

Today a preview shows every draft on the site at once, from the legacy tables. Once a store publishes per document (v4), a preview must show the live store with the founder's saved drafts laid over it, and must work before the first publish too. A stale or forged cookie must never show drafts, and a broken preview table must never take the store down for shoppers.

## Design

### Migration 0022 (`migrations/tenant/0022_preview_sessions.sql`)

`preview_sessions(id, tenant_id, created_by, created_at, expires_at, revoked_at, show_design)` plus an index on `(created_by, created_at)`. `CREATE … IF NOT EXISTS` only. `id` is the sid (`ps_` plus 16 hex). `tenant_id` binds the row to its store. A store without the table gets no overlay.

`scripts/test-publish.js` had pinned 0021 as the newest migration; two assertions now allow later ones (0021 must exist, and a 0020 store misses 0021 and everything after it).

### Tokens (`lib/releases.js`)

- `previewToken({ sid })` mints `p.<exp>.<sid>.<hmac20>`, signed over `tenant|exp|sid`. Without `sid` it mints today's `p.<exp>.<hmac20>` (the legacy releases preview and approvals keep using it).
- `readPreviewToken(token)` reads both formats and returns `{ exp, sid }` (sid `null` for the old format) or `null`. `verifyPreviewToken` is now `readPreviewToken(...) !== null`, so every existing caller is unchanged and open legacy tabs keep working through the deploy.
- `lib/tenant-request.js` `inPreview` uses `readPreviewToken`, the same verifier. It only decides whether the store's row is read fresh; whether a session still counts is decided in `resolve.js`.

### Sessions (`lib/preview-sessions.js`, edge-safe)

- `createPreviewSession({ actor })`: one INSERT, then a best-effort prune of sessions gone for a day. The session lasts as long as its token (1 hour). A failed INSERT throws.
- `setShowDesign({ sid, on, actor? })` and `revokePreviewSession({ sid, actor? })`: guarded UPDATEs (this store, not revoked, not expired, and this person when `actor` is given). They return false when there is nothing to change.
- `readPreviewSession(sid)`: one statement that also answers "does the same person have a newer live session" (the other-tab note). It never throws: a missing table is `no_table` (silent), any other error is `error` plus a `preview_session_read_failed` log line. A row of another store, a revoked row and an expired row are refused.

### The overlay (`lib/content/documents-reader.js`)

- `readDirtyDrafts()`: one statement, every document not archived whose `draft_hash IS NOT published_hash` (never-published included), leaving out `product_content`, `journal_index` and `blueprint`.
- `previewBaseList()`: `parseList(emptyList(m))` with every registered singleton null, for a store that has never published.
- `previewDraftBody(row)`: parses the draft, runs `validateDocument` in draft mode, and uses the validator's body, so HTML is sanitized and old sections upgraded **in memory** (the stored row is never rewritten). A draft that is not this document at all (bad JSON, wrong type) is skipped and the live version stays. Every section with an incomplete or invalid field is marked `unfinished: {label, placeholder}`.
- `overlayList(base, rows, { showDesign })`: singletons get an entry marked `draft`; pages and campaigns get their page rows and redirects rebuilt from the draft's meta (a never-published page appears, a renamed one moves); journal posts go into `list.journalDrafts`, laid over the published index entries. `doc_design` is overlaid only when `showDesign` is on, and `designDirty` reports whether it differs either way. `product_content` is refused here too (it is not publishable).
- `documentBodies` returns the overlay's body for a `draft` entry and reads only real versions. The mappers render an `unfinished` section as a plain note: on the home page a rich-text block titled "Banner: not finished yet" with the placeholder and "Only you can see this in your preview…"; on pages a text block; in PDP accordions an accordion; an unfinished hero with no title shows its placeholder as the title. `resolvedHomePage()` keeps the section with its `unfinished` mark for P2-SECTIONS.

### Which preview a cookie gets (`lib/content/resolve.js` `contentSource`)

| Store | Cookie | Answer |
|---|---|---|
| legacy or migrating | any valid token (old or new format) | today's draft preview, with the S59 candidate |
| documents | session token, row good | `{mode: "live", v: 4, preview: true, overlay, list}`: the live list (or `emptyList(m)` before the first publish) with every dirty draft laid over |
| documents | old-format token | live only, never legacy drafts (plan section 6) |
| documents | session expired, revoked, of another store, missing table, or unreadable | live only; an unreadable table is logged, never a 5xx |
| documents | drafts read fails | live only, `preview_drafts_read_failed` logged |
| documents with a legacy (v1 to v3) release live | session token | live only (nothing to lay drafts over) |
| any | none, forged, expired token | live, exactly as before |
| mode unreadable | valid token | no preview; the live path then fails closed on its own when it must |

`overlay` is `{ sid, documents, designDirty, showDesign, otherTab }`. The page stays dynamic because the cookie is read on every request, as before.

### The console route (`app/api/admin/preview-session/route.js`, nodejs; handler in `lib/admin/preview-session-api.js`)

`POST` with exactly one of `{create: true}`, `{showDesign: {sid, on}}`, `{revoke: sid}`. Parsed first (400), then same origin (403), `storefront.read` (401/403), then the mode: anything but `documents` is 409 `STORE_USES_LEGACY` (legacy stores use the releases preview). Someone else's, ended or unknown session is 404 `PREVIEW_SESSION_NOT_FOUND`. Database failures go through `failure()`: a 5xx with a code and "the preview didn't update", the raw text only in the log (`preview_session_failure`). `create` answers `{sid, token, expiresAt, previewUrl}`; `previewUrl` is today's `/api/preview?token=…&to=/`, which sets the httpOnly cookie as before.

### The preview bar (`components/PreviewBanner.js`, `app/(storefront)/layout.js`, `app/api/preview/route.js`)

The layout keeps the purple bar (it is allowlisted in `test-tokens`) and renders `PreviewBanner` inside it. Legacy previews show exactly today's words. A documents preview adds:
- "You opened a newer preview in another tab. Both tabs show all your saved drafts." when `otherTab`;
- "Your new colours are not shown here. Show them" (or "… are shown here. Hide them") when the design draft differs. The button is a plain form `POST /api/preview` with `design=on|off`. That route reads the session from this browser's cookie (only a session token counts), refuses a cross-origin POST (403), flips `show_design`, and 303s back to the page the bar was on (same-host Referer, else `/`). A write failure is a plain 503 page with the code `PREVIEW_TOGGLE_FAILED`. No client script.

`app/(storefront)/layout.js` was not in the plan's file list; the change is the import, the `previewOverlay` field in `chromeData` (null in the neutral chrome) and one line in the bar. No other batch-4 item edits it.

## Acceptance, with evidence

All in `scripts/test-preview-overlay.js`. At `d36f683` that file was the P2-ATOM placeholder and none of `lib/preview-sessions.js`, the session route, `readPreviewToken`, `overlayList` or migration 0022 existed, so every test below fails there (import errors, or no preview at all on a documents store). The named breaks (B1 to B20) were each applied alone to the finished code and the suite run (script: `scratchpad/p2-b4/P2-PREVIEW/mut/run.py`, files restored after each).

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | On a documents store with a live release, a valid session shows each dirty document's saved draft (home, page, campaign, journal, announcement, header, footer, product_layout, collection_layout, cart, collections_index) and everything else live | DONE | "a valid session shows each dirty document's saved draft …": a release published through the real `commitPublishBatch`, drafts saved through the real document service; every getter checked (hero, home sections, `resolvedHomePage`, page, campaign, journal post and `/journal` listing, announcement, header and footer items and templates, PDP accordions and template, collection template, cart title and products, collections index, page list, a never-published page). An unchanged page and the design stay live. "no cookie: every getter serves the live release …" and "the preview changes nothing stored …" | Base; B1, B12, B19 |
| 2 | On a documents store that has never published, a valid session renders drafts over `emptyList(m)`, other singletons at code defaults | DONE | "drafts render over emptyList(m) …": no cookie is still `DOCUMENTS_UNPUBLISHED`; with a session `releaseId` is null, every other singleton entry is null, the announcement, menus, brand, PDP accordions, cart and journal are their code defaults | Base; B1, B16 |
| 3 | A document with one incomplete enabled section previews (its draft renders) and its incomplete section shows its placeholder | DONE | "a document with one incomplete enabled section previews …": a home draft with an empty banner (the service reports it `incomplete` on `sec_bn`) shows "Banner: not finished yet" with "Write a short message, with an optional button", the rest of the draft renders; a page with an empty rich text shows its placeholder; shoppers see the release. Also "a draft written around the document service (unsanitized) is sanitized in memory …" (a `<script>` and an `onclick` in the stored row are not rendered; the row is not rewritten). Browser: `preview-older-tab-1440.jpg` | B10, B11 |
| 4 | `doc_design` draft colours are not applied until `show_design` is toggled on; then they are | DONE | "doc_design draft colours are not applied until …" (admin route on, off), "the preview bar's form (POST /api/preview) flips the session …" (same-origin only; an old token changes nothing), "the real layout's preview bar …" (`#7c3aed` appears in the page's brand variables only after the toggle; shoppers keep the live colours). Browser: the "Show them" click turned the accent from teal to the draft's magenta (`preview-colours-shown-1440.jpg`) | B2, B17 |
| 5 | No cookie means live only; a tampered hmac, an expired session, a revoked session and a token for store A on store B are each refused (live only) | DONE | "no cookie means live content only; …": also a tampered expiry, another sid under the same signature, an expired token, a revoked session (and revoking twice is 404), store A's token on B, A's token whose sid also exists in B's table, a correctly signed sid whose row belongs to another store, garbage. The untampered token still works | B3, B4, B5, B12 |
| 6 | An old-format token on a documents store gives live only; on a legacy store it still gives today's draft preview | DONE | "an old-format token on a documents store gives live only; …": it still verifies; documents store live; legacy store `mode: "draft"`, preview, its legacy draft hero; the route answers 409 `STORE_USES_LEGACY` on the legacy store and writes no row. `test:preview-experiments`, `test:releases`, `test:cms-api` and `test:console-fresh` (old-token users) all pass. Browser: an old-format cookie on the documents harness store got the live page and no bar | B6, B15 |
| 7 | A `preview_sessions` read failure serves live content (no 5xx) and logs; a missing table means no overlay; a session-create write failure returns 5xx with a code | DONE | "a preview_sessions read failure serves live content …" (a view over a dropped table: live hero, `preview_session_read_failed` logged, no preview flag; the same for the drafts read, `preview_drafts_read_failed`); "a missing preview_sessions table means no overlay …" (nothing logged; `create` is 503 `DATABASE_NOT_READY` with no token); "a session-create write failure returns 5xx with a code and writes nothing" (a trigger refuses the INSERT: 5xx, a code, founder words, no raw database text, no row; the toggle's UPDATE refused likewise) | B7, B13, B14 |
| 8 | A `product_content` draft is not overlaid (documented limit) | DONE | "a product_content draft is not overlaid": the draft is dirty, the session shows nothing of it; `resolvedProductOverride` stays the neutral v4 answer; `overlayList` refuses the row even when handed it; `readDirtyDrafts` leaves it out | B8, B20 |
| 9 | The other-tab note appears when a newer session exists for the same user | DONE | "the other-tab note appears …": someone else's newer session doesn't count, the older tab gets it, the newest doesn't, it goes when the newer session ends; support gets its own sessions. "the real layout's preview bar …" renders the words in the real layout. Browser: the older tab showed it, the newer did not | B9, B18 (someone else toggling) |
| 10 | Migration 0022 applies with `tenant-migrate --check`; existing `test-preview-experiments` cases pass | DONE | "migration 0022 is additive, re-runs cleanly, and tenant-migrate --check …": only `CREATE … IF NOT EXISTS`; a 0021 store misses exactly 0022; a second run changes nothing; the columns; the real `scripts/tenant-migrate.js --check` exits 0 and reports `pd: current, all … migrations up to 0022_preview_sessions`. `test:schema-compat` also runs the CLI with 0022 as the newest (a store one behind is named, missing `0022_preview_sessions`). `pnpm test:preview-experiments` passed unchanged in the gate | Base (no 0022) |

Also: "admin route: one operation, signed in, same origin; someone else's session is not found" (400, 401, 403, 404, the row's `tenant_id`, `created_by`, expiry and `show_design`), "token formats …", and an edge-safety walk of `lib/preview-sessions.js`, `documents-reader.js` and `resolve.js` and everything they import (no `node:` module but `async_hooks`).

### Requirements

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| PV-03 | Previews of every document type but `product_content`, with and without a live release; the signed, tenant-bound, httpOnly cookie stays; the colours note and toggle; the other-tab note; no cookie, forged and cross-store tokens refused | "Two editor tabs each preview their own document" is narrowed: the overlay is every saved draft (this brief), not one document per tab; the note says so. `product_content` (OVL-02). The editor side (minting a session, renewing it, PV-04) is ED-02 |
| DOC-05 | An incomplete section previews as its placeholder and the rest of the draft renders; drafts are re-sanitized in memory before render | "Blocks only its own publish" is P2-PUBLISH's; schedule (PUB-07) |
| DOC-04 | Preview failure rows: read errors are live plus a log line, never a 5xx to shoppers; session writes are 5xx with a code and founder words, never 422 | The other preview rows of the failure matrix belong to the editor (ED-02) |

## Do the tests bite?

| # | Break | Caught by |
|---|---|---|
| B1 | the overlay lays no drafts | 8 tests |
| B2 | the design draft always shown | 2 tests |
| B3 | a revoked session still counts | the refusals test |
| B4 | the session expiry ignored | the refusals test |
| B5 | a row of another store accepted | the refusals test |
| B6 | an old-format token on a documents store gets the legacy draft preview | the old-format test |
| B7 | a session read error throws | 3 failure-row tests |
| B8 | `product_content` overlaid (overlay check removed) | the product_content test (added the direct `overlayList` check after this first survived, because the drafts query also leaves the type out) |
| B9 | the other-tab query ignores the person | the other-tab test |
| B10 | no `unfinished` mark | the DOC-05 test |
| B11 | the raw draft rendered, no in-memory sanitizing | the unsanitized-draft test |
| B12 | the sid left out of the signature | 13 tests |
| B13 | a drafts read error throws | 2 failure-row tests |
| B14 | a failed session INSERT swallowed (a token handed out) | 2 failure-row tests |
| B15 | legacy stores may create sessions | the old-format test |
| B16 | a never-published store gets no overlay | the emptyList test |
| B17 | the bar without the colours note | the layout test |
| B18 | anyone may toggle any session | the admin route test |
| B19 | journal drafts not laid over the index | the main overlay test |
| B20 | `product_content` returned by the drafts query | the product_content test |

## Browser evidence (`docs/cms-reviews/drills/P2-PREVIEW/`)

Design harness on this branch, `DESIGN_PORT=3340 DESIGN_SQLD_PORT=4340`. A scratch helper (`scratchpad/p2-b4/P2-PREVIEW/helpers/pv-drill.mjs`) published a v4 release on the harness store through `commitPublishBatch` (home, announcement, design, a shipping page), put the store in documents mode, saved drafts of home (with an empty banner), announcement, design and a never-published page, and minted two sessions for one person (an older and a newer tab) plus an old-format token.

| Request | What showed |
|---|---|
| `/` with no cookie | "Live hero from the release", bar "Live bar: free shipping", no preview bar, `x-edge-runtime: 1` (`shopper-live-1440.jpg`) |
| `/` in the older tab (via `/api/preview?token=…`) | The purple bar: "Draft preview — this is NOT what shoppers see. Exit preview", "You opened a newer preview in another tab. Both tabs show all your saved drafts.", "Your new colours are not shown here. Show them". Announcement "Draft bar: preview only", hero "Draft hero, only in preview", "Banner: not finished yet" with its placeholder, "Draft new arrivals". Teal accent (`preview-older-tab-1440.jpg`) |
| Clicked "Show them" | Back on `/`, the bar reads "Your new colours are shown here. Hide them", the accent is the draft's magenta (`#c026d3` in the brand variables; the Shop button's colour changed) (`preview-colours-shown-1440.jpg`) |
| `/` with the newer tab's cookie (curl) | The draft hero and the bar, no other-tab note |
| `/` with the old-format cookie (curl) | The live hero, no preview bar |
| `/policies/pv-new` | 404 with no cookie, the never-published page with the session cookie |

Afterwards the helper put the seeded v3 pointer back, set the store to legacy and deleted the sessions; `/` showed the seeded home again. The harness was stopped; ports 3340 and 4340 to 4349 are free. The drill tokens were deleted from the scratch folder.

## Tests

- `scripts/test-preview-overlay.js` replaces the P2-ATOM placeholder (same script, `package.json` unchanged): 20 tests, about 1 s.
- `scripts/test-publish.js`: two assertions no longer pin 0021 as the newest migration.
- `pnpm test`: 66 of 66 suites passed in 121.5 s. `pnpm build` passed.
- The failure-row cases live in this suite, not in `test-failure-matrix` (brief).

## Known limits

- **`product_content` drafts are not previewable** until OVL-02: the reader has no product-content path. Narrowed and recorded (plan section 4).
- **The overlay is every saved draft, not the documents of open tabs** (this brief; spec 8.8 describes a union kept by heartbeat). The other-tab note says both tabs show all drafts. Choosing documents per tab waits for the editor (ED-02) and renewal (PV-04).
- **Sessions are not renewed**: a session ends with its 1-hour token. PV-04.
- **No editor calls the route yet** (ED-02). Today a session is made only through the route or the lib.
- **One extra statement per legacy preview request** (the `cms_state` read that picks the preview), and on a documents preview two more (the session and the drafts). Shopper requests without a cookie are unchanged. A preview on a store whose `cms_state` can't be read shows no preview (live, or the error page when live itself needs the mode); before, a legacy store's founder got drafts.
- **The design draft's brand is not checked for readability in preview**: it renders what was saved (the publish check is P2-PUBLISH's / TOK-03's).
- **A draft whose JSON or type can't be read is silently left live** in the preview (no note). Nothing writes such a draft through the service.
- **Slug clashes between a draft page and a journal post** are not resolved in preview; the page row wins, as on live.
- **`otherTab` compares `created_at` strings**: two sessions minted in the same millisecond see no note.
- **The toggle's 503 is a plain-text page**, not a styled one.
- Unit counts only; no statement-count test for the preview path (P2-PERF measures shopper paths).

### From review

Non-blocking findings from the independent review, added at merge.

- Nothing blocks. I reviewed cms/p2-preview at a916f29 against d36f683 in a detached worktree at /private/tmp/claude-501/-Users-snehal-Documents-Projects-2026-storeasy26/5153dcf1-8283-4e2a-96c1-8fc578250bf7/scratchpad/p2-b4/P2-PREVIEW/rv0, which I have since removed. I started no servers, and ports 3440 and 4440 to 4449 are free. pnpm test: 66 of 66 suites passed in 114.4 s. pnpm build exited 0. Its only edge warning ('Using edge runtime on a page currently disables static generation') was already there. The shopper path is unchanged: with no cookie or an invalid one, readPreviewToken returns null and contentSource runs liveSource(), which is the old body moved into a function. overlayList copies base.documents, pages and redirects rather than changing them, and parseList and the readers keep no cache between requests, so a preview list cannot leak into a shopper's request. The libsql connection is per tenant.
- Of 31 deliberate breaks I applied one at a time, the suite caught 16; the other 15 survived (list in the next items). Caught: other-tab ignoring created_by, counting revoked or older sessions; the read ignoring tenant_id; the expiry check removed; revoke ignoring the person; product_content overlaid; no in-memory sanitizing; sameOrigin removed from /api/preview POST and from the admin route; the 409 for legacy stores removed; the banner always showing the other-tab note; page rows not rebuilt; drafts read error rethrown; an old-format token on a documents store given the legacy draft preview.
- Breaks that survived (all founder-only, no shopper effect). (a) Removing 'archived_at IS NULL' from readDirtyDrafts: the brief's 'non-archived' rule is untested. (b) setShowDesign ignoring revoked_at and expiry: the packet says 'an ended session is 404', but that is not tested for showDesign (it is for revoke-twice). The overlay itself still refuses the session, so nothing wrong is shown. (c) setShowDesign ignoring tenant_id: tenant DBs are separate, so this is low risk. (d) The other-tab subquery counting expired newer sessions. (e) Redirects not rebuilt from draft meta.redirect_from. (f) A draft page's meta.enabled=false ignored. (g) A singleton draft with a non-canonical id accepted. (h) PDP sections marked unfinished ignored. (i) The sid regex in readPreviewToken loosened (the HMAC still binds the sid). Add tests for (a), (b) and (e) when convenient.
- The claim that 'lib/tenant-request.js inPreview uses the same verifier' only has weak evidence. The test only greps the source for the text 'readPreviewToken'. Replacing inPreview's check with 'token.split(".").length === 3' (which drops every new-format token) survived. The only effect is that the tenant row is not read fresh in a session preview, and the code itself is correct, so this is non-blocking. A behaviour test would make the claim proven.
- Untested branches in contentSource. (1) A store in 'migrating' mode with a valid token should still get today's legacy draft preview. Changing the condition to legacy-only survived both test-preview-overlay and test-preview-experiments. The code is correct today, but this is the only guard on a 'today's preview keeps working' path, so add a test. (2) When getCmsMode throws, a valid token now gets live content instead of the legacy draft preview it got before. Founder-only, but it differs silently from before and is untested. (3) A legacy release pointer on a documents store makes documentsPreview return null (live only); untested.
- Existing open redirect, not added by this branch: safePath in app/api/preview/route.js accepts '/\evil.com', and new URL('/\evil.com', origin) resolves to https://evil.com/. On GET, even an invalid token redirects to `to`, so /api/preview?to=/%5Cevil.com bounces any visitor off the store domain. The new POST cannot be abused this way (it requires the same origin, and the Referer is normalized by the browser). Suggest rejecting backslashes in safePath in a follow-up and listing it as an owner or security check.
- Small things in the founder's preview. If show_design is on but the design draft can't be parsed (previewDraftBody returns null), the bar still says 'Your new colours are shown here' even though they aren't. A draft page whose slug matches another live page's slug produces two rows for that slug, and find() takes the first. A revoked or expired session cookie stays set, so the founder sees live content with no preview bar and no Exit link, and isn't told why. The bar's Exit link explains nothing either.
- Owner checks are recorded in the packet: DR-3 (run 0022 before deploy), the CI sqld download approval (.github is untouched), a manual Chrome look, and a hosted Turso staging session. The packet says 'Staging is NOT DONE', which is correct.

## Owner checks

1. **DR-3: run migration 0022** (`pnpm tenant:migrate -- --all`, then `--check` must exit 0) before this code deploys. A store without it simply gets no overlay, so the order is not dangerous, but the editor's preview would not work.
2. **CI sqld install** (carried from P2-ATOM): `.github/` was not touched. Approve the libsql-server release and its checksum.
3. **Look at a documents-mode preview yourself in desktop Chrome** on the design harness (the helper above shows the steps): the bar's words, the "Show them" toggle, an empty banner's placeholder, and that a fresh private window sees only live content.
4. **Hosted Turso, staging tenant in documents mode**: make a session, preview, toggle, revoke; and a preview from another region right after a save (replica lag shows the older draft until the next request).
5. **Confirm the words**: "Your new colours are not shown here. Show them" / "… are shown here. Hide them", "You opened a newer preview in another tab. Both tabs show all your saved drafts.", and the unfinished-section note "<Section>: not finished yet … Only you can see this in your preview. Finish this section to publish this page."
6. **Decide the per-tab overlay** (spec 8.8's union of open tabs) versus "every saved draft" before ED-02 builds the editor side.

## Files

- `migrations/tenant/0022_preview_sessions.sql` (new)
- `lib/preview-sessions.js` (new), `lib/admin/preview-session-api.js` (new), `app/api/admin/preview-session/route.js` (new), `components/PreviewBanner.js` (new)
- `lib/releases.js`, `lib/tenant-request.js`, `lib/content/resolve.js`, `lib/content/documents-reader.js`, `app/api/preview/route.js`, `app/(storefront)/layout.js`
- `scripts/test-preview-overlay.js`, `scripts/test-publish.js`
- `docs/cms-reviews/P2-PREVIEW.md`, `docs/cms-reviews/drills/P2-PREVIEW/*.jpg`

## Commands

```
pnpm test:preview-overlay
pnpm test
pnpm build
```
