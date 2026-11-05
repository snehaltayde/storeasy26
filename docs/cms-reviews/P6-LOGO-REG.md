# P6 · LOGO-REG · The logo in the design document (registry and readers)

Branch `cms/p6-logo-reg`, cut from `b063753` (`cms/phase-1` with the phase 6 plan, after both the P5-FIX2 merge `441b44d` and the P5-DRILLS merge `211c982`). Plan: `docs/cms-reviews/P6-PLAN.md` (decision 5) and `P6-BATCHES.json` (batch 1). Requirements: GEN-04, TOK-03, MED-03.

Migrations owned: none. No rendering: the storefront still shows the text wordmark everywhere (P6-LOGO-RENDER renders the logo in batch 2).

Files changed:
- The plan's files: `lib/registry/settings.js`, `lib/registry/document-types.js`, `lib/content/documents-reader.js`, `lib/content/resolve.js`, `lib/documents/diff.js`, `scripts/test-registry-contract.js`, `scripts/test-media-refs.js`, `scripts/test-design-doc.js`, `scripts/test-editor-inspector.js`, `scripts/test-doc-diff.js` and this file.
- **Two files outside the plan's list:** `scripts/test-release-readers.js` and `scripts/test-content-seam.js`. Both list every exported `resolved*` getter on purpose and fail when a new one appears. Without an edit, `pnpm test` fails. The edit only adds `resolvedLogo`:
  - test-release-readers: one `GETTERS` row, the expected value on the v4 store (`null`, its design has no logo), on the legacy store with no release (`null`) and in `CLOSED_NEUTRAL` (`null`), plus the getter count 17 → 18.
  - test-content-seam: one `CALLS` row. It is not in `RECORDED`, because the a6d028e fixture has no such getter.
  - No other phase 6 item lists either file, so no batch shares them.

Not touched: `package.json`, anything under `.github/`, `inspectorModel.js`, `DesignForm.js`, `DocumentEditor.js`, `lib/documents/checks.js`, `lib/documents/refs.js`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files, and the two named `.claude/worktrees`. No store changed mode and `--hosted` was never passed. Nothing was sent to Typesense, Shopify or Razorpay, and no order was placed.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 98 of 98 suites passed in 201.0 s (ports 6140 and 7140 to 7149). `pnpm build` passed |
| Browser verified | **NOT DONE, and not applicable.** Nothing here renders, so every acceptance item is proved by a suite. The one founder-visible effect (a closed store's preview now shows the design draft) is proved in test-design-doc through the real preview path: a session token, the cookie, then `contentSource` |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing was pushed, merged or deployed |

## What and why

GEN-04's brand step lets the founder add a picture logo. Before this item, the only logo was the text pair in `config.site.logo`, and the design document (`doc_design`) held only `{ brand, theme }`. Plan decision 5 puts the picture logo in the design document, on documents stores only. This item adds:
- the setting kind;
- the declaration on the design type;
- the readers (`designFromBody`, `resolvedLogo`);
- the reference rows, so a used logo file can't be deleted;
- a plain publish-review row;
- a preview rule, so a closed store's founder sees the brand step's colours and logo without first finding a toggle.

## Design

### The `logo` kind (`lib/registry/settings.js`)

- **Value:** `null`, or `{ media, alt? }`.
- **Control:** `"logo"`. It is not `null`, because `null` marks system-only kinds such as `entries`.
- **`media`:** must match `LOGO_MEDIA_RE = /^\/api\/media\/[A-Za-z0-9_-]{1,120}$/`, the media id shape `lib/documents/refs.js` uses. Anything else is `LOGO_INVALID`, class `invalid`, with the words "Your logo must be a picture from your own library. Upload it again." That covers an https address, `//host/...`, another path, and a query string. A `media` that is not a string is `INVALID_VALUE`, class `structure`.
- **`alt`:** optional. A missing, empty or all-spaces alt gives no issue at all, in a draft or at publish. It is never `REQUIRED` and never `incomplete`. A string is trimmed. Over `LOGO_ALT_MAX = 120` characters once trimmed is `TOO_LONG` (`invalid`). The trimmed text is what the check returns, so the stored body holds it trimmed. The file's header comment now names this as the second change a check may make (the first is sanitizing HTML).
- **Other keys:** any other key is `UNKNOWN_FIELD` (`structure`). That also covers TREE-01's price and stock keys, so `logo` is in the suite's `OBJECT_KINDS` table.
- **References:** `refsOfSetting` handles `logo` the same way as `image`: `{ field: "logo.media", ref: "media", src }`. That one case gives three things:
  - `document_refs` holds the file by id (`refs.js` `rowOf` → `mediaIdOf`);
  - the publish checks see it (`checks.js` `refsOfBody` → `MEDIA_MISSING`);
  - `deleteMedia` refuses a file that a retained version still uses.

  The regex belt in `refRows` would already index the id without the case. The publish checks have no belt, so the case is needed for `MEDIA_MISSING`, and test-media-refs fails without it.

### The design type (`lib/registry/document-types.js`)

- It gains `{ key: "logo", kind: "logo", label: "Logo", default: null }`, so `emptyBody("design").settings` is now `{ brand: null, theme: null, logo: null }`.
- `sinceManifest` and the manifest are unchanged. The registry contract ties them to singletons, not to settings, and the design is still a manifest-1 singleton (tested).
- A stored body with only `{ brand, theme }` validates exactly as before, and validation adds no `logo` key to it (tested).

### Readers (`lib/content/documents-reader.js`, `lib/content/resolve.js`)

**`designFromBody(body)`**
- It now returns `{ brand, theme, logo }`.
- `logo` is `{ media, alt? }` only when `media` is a library path. Anything else in a body (no key, `null`, junk, another site's address) reads as `null`, so a hand-edited body never hands the renderer a foreign address.
- `lib/admin/brand-readability.js` spreads this object into `liveDesign()`, so that answer gains a `logo` key. No suite pins its exact shape, and test-design-doc's readers tests pass.

**The preview rule (`overlayList`)**
- The design draft is laid over when `showDesign` is on, **or** when the base list has no live `doc_design` entry (`base.documents.doc_design == null`).
- On a closed store the base is `previewBaseList()`, the code defaults, with `doc_design: null`. So the founder's preview shows the draft brand and logo without "Show them".
- A store with a live design entry keeps today's toggle.
- `designDirty` is reported as before.

**`resolvedLogo()`** (also in `contentGettersFor`)
- It answers `null` when `src.mode === "closed"` or the source is not v4. That covers a closed store for shoppers, legacy and migrating stores in draft mode, and a v1 to v3 release.
- Otherwise it answers `designFromBody(chrome.doc_design).logo`, from the live release or the founder's documents preview with the rule above.
- `resolvedBrand` and `resolvedTheme` are not changed, so legacy and migrated tenants look exactly as before.
- The preview check in `closedStoreGate` / `isStoreClosed` is not changed either.

### The publish review (`lib/documents/diff.js`)

The generic `settingPhrases` path already gives the wanted rows. The logo's default case is `presence(empty, empty)`, under the type's label "Brand":
- "Brand: logo added"
- "Brand: logo changed" (another file, or new words for it)
- "Brand: logo removed"

So no `logo` case was added.

One real gap had to be fixed. A design saved before phase 6 has no `logo` key, while `emptyBody("design")` now carries `logo: null`:
- The id-stripped canonical strings differ.
- The setting rows (correctly) say nothing.
- So `diffBodies` answered the catch-all "Brand: some details changed" for two bodies a shopper sees the same way.

The new `withNullDefaults(t, body)` fills each declared setting whose default is `null` with `null` when its key is missing, on both sides, before the comparison. It changes nothing when the key is there. It runs for every type, which is safe: a missing null-default setting always reads as `null` (`settingsOf(body).x ?? null`). Every existing test-doc-diff case passes unchanged.

### The inspector suite (`scripts/test-editor-inspector.js`)

- `"logo"` is in `WAITING_KINDS`, with a comment naming GEN-04: a P1 follow-up gives the editor a logo control, and in phase 6 the logo is set at `/admin/start`.
- `waitingProblems()` gains `document type "design": setting "logo" has no control`.
- `waitingField` already skips waiting fields in the design form's render check.
- DesignForm writes through `setAt(body, "settings.<key>", v)`. The new test drives the real BrandControl and ThemeControl `onChange` and shows that `settings.logo` survives both edits. `DesignForm.js` and `inspectorModel.js` are not edited.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Unit (test-registry-contract): the logo kind accepts null, `{media:'/api/media/abc'}`, `{media, alt:''}` and `{media, alt:'Acme'}`; refuses https://x/y.png, '/other/path', an unknown key and an alt over 120 characters; a missing alt passes publish-mode validation; the kind has a non-null control | **DONE** | "P6-LOGO-REG: the logo kind takes null and library files…". Each accepted value has zero issues in draft and publish. Each refused value has exactly one error on its field, with its class. Missing and blank alt give zero issues in both modes. `SETTING_KINDS.logo.control === "logo"`, and `controlsForDocument("design")` gives it too. Also checked: trimming, and refsOfSetting. It fails without the lib change (no logo kind); "TREE-01" fails too |
| 2 | Unit (test-media-refs): a doc_design draft with a logo indexes one document_refs row for that media id; removing the logo removes the row; deleting a used logo file is refused while the design is live | **DONE** | "P6-LOGO-REG: a doc_design draft with a logo indexes one document_refs row…": `createDocument({type:"design"})` with the logo. Its first checkpoint holds exactly `[{media, <id>}]`, and the store holds one row for that id. After publish, the live version holds it. A saveDraft with `logo: null` (checkpoint due) writes a version with no row, and usage no longer lists the draft. `deleteMedia` with `force` false and true is `MEDIA_IN_USE` in plain words, and the file stays. "P6-LOGO-REG: the publish checks see the logo…": a deleted logo file gives `MEDIA_MISSING` on `logo.media`. Both fail with only the `refsOfSetting` case removed (checked by mutation): the first on the registry's ref, the second on MEDIA_MISSING. "Removing removes the row" means the new version carries none. Earlier versions keep theirs, as for every image (history, MED-03) |
| 3 | Unit (test-design-doc): resolvedLogo() returns the logo for a v4 release with a design logo and null for closed, legacy and a v4 release without a logo. Preview of a store with no live design shows the draft brand and logo without show_design; a store with a live design still needs show_design | **DONE** | Section 9, three tests on four new file-database stores plus the existing legacy one, each run through a simulated request (next/headers stub, request-cache). The cases: open v4 with a logo; v4 without one; closed; legacy (config brand holding a logo); migrating; a v3 release; `contentGettersFor`. The preview test covers: a closed store's session with the toggle off shows the draft logo and brand (and on, the same); the open store shows the live values until `setShowDesign(on)`, then the draft's; shoppers keep the live values; plus `overlayList` units. Mutations: `resolvedLogo` returning null fails two tests, and the old overlay rule fails the preview test |
| 4 | Unit (test-editor-inspector): 'logo' is a waiting kind; a DesignForm brand change keeps settings.logo | **DONE** | "P6-LOGO-REG: 'logo' is a waiting kind…": WAITING_KINDS holds it, `controlKindOf("logo")` is null, coverage names the design field, and a brand edit and a look edit both keep `settings.logo` deep-equal. Without the lib change it fails, and so do the two coverage tests |
| 5 | Unit (test-doc-diff): a doc_design draft that only adds, changes or removes the logo gives exactly one plain row naming the logo; the existing design diff cases pass unchanged | **DONE** | "P6-LOGO-REG: a doc_design draft that only adds, changes or removes the logo…" covers: added, changed (file), changed (alt), removed; no key vs null both ways is `[]`; old empty vs new empty is `[]`; colour plus logo gives two rows; no row carries `/api/media`, `med_`, "other settings" or "some details". Without the lib change the generic rows hold, but "no key vs null" gives "Brand: some details changed" (mutation of `withNullDefaults`). The 44 existing cases pass unchanged |
| 6 | Existing design bodies with only {brand, theme} validate unchanged; test-preview-overlay unchanged; pnpm test passes | **DONE** | "P6-LOGO-REG: existing design bodies with only { brand, theme }…" covers three such bodies in both modes, with no issue and no key added. test-preview-overlay is not edited and passes 36 of 36. For `pnpm test`, see Tests |

## Tests

- `pnpm test`: see the line below. Ports were pinned to 6140 and 7140 to 7149 (`TEST_PUBLISH_PORTS`, `TEST_PUBLISH_SERVICE_PORTS`, `TEST_PUBLISH_UNDO_PORTS`, `TEST_PRODUCT_CONTENT_PORTS`, `TEST_MIGRATE_MAP_SQLD_PORT`, `MIGRATE_DOCUMENTS_TEST_PORTS`, `MIGRATE_DOCUMENTS_TEST_WEB_PORT`).
- Single suites after the change:

| Suite | Result |
|---|---|
| test-registry-contract | 41 passed |
| test-media-refs | 25 passed (1.5 s) |
| test-design-doc | 26 passed (2.4 s) |
| test-editor-inspector | 59 passed |
| test-doc-diff | 45 passed |
| test-preview-overlay | 36 passed |
| test-release-readers | 47 passed |
| test-content-seam | 20 passed |
| test-legacy-fixtures | 33 passed |

- **Without the lib change** (`git stash -- lib/`):
  - registry-contract: 3 fail;
  - media-refs: 2 fail;
  - design-doc: fails at setup, because `createDocument` refuses an unknown `logo` field;
  - editor-inspector: 3 fail;
  - doc-diff: 1 fails.
- **Single mutations, each failing its test:**
  - the old overlay rule;
  - `withNullDefaults` removed;
  - the `refsOfSetting` `logo` case removed;
  - `resolvedLogo` returning null.
- **Edge runtime:** the lib files touched import nothing new. diff.js's edge-guard test passes, as do the registry and reader edge scans in the gate.

Gate results:

- **`pnpm test`:** 98 of 98 suites passed in 201.0 s, exit 0.
- **`pnpm build`:** passed, exit 0. It printed three warnings, all of them the existing `next.config.mjs` file-tracing warnings, plus the existing edge-runtime note about `/api/errors`. None names a file this item changed.

## Known limits

1. **On a closed store, the editor's "Show them" toggle now changes nothing.** The design draft always shows in the founder's preview there. The same holds on an open store whose live list has `doc_design: null` (opened on the platform default, before PUB-12's design rule). The brief's rule is "no live doc_design entry". `DocumentEditor.js` is not edited for this: its only phase 6 edit is P6-NAV's `startingBrand` prop (owner answer OQ-P6-8). The bar still shows the toggle. Owner check below.
2. **MEDIA_MISSING's words fit an image, not a logo.** For a deleted logo the publish panel says "…shoppers see a plain colour block instead. Choose another image." With the logo it is the text wordmark that shows. `checks.js` is not this item's file. This is a founder-facing publish warning, never shopper text. Follow-up: word it by kind in checks.js (P6-LOGO-RENDER or later).
3. **`emptyBody("design")` now carries `logo: null`.** So `documentHash(prepare(emptyBody("design")).body)` differs from that of an empty design created before this branch. P6-GEN-WRITE's "untouched empty" rule is written for `doc_home`. If it is ever applied to `doc_design`, an old untouched empty design would count as founder-written and would not be refilled. `diffBodies` treats the two the same (tested).
4. **The logo must be exactly `/api/media/<id>`:** no query string and no absolute address. The brand step (P6-BRAND) must write `mediaUrl(id)` as it is.
5. **History keeps the logo file.** Earlier versions keep their `document_refs` row after the logo is removed. The file stays protected while a retained version holds it, as for every image (MED-03, P4-MEDIA). Pruned checkpoints stop counting.
6. **No editor control.** `logo` is a waiting kind in the inspector, so a logo issue in the editor shows as an orphan note at the form's top, with no field to jump to. The control is a P1 follow-up.
7. **Legacy stores:** `config.brand.logo` and `config.site.logo` are not read or moved. `resolvedLogo` is `null` there, and a migration does not carry a picture logo into `doc_design`.
8. **The trimmed alt is written back.** A save sent with `"  Acme  "` stores `"Acme"`. The editor has no logo field, so no typing is disturbed today. A future control should trim on blur, not on every key.

From review:

- The preview bar says something false on a closed store, and the packet's Known limit 1 leaves this out. On a closed store, or a live store whose list has doc_design: null, with the toggle off, the design draft is now shown (overlay.designShown is true, as test-design-doc line 1018 asserts). But app/(storefront)/layout.js passes only designDirty and showDesign to components/PreviewBanner.js. So the bar says 'Your new colours are not shown here. Show them' while the colours are shown. The founder sees this, shoppers never do. The packet only says the toggle 'changes nothing' and 'the bar still shows the toggle'. Fix: add this sentence to Known limit 1 and the owner check. A later fix would be for documentsPreview to report showDesign as session.showDesign || !liveDesign, or for the layout to pass designShown to the banner.
- In logoFrom (lib/content/resolve.js), the src.mode === 'closed' check is never needed: a closed source's list is emptyList() with no doc_design, so the logo is null anyway. Mutation M3 removed the check and test-design-doc and test-release-readers still passed. It is harmless defence, but the 'null for closed' test passes because the list is empty, not because of that line.
- withNullDefaults in lib/documents/diff.js reaches beyond design. It also applies to every setting whose default is null on announcement (link) and on product_content and collection_content, though those two usually go through describeChanges and not diffBodies. For these settings a missing key and a null mean the same thing, and pnpm test passes, so nothing breaks now. The packet presents the change as being about design only.
- test-editor-inspector did not catch mutation M9 (the logo kind's control set to null). test-registry-contract did catch it, so the acceptance item is still covered by one suite.
- The MEDIA_MISSING wording ('plain colour block… Choose another image') for a deleted logo is image wording. The builder already lists it as a founder-only known limit and an owner check. I agree it does not block.

## Owner checks

- **The "Show them" toggle on a closed store** now changes nothing: the design draft always shows in the founder's preview there. Confirm that is acceptable, or ask for the bar to hide the toggle until the store opens (a DocumentEditor / bar change).
- **The MEDIA_MISSING wording for a deleted logo** ("plain colour block… Choose another image.") is image wording. Confirm a logo-specific sentence should come in a later item.
