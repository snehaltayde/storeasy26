# P2-WRITERS: one door for the four programmatic content writers

Branch `cms/p2-writers`, cut from `d36f683`. Plan: `docs/cms-reviews/P2-PLAN.md`
(decisions 12 and 13, batch 4, sections 3, 4 and 6). Spec: DOC-02, DOC-05,
DOC-07 (section 7.1), section 8.11 (mapping traps). Builds on P2-GUARD
(`lib/cms-mode.js`), P2-REG (`lib/registry/legacy.js` adapters), P2-DOCS
(`lib/documents/service.js`) and P2-READ. Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:writers` 20 passed, 0 failed, about 0.8 s. `pnpm test`: 66 of 66 suites passed in 117.2 s. `pnpm build` passed, with the 2 warnings that were already there (NFT trace of `next.config.mjs`). The first build attempt failed fetching Google fonts (`next/font/google`, a network hiccup, nothing in this diff); the rerun passed unchanged |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a unit test through the real routes. No desktop Chrome drill was run (owner check OC-W1) |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed or deployed. No tenant changed mode |

## What and why

Four writers wrote today's content tables directly with `setBlock`, skipping
everything a founder's own save goes through (DOC-02 names them):

- experiment adopt (`lib/experiments.js adoptVariant`) wrote the variant payload
  as the WHOLE hero, so the founder's buttons and badge were replaced by
  defaults (DOC-02 "Adopting an experiment variant keeps the hero's buttons and
  badge. Today they are replaced by defaults");
- AI insight apply (`lib/ai/insights.js applyInsightDraft`), the same for its
  hero draft;
- agency kit apply (`lib/platform/agency.js applyAgencyKit`) stored the kit's
  `home_sections` raw, so id-less sections stayed id-less (the spec 8.11 trap:
  their ids are only the read-time `sec_l<i>`);
- the theme kit's hero preset (`lib/themes/kits.js applyKit`).

None of them checked a revision, none kept history, and none of them knew about
documents mode, so P2-GUARD refused them at the route in a documents store.
This item gives them one door that knows both modes, and removes those route
refusals (except theme, see below).

## Design

### `lib/content-writes.js`: `writeContentDrafts(changes, { actor, source, documents })`

`changes` is any of `hero: { value, merge }`, `home_sections: [...]`,
`announcement: {enabled, text, href}`, all in the old flat shapes. The mode is
read fresh with `getCmsMode()` on every call.

| Mode | What happens |
|---|---|
| `legacy` | Each block is read (`getBlockRow`, strict), its new value built (a `merge` hero is `{...defaultHero, ...stored, ...payload}`, the hero as the editor shows it), then **every** block is validated with `validateBlock` before anything is written; any error is a 422 `ValidationError` with every issue, nothing written. `validateBlock("home_sections")` stamps durable `sec_` ids on id-less sections (the 8.11 trap). Each block is then written with `setBlock(key, value, { expectedRevision: <the revision read> })`: a concurrent edit is a 409 `CMS_CONFLICT` with the current value (`ContentWriteConflictError`), never a silent overwrite. Each write is audited (`block:<key>`, `diff.source` names the caller) and gets a `cms_history` entry with its revision and actor |
| `documents` | The old shapes go through the P2-REG adapters (`legacyHeroToSettings`, `legacyHeroToSection`, `legacyHomeSectionsToSections`, `legacyAnnouncementToSettings`). The hero and home sections go into ONE `saveDraft` of `doc_home`; the announcement into `doc_announcement`. A document that was never saved is created (`createDocument`). A `merge` hero keeps every setting the payload doesn't name (buttons, badge, image); a replace (a kit) starts from the declared defaults and keeps only the image (the old shape can't say anything about it). `home_sections` replaces every section but the hero; a home with no hero gets one back at position 0. Validation, sanitizing, revision + 1, the stale 409 and the checkpoint are the service's. Nothing publishes: `cms_blocks`, `releases`, `release_state`, `publish_log` and every published version are untouched. Each saved document is audited (`document:<id>`) |
| `migrating`, anything else | 409 `STORE_USES_DOCUMENTS` (P2-GUARD's words), nothing written |
| mode unreadable | `CmsModeUnavailableError`, a 5xx, never a go-ahead |

**Edge.** `lib/experiments.js` is imported by the storefront home page and
`lib/themes/kits.js` by `lib/releases.js` (and so by the v4 reader). The
documents service reaches `lib/platform/identity.js`, which imports
`node:crypto`. The first draft loaded the door with `import()`, and
`test-release-readers`' edge walk caught it (it follows `import()` too). So the
door imports nothing Node-only, and the documents service is handed in as
`opts.documents` by a Node caller: the experiments route (`import * as
documents from "@/lib/documents/service"`), and `lib/ai/insights.js` and
`lib/platform/agency.js` (Node-only modules, console routes and pages). A call
without it in a documents store refuses with 409 and writes nothing (fail
closed, never a legacy write). `applyKit` never needs it. The door is still
loaded with `import()` by the callers so a storefront request never runs it.

**Errors for routes.** `writeRefusalBody(e)` gives `{error, code, current?,
saved?}` for a deliberate refusal (`e.expose`, a 4xx). The two `/api/admin`
routes answer `if (e?.issues)` (422 with `validationBody`) and `if (e?.expose)`
before `infraResponse`, the shape `test-failure-matrix` requires.
`contentWriteAnswer(e)` gives the whole answer for `app/api/partners`.

**Test seam.** `__contentWriteTestHooks.beforeWrite`, called after the reads and
before the first write, so a suite can land a colleague's save in between.

### The callers

| Caller | Change | Hero |
|---|---|---|
| `adoptVariant(slug, key, { actor, documents })` | through the door | **merged** over the current hero |
| `applyInsightDraft(id, index, { actor })` | through the door, hands in the service itself | **merged** (an AI hero draft names only title, highlight, subtitle). Announcement: replaced, as before |
| `applyAgencyKit({...})` | one door call inside `runAsTenant` for hero, sections and bar; hands in the service | replaced (a kit is a whole hero, as before) |
| `applyKit(kit, opts)` | refuses any store not on legacy with 409 `STORE_USES_DOCUMENTS` **before** the pin or brand is written (brand and theme are control-plane writes, `doc_design` at TOK-03); the hero preset goes through the door | replaced, as before |

The notes the callers return say "publish it from the editor" in documents mode
and keep today's "publish a release" words in legacy.

### `heroVariantSettings(settings, variantPayload)` in `lib/experiments.js`

`{ ...settings, ...legacyHeroToSettings(variantPayload) }`: the flat payload
goes through the adapter (buttons become typed links) and is merged at the
settings level, so what it doesn't name (the other button, badge, image) stays.
`heroVariantFor` is unchanged for legacy callers. Nothing serves from
`heroVariantSettings` yet; it is there for the v4 home (P2-SECTIONS) and the
cutover translation of running variants (MIG).

### Routes

- `app/api/admin/experiments/route.js`, `app/api/admin/insights/route.js`,
  `app/api/partners/route.js`: P2-GUARD's route-level refusals are removed; the
  door decides by mode. The partners route still checks the grant first (no
  probing another store). The experiments route passes `auth.actor` and the
  documents service; insights passes `auth.actor`.
- `app/api/admin/theme/route.js` is **unchanged**: it keeps P2-GUARD's refusal,
  because `applyKit` also writes brand and theme.

### The grep guard (`scripts/test-writers.js`)

Scans `lib`, `app`, `components`, `scripts`, `migrations` (and
`middleware.js`/`instrumentation.js` when present), comments stripped:

- no call to, or import of, `setBlock`, `deleteBlock`, `upsertContentPage` or
  `deleteContentPage` outside `lib/cms/store.js`, `lib/admin/cms-api.js` and
  `lib/content-writes.js`; allowlisted: `scripts/seed-design-preview.js`,
  `scripts/perf-fixture.js`, `scripts/perf-report.js`;
- no INSERT, UPDATE, DELETE or REPLACE on `documents`, `document_versions` or
  `publish_log` (raw SQL or Kysely) outside `lib/documents/`.

Test suites (`scripts/test-*.js`, `scripts/support/`, `scripts/drills/`) build
their own fixtures and are skipped, as `test-documents`' scan does. The guard is
shown to bite on eight shapes, including the old `adoptVariant` import.

## Acceptance, with evidence

"Bites" says what happened without the change. Two ways were used: (1) the new
suite run with the seven caller and route files put back to `d36f683` (the door
present so the suite loads): 3 passed, 15 failed of the 18 cases at that point;
(2) 19 single mutations of the new code, each run alone; all 19 were caught.

| # | Item | Status | Evidence (`pnpm test:writers` case) | Bites |
|---|---|---|---|---|
| 1 | unit (legacy): adopting a variant keeps the founder's buttons and badge | PASS | "legacy adopt keeps the founder's buttons and badge …" (through `POST /api/admin/experiments`), "a variant that names a button replaces only that button" | Yes: at base both fail (buttons and badge gone). Mutation `merge: false` in `adoptVariant`: 4 cases fail |
| 1b | … a stale concurrent edit gives 409, not a silent overwrite | PASS | "legacy: a concurrent edit between the read and the write is a 409 with the current value …": the seam saves a colleague's hero at the next revision; the route answers 409 `CMS_CONFLICT` with `current`; the colleague's hero is stored; the experiment is not marked adopted | Yes: at base the adopt overwrote. Mutation (no `expectedRevision`): fails. Mutation (conflict status 422): fails |
| 1c | … the write is validated, audited and has a history entry | PASS | "legacy: the write is validated (422 with issues, nothing written), audited, and has a history entry": an empty variant title is 422 `VALIDATION_FAILED` naming `title`/`REQUIRED`, the hero row is unchanged; a valid adopt bumps the revision by 1, adds one `audit_log` row (`block:hero`, the merchant, `diff.source = experiment:good`) and one `cms_history` entry with that revision and actor | Yes: at base no 422, no audit row, no history. Mutations (no audit, no history, no validation refusal): each fails |
| 2 | unit (legacy): an agency kit with id-less `home_sections` stores sections with `sec_` ids | PASS | "legacy agency kit with id-less home_sections stores every section with a durable sec_ id" (through `POST /api/partners`, agency session): 3 sections, valid unique minted ids, none `sec_l<i>`; audited | Yes: at base the ids were missing. Mutation (store the raw value): fails |
| 3 | unit (documents): adopt, insight apply and agency apply each change only the `doc_home` or `doc_announcement` draft (revision + 1), never `cms_blocks` and never the live list | PASS | "documents adopt …", "documents insight apply …", "documents agency kit apply …", all through the real routes: the target document's revision + 1; every other document's revision and hash unchanged; `cms_blocks`, `cms_pages`, `cms_history`, `releases`, `release_state`, `publish_log`, every document's `published_version_id`/`published_hash` and every published version identical before and after. The adopted hero keeps the founder's buttons (as typed links), badge and image | Yes: at base all three answered 409 (P2-GUARD's refusal). Mutation (documents mode takes the legacy path): 7 cases fail. Mutation (route refusal put back): fails |
| 4 | unit: `heroVariantSettings` merges a flat variant payload into hero settings, equal to the `settingsToLegacyHero` round-trip of `heroVariantFor`'s legacy output | PASS | "heroVariantSettings merges …": 12 hero × payload pairs (founder hero, the P2-REG kit fixture, a bare hero; four payloads incl. both buttons) give `settingsToLegacyHero(heroVariantSettings(legacyHeroToSettings(hero), payload))` equal to `heroVariantFor(exp, hero, unit).hero` for a unit assigned to the variant. At settings level the image and badge stay and the button is a typed link; the result is a valid hero section in publish mode; `heroVariantFor` with no unit returns the hero untouched | Yes: no such function at base. Mutation (merge without the adapter): fails |
| 5 | unit: kit apply in documents mode returns 409 (brand and theme are TOK-03); in legacy it works as today | PASS | "kit apply in documents mode is 409 …": `applyKit` throws 409 `STORE_USES_DOCUMENTS`; tenant config, documents and `cms_blocks` unchanged; `POST /api/admin/theme` also 409. "kit apply in legacy works as today …": pin, brand defaults and the hero preset written; now also a history entry; `withPresets: false` writes no hero. Existing `test-themes` (10 cases) passes unchanged | Yes: at base `applyKit` itself wrote the pin and brand in a documents store (only the route refused). Mutation (no mode check in `applyKit`): fails |
| 6 | unit: the grep guard finds no direct block, page or document-table writers outside the allowlist | PASS | "the grep guard finds no direct block, page or document-table writer outside the allowlist": the scan is empty, the four callers and the door are in it, and it catches 8 shapes (incl. the old `adoptVariant` import) | Yes: at base it lists the four callers. Mutation (put `setBlock` back into `lib/experiments.js`): fails |
| 7 | unit: existing `test-preview-experiments` and `test-cms` cases pass unchanged | PASS | `pnpm test`: test:preview-experiments 33/33, test:cms 11/11; `git diff d36f683 -- scripts/test-preview-experiments.js scripts/test-cms.js` is empty | No-regression item |

Further cases in the suite (not acceptance items, each bites by mutation):

- legacy insight apply keeps the founder's buttons and badge, and an
  announcement draft is validated and written;
- a documents home never saved is created holding the hero; a home with no
  hero gets it back first (mutation: append instead of prepend, fails);
- documents: a concurrent save between read and write is a 409 with the
  current document, ours does not land, the experiment isn't marked adopted;
- documents: a kit with an unknown section kind is 422 with issues and nothing
  stored; an empty hero title is only incomplete in a draft and saves (DOC-05);
- `migrating`: adopt, insight apply and kit apply each 409 with "moving to the
  new editor", nothing written (mutation: allow, fails);
- a `cms_state` that can't be read: 5xx, plain words, nothing written;
- a documents store and a caller that doesn't hand in the service: 409,
  nothing written (mutation: drop the check, fails);
- edge: no `node:*` import in the import graph (static and `import()`) of the
  door, `lib/experiments.js` and `lib/themes/kits.js`, and the documents service
  is not in it (mutation: `lib/experiments.js` imports the service, fails).

### Requirements, and what is left

| Requirement | Proven here | Left, and for which item |
|---|---|---|
| DOC-02 | The four named callers use one service per mode; the grep guard; adopt keeps buttons and badge; old-shape experiment, AI and kit payloads produce a valid hero (documents adopt/insight/kit cases, and the settings-level case validates in publish mode); revision checked, 409 with the current value | "The text stays in the editor" (ED-02). The guard is a write check only; the read check of spec 8.11 is MIG |
| DOC-05 | A drafted change never publishes; an incomplete hero saves as a draft; structure is refused | Publish re-validation (P2-PUBLISH) |
| DOC-07 | The flat variant payload merges at the settings level (`heroVariantSettings`), equal to the legacy serving merge | Serving a running experiment on a v4 home (P2-SECTIONS) and translating running variants at cutover (MIG) |

## Tests

| Suite | Result | Time |
|---|---|---|
| `pnpm test:writers` (replaces the P2-ATOM placeholder; `package.json` unchanged) | 20 passed, 0 failed | about 0.8 s |
| `pnpm test:cms-api` | 27 passed (see below) | 0.8 s |
| `pnpm test:failure-matrix` | 112 passed | 23.0 s |
| `pnpm test:release-readers` | 27 passed | 1.9 s |
| `pnpm test` | 66 of 66 suites | 117.2 s |
| `pnpm build` | passed; 2 warnings that were already there | |

`scripts/test-cms-api.js` changed in one place: experiment adopt, insight apply
and agency kit apply left P2-GUARD's "every old writer answers 409 in documents
mode" list, because they no longer refuse there (that is this item's job). The
header comment says where they are covered now. The "back on legacy" adopt case
and every other case are unchanged.

## Known limits

- **The mode check is a pre-check** (MIG-03), as P2-GUARD's: a cutover landing
  between the read and the write is not caught.
- **Legacy writes of several blocks are not atomic.** An agency kit writes
  hero, sections and bar one after another; everything is validated first, but
  a concurrent edit or a database failure on the second or third block leaves
  the first saved. The answer says so (`saved` names the blocks, and the 409
  words name them). In documents mode hero and sections are one `doc_home`
  save; the bar is a second save, with the same reporting.
- **Behaviour changes on legacy stores, on purpose:** an AI hero draft is now
  merged over the current hero (the founder's buttons and badge stay); kit and
  agency payloads are now validated, so one the editor would refuse is a 422
  instead of being stored; agency kit sections get minted ids; each of these
  writes now adds an audit row and a history entry; the theme kit's hero
  preset is written at the revision it was read at (a colleague's save in
  between is a conflict, not overwritten).
- **The theme route answers a hero conflict with 422**, not 409: its catch-all
  is not in this item's files. Nothing is overwritten; the words say someone
  else changed it. The route's own refusal still answers documents stores 409.
- **The partners route answers a database failure 422** (unchanged, it has no
  `infraResponse`).
- **A kit's hero in documents mode keeps the founder's hero image**; everything
  else of the hero copy is replaced. External links in kit or AI payloads are
  refused by the registry's link rule in documents mode (422).
- **Audit twice per adopt**: the route's `experiment:<slug>` row (as before) and
  the door's `block:hero` or `document:doc_home` row.
- **No caller serves from `heroVariantSettings` yet** (P2-SECTIONS, MIG).
- **A caller outside the Node routes** that calls `adoptVariant` without
  `documents` refuses on a documents store (409). `test-growth` calls it on a
  legacy store, which works as before.
- No browser drill (OC-W1).

### From review

Non-blocking findings from the independent review, added at merge.

- Theme route can tell the founder something false (lib/themes/kits.js applyKit plus the catch-all in app/api/admin/theme/route.js). applyKit writes the theme pin and the brand with patchTenant before it writes the hero preset. Because of this change, the hero preset is now written with a revision check. If a colleague saves the hero in between, the route answers 422 'Someone else changed this while it was being saved, so nothing was saved.' But the theme pin and brand were saved. Reproduced on a legacy test store: the answer was 422 with those words, and afterwards config.theme was {kit:'glow'} and config.brand held the glow brand. It only happens in a race, and no founder content is lost; the colleague's hero is kept. The packet's Known limits mentions the 422 but says 'Nothing is overwritten', which skips the false 'nothing was saved'. Suggested fix: catch the hero conflict inside applyKit and return presets:[] with a plain note ('the theme and brand were applied; the hero preset was not, because someone else changed the hero'), or have the route answer 409 with words that name what was saved.
- The grep guard doesn't catch raw SQL or query-builder writes to cms_blocks or cms_pages. Only the four function names are guarded. A mutation that added db.insertInto("cms_blocks") to lib/experiments.js passed all 20 test-writers cases. Putting setBlock back, or adding a direct write to the documents table, was caught. The brief lists only the function names, so the acceptance item holds as written. scripts/seed-cms-beastlife.js already uses INSERT OR IGNORE INTO cms_blocks. Consider adding cms_blocks and cms_pages to the table-write regex, with the same allowlist.
- 'Replaces the hero copy, as before' is not pinned by any test for agency kits or theme kits. I flipped merge:false to merge:true in lib/platform/agency.js and in lib/themes/kits.js. test-writers (20/20), test-agency (16/16) and test-themes (10/10) all still passed. Add a case where the founder's hero has a field the kit leaves out, and check that it is replaced.
- In documents mode, removing the door's audit row (the document:doc_home or document:doc_announcement row in lib/content-writes.js writeDocuments) is not caught by any test. Only the legacy audit is asserted.
- In documents mode, agency kit sections without ids are stored with positional ids (sec_l0, sec_l1, ...) from legacyHomeSectionsToSections. The 8.11 trap is fixed only on the legacy path, which is all the brief asks for. Applying a second kit gives different sections the same sec_l<i> ids, so anything keyed on section ids (experiments, analytics) could attribute across kits. A probe with an explicit sec_l1 next to an id-less section was handled: the service minted a fresh id for the duplicate. Worth an owner note for MIG and P2-SECTIONS.
- Agency kit and theme kit payloads on legacy stores are now validated. A kit the editor would refuse (for example, a section of an unknown kind) now gets 422 for the whole apply. Before, it was stored raw. This is intended and is listed in the packet as OC-W2. It is a real behaviour change for existing agency kits, so the owner should confirm it.
- What I checked: I ran all 66 suites directly with node, one at a time, and all passed in 97 s. test:preview-experiments 33/33 and test:cms 11/11 match the base. In the worktree, pnpm itself refused to run because node_modules there was a symlink to the main checkout, so I ran each suite's own node command instead. next build (Turbopack) passed with the same 2 NFT warnings. No edge chunk contains node:crypto or lib/documents/service. An import walk from the storefront layout, the home page and the edge routes reached only the node:async_hooks import that was already there before this change. I tried 25 single-line mutations: 20 were caught, and the 5 that weren't are the gaps listed above. Probes: a legacy adopt with no hero row creates it at revision 1 over the defaults. A stored hero with an external button is kept as it was. A stale write in documents mode gives 409 with the current document. I removed the worktree and stopped everything I started.

## Owner checks

- **OC-W1** Desktop Chrome on the design harness, own ports: on a legacy test
  store with a hero that has two buttons and a badge, complete a hero test and
  click Adopt; the Designer preview shows the variant's copy with the founder's
  buttons and badge. Apply an AI hero idea: the same. Then set the test store
  to `documents` and adopt again: the answer says "publish it from the editor",
  and `doc_home`'s draft (via `PUT /api/admin/documents {getDocument:
  "doc_home"}`) holds the change while the storefront is unchanged. Not run.
- **OC-W2** The owner confirms the legacy behaviour changes listed in Known
  limits (AI hero drafts merged, kits validated, kit hero keeps the documents
  hero image).
- **OC-W3** Before any store changes mode: MIG-03 tightens the mode pre-check
  into the write (as OC-G3).
- **OC-W4** CI's sqld download (source and checksum) still needs the owner's
  approval; nothing under `.github/` was changed.
- **OC-W5** Hosted Turso: one adopt on a staging legacy store, and one on a
  staging documents test store, each re-read afterwards.

## Files

`lib/content-writes.js` (new), `lib/experiments.js`, `lib/ai/insights.js`,
`lib/platform/agency.js`, `lib/themes/kits.js`,
`app/api/admin/experiments/route.js`, `app/api/admin/insights/route.js`,
`app/api/partners/route.js`, `scripts/test-writers.js`,
`scripts/test-cms-api.js` (one list, see Tests), this packet.

## Commands

```
pnpm test:writers
pnpm test
pnpm build
```
