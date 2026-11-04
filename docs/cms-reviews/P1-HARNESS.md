# P1-HARNESS: the design harness on the edge runtime, and a browser runner

Spec: `docs/CMS_FULL_BUILD_SPEC.md` section 8.15 ("Runners", "Browser drills", "Harness fix"). Branch `cms/p1-harness`, cut from `bdbe1a7`.

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch. Fix round 1 is on top of `f9a0cc5` |
| Locally tested | Yes. `pnpm test:design-harness` 46 passed, 0 failed (3 of 3 repeat runs green). `pnpm test`: 45 of 45 suites passed. Round 1: 18 deliberate breaks, 16 caught, 2 survive (both explained). See "Fix round 1", "Test results" and "Do the tests bite?" |
| Browser verified | Yes, on the design harness on this Mac, in desktop Chrome 156 (headless) through the new runner: `pnpm drill:edge` 150 passed, 0 failed, 5 known failures (findings 5 and 6, which are app bugs outside this item); `pnpm drill:smoke` 31 passed, 0 failed. Screenshots and `results.json` are committed under `docs/cms-reviews/drills/`. Not Safari, not a phone |
| Staging verified | **NOT DONE. Staging is unverified.** The harness is a local tool and nothing here ran on hosting |
| Production enabled | **NOT DONE. Production is unverified.** Nothing pushed, merged or deployed. Nothing in `app/`, `lib/` or `components/` changed (`git diff bdbe1a7 --stat -- app lib components` prints nothing) |

## Fix round 1

An independent review found one blocking problem and nine non-blocking items. Each was checked against the code first. All were right.

### Blocking: a second harness was not refused when the first was started with `pnpm dev:design`

**The review was right, and it was a regression.** At `f9a0cc5`, `runningHarness` compared the launcher's `ps` command line with `process.argv[1]`. Node makes that an absolute path, but pnpm starts the launcher as `node scripts/dev-design.js`, a relative name, so the check never matched. A second `pnpm dev:design`, or a `pnpm seed:design`, then treated the running harness's three `sqld` as left over and killed them, and the seed wiped `.design-data/`. The unit test missed it because it started the harness by its absolute path. At `bdbe1a7` a second `pnpm dev:design` was harmless, because Next refused it.

**Reproduced before the fix**, on `f9a0cc5`, ports 3046 and 18140:

| Step | Result |
|---|---|
| `DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 pnpm dev:design` | Seeded, then up. The pid file recorded the script as `…/wf_860a802e-629-16/scripts/dev-design.js`. `ps -p <launcher> -o command=` printed `node scripts/dev-design.js`. `sqld` 4838 to 4840. `GET /` 200 |
| `DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 pnpm seed:design` | Printed `• stopped a local database server left over from an earlier run (pid 4838)` three times, seeded, and printed `✓ design harness seeded` |
| Afterwards | All three `sqld` PIDs were gone. `GET /` on the running harness answered **500**, and that harness printed nothing about it (only Next's own `fetch failed`) |

**The fix** (`scripts/design-harness.js`):
- The pid file records every process as its PID plus its start time from `ps -o lstart=` (`processStamp`). That covers the launcher, each `sqld`, and now Next too. A recorded process counts as the same process only if that PID is alive with that same start time (`sameProcess`). So it doesn't matter how the launcher was started, and a reused PID is never mistaken for it.
- `runningHarness` uses that check. If a pid file has no start time (one written by `f9a0cc5`), a live launcher whose command line names `dev-design.js` still counts as running.
- `stopLeftovers` now refuses to signal anything while the recorded launcher is still running, even when called on its own.

**Checked after the fix, on the real harness** (same ports, real `sqld` and Next, started with `pnpm dev:design`):

| Command, while the first harness runs | Result |
|---|---|
| `DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 pnpm seed:design` | `✗ The design harness is already running (pid 60645). Stop it with Ctrl-C in its terminal first, then seed again.`, exit 1 |
| `DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 pnpm dev:design` | `✗ The design harness is already running (pid 60645). …`, exit 1 |
| `DESIGN_PORT=3047 DESIGN_SQLD_PORT=18145 node scripts/dev-design.js` (other ports, same checkout) | Same refusal, exit 1. Nothing started |
| Afterwards | `sqld` 60656 to 60658 and Next 60698 still running, ports 18140 to 18142 still listening, `.design-data/seeded.json` still there, `GET /` 200, `/products/glow-serum` still shows "Radiance Glow Serum 30ml" |

**The test the review asked for:** "NEGATIVE: started the way pnpm starts it (a relative script name), a second harness or a seed is refused and the running one keeps working". It starts the stand-in harness with `cwd` set to the fakes folder and args `["design-harness-under-test.mjs", "dev", root]`, as pnpm does. It then tries a seed and a dev, each by relative and by absolute name. All four are refused, and the first harness's `sqld`, Next, ports and data stay up. Put back the `f9a0cc5` check (break B1) and this test fails, along with two others.

### Non-blocking items

| # | Review item | Outcome |
|---|---|---|
| 1 | A closed store still ships its content in the page source | **Confirmed and recorded, not fixed here** (app code, see finding 5). Acceptance row 11 now says "no store content **visible**". The drill check was renamed to match. `drill:edge` gained four raw checks (the HTML of `/`, `/products/glow-serum` and `/policies/shipping`, and an `RSC: 1` fetch of the product). They fail today and are marked known (finding 5). Measured: the product page's HTML holds "Radiance Glow Serum 30ml" 24 times and "1299" 9 times. The `RSC: 1` fetch holds the product name 18 times. The home page holds "Shop bestsellers" and the product name twice each. The policy page holds "Orders dispatch within 24 hours" twice |
| 2 | The running harness doesn't notice when its `sqld` die after startup | **Fixed.** Once all three are up, the harness watches each `sqld`. If one stops by itself, the harness prints which one, its exit code or signal, and the last lines of its log. It then stops Next and the other servers and exits 1. Real run: `kill -9` of the tenant `sqld` printed `✗ The local database server for tenant stopped by itself (SIGKILL). Its log is …/.design-data/tenant.log.` plus 4 log lines and `The harness stopped Next too. Start it again with pnpm dev:design.`, and every process stopped. A Ctrl-C (SIGINT to the whole process group) is not reported this way: real run and a unit test |
| 3 | A harness killed outright leaves Next running too | **Fixed.** The pid file records Next (PID, start time, the Next script it ran). The next start stops it by that PID, but only if the start time matches and its command line still names that script. Then it waits up to 10 seconds for the ports to close. Real run: after `kill -9` of the launcher, Next 68769 with its `next-server` 68780 held 3046, and the three `sqld` held 18140 to 18142. The next `pnpm dev:design` printed `• stopped the web server left over from an earlier run (pid 68769)` and three `sqld` lines. All five PIDs were gone and the new harness answered 200 on the same ports |
| 4 | Guard tests are thin (8 of 9 review breaks survived) | **Fixed.** The review's R1 to R5, R7, R8 and R9 are all caught now (see "Do the tests bite?"). The suite pins its own list of 35 names that must be blanked and checks every one against a shell that sets them all, `PLATFORM_DB_TOKEN` included. It also checks each of the seed's three URL settings with a hosted value. A new test scans every `process.env.NAME` in `app/`, `lib/` and `components/` plus every name in `.env.example`. Each must be blanked, set by the harness, or listed in a new `KEPT_ENV` (passed on purpose). The drill's page facts (`pageFacts`, now exported) run against a stand-in DOM, so the error-page, sideways-scroll and broken-image facts have unit cover |
| 5 | Overclaim in `docs/MANUAL_TESTING_GUIDE.md` ("nothing hosted can be reached") | **Fixed.** It now says "the known hosted keys are blanked" and names `ANTHROPIC_API_KEY` as passed through on purpose. The same overclaim in the guide's table, `docs/platform-guide.md` and the `scripts/dev-design.js` header was fixed too. `PLATFORM_SITE_HOSTS` is now blanked, so a value in `.env.local` can't turn the harness storefront into the marketing site |
| 6 | No end-to-end proof that blanked keys hold against `.env.local` | **Not fixed.** I didn't build a sensitive probe either. It stays in Known limits |
| 7 | A drill attaches to any server on the port | **Fixed.** A drill now attaches only if this checkout's `.design-data/harness.pid.json` names a running harness on that `DESIGN_PORT`. Real run: a plain server on 3048 answering `/robots.txt`, then `DESIGN_PORT=3048 node scripts/drill.js smoke` → `✗ Something is answering at http://localhost:3048, but it isn't this checkout's design harness (…). It may be another checkout's harness or another app. …`, exit 1, nothing written |
| 8 | Finding 1 seen again | **Seen again here.** In both of my `drill:edge` runs the Designer preview showed the draft title, but each still sent `POST /api/exp`, which answered `{"ok":true,"recorded":true}`. Finding 1 updated |
| 9 | 375 and 768 re-measured by the reviewer; the cookie banner over "Checkout →" at 1440 | **Now recorded by the runner.** `drill:edge` opens all seven storefront pages and checkout at 1440, 768 and 375. Each must answer 200 on the edge runtime with real content, no error page and no sideways scroll, and each width is screenshotted. It also collects console errors, page errors, failed requests and 4xx/5xx answers: none. `drill:smoke` repeats the first add to cart at 768 and 375. The banner covers "Checkout →" at all three widths (finding 2). One new failure turned up: **checkout scrolls sideways at 375** (finding 6) |

**A deviation from the review's wording.** The review asked for the raw-HTML check to be "expected to fail until the maintenance fix lands". Instead of leaving `drill:edge` red, a check can now carry `{ known: "finding 5" }`. It still runs and is printed as `KNOWN` with what it found. It is counted under `knownFailures` in `results.json`, not under `failed`, so the drill can still fail on anything new. When a known check starts passing, the drill adds a note saying the marker can go. Unit-tested ("a known issue's check fails visibly…"), and break K1 is caught.

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

- `scripts/design-harness.js` (new): the harness plumbing. It finds `sqld` (`SQLD_BIN`, then `PATH`, then `~/.turso/sqld`), reads ports, starts one `sqld` per database in `.design-data/`, and waits for each `/health`. It writes a pid file recording each process it started (PID plus start time, Next included) and hands Next and the seed `http://127.0.0.1` URLs. It blanks hosted service keys (`BLANKED_ENV`) and passes a named list through on purpose (`KEPT_ENV`). It stops everything on Ctrl-C, SIGTERM or SIGHUP, when Next exits, and when a `sqld` stops by itself. It refuses a second harness, however the first was started. It stops the Next and `sqld` left behind by a harness that was killed outright, by recorded PID, and only if the start time and command line still match. It also notes new migrations since the last seed.
- `scripts/dev-design.js`: now a thin CLI over `runHarness`. Same commands: `pnpm dev:design`, `pnpm seed:design`. Plain one-line errors, no stack.
- `scripts/seed-design-preview.js`: writes over http to the URLs the harness passes, and refuses any URL that isn't a local harness server before any database module loads. Seeds `collection_products` (3 collections now hold 2 to 4 products each). Prints the real port.
- `scripts/drill.js` (new): the browser runner's helpers and CLI (see "How to run a drill"). It attaches only to this checkout's own harness, and supports checks marked as known issues.
- `scripts/drills/smoke.js` (new, `pnpm drill:smoke`) and `scripts/drills/harness-edge.js` (new, `pnpm drill:edge`).
- `scripts/test-design-harness.js` (new, `test:design-harness`): 46 tests, no `sqld`, Chrome or network needed.
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
- One harness per checkout. `.design-data/harness.pid.json` records the launcher, each `sqld` and Next, each with its PID and start time, plus the ports. A second `pnpm dev:design` or `pnpm seed:design` while that launcher runs is refused. After a harness was killed outright, the next start stops what it left behind.
- If a `sqld` stops by itself while the harness runs, the harness names it, shows the end of its log, and stops.
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
| `connectHarness({ start })` | Attaches to this checkout's harness on `DESIGN_PORT` and reads `.design-env`. Something else answering on that port (another checkout's harness, another app) is refused with a plain message. With `start`, starts one and stops it afterwards. Not running and no `start`: a plain message saying how to start it |
| `launchChrome()` / `chromePath()` | The installed Chrome through `playwright-core`, `executablePath` only: `CHROME_BIN`, then the usual macOS and Linux paths. Never a download |
| `drill.context({ width })` | A fresh browser context (own cookies, nobody signed in) |
| `drill.signIn(context)` | The merchant console through the real form: empty email, `DESIGN_ADMIN_PASSWORD` |
| `drill.signInOperator(context)` | The operator console through its real form: `PLATFORM_ADMIN_PASSWORD` |
| `drill.open(page, path, { width })` | Sets the width (375, 768, 1440 or any), loads, waits for network quiet, fonts and images. Returns status and headers |
| `drill.atWidths(page, path, name)` | `open` + `facts` + `shoot` at 375, 768 and 1440 |
| `drill.facts(page)` | DOM facts (`pageFacts`, run inside the page): path, title, `h1`s, viewport and scroll width, sideways overflow, image count, broken images, error page, page text |
| `drill.shoot(page, name)` | PNG into `docs/cms-reviews/drills/<id>/<name>.png`, scaled to at most 720 wide and squeezed until it is at most 300KB |
| `drill.check(ok, label, detail, { known })` / `drill.note(text)` | Records a pass or fail, or a finding that isn't pass or fail. With `known: "finding N"`, a failure is printed as `KNOWN` and counted apart; when it passes, a note says the marker can go |
| `finish()` | Writes `results.json` (checks, notes, screenshots, Chrome version, `passed`, `failed`, `knownFailures`). A screenshot an earlier run of the same drill made and this run didn't is removed; other files are left alone |

The drill exits 1 if any check fails that isn't marked known. Drills are not `test:*` suites: they need a running harness and Chrome, so `pnpm test` and CI never run them.

## Acceptance

Tags: unit = plain node (`test:design-harness`), browser = the new runner on the design harness in desktop Chrome, manual = run by me by hand on this Mac, recorded here. Nothing is tagged rendered: there is still no JSX-capable runner (see "Deviations").

### Harness fix

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| 1 | No runtime edit: `git diff` shows none | unit + browser + manual | Pass | `git diff bdbe1a7 --stat -- app lib components` prints nothing. Unit "no code edit: the storefront still declares the edge runtime, and the harness never touches app/". Drill checks `app/(storefront)/layout.js still says export const runtime = "edge"` and `git diff HEAD -- app is empty`. Break M21 (`runtime = "nodejs"`) turns the unit test red |
| 2 | Home renders with real content on the edge runtime | browser | Pass | `drill:edge` "home" at 1440, 768 and 375: 200, `x-edge-runtime: 1`, not an error page, no sideways scroll, shows "Festive sale" and the hero (one of the two experiment titles). [home-1440](drills/P1-HARNESS/home-1440.png), [home-768](drills/P1-HARNESS/home-768.png), [home-375](drills/P1-HARNESS/home-375.png) |
| 3 | A product page | browser | Pass | "product": `/products/glow-serum` at three widths, 200, edge, "Radiance Glow Serum 30ml", "1,299". [product-1440](drills/P1-HARNESS/product-1440.png), [product-768](drills/P1-HARNESS/product-768.png), [product-375](drills/P1-HARNESS/product-375.png). `drill:smoke` repeats it |
| 4 | A collection | browser | Pass | "collection": `/collections/serums` at three widths, 200, edge, "Serums" with its two products. [collection-1440](drills/P1-HARNESS/collection-1440.png), [collection-768](drills/P1-HARNESS/collection-768.png), [collection-375](drills/P1-HARNESS/collection-375.png) |
| 5 | `/collections` | browser | Pass | At three widths: 200, edge, all three collections. [collections-1440](drills/P1-HARNESS/collections-1440.png), [collections-768](drills/P1-HARNESS/collections-768.png), [collections-375](drills/P1-HARNESS/collections-375.png) |
| 6 | Search | browser | Pass | `/search?q=serum` at three widths, 200, edge, finds the product (SQL search; Typesense is blanked). [search-1440](drills/P1-HARNESS/search-1440.png), [search-768](drills/P1-HARNESS/search-768.png), [search-375](drills/P1-HARNESS/search-375.png) |
| 7 | Cart | browser | Pass | Add to cart: `POST /api/cart` 200, the drawer opens with the item; `GET /api/cart` 200 holds it. `/api/cart` is a route handler, which doesn't send `x-edge-runtime`; the drill reads Next's own dev manifest (`.next/dev/server/app/api/cart/route/middleware-manifest.json`) and checks it lists `/api/cart/route` as an edge function built from `server/edge/` chunks. [cart-drawer-1440](drills/P1-HARNESS/cart-drawer-1440.png) |
| 8 | Checkout's first step | browser | Pass on the edge runtime; **sideways scroll at 375 (finding 6)** | `/checkout` with that cart at three widths: 200, edge, "Contact & shipping address", the product in the summary. At 375 the page is 398px wide (a known check, finding 6). [checkout-1440](drills/P1-HARNESS/checkout-1440.png), [checkout-768](drills/P1-HARNESS/checkout-768.png), [checkout-375](drills/P1-HARNESS/checkout-375.png) |
| 9 | Account sign-in | browser | Pass | `/account` at three widths: 200, edge, "Sign in", "Email". [account-sign-in-1440](drills/P1-HARNESS/account-sign-in-1440.png), [account-sign-in-768](drills/P1-HARNESS/account-sign-in-768.png), [account-sign-in-375](drills/P1-HARNESS/account-sign-in-375.png) |
| 10 | A CMS page | browser | Pass | `/policies/shipping` at three widths: 200, edge, "Shipping policy", "Orders dispatch within 24 hours". [cms-page-1440](drills/P1-HARNESS/cms-page-1440.png), [cms-page-768](drills/P1-HARNESS/cms-page-768.png), [cms-page-375](drills/P1-HARNESS/cms-page-375.png) |
| 11 | The maintenance page when the store is closed | browser | Pass for what the visitor sees; **the page source still carries the store (finding 5)** | The drill signs in to the operator console through its form and switches maintenance on (`PATCH /api/platform/tenants/design` 200). A signed-out visitor then gets the maintenance page with the founder's message, on the edge runtime, with no store content visible (no announcement bar). A product page and a CMS page also show the maintenance page, not the product or the policy. **Behind the visible page, the raw HTML of `/`, `/products/glow-serum` and `/policies/shipping`, and a client-side `RSC: 1` fetch of the product, still carry the store's content.** Those four checks are known failures (finding 5). The leak is not caused by this branch: `app/(storefront)/layout.js` is unchanged from `bdbe1a7`. Maintenance is switched off in a `finally`, and the drill waits until the store shows real content again. [maintenance-1440](drills/P1-HARNESS/maintenance-1440.png) |
| 12 | The console's Designer and its storefront preview work | browser | Pass | Signed in through the real form, landed on the dashboard. Home Designer: "Preview shows your last save", the preview is the saved draft (button "Shop night routine", not the live "Shop bestsellers"), marked "Draft preview", its page came from the edge runtime (200, `x-edge-runtime: 1`). Product and collection Designers: a product and a collection picked through the real picker, the preview connects, shows that product or collection page, from the edge runtime. [designer-1440](drills/P1-HARNESS/designer-1440.png), [designer-product-1440](drills/P1-HARNESS/designer-product-1440.png), [designer-collection-1440](drills/P1-HARNESS/designer-collection-1440.png) |
| 13 | Record the response of each with a screenshot | browser | Pass | 29 screenshots plus the 2 "before" ones, and every status, header and content check in [results.json](drills/P1-HARNESS/results.json). No console errors, page errors, failed requests or 4xx/5xx answers on any storefront page in the drill |
| 14 | `sqld` looked up through `SQLD_BIN`, then `PATH`, then `/Users/snehal/.turso/sqld` | unit | Pass | "sqld is found through SQLD_BIN first", "then PATH, in PATH order", "then ~/.turso/sqld". Breaks M2 and M3 caught |
| 15 | Negative: fails with a plain message if `sqld` is missing | unit + manual | Pass | Unit "NEGATIVE: sqld missing everywhere…" (pure) and "NEGATIVE: sqld missing: plain message, nothing started, no data folder made" (whole harness). Manual: `SQLD_BIN=/nonexistent/sqld node scripts/dev-design.js` → `✗ SQLD_BIN is set to /nonexistent/sqld, but there is no file there. Fix the path, or unset SQLD_BIN to use the sqld on your PATH.`, exit 1. The no-sqld-anywhere case was not run by hand (it needs a changed `HOME`); the unit test runs the real harness that way |
| 16 | `scripts/dev-design.js` starts `sqld` for the platform database and the tenant database(s) | unit + manual | Pass | Unit "seed: … one database server per database…" checks each server's listen address and data path, and the URLs the seed and Next receive. Manual: `ps -g` of a running `pnpm dev:design` shows three `sqld` (18080, 18081, 18082) and Next |
| 17 | The seed writes over http | unit + manual | Pass | Unit checks the seed gets `http://127.0.0.1` URLs. Manual: `DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 pnpm seed:design` exit 0, "seeding the design store over http (databases on ports 18080, 18081, 18082)", then everything stopped |
| 18 | Negative: the seed never writes anywhere but a local harness server | unit | Pass | "NEGATIVE: the seed writes only to a local harness database" (libsql and https hosts, `file:`, a LAN address, no port) and "NEGATIVE: the real seed script refuses a hosted URL in any of its three database settings…" (runs the real script once per setting: `PLATFORM_DB_URL`, `DESIGN_TENANT_DB_URL`, `DATABASE_URL`; the query string with a token-like value is not printed). Test hosts use the reserved `.invalid` domain, and since round 1 the "local" values point at ports 1 to 3, where nothing listens, so even a break can't write into a harness on the default ports. Breaks M11, M12, M22, and the review's R3 and R4, caught |
| 19 | `next dev` runs with `runtime = "edge"` untouched | browser | Pass | Every storefront check above saw `x-edge-runtime: 1`, which Next's edge page template sets |
| 20 | `sqld` data lives in a gitignored folder | unit | Pass | "the harness data folder and credentials are gitignored; screenshots are not" (`git check-ignore`) |
| 21 | Stopping the harness stops `sqld` | unit + manual | Pass | Unit: SIGTERM and SIGINT to the harness, a SIGINT to its whole process group, a second Ctrl-C while stopping, Next exiting on its own, and a `sqld` stopping by itself each stop every server (PIDs gone, ports closed, pid file removed). Manual, real `sqld` and Next: (a) SIGTERM to `node scripts/dev-design.js` → all 3 `sqld` PIDs gone, ports 3027 and 18080-18082 closed; (b) SIGINT to the whole process group of `pnpm dev:design` (what Ctrl-C does) → 0 processes left in the group, no pid file (repeated in round 1 on 3046: 0 left, no "stopped by itself" message); (c) SIGTERM to the `pnpm` process alone (what a process manager does) → pnpm passed it on, 0 left; (d) `node scripts/drill.js smoke --start` → harness started, drill passed, nothing left listening (repeated in round 1 on 3046 and 18140); (e) round 1: `kill -9` of one `sqld` → the harness named it, stopped Next and the rest, exit 1; (f) round 1: `kill -9` of the launcher left Next and 3 `sqld`; the next `pnpm dev:design` stopped all of them by recorded PID and came up on the same ports |
| 22 | Ports configurable by env, 3017 the default for Next | unit + manual | Pass | "ports default to today's 3017…", "DESIGN_PORT and DESIGN_SQLD_PORT move every port", overlap and range refused. Every manual run here used `DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080` |
| 23 | `pnpm dev:design` and `pnpm seed:design` keep working with the same commands | manual + browser | Pass on this Mac with `sqld` installed | Both run through `pnpm` above. `.claude/launch.json` is unchanged (`pnpm dev:design`, port 3017). Not run on port 3017 itself, which the brief reserves for the owner |
| 24 | Negative: a busy port, a second harness, a dying `sqld`, a failed seed | unit + manual | Pass (round 1; **was false at `f9a0cc5`** for a second harness) | Each has a test with a plain message and nothing left running. **Correction:** at `f9a0cc5` a second harness or a seed was *not* refused when the first was started with `pnpm dev:design`. It killed the running harness's `sqld` and the seed wiped its data (see "Fix round 1"). The old test started the harness by its absolute path, which hid this. Now a second `pnpm dev:design` or `pnpm seed:design` is refused whether started by a relative or an absolute name, and the running harness keeps its servers, port and data. Shown by a unit test and by hand on the real harness. A `sqld` that dies after startup now stops the harness with a plain message too (before, only one dying while starting did). Breaks M6 to M9, M27, B1 to B3 and N1 caught |

### Browser runner

| # | Item | Tag | Status | Evidence |
|---|---|---|---|---|
| 25 | `playwright-core` as a devDependency, the installed Chrome via `executablePath`, never a download | unit + browser | Pass | Unit "drills use the installed Chrome…" (lookup order, plain message, the one `chromium.launch` passes `executablePath`, no download path in the source, exact version, only `playwright-core`). Every drill above ran Chrome 156.0.8078.80 from `/Applications/Google Chrome.app`. `pnpm add` reported no install script; `playwright-core` has no browser download step |
| 26 | `scripts/drill.js`: start from a running harness | browser + unit + manual | Pass | Every drill attached to this checkout's harness (3027 at first, 3046 in round 1). Negative, manual: `DESIGN_PORT=3027 pnpm drill:smoke` with nothing running → `✗ The design harness isn't running at http://localhost:3027. Start it with DESIGN_PORT=3027 pnpm dev:design, wait for "Ready", then run the drill again. Or add --start to have the drill start and stop it.`, exit 1. Unit "NEGATIVE: a drill with no harness running…". Round 1: a server on the port that isn't this checkout's harness is refused (unit, with and without `--start`, plus a manual run on 3048); this checkout's harness on another port is refused too |
| 27 | Sign in to the console with the `.design-env` test credentials | browser | Pass | `drill:edge` "console: signed in with the .design-env setup password, landed on the dashboard", and the operator sign-in for maintenance. The passwords are read from `.design-env` and only typed into the form; they are never printed or written to `results.json` |
| 28 | Open a URL at 375, 768 and 1440 wide | browser | Pass | `drill:smoke` checks the product page at each width, and `drill:edge` (round 1) every storefront page and checkout; the screenshots are 375, 720 (768 scaled down) and 720 (1440 scaled down) wide |
| 29 | Screenshots into `docs/cms-reviews/drills/<id>/`, small | unit + browser | Pass | Unit: a 1440x2400 random-noise image (the worst case) comes out at most 300KB and 720 wide; a 375 shot is not enlarged. Committed shots are 7 to 73KB each; the two folders are about 1.2MB together, `results.json` included |
| 30 | Read DOM facts | unit + browser | Pass | `facts()` feeds every content, overflow and error-page check in both drills. Round 1: `pageFacts` runs against a stand-in DOM in the unit suite (error page in three wordings, sideways scroll with 1px of rounding allowed, broken images); breaks R8 and R9 caught |
| 31 | `pnpm drill:smoke`: a product page at three widths, add to cart, open the drawer, writes screenshots | browser | Pass | 31 passed, 0 failed: 200, edge, heading, price, no error page, no sideways scroll at each width; the drawer starts closed; add to cart opens it with the item; Close closes it; the header button ("Open cart, 1 item") opens it again; round 1 adds a first add to cart at 768 and 375. [product-375](drills/smoke/product-375.png), [product-768](drills/smoke/product-768.png), [product-1440](drills/smoke/product-1440.png), [drawer-after-add](drills/smoke/drawer-after-add.png), [drawer-after-add-768](drills/smoke/drawer-after-add-768.png), [drawer-after-add-375](drills/smoke/drawer-after-add-375.png), [drawer-from-header](drills/smoke/drawer-from-header.png), [results.json](drills/smoke/results.json) |
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

M6 was caught only because the old test started the harness by its absolute path. Under pnpm the same check failed (see "Fix round 1"). The review's own breaks R1 to R9 showed 8 of 9 surviving.

**Round 1: 18 breaks, each applied alone, the suite run, the file restored (checked byte for byte).** 16 caught, 2 survive:

| Break | Result |
|---|---|
| B1 the `f9a0cc5` launcher check put back (the review's R7, the blocking bug) | caught: the relative-start test, the older-pid-file test, the drill attach test |
| B2 `stopLeftovers` no longer refuses while the harness runs | caught: the older-pid-file test |
| B3 start time ignored (a PID alone identifies a process) | caught: the pid-file test |
| N1 a `sqld` dying after startup not watched | caught: the dying-`sqld` test. The first time it hung the suite, which the spawn timeout killed. 4 stand-ins were left behind (stopped by PID). The test now gives up after 10 seconds and fails plainly |
| N2 Next not recorded in the pid file | caught: the pid-file test, the leftover-Next test |
| R1 `PLATFORM_RAZORPAY_KEY_SECRET` not blanked; R2 `SHOPIFY_CLIENT_SECRET` not blanked; R2b it moved to `KEPT_ENV`; R5 `PLATFORM_DB_TOKEN` not blanked; P1 `PLATFORM_SITE_HOSTS` not blanked | caught: the pinned blank-list test and the classification scan |
| R3 the seed's `DATABASE_URL` check deleted; R4 its `DESIGN_TENANT_DB_URL` check deleted | caught: the three-setting seed test |
| R8 the drill's `errorPage` fact disabled; R9 its `overflowX` fact disabled | caught: the page-facts test |
| G1 a drill attaches to any server on the port | caught: both attach tests |
| K1 known failures fail the drill | caught: the known-issue test |
| N3 no 500ms grace before reporting a dead `sqld`; N4 the "Ctrl-C is under way" check removed | **survive.** Both guard a race: a terminal's Ctrl-C reaches `sqld` and the harness at once. In every run here (the unit test with a real group SIGINT, and the real harness), the harness's own SIGINT handler ran before `sqld`'s exit was seen. So the "stopping" flag already covered it, and these two extra guards were never needed. They stay as cheap insurance |

**Browser drill against the bug.** `scripts/design-harness.js` was put back to `file:` URLs for one run (the original bug), the harness started on 3027 and `pnpm drill:edge` run: **16 passed, 25 failed** (24 checks plus the abort at "Add to cart", which the error page doesn't have). Every storefront page failed "not an error page" and "shows real content"; three still answered 200, which is why status is not the test. The file was restored and the drill run again: 67 passed, 0 failed.

These prove the tests notice these breaks, not every break.

## Test results

First round (`f9a0cc5`):

- Baseline at `bdbe1a7`, before any change: `pnpm test` **44 of 44 suites passed** in 36.0s.
- `f9a0cc5`: `pnpm test` **45 of 45 suites passed** in 52.1s (the 44, plus `test:design-harness`), exit 0.
- `pnpm test:design-harness` on its own: **35 passed, 0 failed**. Repeated 8 more times in a row on that code: 8 of 8 green, 16.0 to 17.1 seconds each, no process left behind. Its lifecycle tests use timeouts (up to 15 seconds for a stand-in to come up), so a very slow CI machine is the likeliest place for it to flake; not seen here.
- An earlier full run on this branch had `test:shopify-boundary` red (40 passed, 1 failed): the seed's printed console address became `http://localhost:${PORT}/admin/login`, which its Admin-URL scan reads as a possible Admin REST call. Fixed by keeping the origin in a variable (`${harnessUrl}/admin/login`), which the scan's rules already allow for the app's own console pages. The suite itself wasn't touched. Its `NOT_SHOPIFY_URLS` entry for `http://localhost:3017/admin/login` is now unused and can go in a later SHOP change.
- Drills on the `f9a0cc5` code, each run with `--start` (it started and stopped its own harness on 3027 and 18080 to 18082): `drill:edge` **67 passed, 0 failed**; `drill:smoke` **27 passed, 0 failed**. Nothing was left listening afterwards.

Fix round 1:

- `pnpm test`: **45 of 45 suites passed** in 56.5s, exit 0. (No suite was added: the new tests are in `test:design-harness`.)
- `pnpm test:design-harness`: **46 passed, 0 failed**, about 21 seconds. 3 more runs in a row, 3 of 3 green, and no stand-in left running afterwards.
- `DESIGN_PORT=3046 pnpm drill:edge` against `pnpm dev:design` on 3046 and 18140: **150 passed, 0 failed, 5 known failures**. Four are finding 5 (closed store's content in the page source) and one is finding 6 (checkout at 375). The first run had the checkout overflow as a plain failure (150 passed, 1 failed); after reading its cause it was marked known.
- `DESIGN_PORT=3046 pnpm drill:smoke`: **31 passed, 0 failed**. Again with `--start` (it started and stopped its own harness on 3046 and 18140): 31 passed, 0 failed. Nothing was left listening, and no pid file was left.
- Every harness I started was stopped, and ports 3046 and 18140 to 18142 were free at the end.

Commands, exactly (round 1):

```
git checkout cms/p1-harness
pnpm install --frozen-lockfile --prefer-offline
DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 pnpm dev:design      # repro on f9a0cc5, then the fix
DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 pnpm seed:design     # while it runs
DESIGN_PORT=3047 DESIGN_SQLD_PORT=18145 node scripts/dev-design.js
DESIGN_PORT=3046 pnpm drill:edge
DESIGN_PORT=3046 pnpm drill:smoke
DESIGN_PORT=3048 node scripts/drill.js smoke                 # a plain server on 3048
DESIGN_PORT=3046 DESIGN_SQLD_PORT=18140 node scripts/drill.js smoke --start
pnpm test:design-harness
pnpm test
```

Commands, exactly (first round):

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

1. **The Designer preview counts as an experiment visitor.** With the seeded hero experiment running, the founder's own Designer preview is bucketed like a shopper. In 5 of 6 first-round runs it showed variant b's title ("Visibly brighter in 14 days") instead of the draft title ("Winter repair, started."). Every run sent `POST /api/exp` from inside the preview, answered `{"ok":true,"recorded":true}`. In round 1, the reviewer's run and both of mine showed the draft title, but each still sent `POST /api/exp` and was recorded. So a founder can see a title they didn't write while editing, which title shows varies from run to run, and their own preview views are counted as exposures. Cause read from `app/(storefront)/page.js:43-46`: `heroVariantFor` runs with no preview check, and `ExperimentPing` renders in preview too.
2. **The cookie banner covers the cart drawer's Checkout button** for a first-time shopper, at every width. Before the banner is answered, a tap on "Checkout →" in the drawer lands on the banner at 1440, 768 and 375 (`elementFromPoint`, recorded in `drills/smoke/results.json`). Both are `z-50` and the banner comes later in the page. At 375 the banner hides the button completely. See [drawer-after-add](drills/smoke/drawer-after-add.png), [drawer-after-add-768](drills/smoke/drawer-after-add-768.png) and [drawer-after-add-375](drills/smoke/drawer-after-add-375.png).
3. **The maintenance message is nearly invisible on this store's brand.** The founder's message is `rgb(212, 212, 216)` on white, contrast **1.48:1** (WCAG asks 4.5:1), and the "store team sign-in" link is fainter still. Visible in [maintenance-1440](drills/P1-HARNESS/maintenance-1440.png). The harness store has a light background on purpose; a dark-hero brand may be fine.
4. **Maintenance reaches pages at different times.** Each storefront page keeps its own 30-second copy of the store's settings (`PLATFORM_CACHE_MS`), so for up to 30 seconds the home page can show the closed page while a product page still shows the product. Seen on the harness, where each route runs in its own edge sandbox; not checked on hosting.
5. **A closed store still ships its content in the page source** (found by the round 1 review, now measured by `drill:edge`). With maintenance on, a signed-out visitor *sees* only the closed page. But the raw HTML of `/products/glow-serum` holds "Radiance Glow Serum 30ml" 24 times and "1299" 9 times. The home page's HTML holds "Shop bestsellers" and the product name. The shipping policy's HTML holds "Orders dispatch within 24 hours". A client-side fetch of the product (`RSC: 1`) holds the product name 18 times. So anyone who views the source, or any crawler, still reads a closed store's products, prices and pages. Not caused by this branch: `app/(storefront)/layout.js` is unchanged from `bdbe1a7`. The separate maintenance-bypass work reported the same leak. The four `drill:edge` checks for it are marked known and will say so when it is fixed.
6. **Checkout scrolls sideways on a phone.** At 375 wide the checkout page is 398px wide, and at 390 (most current iPhones) 398px too. At 414 it fits. The cause is the step row "1 Address → 2 Review → 3 Payment" in `components/checkout/CheckoutFlow.js:235`. It is a flex row that never wraps, set beside the store name, so "Payment" runs off the right edge (the store name wraps to three lines next to it). A longer store name makes it worse. See [checkout-375](drills/P1-HARNESS/checkout-375.png). Found by round 1's new 375 check; the `drill:edge` check is marked known.

## Browser drills still needed

Desktop Chrome on the design harness can check these; an agent can run them with the new runner. (The first round's items 1, 2 and 5 are done in round 1: every storefront page and checkout at 375, 768 and 1440, the cookie banner at 768 and 375, and console, page and request errors, all now in `drill:edge` and `drill:smoke`.)

1. **The S57 and S59 Designer flows on the edge runtime.** Those drills ran with the storefront flipped to nodejs. Edit the hero in the Designer, save, see the preview refresh, publish, and see it live on a signed-out page. Pass: each step shows the new words, and the preview stays on the edge runtime (`x-edge-runtime: 1`).
2. **A production build on the harness databases.** `next build` then `next start` with the harness's env, then `drill:edge` against it (the harness itself only runs `next dev`). Pass: 150 passed and 0 failed, with the same 5 known failures, as in dev.
3. **The maintenance page on a dark brand.** Change the harness brand to a dark background in the console, switch maintenance on, and measure the message contrast as the drill does. Pass: 4.5:1 or better, or the number recorded for finding 3.
4. **Checkout at 390 and 360 wide** (finding 6). Run the checkout page check at 390 (most current iPhones) and 360 (many Android phones), with the screenshot. Pass: the numbers recorded for finding 6. Once the step row is fixed: no sideways scroll at 360, 375, 390 and 414, and the known marker removed from `drill:edge`.
5. **Finding 5 after the maintenance fix lands.** Merge the maintenance fix, run `pnpm drill:edge`. Pass: the four "carries no store content" checks pass and the drill notes "finding 5 looks fixed"; then remove their `known` marker.
6. **The drill's own Designer preview count** (finding 1). Run `drill:edge` five times and record the preview's hero title and the `/api/exp` answers each time. Pass: the numbers recorded, so the owner's decision on finding 1 has them.

## Checks only the owner can do

1. **Your own harness on 3017.** From your main checkout (with `.env.local` present), run `pnpm dev:design`. It seeds the first time. Open http://localhost:3017 signed out. Pass: the Design Demo Co storefront shows its products (not the marketing site), and the console sign-in works with `.design-env`. In a second terminal, run `pnpm seed:design`. Pass: it says the harness is already running, and the storefront still loads. Then press Ctrl-C in the first terminal. Pass: `lsof -nP -iTCP:3017 -iTCP:18017-18019 -sTCP:LISTEN` prints nothing.
2. **Decide on finding 1** (the Designer preview counted as an experiment visitor). Pass: a decision on whether the preview should show the draft untouched and record no exposure.
3. **Decide on finding 2, and check it on a real phone.** On an iPhone in Safari, first visit to a real store, add to cart. Pass: "Checkout →" in the drawer can be tapped without answering the cookie banner first, or you decide that is acceptable. The drill shows the banner covering it at 375, 768 and 1440 in Chrome.
4. **Decide on finding 3** (maintenance message contrast) for the brands your stores use.
5. **Decide on finding 5** (a closed store's content in its page source). Pass: a decision on whether a closed store must send no products, prices or pages at all, which is what the maintenance fix in the other session aims for.
6. **Check finding 6 on a real phone.** On your iPhone in Safari, open a real store's checkout with something in the cart. Pass: the page doesn't move sideways and "Payment" in the step row is fully visible, or you see the same cut-off and decide when it is fixed.
7. **Staging on the hosted edge runtime.** The drills prove Next's local edge sandbox only. On staging, open the home page, a product, a collection, `/collections`, search, checkout's first step, account sign-in, a CMS page, and the maintenance page with the store closed. Pass: each shows real content, and the Designer preview works.
8. **Safari on the Mac.** Open the harness storefront and the Designer in Safari. Pass: both render and the preview connects (the runner drives Chrome only).

## Deviations

- **Three `sqld` processes, not one.** One per database (platform, store, env default), on consecutive ports. `sqld` namespaces would need a host name per database, which `*.localhost` doesn't reliably give Node on macOS.
- **`DESIGN_SQLD_PORT` defaults to 18017**, my choice (it mirrors 3017). The brief fixed only Next's default.
- **The env default database gets its own server.** `DATABASE_URL` was a `file:` URL too, and anything that touches it on the edge runtime would fail the same way.
- **Hosted keys are blanked for the harness** (beyond the brief): database tokens, Shopify, Razorpay (store and platform), Typesense, Resend, GA4 and Meta forwarding, the alert webhook, `COOKIE_DOMAIN`, `PLATFORM_URL`, `VERCEL_URL`, and since round 1 `PLATFORM_SITE_HOSTS`. The owner runs the harness from a checkout with `.env.local`, and Next keeps a preset empty value over `.env.local` (a unit test pins that behaviour of `@next/env`). `ANTHROPIC_API_KEY` is passed through on purpose, so AI insights reach Anthropic if the owner's shell has a key. It is listed in `KEPT_ENV` with the tuning knobs and local secrets that pass through. A unit test fails when the app or `.env.example` names a variable in neither list. `NEXT_PUBLIC_SITE_URL` is set to the harness URL and `NEXT_TELEMETRY_DISABLED=1`.
- **The pid file records start times and Next** (round 1). Every recorded process is identified by PID plus start time (`ps -o lstart=`), not by its command line, because pnpm and `node` show different command lines for the same launcher.
- **Known-issue checks in drills** (round 1). The review asked for the finding 5 check to be "expected to fail". It is, but it is marked known, so the drill stays green on everything else and still fails on anything new (see "Fix round 1").
- **A drill attaches only to this checkout's harness** (round 1, beyond the review's "minor"). It refuses anything else on `DESIGN_PORT`.
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
- When the maintenance fix (finding 5) merges, run `pnpm drill:edge`. Its four finding 5 checks should pass and print a note; then delete their `{ known: "finding 5" }` in `scripts/drills/harness-edge.js`. The same goes for finding 6 and its `knownOverflow`.
- A new `process.env.NAME` in `app/`, `lib/` or `components/`, or a new line in `.env.example`, turns `test:design-harness` red until the name is added to `BLANKED_ENV` or `KEPT_ENV` in `scripts/design-harness.js`. Any branch that adds an env variable will hit this after merging. That is on purpose. Checked when this was written: `cms/p1-gen02`, `cms/p1-com03` and `cms/p1-mig-ovl` add no new `process.env` name.

## Known limits

- **Local Next only, in dev mode.** The drills run `next dev` (Turbopack) on this Mac. Next's edge sandbox in dev is not Vercel's edge runtime, and no production build ran here. Edge claims in OVL-03, PERF-03 and section 8.7 now have a local run to point at; hosted behaviour (latency, memory, cold starts) is still unmeasured.
- **Chrome only, headless, on macOS.** No Safari, Firefox or phone. Screenshots are the top of the page at each width, not the full page (the helper can take a full page, cut at 6000px).
- **One store.** The seed builds one tenant, so "the tenant database or databases" is one database today. The harness's `DATABASES` list is where a second store would go, with its own seed.
- **A harness killed outright leaves Next and `sqld` running** until the next `pnpm dev:design` or `pnpm seed:design`. That start stops them by recorded PID, only if the start time matches and the command line still names this checkout's `.design-data` (for `sqld`) or Next script (for Next). Until then, port `DESIGN_PORT` still serves the old harness. Stopping Next sends SIGTERM to the `next dev` process, which stopped its own `next-server` child in the one real run; if it ever doesn't, the start waits 10 seconds for the port and then says it is in use.
- **A `sqld` that dies is noticed only after all three are up.** While starting, the existing check (a server that stops while starting) covers it. In a seed, a dying `sqld` is named in the "Seeding failed" message. The 500ms wait before reporting, and the "Ctrl-C under way" check, guard a race that never showed up here (breaks N3 and N4 survive).
- **The pid file's start times come from `ps -o lstart=`**, to the second, in the C locale. Two processes on the same PID within the same second would look the same; that can't happen in practice. A pid file written by `f9a0cc5` has no start times; a live launcher whose command line names `dev-design.js` still counts as running.
- **Ctrl-C was emulated, not pressed.** The group SIGINT is what a terminal sends; a real terminal wasn't used.
- **The "no sqld anywhere" message was only run inside the unit test**, which sets `HOME`; it was not run by hand.
- **Not run on port 3017**, reserved for the owner. Manual runs used 3027 and 18080 to 18082 (first round) and 3046 and 18140 to 18142 (round 1).
- **The blank list is still a list, but now a checked one.** The unit test scans `process.env.NAME` in `app/`, `lib/` and `components/` and every name in `.env.example`. It does not see a variable read another way: `process.env[name]`, destructuring, or code in `scripts/`. Such a variable is neither blanked nor flagged.
- **No end-to-end proof that a blanked key beats `.env.local`.** The claim rests on the unit test that pins `@next/env`'s minified source (Next keeps a preset empty value). The reviewer's attempt to prove it end to end (fake Typesense values in `.env.development.local`, a logging stand-in, a search) wasn't sensitive: the control run without blanking sent no request either. I didn't build a sensitive probe.
- **The drill's attach check trusts this checkout's pid file.** If this checkout's harness runs on `DESIGN_PORT`, the drill attaches. It does not check that the page it gets came from that Next process.
- **Known-issue checks are trusted to stay honest.** A check marked `known` doesn't fail the drill, so a new, different failure on the same check (for example the maintenance page leaking even more) only shows in its detail text and `results.json`, not in the exit code.
- **Finding 6 measured only at 375, 390 and 414** (390 and 414 by a one-off script, not the drill). 360 and other widths were not checked.
- **The maintenance step changes shared harness state.** It switches maintenance off in a `finally`, but a drill killed outright mid-step leaves the store closed; switch it off in the operator console.
- **The "no failed requests" check skips cut-off requests.** A request cut off by the drill's own next navigation (`net::ERR_ABORTED`) is counted in a note, not as a failure. Both round 1 runs had 0.
- **The hero varies by visitor.** The home check accepts either experiment title, because the running experiment buckets each new visitor at random.
- **`results.json` changes on every run** (timestamps), so re-running a drill makes a diff even when nothing else changed.
- **Unix only.** The harness uses `ps` and the unit test writes a `#!/usr/bin/env node` stand-in for `sqld`. CI (Ubuntu) runs `test:design-harness`, which needs neither `sqld` nor Chrome; the drills don't run in CI.
- **The `@next/env` pin reads Next's minified source.** A Next upgrade that renames variables fails that test even if the behaviour is the same; re-check and update the pattern then.
- **`playwright-core` 1.64.1 drove Chrome 156**, newer than the Chrome that Playwright release was built against. It worked for everything here; a future Chrome could need a `playwright-core` update.

### From review

Non-blocking findings from the independent reviews, added at merge. The first nine came from the first review and are answered in "Fix round 1" above; they are kept here so the list is complete. The rest came from the review of round 1 and are still open.

**First review (answered in "Fix round 1").**
- **A closed store still sends its content in the page source.** With maintenance on, a signed-out visitor sees only the closed page, but the raw HTML of a product page holds the product name and price many times over, the home page holds product names and the hero button, a policy page holds its text, and a client-side fetch of a product returns the product. Not caused by this branch. The packet's maintenance row now says "no store content visible", and `drill:edge` has four raw-source checks marked known (finding 5) until the maintenance fix lands.
- **The harness did not notice when a database server died after startup.** It kept Next up and served 500 with no message. Fix round 1 item 2 says it now watches each `sqld`, names the one that stopped, and stops everything.
- **A harness killed outright left Next running too**, so the next `pnpm dev:design` failed with "port already in use". Fix round 1 item 3 says the pid file now records Next and the next start stops it.
- **The guard tests were thin.** 8 of the reviewer's 9 deliberate breaks survived (the seed's URL checks, several blanked key names, the drill's error-page and sideways-scroll facts). Fix round 1 item 4 says all are caught now.
- **The testing guide overclaimed** that "nothing hosted can be reached" from the harness, while `ANTHROPIC_API_KEY` passes through on purpose and `PLATFORM_SITE_HOSTS` was not blanked. Fix round 1 item 5 says the wording is fixed and `PLATFORM_SITE_HOSTS` is now blanked.
- **No end-to-end proof that blanked keys beat `.env.local`.** The reviewer's probe was not sensitive (the control run sent no request either). Still open; already listed above.
- **A drill attached to any server on its port**, and could switch another checkout's harness into maintenance. Fix round 1 item 7 says a drill now attaches only to this checkout's running harness.
- **The Designer preview still counts as an experiment visitor** (finding 1 seen again): the preview showed the draft title but still sent `POST /api/exp`, which was recorded.
- **375 and 768 re-measured by the reviewer.** Seven storefront pages answered 200 on the edge runtime with no sideways scroll, no error page, and no console or request errors. The cookie banner over "Checkout →" at 1440 was reproduced (finding 2).

**Review of round 1 (still open).**
- **Running the seed with a different time zone can wipe a running harness's data.** The "same process" check compares start times from `ps -o lstart=`, which prints local time; the `ps` call pins `LC_ALL` but not `TZ`. With `TZ=UTC` set, a second seed thought the running harness was gone. On the way, `stopLeftovers` deleted the running harness's pid file even though it skipped every process. After that, a seed on other ports wiped and reseeded `.design-data`, said it succeeded, and the first harness started failing ("connect ECONNREFUSED", "no such table: app_errors"). Once the pid file is gone, any seed on other ports does this, with or without `TZ`. Not blocking: no project script sets `TZ`, and only local harness data is lost. Suggested fix: add `TZ: "UTC"` next to `LC_ALL: "C"`, and keep the pid file while the recorded launcher is alive and still names `dev-design.js`. On Linux (CI), `lstart` is worked out from boot time and can be off by a second, which the "can't happen in practice" wording above does not cover.
- **Two deliberate breaks survive on harmless lines.** Dropping the start-time check on targets in `stopLeftovers` survives because the command-line check still guards each one (dropping that check is caught). Clearing the pid file before the loop instead of after survives and makes no difference.
- **Not probed, likely harmless:** on a first `pnpm dev:design` with no data, the pid file is missing for a few milliseconds between the seed clearing it and the databases starting. A seed started in exactly that gap would only be stopped by the port check.

## Phase 3 additions (P3-HARNESS)

Added by `cms/p3-harness` so the phase 3 drills (batches 3 to 5) share one seed and one set of helpers. The packet is `docs/cms-reviews/P3-HARNESS.md`. Nothing above changed: `pnpm seed:design`, `pnpm dev:design`, the legacy seed, `drill:smoke`, `drill:edge` and the P2 drill seed (`seed-design-documents.js` without `--p3`) work as before.

### The phase 3 seed

```
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/seed-design-documents.js --p3   # harness stopped
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 pnpm dev:design                              # then start it
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/seed-design-documents.js check --p3
```

`--p3` starts from a fresh perf seed by itself (the same as `node scripts/dev-design.js seed --fixture perf`), so it needs no step before it, and running it again resets everything: the same rows and counts, new ids and new passwords. It takes about 4 seconds. `--worst-case` and `--posts N` still work with it; `--drafts-only` doesn't (the drill content is published).

What it holds, on top of the P2 documents store (the perf content as documents, published as one set):

| What | Where | For |
|---|---|---|
| An owner login and a staff login on the design store | `founder@design.test` (owner) and `staff@design.test` (staff: edits and previews, can't publish). Passwords are made fresh by each seed and written only to `.design-data/p3-seed.json` (mode 600, gitignored). The seed never prints them | AU-04 and every role check |
| A campaign that is never published | slug `p3-spring-edit`, `/campaigns/p3-spring-edit` answers 404 | PUB-03 "links to unpublished" |
| A live page whose draft links to that campaign | slug `p3-spring-guide`, `/policies/p3-spring-guide`. Live without the link; the draft adds a banner whose button links to the campaign | the `LINKS_TO_UNPUBLISHED` offer |
| A live campaign linked from home | slug `p3-weekend-offer`, published on its own (so its Undo is "take offline"), then the home page gains a banner `sec_p3camp` linking to it. The home page's live version has a `document_refs` row naming it | PUB-04 take offline, the linkers list |
| A journal post | the fixture's first live post | Undo and offline on a post |
| A home with a product rail whose collection has products | the fixture's `sec_pfrail1` (collection `top-rated`, 60 products) | AU-04 |
| A three-document publish set, the last publish | pages `faq` and `size-guide` (first section title "Updated in the spring set") and the announcement, published together | whole-set Undo |
| A second store, closed | tenant `design-closed`, host `closed.localhost`, name "Closed Demo Co". Documents mode, no release (state none), two drafts (a home page and an about page). Shoppers see "Opening soon". No members, so its setup password (`DESIGN_ADMIN_PASSWORD`) signs in | PUB-06 |

Every publish goes through `lib/documents/publish.js`, as the owner, so `publish_log`, `document_refs` (migration 0023) and the live addresses all exist. `check --p3` compares each published version's `document_refs` rows with what `refRows` makes from its body.

**The closed store's database** is the harness's third server (`DESIGN_SQLD_PORT + 2`, the env default database). No request otherwise uses it: an unknown host never falls back to it. `scripts/design-harness.js` still starts three servers and updates only the design store's address (`pointTenantAtThisRun`). Since P3-FIX2, the phase 3 drill helpers also point the closed store's tenant row at this run's third server when they start the harness (`startOwned()` in `scripts/drills/p3/lib.mjs`, through `pointClosedStoreAt` in `scripts/seed-design-documents.js`, local addresses only), so a drill on new ports never reaches another checkout's database. A harness you start by hand with `pnpm dev:design` does not do this: after changing `DESIGN_SQLD_PORT`, reseed with `--p3` (or run a phase 3 drill) before using the closed store.

**`closed.localhost`** resolves to this machine in Chrome without any hosts-file change. Other tools may need `--resolve` or a `Host` header.

**Once the design store has members, its setup password no longer signs in there** (the console's bootstrap rule). Phase 3 drills sign in by email (`login()` below). `drill:smoke`, `drill:edge` and the P2 drills use the setup password, so they run on the plain or P2 seeds, not on `--p3`.

`.design-data/p3-seed.json` holds: `stores` (live and closed, with host and the closed store's draft ids), `logins` (owner and staff: id, email, name, role, password), `documents` (home, liveCampaign, unpublishedCampaign, guide, journalPost: id, type, slug, label, path, `liveUrl` from `lib/documents/paths.js`, published version, the publish_log row of its seeded publish, and the links between them), and `publishSet` (set id, release and each member's `logId`).

### Helpers for phase 3 drills: `scripts/drills/p3/lib.mjs`

```
DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/drills/p3/smoke.mjs [--headed]
```

| Helper | Does |
|---|---|
| `p3Ports()` | Reads `DESIGN_PORT` and `DESIGN_SQLD_PORT`. Both must be set, and 3017 is refused |
| `runDrill({ id, part, title }, fn)` | Refuses a harness already running in this checkout, launches the installed Chrome (playwright-core, never a download), runs `fn(drill)`, writes the results file, closes Chrome and stops the harness it started. Returns the exit code |
| `reseed(drill, { start, flags })` | Stops the harness this run started, runs `seed-design-documents.js --p3`, and (by default) starts the harness again. Returns `{ seed, out }` |
| `readSeed()`, `seedState()` | The seed config, and `check --p3`'s answer |
| `drill.login(role, { context, store })` | `'owner'` or `'staff'` through the real form, by email, on the live store; `store: 'closed'` signs in to the closed store as its owner. Cookies are reused per role within one seed (the sign-in route allows 5 tries a minute) |
| `drill.clickCounter(context)` | Counts every real click in that context, on every page, across navigations: `count`, `clicks` (`path`, `tag`, `text`), `mark()`, `since(mark)`, `reset()`. A second call for the same context returns the same counter |
| `drill.screenshot(page, name)` | A small PNG in the results folder (`drill.shoot`) |
| `drill.writeResults()` | `results-<part>.json` in the P2 format: id, part, title, ranAt, harness, chrome, passed, failed, knownFailures, aborted, checks, notes, screenshots |
| `storeUrl(drill, 'live' \| 'closed', path)`, `storeSql(store, statements)` | An address on either store; a read of either store's database (or `'platform'`) through the running harness's ports |
| `docsApi(page, body)`, `bodyText`, `noThanks`, `settle` | The documents API from a signed-in page, the page's text, the cookie banner's "No thanks", wait for quiet |

The results folder is `docs/cms-reviews/drills/<id>/`: screenshots and `results-<part>.json` together. Everything else from `scripts/drill.js` (`check`, `note`, `open`, `facts`, `atWidths`, `context`) works on a `P3Drill`.

### Running drills on an agent's own ports (P3-FIX2)

Every drill takes its ports from the environment. An agent (or a second checkout) sets all of them to its own range, so nothing it starts meets the owner's harness on 3017 or another run:

| Variable | Used by | Default | What it is |
|---|---|---|---|
| `DESIGN_PORT` | every drill, the harness | 3017 (refused by the P3 drills) | the Next server |
| `DESIGN_SQLD_PORT` | every drill, the harness | 18017 | the first of three database servers in a row (platform, tenant, default; the closed store uses the third) |
| `DRILL_HTTPS_PORT` | `scripts/drills/p2/publish.mjs` | 4806 | the small local HTTPS server the P2 publish drill serves an outside image from. Outside most agents' ranges, so set it |
| `DRILL_SCRATCH` | `scripts/drills/p2/publish.mjs` | `.design-data/p2-drills` | where that HTTPS server's throwaway key and certificate are written |
| `DRILL_TMP` | `scripts/drills/p2/run.mjs` | the system temp folder | where the "path with a space" part copies scripts (a folder named `Projects 2026`); point it at your scratch folder |

For example, on ports 6200 and 7200 to 7209 with a scratch folder `$S`:

```
DESIGN_PORT=6200 DESIGN_SQLD_PORT=7200 DRILL_HTTPS_PORT=7206 DRILL_SCRATCH=$S/p2 DRILL_TMP=$S/tmp node scripts/drills/p2/run.mjs
DESIGN_PORT=6200 DESIGN_SQLD_PORT=7200 node scripts/drills/p3/smoke.mjs
```

**Ports to avoid on the owner's Mac.** 5000 and 7000 are taken by ControlCenter (AirPlay Receiver), and 5037 and 5500 are in use. Node's `fetch` refuses 5060 and 5061 (blocked SIP ports), so a database server there can't be reached and the harness never comes up. A port that is busy shows as a 20-second health timeout or "didn't come up within 3 minutes", which looks like a code failure: check the port first (`lsof -nP -iTCP:<port> -sTCP:LISTEN`).
