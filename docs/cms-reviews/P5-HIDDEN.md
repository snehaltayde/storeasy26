# P5-HIDDEN: telling the founder why a section is hidden (COM-01)

Branch `cms/p5-hidden`, cut from `b09f342` (`cms/phase-1`). Plan: `docs/cms-reviews/P5-PLAN.md` and `P5-BATCHES.json` (item P5-HIDDEN, batch 1). Requirement: COM-01 (the "founder in preview" column of the state contract). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the plan's list):
- Code: `components/sections/index.js`, `components/sections/HomeSections.js`, `components/sections/parts.js`.
- Tests: `scripts/test-sections-render.js` (new section 6, a digest recorder, and the `request-cache` import).
- Docs: this packet.

Not touched: `package.json`, `.github/`, `MANUAL-CHECKS.md`, `lib/cms/section-data.js` (P5-SOURCES sets `data.bindingFailedCause`; this item only reads it), any component other than the three above, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration. No new dependency.

Safety: only file databases (`.test-sr-*.db` at the worktree root, removed by the suite) were used. No server was started, so ports 6160 and 7160 to 7169 were never used. No store was moved, no `--hosted`, no Typesense, nothing written to Shopify, no test order.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `node scripts/test-sections-render.js`: 44 passed, 0 failed (36 before, plus 8 new), about 1.1 s. `pnpm test`: 96 of 96 suites passed in 197.3 s. `pnpm build` passes; its 3 Turbopack warnings all come from `next.config.mjs` (the existing NFT trace warning) and none involves `components/sections` |
| Browser verified | **NOT DONE.** No registered kind has `hiddenReason` yet (the first is P5-BLOCKS' bundle card and grid), so there is nothing a founder could see on the design harness. Every acceptance item is a rendered test, and the mutation table shows each one fails without the change. P5-DRILLS covers it in Chrome once the bundle kinds exist (owner check below) |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed |

## What and why

A section that hides itself (a rail with too few products, and from P5-BLOCKS a bundle that is turned off or deleted) simply vanished from the founder's preview. The founder could not tell "hidden on purpose" from "broken" and had no hint of the fix. COM-01's state table gives every hidden state a founder note with a reason, in preview only.

This item adds the mechanism, not any reason: no existing component gets the hook, so product_rail (PV-09, P1) and every live page are unchanged.

It also gives the binding-failed preview note the right words when the failure can't be fixed by a reload: P5-SOURCES marks a binding whose source the store no longer knows with cause `source_unknown`, and for that cause the note now says to remove the section and add it again (the same words as the BINDING_INVALID publish check, plan C4-4).

## How the documents preview is detected today (recorded as the brief asks)

- `lib/content/resolve.js` `contentSource()` runs once per request. Its `noteRequestScope(src)` writes `documentsPreview = src.preview === true && src.v === DOCUMENTS_RELEASE_VERSION` (v4) into a per-request holder (React `cache`), published under `Symbol.for("storeasy.requestScope")`.
- So the flag is true only for a valid preview session on a documents store whose overlay applied. A legacy preview (`{ mode: "draft", preview: true }`, no `v`), a live page, an ended or refused session (live source) and any render outside a request all read false.
- `components/sections/index.js` `inDocumentsPreview()` reads that holder; `SectionView` already used it to add `ctx.preview` for the hero (P3-FRAME) and `ContentPage` for its pages.
- This item uses exactly that signal. `isFounderPreview(ctx)` is `ctx.preview` when the caller passes a boolean, otherwise `inDocumentsPreview()`. `HomeSections` passes no `ctx.preview` (as before), so on the home page it is the request scope.
- Not used: `isPreviewRequest()` (lib/cms/section-data.js), which the failed note uses. It answers true for legacy previews too, so it would show hidden notes in a legacy preview.

## Design

1. **The hook.** A section component may carry a static `hiddenReason(section, data, ctx) -> string | null`, next to its `shows()`. It is asked only when `shows()` is false.
2. **`hiddenNote(section, data, ctx)`** (index.js, exported): returns `null` unless the kind's component declares `hiddenReason`, `isFounderPreview(ctx)` is true, and the hook returns a non-empty string (a throw counts as no reason). Otherwise it returns the founder note: the same rich-text block the unfinished and failed notes use (`RichTextSection`), titled `"<Label>: hidden from shoppers"`, with the reason followed by "Only you can see this note in your preview." The root keeps `data-section-id` and `data-section-kind`, gets `data-sec` from `ctx.secKey` (as the section itself would, so a click selects it in both bridge versions), and `data-hidden-reason=""`. It is not marked `data-unfinished`: the section is finished, shoppers just don't see it, so the editor's "unfinished" list (bridge-core `ready().unfinished`) does not count it. The reason is HTML-escaped before it goes into the rich text.
3. **`HomeSections`**: where `!sectionShows(s, data)` returned `null`, it now returns `hiddenNote(s, data, { surface: "home", secKey: key })` (wrapped in a keyed `Fragment`), with the same `key` SectionView gets as `secKey`. Live and in a legacy preview that is `null`, as before. The note returns before the `#new` anchor logic, so it never takes the anchor. In a preview the note is a truthy entry, so it counts as "something shown" for `emptyNote` (a founder sees the note, not the empty-page message); live it is `null` and never counts.
4. **`isFounderPreview(ctx)` and `FounderNote`** (parts.js, re-exported from index.js) for per-cell notes (P5-BLOCKS' grid uses them for dropped cells). `FounderNote({ ctx, title, text, attrs, className })` renders a small dashed box (`data-founder-note=""` plus the given attrs, design tokens only) with the title, the text and the founder-only sentence. It checks `isFounderPreview(ctx)` itself and renders nothing otherwise, so a component author cannot leak it to shoppers by forgetting the check. React escapes its text.
5. **`requestScope()` and `inDocumentsPreview()` moved to parts.js**, unchanged, and are re-exported from index.js. A section component (imported by index.js) can now ask without importing index.js back. `ContentPage` keeps importing them from index.js.
6. **The binding-failed note's words.** `SectionView`'s `bindingFailed` branch passes a note cause to `failed()`: `"source_unknown"` when any failed field has that cause in `data.bindingFailedCause`, else `"fault"` (also when no cause was given). Words:
   - `source_unknown`: "This <label> section is set up in a way the editor can't fix. Remove it and add it again. Only you can see this note in your preview: shoppers don't see the section." (`unknownSourceText`)
   - `fault` or no cause: today's `failedText` unchanged ("… Reload the preview to try again.").
   The log line (`section_render_failed`, cause `data`) and the live behaviour (nothing) are unchanged. The words include the section's label, as the plan's C4-4 text does ("This <label> section …"); the brief's shorter quote has no label.

HOME_EMPTY is unaffected (it counts enabled body sections, not rendered ones). No legacy impact: legacy homes never carry a kind with the hook, and a legacy preview never sets the scope.

## Acceptance, with evidence

All in `scripts/test-sections-render.js`, section 6. "Fails without the change": run with `components/sections/*` checked out at `b09f342` and this test file (39 passed, 5 failed), plus the mutations below.

| # | Acceptance item | Status | Evidence |
|---|---|---|---|
| 1 | A throwaway kind whose `shows()` is false and whose `hiddenReason` returns a sentence renders that sentence in a documents preview render, with `data-sec` and `data-hidden-reason`, and an empty string live | DONE | "a throwaway kind whose shows() is false …": publishes the kind on a v4 store through the real service, renders `app/(storefront)/page.js` with a real preview session cookie inside one simulated request (`runRequest`), and checks the note's root (`data-sec="sec_hid1"`, `data-section-id`, `data-section-kind`, `data-hidden-reason=""`, no `data-unfinished`), title and words, and that `#new` still lands on the newest products. Live: the page with the hidden section equals the page without it, byte for byte; `HomeSections`, `SectionView` and `hiddenNote` with no request render `""`. Fails at base (no `hiddenNote`), with M1, M2 and M6 |
| 2 | product_rail bound to an empty collection still renders nothing in preview and live | DONE | "product_rail bound to an empty collection still renders nothing …": real data path, then `HomeSections` and `SectionView` inside a documents preview request, live, and the whole preview page. Fails with M4 (product_rail given a `hiddenReason`) |
| 3 | A bindingFailed section with cause `source_unknown` says "Remove it and add it again" in preview; with cause `fault` it says reload; live renders nothing for both | DONE | "a binding that failed: …": `SectionView` with `ctx.preview` true and false, then `HomeSections` inside a real documents preview request and a real live request (async render, as the failed note asks the request). Also: no cause keeps today's words, and a cause on a field that did not fail does not count. Fails at base and with M3 |
| 4 | Live renders of every registered kind against the worst-case fixtures, and the a6d028e legacy home fixtures, are byte-identical to the base | DONE | "live renders of every registered kind's worst-case fixtures … byte-equal to the base (b09f342)": per kind, one sha256 over every worst-case fixture rendered five ways (SectionView home and page with data; HomeSections with data, with none, and with none plus `emptyNote`). The digests in `BASE_LIVE` were recorded with `SR_RECORD=1` on this checkout before any component change (and again with the request-cache import removed: identical). A second test checks the same digests inside a real live request on a documents store. The a6d028e legacy fixtures are section 2's existing tests (v1, v2, v3, drafts, candidate, experiments), still green. Fails with M7 (live markup for a hidden section changed) |
| 5 | A legacy preview render shows no hidden note | DONE | "a legacy preview shows no hidden note …": a legacy store with a legacy preview token (`lib/releases.js previewToken`); inside that request `contentSource()` says `preview: true, mode: "draft"`, and `HomeSections`, `SectionView`, `FounderNote` render `""` and `isFounderPreview({})` is false; the whole legacy preview page has no `data-hidden-reason`. The same section in a documents preview request shows the note. Fails with M1 and M6 |
| 6 | The edge-safety scan still passes for `components/sections/*` | DONE | Section 5's existing scan reads every `components/sections/*.js` (parts.js included) for `node:` and Node built-in imports: passes. The new code imports only `react` and the section modules |
| 7 | `pnpm test` is green on the branch | DONE | 96 of 96 suites passed in 197.3 s |

Extra (not in the acceptance list): "FounderNote (a per-cell note) …" checks the part renders only in a documents preview (by `ctx.preview` or the request scope), with its attributes and words, and nothing live or for `ctx.preview: false`. "a kind without hiddenReason …" checks the empty-page rule both ways.

## Tests

Mutations, each applied alone to the changed components and run against the full suite:

| # | Mutation | Result |
|---|---|---|
| base | `components/sections/*` at `b09f342` | 5 failed (items 1, 3, 5, the plain-kind test, FounderNote) |
| M1 | `isFounderPreview` answers true for any request scope (so any request, a legacy preview included) | 4 failed (items 1, 5, plain-kind, FounderNote) |
| M2 | `HomeSections` builds the note's ctx without `secKey` | 1 failed (item 1: data-sec) |
| M3 | `bindingCause` always "fault" | 1 failed (item 3) |
| M4 | product_rail given `hiddenReason` | 1 failed (item 2) |
| M6 | `hiddenNote` without the preview check (note live too) | 3 failed (items 1, 5, plain-kind) |
| M7 | `HomeSections` renders `<i hidden>` instead of `null` for a hidden section | 7 failed, including the worst-case digest test (item 4) |

The suite now imports `scripts/support/request-cache.js` first, so `contentSource`'s React `cache` memoizes within `runRequest`, as in a real request. Outside `runRequest` nothing is memoized, as before; the 36 older tests are unchanged and pass.

## Known limits

- **No kind uses the hook yet.** The first users are P5-BLOCKS' bundle card and grid. Product rail still hides silently in preview (PV-09, P1), as the plan says.
- **Home page only.** `ContentPage` (pages, campaigns, journal) does not call `hiddenNote`: pages filter their sections with `sectionShows` and render no bound kinds today (DOC-06, SURF-05). A page kind with the hook would still vanish there.
- **The founder-note look is the rich-text block** (as for unfinished and failed notes), not the section's own look. The per-cell `FounderNote` is a small dashed box; its look on phones and in Safari is unchecked (owner check).
- **The reason is plain text.** A component returns one sentence; it cannot carry a link. "Catalog > Bundles" as a link is the editor's job (P5-EDITOR), not the preview note's.
- **A hidden note counts as "shown" for the empty-page message in a preview only.** A founder whose home has only hidden sections sees the notes, while shoppers see the empty-page message. This is the brief's rule.
- **The binding-failed words pick `source_unknown` when any failed field has it**, even if another field failed for a fault: reloading won't fix the section, so the remove words win.
- **`data-hidden-reason` is an empty marker**, not the reason text (the reason is the note's body).
- **Founder-only words.** The note says "<Label>: hidden from shoppers" with the label as the registry spells it.
- Rendered tests are react-dom/server (plus `prerenderToNodeStream` for the async failed note), not the RSC renderer. The request scope through React `cache` was checked on a production build by the P3-FRAME review; this item adds no new reader of it.

## From review

(Empty until the review.)

## Owner checks

- **Browser check (P5-DRILLS, once the bundle kinds exist):** in a documents preview in desktop Chrome, a turned-off bundle card shows the "hidden from shoppers" note with the reason, a click on it selects the section in the editor, and the live page shows nothing there. A grid with a dropped cell shows the per-cell note in preview only.
- Phone widths (375 and 768) and Safari for both notes (part of the plan's section 4 list).
- Wording sign-off: the note's title "<Label>: hidden from shoppers" and the `source_unknown` words, which include the section's label ("This newest products section is set up in a way the editor can't fix. Remove it and add it again.").
- Staging: one documents-mode tenant previewing a hidden bundle section after phase 5 deploys.
- (Carried) The CI sqld download in `.github` still needs the owner's approval of its source and checksum; this item did not touch `.github`.

## Commands

```
node scripts/test-sections-render.js                 # 44 passed
SR_RECORD=1 node scripts/test-sections-render.js     # prints the live worst-case digests
pnpm test                                            # 96 of 96 suites
pnpm build
```
