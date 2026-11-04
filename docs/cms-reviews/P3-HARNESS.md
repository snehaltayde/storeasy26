# P3-HARNESS: the phase 3 seed and shared drill helpers (PUB-06, PUB-04, AU-04)

Plan: `docs/cms-reviews/P3-PLAN.md` (batch 2, critique B6, "Harness seeds") and `P3-BATCHES.json`. Harness: `docs/cms-reviews/P1-HARNESS.md` (new section "Phase 3 additions"). Branch `cms/p3-harness`, cut from `5bbc819`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test`: 81 of 81 suites passed in 130.8 s (`TEST_PUBLISH_PORTS=4883,4884`, `TEST_PUBLISH_SERVICE_PORTS=4887,4888`). `pnpm build`: passed; its two warnings are the old `next.config.mjs` NFT trace, not from this item (nothing in `app/`, `lib/` or `components/` changed). No `test:*` suite was added or changed (see "Deviations") |
| Browser verified | Yes, on the design harness on this Mac (`DESIGN_PORT=3880`, `DESIGN_SQLD_PORT=4880`, `next dev`), in desktop Chrome 156 (headless, through `playwright-core`). `scripts/drills/p3/smoke.mjs`: 22 passed, 0 failed. `scripts/drills/p2/run.mjs`, every part, against the new seed script: 682 passed, 0 failed, 1 known (unchanged). Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** The harness is a local tool |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No real tenant changed mode. No migration. Nothing in `app/`, `lib/` or `components/` changed |

## What and why

Batches 3 to 5 each ship a browser drill (plan critique B6). Without this item each would build its own store, its own logins and its own helpers. This item gives them:
- one seed with everything those drills need, made through the publish service, so `publish_log`, `document_refs` (0023) and the live addresses are real;
- a second store that has never published (PUB-06);
- a staff login next to the owner's (the "can't publish" paths);
- one helper module for ports, reseeding, sign-in, click counts, screenshots and results.

The P2 drill seed is kept as it was: `seed-design-documents.js` without `--p3` does exactly what it did.

## Design

### `scripts/seed-design-documents.js --p3`

- **Fresh every time.** `--p3` first runs the fresh perf seed itself (`runHarness({ mode: "seed", fixture: "perf" })`, the same call as `node scripts/dev-design.js seed --fixture perf`), then the P2 documents store (`takeOver`, `publishDocumentsFixture`), then the phase 3 parts. Documents are only ever written through `lib/documents` (the write guards in `test-documents` and `test-writers`), so a fresh seed is the only way back to a known state. That is what makes a re-run a reset: the same rows and counts, new ids and new passwords. About 4 seconds.
- **Logins** (`seedP3Logins`). `founder@design.test` (owner) and `staff@design.test` (staff), through `lib/platform/identity.js` (`createUser`, `addMembership`). Each password is `<role>-` plus 18 random hex characters, made fresh by every seed and written only to `.design-data/p3-seed.json` (mode 600; `.design-data/` is gitignored). The summary line names the file, not the passwords.
- **Drill content** (`seedP3Content`). Every publish is `lib/documents/publish.js` `publish()`, as the owner (`{ kind: "merchant", id, role: "owner" }`), so the log rows carry a real actor:
  1. a campaign `p3-spring-edit`, created and never published;
  2. a page `p3-spring-guide`, published, whose draft then gains a banner linking to that campaign (a typed page link with the document id). It stays a draft because P3-CHECKS will refuse that publish with `LINKS_TO_UNPUBLISHED`, which is what a later drill wants to see;
  3. a campaign `p3-weekend-offer`, published on its own (its first publish, so its Undo is "take offline"), then the home page gains a banner `sec_p3camp` linking to it, published. The home page's live version gets a `document_refs` row naming the campaign, which is what the take-offline confirm lists;
  4. the fixture's first live journal post, and the home page's product rail `sec_pfrail1` (collection `top-rated`, 60 products). The seed stops with an error if either is missing;
  5. last, one publish set of three documents: pages `faq` and `size-guide` (first section title "Updated in the spring set") and the announcement. One `set_id`, three `publish_log` rows, for whole-set Undo.
- **The closed store** (`seedClosedStore`). Tenant `design-closed`, name "Closed Demo Co", host `closed.localhost`. Its database gets the tenant schema and every migration, then `takeOverHarnessStore` (documents mode, no live pointer), then two drafts through the write service (a home page whose hero says "Closed draft: not for shoppers yet", and an about page). No release, no publish_log row. No members, so its setup password (`DESIGN_ADMIN_PASSWORD`) signs in to its console.
  - **Its database is the harness's third server** (`DESIGN_SQLD_PORT + 2`, the env default database). The harness runs three servers and `scripts/design-harness.js` is not this item's file. No request otherwise reaches that database: an unresolved host never falls back to the default store (`lib/tenant-request.js`). `withHarnessStore` gained a `databases` option so the seed starts that server too when the harness is stopped.
- **The seed config**, `.design-data/p3-seed.json`: `stores`, `logins`, `documents` (home, liveCampaign, unpublishedCampaign, guide, journalPost: id, type, slug, label, path, `liveUrl` from `lib/documents/paths.js` `liveExitUrl(livePath())`, published version, the `logId` of its seeded publish, and the links between them) and `publishSet` (set id, release, members with `logId`). Drills read ids from here, never by guessing.
- **`check --p3`** prints row counts (documents, versions, publish_log, document_refs, releases, catalog, publish sets), the refs check (each published version's stored `document_refs` rows against `refRows(id, body)`; mismatches and orphan rows listed), the members, the platform counts and the closed store's state. It writes nothing and works with the harness running.

### `scripts/drills/p3/lib.mjs`

Built on `scripts/drill.js` (its `Drill`, `connectHarness`, `launchChrome`), so it uses `playwright-core` and the installed Chrome only. The helper list is in `P1-HARNESS.md`. Points worth checking:
- `p3Ports()` needs both `DESIGN_PORT` and `DESIGN_SQLD_PORT` set and refuses 3017. An unset `DESIGN_PORT` would mean 3017, so it is refused too.
- `runDrill` refuses a harness already running in this checkout (a reseed wipes its data), and stops the harness it started even when the drill throws.
- `login(role)` signs in through the real form, by email, with the seeded password; it reuses cookies per role within one seed, because the sign-in route allows 5 tries a minute.
- `clickCounter(context)` counts trusted `click` events through `exposeBinding` plus an init script, so it counts clicks on every page of the context, across navigations, whichever helper made them.
- `writeResults()` writes `results-<part>.json` in the P2 shape, next to the screenshots in `docs/cms-reviews/drills/<id>/`.

### `scripts/drills/p3/smoke.mjs`

Seeds twice and compares counts, checks refs, the closed store, the logins and the config file's mode, then starts the harness, signs in as owner and staff, opens `/` on both stores and the seeded pages. Results: `docs/cms-reviews/drills/P3-HARNESS/results-smoke.json` and four screenshots.

## Acceptance, with evidence

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | drill (harness): smoke.mjs reseeds, logs in as owner and staff, opens / on the closed tenant and sees 'Opening soon', opens / on the live tenant, and records results | DONE | `results-smoke.json`: 22 passed, 0 failed. Owner: `getDocument doc_home` access `canPublish: true`. Staff: `canPublish: false` with "…You can edit and preview.", and a publish answers 403. `http://closed.localhost:3880/` answers 200 with "Opening soon" and without the draft title (`closed-home-1440.png`). `http://localhost:3880/` answers 200 with the hero, the campaign banner and its link, and 8 product links in the rail (`live-home-1440.png`). The live campaign and the journal post answer 200, the unpublished campaign 404, the guide is live without its draft's banner. The click counter saw exactly the one "Sign in" click | B1 (closed store left in legacy mode), B3 (no staff membership), B5 (home without the campaign link); see "Do the tests bite?" |
| 2 | unit: the seed run twice gives the same row counts; document_refs has rows for every seeded published version; the closed tenant has no release | DONE, as drill checks (no `test:*` suite; see "Deviations") | The smoke's first three checks, from `check --p3` after each of two seeds: identical counts (39 documents, 82 versions, 42 publish_log rows, 69 document_refs rows, 7 releases, 5 publish sets, 1 owner, 1 staff, 2 tenants), a new live release on the second run. Refs: 43 published versions, 25 of them refer to something, 0 mismatched, 0 orphan rows (the other 18 bodies have nothing to refer to, and hold no rows, which is also checked). Closed store: documents mode, live pointer null, 0 releases, 0 published, 0 publish_log rows, 2 drafts. The home page's live version names the live campaign; the last set has three rows matching the config | B4 (no fresh seed: the second run refuses), B1 |
| 3 | drill: scripts/drills/p2/run.mjs still passes (its known checks unchanged) against the new seed | DONE | All ten parts, `DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880`: sections 453, hero-image 32, policy-typo 8, error-chrome 13, edge 25, preview 21, unfinished 8 (+1 known), redirect 115, space 3, legacy 4; 0 failed, exit 0. Every part's known-marked checks have the same labels and markers as the committed results. One known check now passes in `preview` ("after signing out of the console, the same browser no longer sees the draft overlay", finding 1): that is P3-SESSION's logout fix, already merged, not this item. Copies of the results: `docs/cms-reviews/drills/P3-HARNESS/p2-run/`. The committed P2 results and screenshots were restored, because `scripts/drills/p2/` belongs to P3-DRILLS | The P2 seed path is unchanged code; the `space` part also runs this file's CLI from a path with a space |

Also checked by the smoke, for the brief's other lines:
- the seed prints neither password (both runs' output searched for both);
- `.design-data/p3-seed.json` is mode 600.

## Do the tests bite?

Scratch runner `…/scratchpad/p3-b2/P3-HARNESS/mut/run.py`: one break at a time in `seed-design-documents.js`, the smoke drill run, the file restored.

All 5 were caught (the smoke exits 1):

| Break | What failed |
|---|---|
| B1: the closed store is left in legacy mode (no `takeOverHarnessStore`) | "the closed store is in documents mode with no release", "closed store: / shows 'Opening soon'" |
| B2: the summary line prints the staff password | "the seed prints neither password" |
| B3: no staff membership | "the design store has one owner and one staff login"; the staff sign-in stops the drill |
| B4: `--p3` without the fresh perf seed | the second seed refuses ("already holds 39 documents"), so the drill stops: re-running is a reset only because of the fresh seed |
| B5: the home banner links to `/collections`, not the campaign | "the live home page's refs name the live campaign", "the home page links to the live campaign" |

Not broken on purpose: the refs check itself (`mismatched`) was not mutated, because `document_refs` is written by P3-COMMIT's build, not by this seed. Its value is pinned by P3-COMMIT's suites; here it is a cross-check on real seeded data.

## Tests

| What | Result | Time |
|---|---|---|
| `scripts/drills/p3/smoke.mjs` | 22 passed, 0 failed | about 2 minutes (two seeds of about 4 s each, then Next compiling) |
| `scripts/drills/p2/run.mjs` (all parts) | 682 passed, 0 failed, 1 known | about 11 minutes |
| `pnpm test` | 81 of 81 suites passed in 130.8 s (`TEST_PUBLISH_PORTS=4883,4884`, `TEST_PUBLISH_SERVICE_PORTS=4887,4888`) | |
| `pnpm build` | passed; its two warnings are the old `next.config.mjs` NFT trace, not from this item (nothing in `app/`, `lib/` or `components/` changed) | |

## Deviations

- **The "unit" acceptance item is proved by drill checks, not a `test:*` suite.** A new `scripts/test-*.js` needs a matching `package.json` script (`run-tests.js` fails otherwise), and `package.json` is not this item's file in batch 2. The checks need sqld and the real seed anyway. They run in `smoke.mjs` from `check --p3`'s output.
- **`seed-design-preview.js` is unchanged.** Everything new is behind `--p3` in `seed-design-documents.js`, so the legacy seed, `drill:smoke`, `drill:edge` and the P2 seed are untouched.
- **The phase 3 content is behind `--p3`, not in the default seed.** Members on the design store turn its setup-password sign-in off, and `drill.js` `signIn` (used by `drill:smoke`, `drill:edge` and the P2 drills) signs in with that password. Adding the logins to the default seed would break all three.
- **`liveUrl` comes from the seed, not from the publish answer.** `publish()` does not return a `liveUrl` yet (P3-CHECKS adds it to the API answer in this batch). The seed records `liveExitUrl(livePath(type, meta))` from `lib/documents/paths.js`, the same function.

## Known limits

- **The closed store shares the env default database server.** A request outside any store (none on the harness) would read the closed store's tables. If a later item adds a fourth server to `scripts/design-harness.js`, move the closed store there.
- **Only the design store is re-pointed when the harness starts** (`pointTenantAtThisRun`). After changing `DESIGN_SQLD_PORT`, reseed with `--p3` before using the closed store, or it points at the old port.
- **`closed.localhost`** resolves to this machine in Chrome. Node `fetch`, curl and other tools may not resolve it; use `--resolve` or a `Host` header. Next's dev server answered it with no `allowedDevOrigins` change (that file is P3-RTE's).
- **A `--p3` store refuses the setup password** on the design store (it has members). `drill.signIn` doesn't work there; use `login()`.
- **Passwords are in a plain JSON file** under `.design-data/` (mode 600, gitignored). They are local test values, new on every seed.
- **Whole-set Undo, take offline and the `LINKS_TO_UNPUBLISHED` offer were not run**: their code (P3-UNDO, P3-CHECKS) is being built in this batch. The seed only sets up the data they need; the later drills prove the flows.
- **The hero runs a seeded experiment**, so the smoke accepts either hero title.
- **Next dev only**, Chrome only, headless, macOS.
- **`check --p3` compares refs with `refRows` of the stored body.** It proves the build wrote what `refs.js` says, not that `refs.js` is right (that is P3-COMMIT's suite).

## Owner checks

- None new for the harness itself: it is local and drills are agent-run.
- **CI `sqld` download:** not touched (no `.github/` change). Its source and checksum still need the owner's approval.
- Optional: run `DESIGN_PORT=<port> DESIGN_SQLD_PORT=<port> node scripts/drills/p3/smoke.mjs` once on your Mac, and open `http://closed.localhost:<port>/` in your own Chrome.

## Files

- `scripts/seed-design-documents.js`: `--p3`, `check --p3`, `withHarnessStore({ databases })`, the P3-HARNESS section
- `scripts/drills/p3/lib.mjs` (new), `scripts/drills/p3/smoke.mjs` (new)
- `docs/cms-reviews/P1-HARNESS.md`: "Phase 3 additions"
- `docs/cms-reviews/P3-HARNESS.md`, `docs/cms-reviews/drills/P3-HARNESS/` (smoke results, screenshots, `p2-run/` copies)

## Commands

```
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/seed-design-documents.js --p3
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/seed-design-documents.js check --p3
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/drills/p3/smoke.mjs
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 DRILL_HTTPS_PORT=4886 DRILL_TMP=<scratch> DRILL_SCRATCH=<scratch> node scripts/drills/p2/run.mjs
pnpm test
pnpm build
```
