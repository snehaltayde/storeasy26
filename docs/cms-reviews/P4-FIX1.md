# P4 · FIX1 · The MAPPER review's findings

Branch `cms/p4-fix1`, cut from `509bf57` (`cms/phase-1`). Plan: `docs/cms-reviews/P4-PLAN.md` and `P4-BATCHES.json` (item P4-FIX1). Requirements: MIG-01 and MIG-02. The findings come from the "From review" list in `docs/cms-reviews/P4-MAPPER.md`.

Files changed: `lib/migrate/map.js`, `lib/migrate/report.js`, `scripts/migrate-documents.js`, `scripts/test-migrate-map.js`, `docs/cms-reviews/P4-MAPPER.md` and this packet. `lib/migrate/ids.js` and `lib/migrate/state.js` needed no change; their rules are now tested.

Not touched:
- `lib/migrate/check.js` and `lib/migrate/map-entities.js` (P4-OVL07 owns them in this batch).
- `package.json`, `.github/`, `MANUAL-CHECKS.md` and the untracked `docs/CMS_*.md` files.
- Any P3-FIX5 file.

No migration. Only file databases were used. No case passes `--hosted`.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 96 of 96 suites passed in 170.4 s. `test:migrate-map`: 59 passed (47 before; 12 new). `pnpm build` passes |
| Browser verified | Not applicable. The changes are to a command-line dry run and to library code that no route imports. Nothing a shopper or founder sees in the browser changed. No dev server was started, and port 6160 and ports 7160 to 7169 were not listened on |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso. Running a real dry run is an owner step |
| Production enabled | **NOT DONE.** Nothing was pushed or deployed |

## What, why and design

1. **Six safety lines are now pinned by tests (no code change).** Before this item, each of these lines could be switched off and every test still passed. Each one now has a case in part 13 of `scripts/test-migrate-map.js`:
   - **(a) Entity content.** A store that is ready (the journal set), plus one `product_overrides` row, is refused with `ENTITY_CONTENT_NOT_MOVABLE`.
     - The case hands in the entity part as it is while unbuilt (`built: false`, real `entityHoldings`). So it keeps pinning map.js's refusal after P4-OVL07 builds the real entity part.
     - A built entity part with the same content is not refused.
   - **(b) A data-check difference alone.** The store is the journal set with a candidate whose announcement differs. It has no refusal and no unmatched address. Its verdict is "Not ready: 1 thing to fix", and the one fix is the shopper change.
   - **(c) Agency access.** An accepted agency grant (the `agency_grant` fixture) gives `AGENCY_ACCESS`, and that is the only refusal. A run with no control plane gives `AGENCY_UNCHECKED`.
   - **(d) Brand and theme edits.** `sourceHash` already included `design`. The test now shows that a brand edit, and then a theme edit, each change it, and that `sourceHashOf` reads the design.
   - **(e) Two cart offers.** Two enabled cart offers, plus one that is switched off, merge in position order with each product once (`P221, P1, P220`). The first offer's `''` title becomes the default words, the later offer's title is listed, and the data check shows no cart difference.
   - **(f) No announcement row.** With no row, there is no announcement document, and the list holds `null`. This holds on a live v3 store and on a store that is open with no release.
2. **`lib/migrate/ids.js` is proven by checks that never call `migratedVersion`.**
   - **The fixture.** A live v3 release holds home sections with no ids. Next to it are drafts with the same content and ids of their own (`sec_new01`, …). The bodies differ only by ids. Their draft and published hashes are equal, and `doc_home` is not dirty.
   - **`draftHash` and `publishedHash`.** Each gives the same value for a body whose ids were renamed. Neither equals the hash with ids kept, and a content change still changes them.
   - **Version ids.** Every listed version id equals `ver_` plus the first 16 hex of `sha256(documentId + sha256(canonical body))`, worked out with node's `crypto` in the test. It never equals the same hash without the document id. Each list entry's `hash` is the hash with ids kept.
   - So the packet's claim "even where an old live snapshot had no section ids" now has a fixture.
3. **The report never says "Nothing." when the data check didn't run.**
   - `buildReport` sets `shopperChangesChecked`. It is true only when the check ran, or when nothing is published to compare (a store that isn't open yet: "stays closed until your first publish").
   - Otherwise, "What shoppers will see change" prints `Not checked: fix the things above first.` That covers NEEDS_FLAG, PENDING_SCHEDULE, LIVE_READ_ERROR, migrating, already in documents mode, and no check passed at all.
   - A store with no refusal whose comparison did not run is a fix: "The comparison with your live store couldn't run". Before this change, that only happened when a check object said `REFUSED`. Now a missing check object counts too, so no path gives "Ready to move" without a comparison.
4. **Generated section ids never repeat a stored one.**
   - The new `uniqueSectionIds(entries, reserved)` in map.js keeps stored ids first; the first of two equal ones keeps its id. Then each generated id, or a repeat, takes the first free id out of `<id>x2`, `<id>x3` and so on, or `sec_dup<k>` when that would be too long for an id.
   - It is used for:
     - home sections (`sec_hero` reserved);
     - product-page extras (`sec_productmain` reserved);
     - page sections, which come from the registry's `legacyPageSectionsToSections`.
   - Stored `[{id:'sec_l1'}, {}, {}]` now gives `sec_l1, sec_l1x2, sec_l2`. That holds for rows stamped at read (schema 1 `home_sections`) and for rows read as stored (schema 2).
   - No `SECTION_ID_DUPLICATE` is left to stop a draft save, and the home and page data checks still show no difference.
5. **The cart handle is kept, and recorded for P4-CUTOVER.** Something needs the handle:
   - `resolve.js` `cartPlacementRows` only takes picks that have a string `handle`;
   - the `product_list` check (`checkRef`) requires a valid handle;
   - MED-03 references are keyed by handle.

   So the handle can't be dropped. map.js now says so above `mapCart`. A new case shows that a Shopify handle change leaves `sourceHash` the same but changes the cart version id and the release id, while shoppers see the same offer. **For P4-CUTOVER: compare source hashes, and never expect the rehearsal's version or release ids to match the cutover's.**
6. **`{store_name}` stays "no title of its own" (no token).**
   - A token would need the readers (`resolve.js`, `documents-reader.js`, the home page's `heroWithDefaults`) to fill it. Those files belong to SEAM, LIVEROW and OVL07, and the registry has no fill step. So a token is not simple within the registry; it stays an owner check (below).
   - The cost is recorded in Known limits. It was checked here: `validateDocument` on the migrated default hero gives `REQUIRED` "The title is empty. Fill it in before publishing." That is "incomplete" in draft mode and an error in publish mode.
7. **`scripts/migrate-documents.js`:**
   - **The control plane gets the store's local/hosted check.** `PLATFORM_DB_URL`, or its default `file:platform.db`, must be a local file or on this machine. The check runs before anything is read, for every store, `_default` included. Otherwise the command refuses unless `--hosted --confirm <id>` is given, and the URL is never printed.
   - **When `--hosted` is accepted.** `--hosted` is accepted only when the store's database or the control plane really is hosted.
   - **The dry run lists the routes its data check covered.** The command passes `routesFor(source)`'s routes to `buildReport`. Details then shows "routes given to the data check (N):", grouped by getter with their arguments, and `--json` has `details.routesChecked`. These are only the store's own routes: the base getters, its pages, the pages it serves from code, and its old addresses. They are not the test suite's extra probes.

## Acceptance, with evidence

The mutation runs used a scratch script outside the repository (not committed). Each run changes one line, runs `node scripts/test-migrate-map.js` and restores the file. The "without your change" runs undo this item's own code.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Each of the six surviving MAPPER mutations now fails a test | **DONE** | Mutations (failing case): (a) `if (entityContent && !entities.built)` changed to `if (false)`: (1a). (b) `if (unexpected.length) fixes.push` changed to `if (false)`: (1b). (c) the AGENCY_ACCESS line off: (1c). (d) `design` removed from `sourceHashOf`: (1d). (e) `mapCart` reading only the first offer: (1e). (f) an absent announcement mapped to a default body: (1f). Each run gives exactly 1 failing case, and 59 pass on the branch |
| 2 | Id-stripped hashes and the documentId in the version id are proven independently | **DONE** | Case (2) works the expected values out with node `crypto` and never calls `migratedVersion` for the mapped ids. Mutations: `draftHash` keeping ids fails (2); `publishedHash` keeping ids fails (2); a version id without the documentId fails (2). The id-less live sections fixture is in (2) |
| 3 | An unchecked data check never prints "Nothing."; generated section ids never collide with stored ones | **DONE** | (3) covers NEEDS_FLAG, PENDING_SCHEDULE (in-process and through the command), LIVE_READ_ERROR, migrating and documents, each with the check's own answer and with no check: the section reads exactly `Not checked: fix the things above first.`. A check that ran still says "Nothing." (and the ready snapshot in part 9 is unchanged). Without this item's change (the section's empty text back to `"Nothing."`), (3) fails. (4): the rule unit-tested, then home, page and product page extras on schema 1 and schema 2 rows, with no `SECTION_ID_DUPLICATE`. Without the change (home ids not made unique; page ids not made unique), (4) fails |
| 4 | The migrate command refuses a non-file PLATFORM_DB_URL without --hosted --confirm | **DONE** | Part 8, "P4-FIX1: the command refuses a control plane…": for `mmapcli` and `_default`, `PLATFORM_DB_URL=libsql://mmap-platform.invalid` exits 1 with the refusal and prints nothing on stdout; the URL and the dummy token are not printed; `--confirm` alone is refused too; a `127.0.0.1` address is not refused. Without the change (the check off), the case fails. A second new case shows the routes list below Details, with the JSON count matching the compared and skipped calls (fails with the routes block off) |
| 5 | `pnpm test` passes | **DONE** | 96 of 96 suites passed in 170.4 s. `pnpm build` passes |

## Tests

- `scripts/test-migrate-map.js` (`pnpm test:migrate-map`) has 59 cases, about 11 s.
  - Part 13 is new (10 cases). Part 8 gains 2 cases (the control-plane refusal and the routes list).
  - It uses file databases only: `.test-mmap-*.db`, removed at the end.
  - The tenants added here use their own ids (`mmapent`, `mmapdiff`, `mmapagency`, `mmapbrand`, `mmapcart2`, `mmapann`, `mmaphash`, `mmapnc1` to `mmapnc4`, `mmapids`, `mmapcarth`), so the agency grant can't leak into other cases.
  - The hosted control-plane URL uses a `.invalid` host, so even a broken check could reach nothing. No case passes `--hosted`.
- Mutation runs: 14 mutations, each failing exactly one case. The list is in the table above, plus two for the command: the platform check off, and the routes block off.

## Known limits

- **`{store_name}` (finding 6) is unchanged by design; this packet records its cost:**
  - The migrated default hero has no title of its own, so the new editor shows it as incomplete.
  - The inherited rule only softens the publish check while the hero section is unchanged. The first time the founder edits any hero field (the subtitle, a button), publishing the home page is blocked until they type a title.
  - Once typed, the title no longer follows a store rename.
  - `lib/experiments.js` `unpublishableDrafts` runs a plain publish-mode `validateDocument`. So adopting a hero variant that only sets the subtitle on a migrated half-customized home reports the home page as blocked ("can't be published yet. Fix this in the editor first: … The title is empty …"). The variant is still saved in the draft.
  - A `{store_name}` token needs the readers to fill it (SEAM's, LIVEROW's and OVL07's files), so it is an owner decision (Owner checks).
- **Product-page extras stored with an id show as a data-check difference.** The old `resolvedPdpExtras` returns each extra's stored `id`, and the new reader's answer has none. That makes a false "Not ready", the safe way round, and it was there before this item. Case (4) asserts that ids are the only difference. Moving that rule into the comparison is `check.js` work (OVL07, then CUTOVER).
- **Two stored sections with the same id.** The second one is renamed (`<id>x2`), so a draft can be saved. Ids never reach shoppers except as the `data-sec` attribute, which the MIG-02 comparison strips.
- **Stamped schema-1 home rows.** `upgradeBlock` stamps `sec_l<stored place>` at read, so map.js can't tell a stamped id from a stored one. If a stamped id comes before an equal stored one (`[{}, {id:'sec_l0'}]`), the later, stored one is renamed. Shoppers see no difference either way.
- **Generated ids and the old home page.** A generated id that had to skip a taken one (`sec_l1x2`) no longer equals the id `resolvedHomePage` gives that section today. That id was a duplicate there too; the data check ignores ids.
- **The cart handle.** Rehearsal and cutover ids may differ while their source hashes match (finding 5, recorded for P4-CUTOVER above).
- **The routes list.** It names what the command's data check was given. Entity routes are counted as skipped until P4-OVL07.
- **`--hosted` against a hosted control plane was never exercised.** Builders never pass `--hosted`; the refusal without it is tested.

## Owner checks

- **`{store_name}` binding (finding 6).** Decide whether a migrated half-customized home should keep "no title of its own" (today's words, it follows a rename, and the first hero edit asks the founder to type a title) or get a real store-name token. A token needs a named owner for the readers (`resolve.js` and `documents-reader.js`, plus the home page). Until then, after a real cutover, open the new editor's home page once and check the title note reads sensibly. Then try a subtitle-only hero experiment adopt, and check the "can't be published yet" note is acceptable.
- **A real dry run per store** with a hosted control plane is the owner's step: `pnpm migrate:documents -- --tenant <id> --dry-run --hosted --confirm <id>`, with `PLATFORM_DB_URL` and its token in the environment. Check that the Details "routes given to the data check" list covers the store's pages and old addresses.
- The CI sqld download in `.github/` still needs the owner's approval of its source and checksum (carried over; nothing here changed `.github/`).

## From review

(empty until reviewed)
