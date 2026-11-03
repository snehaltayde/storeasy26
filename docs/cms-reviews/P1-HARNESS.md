# P1-HARNESS: the design harness on the edge runtime, and a browser runner

Spec: `docs/CMS_FULL_BUILD_SPEC.md` section 8.15 ("Runners", "Browser drills", "Harness fix"). Branch `cms/p1-harness`, cut from `bdbe1a7`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:design-harness` 35 passed, 0 failed (and 8 of 8 repeat runs green). `pnpm test`: 45 of 45 suites passed. 29 deliberate breaks of the fix, each caught. See "Test results" and "Do the tests bite?" |
| Browser verified | Yes, on the design harness on this Mac, in desktop Chrome 156 (headless) through the new runner: `pnpm drill:edge` 67 passed, 0 failed; `pnpm drill:smoke` 27 passed, 0 failed. Screenshots and `results.json` are committed under `docs/cms-reviews/drills/`. Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** The harness is a local tool and nothing here ran on hosting |
| Production enabled | **NOT DONE. Production is unverified.** Nothing pushed, merged or deployed. Nothing in `app/`, `lib/` or `components/` changed (`git diff bdbe1a7 --stat -- app lib components` prints nothing) |

## The bug, reproduced first

Before any change, the base harness (`bdbe1a7`) was run with its exact environment, only moved from port 3017 to 3027: `node scripts/dev-design.js seed`, then `next dev -p 3027` with the env from the base `scripts/dev-design.js` (file databases). `.design-*.db` were seeded normally.

| Request | Result on the base harness |
|---|---|
| `GET /` | 500, `x-edge-runtime: 1`, "Something went wrong", seeded product names found: 0 |
| `GET /products/glow-serum` | 200 status, but the page is the error page ("Something went wrong"), product name found: 0 |
| `GET /collections` | 200 status, error page, collection names found: 0 |
| `GET /admin/login` | 200 (the console runs on nodejs, so it worked) |

Server log, every storefront page:

```
⨯ Error: control plane unavailable
    at tfetch (lib/tenant-request.js:44:42)
[errors] capture failed: URL_SCHEME_NOT_SUPPORTED: The client that uses Web standard APIs supports only "libsql:", "wss:", "ws:", "https:" and "http:" URLs, got "file:".
```

Screenshots: [before-home.png](drills/P1-HARNESS/before-home.png), [before-product.png](drills/P1-HARNESS/before-product.png). These two were taken once with a one-off script before the runner existed; the drill never rewrites them.

So the edge runtime's libSQL client refused the `file:` URL for the control plane, the host could not be resolved, and every storefront page failed. A 200 status alone would have hidden this: the product and collection pages answered 200 with an error page, which is why the drill checks content, not status.

The unit test for it ("THE BUG: Next is never handed a file: database URL") was written with the fix, not before it. Proof that it catches the bug is the mutation run below (break M1), and the browser drill against a harness put back to `file:` URLs (25 failures, see "Do the tests bite?").

## What was built

- `scripts/design-harness.js` (new): the harness plumbing. Finds `sqld` (`SQLD_BIN`, then `PATH`, then `~/.turso/sqld`), reads ports, starts one `sqld` per database in `.design-data/`, waits for each `/health`, writes a pid file, hands Next and the seed `http://127.0.0.1` URLs, blanks hosted service keys, stops everything on Ctrl-C, SIGTERM or SIGHUP and when Next exits, refuses a second harness, stops `sqld` left behind by a harness that was killed outright (by recorded PID, only if its command line names this data folder), and notes new migrations since the last seed.
- `scripts/dev-design.js`: now a thin CLI over `runHarness`. Same commands: `pnpm dev:design`, `pnpm seed:design`. Plain one-line errors, no stack.
- `scripts/seed-design-preview.js`: writes over http to the URLs the harness passes, and refuses any URL that isn't a local harness server before any database module loads. Seeds `collection_products` (3 collections now hold 2 to 4 products each). Prints the real port.
- `scripts/drill.js` (new): the browser runner's helpers and CLI (see "How to run a drill").
- `scripts/drills/smoke.js` (new, `pnpm drill:smoke`) and `scripts/drills/harness-edge.js` (new, `pnpm drill:edge`).
- `scripts/test-design-harness.js` (new, `test:design-harness`): 35 tests, no `sqld`, Chrome or network needed.
- `package.json`: `playwright-core` 1.64.1 (exact) as a devDependency, the one new dependency; scripts `drill:smoke`, `drill:edge`, `test:design-harness`. `pnpm-lock.yaml` adds only `playwright-core` (no dependencies of its own, no install script, no browser download).
- `.gitignore`: `/.design-data/`.
- Docs: `docs/MANUAL_TESTING_GUIDE.md` (new "How the design harness runs" section, and every "the harness storefront 500s" line replaced), `docs/platform-guide.md` (harness entry).

### How the harness runs now

```
pnpm dev:design
  └ node scripts/dev-design.js
      ├ sqld :DESIGN_SQLD_PORT     .design-data/platform.sqld   control plane (tenants, users, sessions)
      ├ sqld :DESIGN_SQLD_PORT+1   .design-data/tenant.sqld     the "design" store
      ├ sqld :DESIGN_SQLD_PORT+2   .design-data/default.sqld    env default (DATABASE_URL)
      └ next dev -p DESIGN_PORT    PLATFORM_DB_URL / DATABASE_URL = http://127.0.0.1:<port>
```

- Defaults: `DESIGN_PORT` 3017 (as before), `DESIGN_SQLD_PORT` 18017 (so 18017 to 18019).
- First `pnpm dev:design` with no data seeds first. `pnpm seed:design` empties `.design-data/` and seeds again, then stops the servers.
- The tenant row stores its database URL at seed time. Each start points it at this run's tenant server, so changing `DESIGN_SQLD_PORT` later works without a re-seed.
- Next is started as `node node_modules/next/dist/bin/next dev`, not through `pnpm exec`, so the harness's SIGTERM reaches it.
- `runtime = "edge"` in `app/(storefront)/layout.js` is untouched.

### How to run a drill

```
pnpm dev:design                       # terminal 1, wait for "Ready"
pnpm drill:smoke                      # terminal 2
pnpm drill:edge
node scripts/drill.js smoke --start   # or: start and stop the harness for this run
node scripts/drill.js smoke --headed  # watch it
DESIGN_PORT=3027 pnpm drill:smoke     # a harness on another port
```

Helpers in `scripts/drill.js`, for new journeys in `scripts/drills/<name>.js`:

| Helper | Does |
|---|---|
| `connectHarness({ start })` | Attaches to the harness on `DESIGN_PORT`, reads `.design-env`. With `start`, starts one and stops it afterwards. Not running and no `start`: a plain message saying how to start it |
| `launchChrome()` / `chromePath()` | The installed Chrome through `playwright-core`, `executablePath` only: `CHROME_BIN`, then the usual macOS and Linux paths. Never a download |
| `drill.context({ width })` | A fresh browser context (own cookies, nobody signed in) |
| `drill.signIn(context)` | The merchant console through the real form: empty email, `DESIGN_ADMIN_PASSWORD` |
| `drill.signInOperator(context)` | The operator console through its real form: `PLATFORM_ADMIN_PASSWORD` |
| `drill.open(page, path, { width })` | Sets the width (375, 768, 1440 or any), loads, waits for network quiet, fonts and images. Returns status and headers |
| `drill.atWidths(page, path, name)` | `open` + `facts` + `shoot` at 375, 768 and 1440 |
| `drill.facts(page)` | DOM facts: path, title, `h1`s, viewport and scroll width, sideways overflow, image count, broken images, error page, page text |
| `drill.shoot(page, name)` | PNG into `docs/cms-reviews/drills/<id>/<name>.png`, scaled to at most 720 wide and squeezed until it is at most 300KB |
| `drill.check(ok, label, detail)` / `drill.note(text)` | Records a pass or fail, or a finding that isn't pass or fail |
| `finish()` | Writes `results.json` (checks, notes, screenshots, Chrome version). A screenshot an earlier run of the same drill made and this run didn't is removed; other files are left alone |

The drill exits 1 if any check fails. Drills are not `test:*` suites: they need a running harness and Chrome, so `pnpm test` and CI never run them.

## Acceptance

Tags: unit = plain node (`test:design-harness`), browser = the new runner on the design harness in desktop Chrome, manual = run by me by hand on this Mac, recorded here. Nothing is tagged rendered: there is still no JSX-capable runner (see "Deviations").

### Harness fix

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| 1 | No runtime edit: `git diff` shows none | unit + browser + manual | Pass | `git diff bdbe1a7 --stat -- app lib components` prints nothing. Unit "no code edit: the storefront still declares the edge runtime, and the harness never touches app/". Drill checks `app/(storefront)/layout.js still says export const runtime = "edge"` and `git diff HEAD -- app is empty`. Break M21 (`runtime = "nodejs"`) turns the unit test red |
| 2 | Home renders with real content on the edge runtime | browser | Pass | `drill:edge` "home": 200, `x-edge-runtime: 1`, not an error page, shows "Festive sale" and the hero (one of the two experiment titles). [home-1440](drills/P1-HARNESS/home-1440.png), [home-375](drills/P1-HARNESS/home-375.png) |
| 3 | A product page | browser | Pass | "product": `/products/glow-serum`, 200, edge, "Radiance Glow Serum 30ml", "1,299". [product-1440](drills/P1-HARNESS/product-1440.png), [product-375](drills/P1-HARNESS/product-375.png). `drill:smoke` repeats it at 375, 768 and 1440 with no sideways scroll |
| 4 | A collection | browser | Pass | "collection": `/collections/serums`, 200, edge, "Serums" with its two products. [collection-1440](drills/P1-HARNESS/collection-1440.png) |
| 5 | `/collections` | browser | Pass | 200, edge, all three collections. [collections-1440](drills/P1-HARNESS/collections-1440.png) |
| 6 | Search | browser | Pass | `/search?q=serum`, 200, edge, finds the product (SQL search; Typesense is blanked). [search-1440](drills/P1-HARNESS/search-1440.png) |
| 7 | Cart | browser | Pass | Add to cart: `POST /api/cart` 200, the drawer opens with the item; `GET /api/cart` 200 holds it. `/api/cart` is a route handler, which doesn't send `x-edge-runtime`; the drill reads Next's own dev manifest (`.next/dev/server/app/api/cart/route/middleware-manifest.json`) and checks it lists `/api/cart/route` as an edge function built from `server/edge/` chunks. [cart-drawer-1440](drills/P1-HARNESS/cart-drawer-1440.png) |
| 8 | Checkout's first step | browser | Pass | `/checkout` with that cart: 200, edge, "Contact & shipping address", the product in the summary. [checkout-1440](drills/P1-HARNESS/checkout-1440.png) |
| 9 | Account sign-in | browser | Pass | `/account`: 200, edge, "Sign in", "Email". [account-sign-in-1440](drills/P1-HARNESS/account-sign-in-1440.png) |
| 10 | A CMS page | browser | Pass | `/policies/shipping`: 200, edge, "Shipping policy", "Orders dispatch within 24 hours". [cms-page-1440](drills/P1-HARNESS/cms-page-1440.png) |
| 11 | The maintenance page when the store is closed | browser | Pass | The drill signs in to the operator console through its form and switches maintenance on (`PATCH /api/platform/tenants/design` 200). A signed-out visitor then gets the maintenance page with the founder's message, on the edge runtime, with no announcement bar behind it; a product page shows the maintenance page and not the product. Maintenance is switched off in a `finally`, and the drill waits until the store shows real content again. [maintenance-1440](drills/P1-HARNESS/maintenance-1440.png) |
| 12 | The console's Designer and its storefront preview work | browser | Pass | Signed in through the real form, landed on the dashboard. Home Designer: "Preview shows your last save", the preview is the saved draft (button "Shop night routine", not the live "Shop bestsellers"), marked "Draft preview", its page came from the edge runtime (200, `x-edge-runtime: 1`). Product and collection Designers: a product and a collection picked through the real picker, the preview connects, shows that product or collection page, from the edge runtime. [designer-1440](drills/P1-HARNESS/designer-1440.png), [designer-product-1440](drills/P1-HARNESS/designer-product-1440.png), [designer-collection-1440](drills/P1-HARNESS/designer-collection-1440.png) |
| 13 | Record the response of each with a screenshot | browser | Pass | 15 screenshots plus the 2 "before" ones, and every status, header and content check in [results.json](drills/P1-HARNESS/results.json) |
| 14 | `sqld` looked up through `SQLD_BIN`, then `PATH`, then `/Users/snehal/.turso/sqld` | unit | Pass | "sqld is found through SQLD_BIN first", "then PATH, in PATH order", "then ~/.turso/sqld". Breaks M2 and M3 caught |
| 15 | Negative: fails with a plain message if `sqld` is missing | unit + manual | Pass | Unit "NEGATIVE: sqld missing everywhere…" (pure) and "NEGATIVE: sqld missing: plain message, nothing started, no data folder made" (whole harness). Manual: `SQLD_BIN=/nonexistent/sqld node scripts/dev-design.js` → `✗ SQLD_BIN is set to /nonexistent/sqld, but there is no file there. Fix the path, or unset SQLD_BIN to use the sqld on your PATH.`, exit 1. The no-sqld-anywhere case was not run by hand (it needs a changed `HOME`); the unit test runs the real harness that way |
| 16 | `scripts/dev-design.js` starts `sqld` for the platform database and the tenant database(s) | unit + manual | Pass | Unit "seed: … one database server per database…" checks each server's listen address and data path, and the URLs the seed and Next receive. Manual: `ps -g` of a running `pnpm dev:design` shows three `sqld` (18080, 18081, 18082) and Next |
| 17 | The seed writes over http | unit + manual | Pass | Unit checks the seed gets `http://127.0.0.1` URLs. Manual: `DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 pnpm seed:design` exit 0, "seeding the design store over http (databases on ports 18080, 18081, 18082)", then everything stopped |
| 18 | Negative: the seed never writes anywhere but a local harness server | unit | Pass | "NEGATIVE: the seed writes only to a local harness database" (libsql and https hosts, `file:`, a LAN address, no port) and "NEGATIVE: the real seed script refuses a hosted URL before opening any database, and never prints the full URL" (runs the real script; the query string with a token-like value is not printed). Test hosts use the reserved `.invalid` domain, so nothing is contacted even under a break. Breaks M11, M12, M22 caught |
| 19 | `next dev` runs with `runtime = "edge"` untouched | browser | Pass | Every storefront check above saw `x-edge-runtime: 1`, which Next's edge page template sets |
| 20 | `sqld` data lives in a gitignored folder | unit | Pass | "the harness data folder and credentials are gitignored; screenshots are not" (`git check-ignore`) |
| 21 | Stopping the harness stops `sqld` | unit + manual | Pass | Unit: SIGTERM and SIGINT to the harness, a second Ctrl-C while stopping, and Next exiting on its own each stop every server (PIDs gone, ports closed, pid file removed). Manual, real `sqld` and Next: (a) SIGTERM to `node scripts/dev-design.js` → all 3 `sqld` PIDs gone, ports 3027 and 18080-18082 closed; (b) SIGINT to the whole process group of `pnpm dev:design` (what Ctrl-C does) → 0 processes left in the group, no pid file; (c) SIGTERM to the `pnpm` process alone (what a process manager does) → pnpm passed it on, 0 left; (d) `node scripts/drill.js smoke --start` → harness started, drill passed, nothing left listening |
| 22 | Ports configurable by env, 3017 the default for Next | unit + manual | Pass | "ports default to today's 3017…", "DESIGN_PORT and DESIGN_SQLD_PORT move every port", overlap and range refused. Every manual run here used `DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080` |
| 23 | `pnpm dev:design` and `pnpm seed:design` keep working with the same commands | manual + browser | Pass on this Mac with `sqld` installed | Both run through `pnpm` above. `.claude/launch.json` is unchanged (`pnpm dev:design`, port 3017). Not run on port 3017 itself, which the brief reserves for the owner |
| 24 | Negative: a busy port, a second harness, a dying `sqld`, a failed seed | unit | Pass | Each has a test with a plain message and nothing left running. Breaks M6 to M9 and M27 caught |

### Browser runner

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| 25 | `playwright-core` as a devDependency, the installed Chrome via `executablePath`, never a download | unit + browser | Pass | Unit "drills use the installed Chrome…" (lookup order, plain message, the one `chromium.launch` passes `executablePath`, no download path in the source, exact version, only `playwright-core`). Every drill above ran Chrome 156.0.8078.80 from `/Applications/Google Chrome.app`. `pnpm add` reported no install script; `playwright-core` has no browser download step |
| 26 | `scripts/drill.js`: start from a running harness | browser + unit + manual | Pass | Every drill attached to `localhost:3027`. Negative, manual: `DESIGN_PORT=3027 pnpm drill:smoke` with nothing running → `✗ The design harness isn't running at http://localhost:3027. Start it with DESIGN_PORT=3027 pnpm dev:design, wait for "Ready", then run the drill again. Or add --start to have the drill start and stop it.`, exit 1. Unit "NEGATIVE: a drill with no harness running…" |
| 27 | Sign in to the console with the `.design-env` test credentials | browser | Pass | `drill:edge` "console: signed in with the .design-env setup password, landed on the dashboard", and the operator sign-in for maintenance. The passwords are read from `.design-env` and only typed into the form; they are never printed or written to `results.json` |
| 28 | Open a URL at 375, 768 and 1440 wide | browser | Pass | `drill:smoke` checks the product page at each width; the screenshots are 375, 720 (768 scaled down) and 720 (1440 scaled down) wide |
| 29 | Screenshots into `docs/cms-reviews/drills/<id>/`, small | unit + browser | Pass | Unit: a 1440x2400 random-noise image (the worst case) comes out at most 300KB and 720 wide; a 375 shot is not enlarged. Committed shots are 7 to 41KB, 576KB for both folders together |
| 30 | Read DOM facts | browser | Pass | `facts()` feeds every content, overflow and error-page check in both drills |
| 31 | `pnpm drill:smoke`: a product page at three widths, add to cart, open the drawer, writes screenshots | browser | Pass | 27 passed, 0 failed: 200, edge, heading, price, no error page, no sideways scroll at each width; the drawer starts closed; add to cart opens it with the item; Close closes it; the header button ("Open cart, 1 item") opens it again. [product-375](drills/smoke/product-375.png), [product-768](drills/smoke/product-768.png), [product-1440](drills/smoke/product-1440.png), [drawer-after-add](drills/smoke/drawer-after-add.png), [drawer-from-header](drills/smoke/drawer-from-header.png), [results.json](drills/smoke/results.json) |
| 32 | Drill scripts are not `test:*` suites | unit | Pass | The runner test checks no `test:*` script runs a drill. The files are not named `test-*.js`, so `scripts/run-tests.js` doesn't require a `test:*` for them |
| 33 | The flow is documented in this packet and the harness docs | manual | Done | "How the harness runs now", "How to run a drill", `docs/MANUAL_TESTING_GUIDE.md` §1, `docs/platform-guide.md` |

## Do the tests bite?

**Unit suite, 29 breaks, each applied alone, the suite run, the file restored.** All 29 turned the suite red. Three were added after the first runs found gaps:

| Break | Caught by |
|---|---|
| M1 `file:` URLs back (the original bug) | "THE BUG…", the seed and both dev tests |
| M2 `PATH` before `SQLD_BIN`; M3 a bad `SQLD_BIN` silently skipped | lookup tests (M2 also sends the lifecycle tests to the real `sqld`) |
| M4 stop leaves `sqld` running; M5 no SIGTERM handler; M5b no SIGINT handler | lifecycle tests |
| M6 a running harness not detected; M7 leftovers not stopped; M8 busy ports not checked; M9 a dead `sqld` not noticed | their negatives |
| M10 a Razorpay secret not blanked | the hosted-values test |
| M11 any database host accepted; M12 the full URL printed; M22 the seed doesn't check URLs | the seed negatives |
| M13 a seed keeps old data; M14 new migrations never noticed; M18 an empty harness never seeded; M20 the tenant row not repointed; M23 Next's exit code dropped | seed and dev tests |
| M15 screenshots not compressed; M16 `CHROME_BIN` ignored; M17 `finish` removes every PNG; M24 a screenshot name with a path; M26 a drill id with a path | runner tests |
| M19 default port not 3017; M21 storefront flipped to `nodejs` | ports and no-code-edit tests |
| M25 a leftover killed without checking its command line | **survived the first run.** Added "NEGATIVE: a recorded PID that now belongs to some other program is never signalled" |
| M27 the web port not checked | **survived the second run.** Added "NEGATIVE: a busy web port stops dev…; a seed doesn't need that port" |
| M28 `process.once` instead of `process.on` for SIGINT | Found by hand, not by a test: a real Ctrl-C under `pnpm` reached the harness twice, the second one killed it mid-stop, and `harness.pid.json` was left behind. Fixed, then "dev: a second Ctrl-C while stopping doesn't cut the stop short" was added; it fails on the old code |

The first runs also showed that a red run could leave stand-in processes behind (117 of them after the first mutation run, all stopped by PID). The suite now records every PID it starts and kills them on exit, red or green, and no process was left after the later runs.

**Browser drill against the bug.** `scripts/design-harness.js` was put back to `file:` URLs for one run (the original bug), the harness started on 3027 and `pnpm drill:edge` run: **16 passed, 25 failed** (24 checks plus the abort at "Add to cart", which the error page doesn't have). Every storefront page failed "not an error page" and "shows real content"; three still answered 200, which is why status is not the test. The file was restored and the drill run again: 67 passed, 0 failed.

These prove the tests notice these breaks, not every break.

## Test results

- Baseline at `bdbe1a7`, before any change: `pnpm test` **44 of 44 suites passed** in 36.0s.
- Final tree: `pnpm test` **45 of 45 suites passed** in 52.1s (the 44, plus `test:design-harness`), exit 0.
- `pnpm test:design-harness` on its own: **35 passed, 0 failed**. Repeated 8 more times in a row on the final code: 8 of 8 green, 16.0 to 17.1 seconds each, no process left behind. Its lifecycle tests use timeouts (up to 15 seconds for a stand-in to come up), so a very slow CI machine is the likeliest place for it to flake; not seen here.
- An earlier full run on this branch had `test:shopify-boundary` red (40 passed, 1 failed): the seed's printed console address became `http://localhost:${PORT}/admin/login`, which its Admin-URL scan reads as a possible Admin REST call. Fixed by keeping the origin in a variable (`${harnessUrl}/admin/login`), which the scan's rules already allow for the app's own console pages. The suite itself wasn't touched. Its `NOT_SHOPIFY_URLS` entry for `http://localhost:3017/admin/login` is now unused and can go in a later SHOP change.
- Drills on the final code, each run with `--start` (it started and stopped its own harness on 3027 and 18080 to 18082): `drill:edge` **67 passed, 0 failed**; `drill:smoke` **27 passed, 0 failed**. Nothing was left listening afterwards.

Commands, exactly:

```
git checkout -B cms/p1-harness bdbe1a7
pnpm install --frozen-lockfile --prefer-offline
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm add -D --save-exact playwright-core@1.64.1
DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 pnpm seed:design
DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 pnpm dev:design
DESIGN_PORT=3027 pnpm drill:edge
DESIGN_PORT=3027 pnpm drill:smoke
DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 node scripts/drill.js harness-edge --start
DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 node scripts/drill.js smoke --start
pnpm test:design-harness
pnpm test
```

## Findings outside this item (for the owner)

Seen by the drills on the harness. None is fixed here.

1. **The Designer preview counts as an experiment visitor.** With the seeded hero experiment running, the founder's own Designer preview is bucketed like a shopper: in 5 of 6 runs it showed variant b's title ("Visibly brighter in 14 days") instead of the draft title ("Winter repair, started."), and every run sent `POST /api/exp` from inside the preview, answered `{"ok":true,"recorded":true}`. So a founder can see a title they didn't write while editing, and their own preview views are counted as exposures. Cause read from `app/(storefront)/page.js:43-46`: `heroVariantFor` runs with no preview check, and `ExperimentPing` renders in preview too.
2. **The cookie banner covers the cart drawer's Checkout button** for a first-time shopper. At 1440 wide, before the banner is answered, a tap on "Checkout →" in the drawer lands on the banner (`elementFromPoint`, recorded in `drills/smoke/results.json`). Both are `z-50` and the banner comes later in the page. Visible in [drawer-after-add](drills/smoke/drawer-after-add.png). Not checked at 375.
3. **The maintenance message is nearly invisible on this store's brand.** The founder's message is `rgb(212, 212, 216)` on white, contrast **1.48:1** (WCAG asks 4.5:1), and the "store team sign-in" link is fainter still. Visible in [maintenance-1440](drills/P1-HARNESS/maintenance-1440.png). The harness store has a light background on purpose; a dark-hero brand may be fine.
4. **Maintenance reaches pages at different times.** Each storefront page keeps its own 30-second copy of the store's settings (`PLATFORM_CACHE_MS`), so for up to 30 seconds the home page can show the closed page while a product page still shows the product. Seen on the harness, where each route runs in its own edge sandbox; not checked on hosting.

## Browser drills still needed

Desktop Chrome on the design harness can check these; an agent can run them with the new runner.

1. **Every storefront page at 375 and 768.** `drill:edge` shoots most pages at 1440 only. Open home, a collection, `/collections`, search, checkout's first step, account sign-in and a CMS page at 375, 768 and 1440 with `drill.atWidths`. Pass: 200, no error page, no sideways scroll at any width.
2. **The cookie banner over the drawer at 375 and 768.** Repeat the smoke journey's `elementFromPoint` note at both widths. Pass: recorded either way; if the banner covers "Checkout →", attach the screenshot to finding 2.
3. **The S57 and S59 Designer flows on the edge runtime.** Those drills ran with the storefront flipped to nodejs. Edit the hero in the Designer, save, see the preview refresh, publish, and see it live on a signed-out page. Pass: each step shows the new words, and the preview stays on the edge runtime (`x-edge-runtime: 1`).
4. **A production build on the harness databases.** `next build` then `next start` with the harness's env, then `drill:edge` against it (the harness itself only runs `next dev`). Pass: 67 of 67, as in dev.
5. **No browser console errors on the key pages.** Collect `console.error` and failed requests during `drill:edge`. Pass: none, or each one explained.
6. **The maintenance page on a dark brand.** Change the harness brand to a dark background in the console, switch maintenance on, and measure the message contrast as the drill does. Pass: 4.5:1 or better, or the number recorded for finding 3.

## Checks only the owner can do

1. **Your own harness on 3017.** From your main checkout (with `.env.local` present), run `pnpm dev:design`. It seeds the first time. Open http://localhost:3017 signed out. Pass: the Design Demo Co storefront shows its products, and the console sign-in works with `.design-env`. Then press Ctrl-C. Pass: `lsof -nP -iTCP:3017 -iTCP:18017-18019 -sTCP:LISTEN` prints nothing.
2. **Decide on finding 1** (the Designer preview counted as an experiment visitor). Pass: a decision on whether the preview should show the draft untouched and record no exposure.
3. **Decide on finding 2, and check it on a real phone.** On an iPhone in Safari, first visit to a real store, add to cart. Pass: "Checkout →" in the drawer can be tapped without answering the cookie banner first, or you decide that is acceptable.
4. **Decide on finding 3** (maintenance message contrast) for the brands your stores use.
5. **Staging on the hosted edge runtime.** The drills prove Next's local edge sandbox only. On staging, open the home page, a product, a collection, `/collections`, search, checkout's first step, account sign-in, a CMS page, and the maintenance page with the store closed. Pass: each shows real content, and the Designer preview works.
6. **Safari on the Mac.** Open the harness storefront and the Designer in Safari. Pass: both render and the preview connects (the runner drives Chrome only).

## Deviations

- **Three `sqld` processes, not one.** One per database (platform, store, env default), on consecutive ports. `sqld` namespaces would need a host name per database, which `*.localhost` doesn't reliably give Node on macOS.
- **`DESIGN_SQLD_PORT` defaults to 18017**, my choice (it mirrors 3017). The brief fixed only Next's default.
- **The env default database gets its own server.** `DATABASE_URL` was a `file:` URL too, and anything that touches it on the edge runtime would fail the same way.
- **Hosted keys are blanked for the harness** (beyond the brief): database tokens, Shopify, Razorpay (store and platform), Typesense, Resend, GA4 and Meta forwarding, the alert webhook, `COOKIE_DOMAIN`, `PLATFORM_URL`, `VERCEL_URL`. The owner runs the harness from a checkout with `.env.local`, and Next keeps a preset empty value over `.env.local` (a unit test pins that behaviour of `@next/env`). `ANTHROPIC_API_KEY` is left alone on purpose, so AI insights still work if the owner's shell has a key. `NEXT_PUBLIC_SITE_URL` is set to the harness URL and `NEXT_TELEMETRY_DISABLED=1`.
- **`pnpm dev:design` seeds by itself** when there is no harness data, instead of starting against empty databases.
- **The seed adds `collection_products`**, so collection pages and rails show products. S57 added them by hand for its drill.
- **`pnpm drill:edge` was added** as the proof journey, alongside the `pnpm drill:smoke` the brief asked for.
- **The runtime proof is Next's own signals.** Pages: the `x-edge-runtime: 1` header from Next's edge page template. `/api/cart`: Next's dev manifest. Neither is an assertion made by our code.
- **`results.json` is committed** next to the screenshots, so a reviewer can read every check without running the drill.
- **No JSX-capable runner for rendered tests.** Spec 8.15 also asks for one (for example Vitest). The brief for this item covers the harness and the browser runner only, so nothing is tagged rendered.

## Merge notes

- `package.json`: the new `test:design-harness` line sits right after `test:media-upload`, and two `drill:*` lines after `dev:design`. Other batch B branches adding `test:*` lines there will conflict textually; keep both sides.
- `pnpm-lock.yaml` gains only `playwright-core@1.64.1`. Run `pnpm install` after merging.
- After merging, the owner's old `.design-*.db` files are unused (still gitignored, safe to delete). The first `pnpm dev:design` seeds into `.design-data/`. `sqld` must be installed; it is at `~/.turso/sqld` on this Mac.
- Agents running harnesses side by side must each set `DESIGN_PORT` and `DESIGN_SQLD_PORT`, and only one Next dev server can run per checkout.
- After a new tenant migration (0018 to 0020 are reserved in this batch), `pnpm dev:design` prints that a re-seed is needed; run `pnpm seed:design`.
- Nothing in `app/`, `lib/` or `components/` changed, so this merges independently of the other items.

## Known limits

- **Local Next only, in dev mode.** The drills run `next dev` (Turbopack) on this Mac. Next's edge sandbox in dev is not Vercel's edge runtime, and no production build ran here. Edge claims in OVL-03, PERF-03 and section 8.7 now have a local run to point at; hosted behaviour (latency, memory, cold starts) is still unmeasured.
- **Chrome only, headless, on macOS.** No Safari, Firefox or phone. Screenshots are the top of the page at each width, not the full page (the helper can take a full page, cut at 6000px).
- **One store.** The seed builds one tenant, so "the tenant database or databases" is one database today. The harness's `DATABASES` list is where a second store would go, with its own seed.
- **A harness killed outright leaves `sqld` running** until the next `pnpm dev:design` or `pnpm seed:design`, which stops them by recorded PID. A PID is only signalled if its command line still names this checkout's `.design-data`.
- **Ctrl-C was emulated, not pressed.** The group SIGINT is what a terminal sends; a real terminal wasn't used.
- **The "no sqld anywhere" message was only run inside the unit test**, which sets `HOME`; it was not run by hand.
- **Not run on port 3017**, reserved for the owner. Every manual run used 3027 and 18080 to 18082.
- **The blank list is a list.** A new environment variable for a hosted service won't be blanked until it is added to `BLANKED_ENV` in `scripts/design-harness.js`.
- **The maintenance step changes shared harness state.** It switches maintenance off in a `finally`, but a drill killed outright mid-step leaves the store closed; switch it off in the operator console.
- **The hero varies by visitor.** The home check accepts either experiment title, because the running experiment buckets each new visitor at random.
- **`results.json` changes on every run** (timestamps), so re-running a drill makes a diff even when nothing else changed.
- **Unix only.** The harness uses `ps` and the unit test writes a `#!/usr/bin/env node` stand-in for `sqld`. CI (Ubuntu) runs `test:design-harness`, which needs neither `sqld` nor Chrome; the drills don't run in CI.
- **The `@next/env` pin reads Next's minified source.** A Next upgrade that renames variables fails that test even if the behaviour is the same; re-check and update the pattern then.
- **`playwright-core` 1.64.1 drove Chrome 156**, newer than the Chrome that Playwright release was built against. It worked for everything here; a future Chrome could need a `playwright-core` update.
