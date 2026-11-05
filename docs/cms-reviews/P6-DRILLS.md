# P6 · DRILLS · Phase 6 in desktop Chrome on the design harness (GEN-01, GEN-04, PUB-12; US-01, US-04, US-41)

Branch `cms/p6-drills`, cut from `60a37b8` (`cms/phase-1` with phase 6 batches 0 to 3 merged). Both base merges are in its history: P5-FIX2 (`441b44d`) and P5-DRILLS (`211c982`). Plan: `docs/cms-reviews/P6-PLAN.md` revision 4 and `P6-BATCHES.json` (item P6-DRILLS, batch 4). Harness: `docs/cms-reviews/P1-HARNESS.md`.

**What was drilled:** the tree at `60a37b8`. P6-FIX3 ran beside this item and had not merged (its branch head was `2cef24d`), so its three fixes (the half-finished first-run words, the failed policy-read words, `closedSource(null)`) are not in what was drilled.

This is the author's own report. Reviewers should re-read the code.

## Files

All in the plan's list:
- `scripts/drills/p6/run.mjs` (the P6-FIXTURE placeholder, now the runner of `pnpm drill:p6`)
- `scripts/drills/p6/lib.mjs`, `seed-p6.mjs`, and one module per stage: `generate.mjs` (baseline and A), `brand.mjs` (B), `open.mjs` (C and D), `empty.mjs` (E), `legacy.mjs` (F), `setup.mjs` (G)
- `scripts/seed-design-documents.js`: the new `--p6 --stage <a..g> [--variant …]` flag and `check --p6`
- `docs/cms-reviews/drills/P6-DRILLS/`: `results.json`, `results-<stage>.json`, 46 screenshots, the three RSC probe reports and the stage F captures (`legacy-f/`)
- `docs/cms-reviews/drills/P5-DRILLS/`: the phase 5 re-run (pick, create, console)
- `docs/cms-reviews/MANUAL-CHECKS.md`: "Phase 6, batch 4"
- This packet

No product code, no `package.json`, nothing in `scripts/drills/p3/` or `p4/`, nothing under `.github/`, no migration, no new dependency.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes: `pnpm test` 102 of 102 suites (197.8 s, CHECKOUT_MODE unset, ports 6100 and 7100 to 7109) and `pnpm build` (exit 0) |
| Browser verified | **Yes**, desktop Chrome 156 (headless) on the design harness, ports 6100 and 7100 to 7102: `pnpm drill:p6`, 160 checks passed, 0 failed, every stage passing ([results.json](drills/P6-DRILLS/results.json)). Not Safari, not a phone |
| Staging verified | **NOT DONE.** Nothing ran on hosting |
| Production enabled | **NOT DONE.** Nothing pushed or merged |

## What and why

Phase 6's items were each proved by unit and rendered tests. None had been driven end to end in a browser by a founder: sign in, open "Start your store", choose colours and a logo, read the "Before you open your store" panel, start the policy pages, place a test order and open the store. This item does that, on a fresh documents store per stage, and checks that legacy stores and the P3 closed store are untouched.

## Design

### Seeding (`--p6 --stage`)

`withHarnessStore` refuses to write while the harness runs, so every stage stops the harness, seeds, starts it again and drives Chrome. A stage seed (`seed-p6.mjs`), with the harness's three local `sqld`:
1. refuses when the shell names a Shopify store or a payment secret;
2. parks the P3 closed store (its domain row is emptied), because its database is the harness's third server;
3. wipes that third server (every table, view and trigger dropped), so `DOCUMENTS_FOR_FRESH_STORE_SQL` sees empty content tables;
4. provisions tenant `p6` there the way `lib/platform/provision.js` does: `applyTenantSchema`, `applyContentMode` (documents; legacy for stage F), the tenant row with a domain row for `p6.localhost` and `config.onboarding` as `record_onboarding` writes it, and no Shopify fields;
5. makes the founder's owner login (a fresh password each seed, only in `.design-data/p6-seed.json`, mode 600, never printed);
6. copies the perf fixture's library photos from the design store, then syncs 24 perf products in 6 collections through `runCatalogSync` with injected fetchers and a no-op indexer. That writes a real, complete `sync_runs` row with no network.

Per stage on top of that:
- **C:** `returns_window_days` 10, no support email, a PNG logo in the library.
- **D:** checkout off, a support email, and a privacy page and a terms page the founder saved (`startPolicyPage`, then `markPolicyRead` as the founder).
- **E:** `--variant empty | refill | no-collections`. Refill keeps the store and runs a second complete sync with products.
- **F:** a legacy store.

`check --p6` reads the store back against `P6_SEED_LIST`. The design store keeps whatever the last `--p3` seed left.

The runner blanks every Shopify, Razorpay and AI key for the seed and the harness (`stageEnv`, `blankKeysHere`). The harness itself passes `ANTHROPIC_API_KEY` through, so the drill blanks it.

### Order

The order is: baseline, A, B, C, D, E, F, G, final. Stage A ends with the RSC probe on the generated, unpublished store. "final" re-seeds `--p3` and runs `check --p3`.

### The RSC probe

`docs/cms-reviews/drills/P3-CLOSED/rsc-probe.mjs` has fixed ports and closes the store it probes. It is not this item's file, so `lib.mjs` `rscProbe` is the same probe made reusable and read-only:
- the same 8 routes × 4 cookie sets × (HTML, and `RSC: 1` with the router-state header): 64 requests;
- strings of 10 or more characters from every document draft and version, the legacy blocks and pages, and the releases;
- catalog titles left out (the P3-CLOSED owner interpretation), and the store name left out (the closed page shows it on purpose).

Deviation: only strings with a space count. A first run flagged `collections` and `product_rail`, which are registry words that every page ships, not content. The baseline runs on the P3 closed store (`closed.localhost`), with a control run on the open design store.

## Acceptance

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm drill:p6` runs stages A to G in order on the harness and writes results.json plus screenshots to `drills/P6-DRILLS/`, every stage passing | **DONE** (browser) | [results.json](drills/P6-DRILLS/results.json): baseline 5, A 17, B 28, C 42, D 10, E 20, F 13, G 15, final 10 passed; 0 failed. Run with `P6_DRILL_SCRATCH=… DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 pnpm drill:p6`, exit 0 |
| 2 | Stage A: 0 requests to api.anthropic.com and the closed storefront; the P3-CLOSED rsc-probe passes on the generated, unpublished store and at the baseline | **DONE** (browser) | [results-a.json](drills/P6-DRILLS/results-a.json): the harness env has ANTHROPIC_API_KEY blank. /admin/start made the store in 2 s ("…the Slate colours. Nothing is public yet."). doc_home and doc_design are `system:first-run` drafts, with no header or footer document and no release. The preview shows the hero, both rows, a header menu that is exactly the 6 catalog collections, a footer, and `--accent-500` #334155. The browser's network log for the whole stage: 181 requests, all to p6.localhost, 0 to api.anthropic.com. p6.localhost is "Opening soon" with none of the draft's words (Chrome and raw HTML). Probe: 64 requests, 0 leaks ([rsc-probe-p6-generated.json](drills/P6-DRILLS/rsc-probe-p6-generated.json)). Baseline: 64 requests, 0 leaks on the P3 closed store ([rsc-probe-baseline.json](drills/P6-DRILLS/rsc-probe-baseline.json)); the control on the open store finds content in 44 of 64. Limit: the network log is the browser's; the server's own outgoing requests are not logged (see Known limits) |
| 3 | Stage B: Forest save shows in the preview; 'Go back to your starting colours' restores Forest (Slate on the Skip re-seed), never lime | **DONE** (browser) | [results-b.json](drills/P6-DRILLS/results-b.json): Slate preselected. Forest, a PNG uploaded through the MediaPicker with the alt cleared, and a description, then Save: the design draft is Forest with `logo { media }` and no alt; `brand_step.paletteId` is forest; the tagline is saved. The preview's header and footer logo has alt "Fernway Goods" and loaded; the accent is #166534. In the editor's design settings, accent #7c3aed is saved, then 'Go back to your starting colours (Forest)': the draft brand equals Forest key for key, the colour inputs and placeholders hold no lime, the stored draft holds no 84cc16, and the preview's `--accent-500` is #166534. Skip re-seed: the text wordmark, Slate, and Reset says "(Slate)" and restores Slate. Screenshots `b-*` |
| 4 | Stage C: Open disabled with no policy page, with only the returns starter, with it untouched after Check again, and with returns read but privacy missing; enabled only once both are read or saved; 'within 10 days of your order', never 7 or 14; the COD test order (snehal@mediastic.in) cancelled in the stage and the Shopify push failed harmlessly; opened store not lime, logo in header and footer, both policy pages live | **DONE** (browser) | [results-c.json](drills/P6-DRILLS/results-c.json), 42 checks, in this order. "Before you open your store" comes first, with doc_design ("Brand") in the set and nothing live. Privacy and returns are Must fix, with their Start buttons; Open is disabled; test order and contact are 'Check'. 'Start a returns page' makes a "Terms of service" draft at slug `terms`, `updated_by system:policy-starter`, and nothing goes live; Open is disabled. 'Read it' shows "within 10 days of your order", with no 7 or 14 anywhere in the text or the stored draft. Check again: still Must fix, not in the set, Open disabled. "I've read it": returns says "goes live too" and is in the set; Open is disabled (privacy missing). 'Start a privacy page', then one sentence changed and saved in the editor; Check again: privacy says "goes live too", the set is 4 documents, and only now is 'Open my store anyway' enabled. A COD order in the founder's preview, to snehal@mediastic.in: its Shopify push ran once and failed before any request ("No SHOPIFY_ADMIN_TOKEN, and SHOPIFY_CLIENT_ID/SECRET not set either", no Shopify order id), and it was cancelled at once (status cancelled). Check again: the test order is done. Open: a release; home, design, privacy and terms are live. A shopper sees `--accent-500` #334155 and the logo in the header and footer (alt the store name, loaded). /policies/privacy-policy and /policies/terms answer 200 with the founder's text, and checkout links both. No card details were entered; the radio was cash on delivery |
| 5 | Stage D refuses to open with checkout off; E shows the empty-catalog copy, the later refill and the no-collections copy; F shows legacy unchanged; G: the checklist's starters make review drafts that don't tick the step until saved or marked read, and a second start is refused | **DONE** (browser), with three findings below | **D** ([results-d.json](drills/P6-DRILLS/results-d.json)): payment is the only block: "Checkout is turned off…" with 'Open Settings' → /admin/settings#commerce. Open is disabled. A direct open with checkOpening and confirmOpen gets 409 STORE_CANNOT_TAKE_PAYMENT, and nothing goes live. Settings > Commerce set to direct and saved; Check again: "Cash on delivery only", Open enabled; opened. The panel shows a disabled Open button, not none (finding P6D-3). **E** ([results-e.json](drills/P6-DRILLS/results-e.json)): "Your Shopify store has no products yet. Add products in Shopify, then sync again." and a hero-only home. After the second seeded sync, /admin/start and the editor leave the hero-only home as it is (finding P6D-2). The worker's own post-sync step (`workerFirstRun.generate({ trigger: 'sync' })`, run in process because the harness has no Shopify for the queued slice) refills it: rows added, revision up, still the generator's draft, and the preview and /admin/start show the rows. No collections: "Your products have no collections in Shopify yet…", a hero and the newest products, 8 product links in the preview. **F** ([results-f.json](drills/P6-DRILLS/results-f.json), `legacy-f/`): the same legacy store, served by a throwaway worktree at b063753 (phase 6's base; checked that it holds no phase 6 merge) and by this tree. The checklist from GET /api/admin/setup, the page text and buttons, and the header and footer words, links and masked HTML are identical. /admin/start redirects to /admin/setup (404 at b063753). **G** ([results-g.json](drills/P6-DRILLS/results-g.json)): 'Add your legal pages' with both Start buttons. Start privacy: a starter draft; the step stays not done; "Read your privacy page" shows. The replayed POST gets 409 POLICY_PAGE_EXISTS "You already have a privacy page…". The privacy page saved in the editor; still not done. Start returns, then the checklist's "I've read it" with no edit: done. Nothing published; the closed page throughout |
| 6 | After the run `check --p3` passes; pnpm test still passes (102 suites); MANUAL-CHECKS.md holds every phase 6 owner check | **DONE** | [results-final.json](drills/P6-DRILLS/results-final.json): re-seed --p3; check --p3 shows the design store live and the closed store back on closed.localhost with no release; every published version's refs match. Its orphanRefs (22, checkpoint versions' refs) is the known P4-MEDIA owner check, recorded, not judged. `pnpm test`: 102 of 102 suites. MANUAL-CHECKS.md "Phase 6, batch 4" lists every carried check named in the brief plus the five new findings |

No acceptance item rests on a unit test. This item adds drills, not product code, so "a test that fails without the change" does not apply. Every item is proved by the desktop Chrome drill.

## Findings (for the owner)

- **P6D-1, words a shopper sees:** the generated hero subtitle reads **"Shop Shop all and Creatine."** when the store has a Shopify collection called "Shop all". `lib/first-run/plan.js` `subtitleFor` fills "Shop {a} and {b}." with the top collections' titles. It went live in stage C ([c-live-home-1440.png](drills/P6-DRILLS/c-live-home-1440.png)). Catch-all collections like "Shop all" or "All products" are common. Not fixed here (product code). The plan's rule is "wrong text a shopper sees", so it belongs to the next fix item.
- **P6D-2:** the empty-catalog note "product rows appear after your next sync" holds only when the queued worker runs the sync, because it calls the generator after a completed sync. After an inline, CLI or connect-callback sync, or when the worker defers (less than 5 s left), /admin/start shows "ready" without posting, and the editor generates only when there is no home. So the hero-only home is never refilled.
- **P6D-3:** with checkout off, the proactive panel shows a disabled Open button rather than none. The "no Open button" view (`cannotOpen`) appears only after a 409 that the disabled button can't trigger. The server does refuse.
- **P6D-4:** the brand step accepts any `/api/media/<id>` as the logo, but the media route serves only `med_` plus 18 hex digits. Uploads always give a valid id; the drill's first seeded logo did not, and showed as a broken image.
- **P6D-5:** the closed page computes the platform's lime as `--accent-500`. Nothing on it draws in that colour today.
- Observed, not judged: the generated hero carries a "24 products · 6 collections" pill.

## Carried from phase 5: the P5 re-run

On the integrated tree (P5-FIX2 merged after the P5 drill run), `node scripts/drills/p5/run.mjs pick,create,console` passed: pick 8, create 11, console 5, 0 failed ([results-run-pick-create-console.json](drills/P5-DRILLS/results-run-pick-create-console.json); the three results files and their screenshots were rewritten). P5D-1 (no phone-width preview switch in the editor) is listed as an owner check.

## Tests

- `node scripts/drills/p6/lib.mjs --check`: 8 of 8. It covers `assertLocal`, the 3017 refusal, `stageEnv` blanking every key, a Shopify token being noticed, and the stage plans.
- `pnpm drill:p6`: 160 passed, 0 failed (above). An earlier full run had one stage (D) fail to start: `next dev` took over the 3 minutes `connectHarness` waits. `reseedP6` now tries once more and notes it. The rerun passed every stage with no retry needed.
- `pnpm test`: 102 of 102 suites passed in 197.8 s, exit 0.
- `pnpm build`: exit 0.

## Known limits

- **Server-side AI requests are not logged.** The "0 requests to api.anthropic.com" is the browser's network log. The server side rests on the key being blank in the harness env (checked) and on P6-GEN's unit test that the generator never imports lib/ai.
- **The refill in stage E runs the worker's post-sync step in process**, after a seeded sync. The queued slice itself needs Shopify, which the harness doesn't have.
- **The RSC probe on the generated store had 2 strings to look for.** The generated drafts are mostly catalog titles and the store name, which the probe leaves out. Stage A also checks the draft's hero subtitle, button and row titles against the closed page's text and raw HTML.
- **next dev only**, headless desktop Chrome on macOS, 1440 wide. No production build, no Safari, no phone.
- **Stage F compares one freshly provisioned legacy store**, not the P4 legacy store with releases.
- **The probe's baseline is the P3 closed store** (`closed.localhost`), not the P3-CLOSED script's own way of closing the design store.

From review:

- Reproduced at 67d58ac in a detached worktree on ports 6300 and 7300-7302. `pnpm drill:p6` passed every stage with exit 0, 160 checks in all: baseline 5, A 17, B 28, C 42, D 10, E 20, F 13, G 15, final 10. Afterwards `check --p3` passed. `pnpm test` passed 102 of 102 suites in 202.4 s, with CHECKOUT_MODE and ANTHROPIC_API_KEY unset and review ports 7300-7309 and 6300. The P5 re-run of pick, create and console passed with 8, 11 and 5 checks. The branch touches only the files P6-BATCHES gives it: no product code, no package.json, nothing in p3 or p4, nothing under .github. The worktree is removed, the drill's own b063753 worktree is gone, and nothing is left listening.
- Mutation testing shows the drill catches real faults. (M1) policy-start.js was changed to write a fixed 14-day window instead of returnsWindowDays(). Stage C failed on 'within 10 days' (it saw 14, 14), on the stored draft check and on the live /policies/terms text. (M2) An untouched starter was made to count in COUNTING_STATES (lib/documents/policy-pages.js). Stage G failed: the step showed done after an unread returns starter. (M3) A starter was set to 'info' in lib/documents/opening.js policyItem. Stage C failed: returns was no longer 'Must fix', and Check again no longer blocked the untouched starter. All mutations were reverted.
- Owner should know (product code, outside this branch, the drill found and reported it as P6D-1): the generated hero subtitle reads 'Shop Shop all and Creatine.' when a collection is called 'Shop all'. The cause is lib/first-run/plan.js subtitleFor filling 'Shop {a} and {b}.' with raw collection titles. Shoppers see it when the store opens. Not a defect of this drills item, but the next fix item must take it.
- Stage A's '0 requests to api.anthropic.com' is only the browser's network log. The generator runs on the server, so the browser could never call Anthropic anyway. The real proof is ANTHROPIC_API_KEY being blank in the harness env, which the drill does check. The limit is disclosed, but the evidence is weaker than the acceptance wording suggests.
- The RSC probe on the generated store had only 2 strings to look for: 'Shop by collection' and 'New arrivals'. The hero subtitle is dropped because it contains a catalog title. The draft words are checked directly against the closed page's text and raw HTML, so the closed-store claim still holds, but the probe on that store proves little by itself (disclosed).
- Stage E's refill is not driven by the sync. The drill calls workerFirstRun.generate({trigger:'sync'}) itself, in its own process. It proves that the refill step works, not that a sync starts it. P6D-2 (inline, CLI and connect-callback syncs never refill) is real and listed for the owner.
- Stage D's 'founder-saved' policy pages are seeded with markPolicyRead ('I've read it'), not by an edit and save. That is enough to make payment the only block, but the wording overstates it. P6D-3 (a disabled Open button rather than no button) is a deviation from the brief, and it is listed for the owner. The server refuses a direct open with 409.
- Small doc and code mismatches: (1) The packet says the header menu is 'exactly the 6 collections', but the check only asserts that every collection is linked; the header also has a 'Shop all' link to /collections. (2) The header comment in empty.mjs still says the refill happens 'when the founder opens the editor', which contradicts P6D-2 and the code. (3) P6-FIX3 was not merged, so its fixes were not drilled (disclosed).

## Owner checks

See MANUAL-CHECKS.md "Phase 6, batch 4": staging end to end (OQ-4); a phone logo upload (PNG, JPEG, SVG, HEIC refused); the RSC probe on a production build; a real Razorpay-key tenant; the P4-PROVISION Setup check; the CI sqld download approval; legal review of the starters; the founder words on a phone; the CLAIMS lexicon; lime `--sf-success*`; a deleted logo's wording; `.test-pe-*.db` leftovers; un-hooked syncs; 'already open' words; 'Review and open your store'; the dashboard nudge deviation; the schema-compat flake; open stores and unread starters; the '#1' rule; P5D-1; and P6D-1 to P6D-5.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p5/run.mjs pick,create,console
P6_DRILL_SCRATCH=<scratch>/tmp DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 pnpm drill:p6
DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p6/lib.mjs --check
TEST_PUBLISH_PORTS=7100,7101 TEST_PUBLISH_SERVICE_PORTS=7102,7103 TEST_PUBLISH_UNDO_PORTS=7104 \
  TEST_PRODUCT_CONTENT_PORTS=7105,7106 TEST_MIGRATE_MAP_SQLD_PORT=7107 MIGRATE_DOCUMENTS_TEST_PORTS=7108,7109 \
  MIGRATE_DOCUMENTS_TEST_WEB_PORT=6100 DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 env -u CHECKOUT_MODE pnpm test
env -u CHECKOUT_MODE pnpm build
```
