# Decisions

Newest first. One entry per choice that someone might later ask "why" about. Entries made
without asking the owner are marked so they are easy to review.

## 2026-11-25 Removing legacy code (on the owner's behalf; scope by the owner)

- **Decision:** no migration and no table changes; the 11 legacy tables stay, and only a short list of read-only helpers may name them (enforced by `test:no-dead-code`). `documents` is the only content mode: any other stored value is a 5xx `STORE_MODE_INVALID`, never a fallback. A media delete whose usage read fails is refused (no legacy scan). The 12 legacy redirect pages plus `/admin/start` and `/admin/setup` are deleted, not moved to config redirects (nothing is hosted, so no outside links exist; supersedes keeping start/setup as redirects). `lib/cms/*` and `lib/registry/legacy.js` keep their names (live code). A manual tool stays only if `package.json` names it (`scripts/real-checks/**` is the one allowlisted owner root). Superseded docs are deleted once their still-true parts move to `docs/operations.md` (`CMS_*.md`, `cms-reviews/**`, `plans/**` stay). Code only tests reach counts as dead. The `publish_release` job handler goes.
- **Open owner question:** single-store env mode (`ADMIN_PASSWORD`, the env database and the commands using it) stays until the owner says where the BeastLife data lives.
- **Why:** owner: "whatever older code or remnants we have remove them, everything should be based on new architecture".
- **Decided by:** owner (scope), Claude (details)
- **Slice:** Phase 1, legacy code removal

## 2026-11-25 An operator creates a store for a founder (on the owner's behalf)

- **Decision (schema and permissions first):** operator-created stores reuse `signups` with `source='operator'` (platform migration `0015`: seven columns, a partial unique index on the live shop domain); the Shopify client secret is held encrypted on that row only until the job finishes; same `provision_store` job, steps and retries as signup. The page and routes are operator-only; the old `POST /api/platform/tenants` "New tenant" form and its one-time password reveal are removed (owner: remove legacy remnants); answers never carry a token or link. Accepting any invite with an existing account now needs that account's password, checked before the invite is spent; new accounts from an invite count as email-verified. A Shopify store already on any store (active or suspended) is refused. The first invite is automatic; resends use line 8's throttled action. Progress is a page with the signup id in the address so a reload keeps it. Custom domains, adopting a database and the legacy editor stay CLI or domains-panel only.
- **Builder's calls:** done operator rows are never pruned (the "Created by Storeasy" badge stays); the optional founder name is stored as `''`; client id and secret share one field-error key `app` (no answer key contains "secret"); a new account's password is checked before the token is spent (the 8-character rule moved into `acceptInvite`); a resend for an operator-made store uses the operator invite wording; a re-run job never sends a second invite; if the automatic invite throws, the store is still done with "Invite not sent"; the client secret is scrubbed from provision step errors.
- **Review fixes and accepted risk:** accepting an invite with an existing account counts against the same lockout as sign-in and refuses turned-off accounts; operators can cancel a Storeasy-created setup that isn't running (frees the address and shop, deletes the stored secret, audited); someone holding a live invite can reset their password from that store. Accepted: the accept-invite page tells whoever holds the invite link whether that email already has an account (only the invitee and the inviting admin hold it).
- **Why:** owner: one onboarding for every way a store starts; operators help without seeing credentials.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 1, operator creates a store

## 2026-11-24 Phase 1 lines 4–8: decisions taken from the plans (on the owner's behalf)

Schema and permission decisions first; full detail in `docs/plans/phase-1.md` lines 4–8.

- **Line 5 (schema):** tenant migration `0028` adds `collections_total`, `skipped_count` and `skipped` (JSON, at most 50) to `sync_runs`; no stage or error-kind column (stage is `phase`; the failure kind is worked out from the error). A product or collection that can't be mapped is skipped and listed, not fatal; a run with skips is complete; a skipped product already in the store keeps its last good copy. Sync code still works on stores without 0028.
- **Line 8 (schema):** platform migration `0014` adds `onboarding_progress` (an operator-only cache refreshed by a 10-minute sweep and on opening a store; the founder page stays live), append-only `operator_notes`, and `released_at`/`released_by` on `signups` (status `released` frees a lapsed address; the app checks the database is gone but never deletes one).
- **Line 4 (schema/permissions):** no migration; new keys in the encrypted tenant JSON for expiring Shopify tokens (`shopify_refresh_token`, expiry times, `reauth_needed_at`, `connected_by`). Authorization code grant with expiring offline tokens and refresh (Shopify requires them for apps from 2026-12-01). Founder routes under `app/api/admin/shopify/` need `settings.write`; state is HMAC-signed and bound to the store, the session and a nonce cookie. A shop another active store already holds can't be connected. One Shopify app per store; the domain locks once the app is set up. The test stand-in is loopback-only via `SHOPIFY_API_ORIGIN`, refused in production.
- **Line 4 builder's calls:** the domain also locks once `shopify_connected_at` is set; operator OAuth states are now `op|tenant|nonce|exp` (old unmarked states refused); state expiry is checked before session and nonce (a late return reads "expired"); once Shopify asks for a reconnect, no fallback to the client-credentials token; if the link breaks but products are in, step 1 stays Done with the problem and a reconnect; revoking the Shopify integration also clears the refresh token and expiry keys.
- **Line 8 (permissions):** operator-only screen; audit rows carry the real operator id (`platformOperator()`); help goes by email to addresses on file only — operators never see a token or link, and the old handoff route that showed invite links is removed. At most 5 help emails per store per hour.
- **Line 8 builder's calls:** migration 0014 also adds `onboarding_progress.step_since_exact` (so a stuck time can say "at least"); `onboarding_sweep` is a long job run only by budgeted callers; "Needs attention" = a failed, not-lapsed signup (any age), a signup setting up past the stuck threshold, or an active closed store with a problem or past the threshold (the stuck filter applies only to this view); a pending signup past expiry shows as expired; owner invites go to the latest signup's email and refuse with none on file; help mails go through `platform_mail` (in local runs the reset link sits in the stored mock body); the old bootstrap-password rotate action went with the removed handoff route; Badge gained five status tones.
- **Line 7:** step 4 drives the editor's own publish flow (one publish path, no new route); cash on delivery turns on through the existing settings call; Razorpay keys are only entered in Settings (with a "Back to onboarding" link); inline policy reader with "I've read it" after the text; inline contact form only while both support fields are empty.
- **Line 7 builder's calls:** `FIX_HREFS` lives in `lib/onboarding/open-step.js` (re-exported by `opening.js`); new action `policy_view` (`storefront.read`) is the only step-4 action support has; when anything blocks, Open is not allowed with "Fix the items marked “Needed” first." (role reasons first); step 4 lists the home line first, then every opening item including the fine ones; a store with no design draft gets one more confirm (the editor's existing behaviour).
- **Line 6:** the live preview is the existing preview session plus an overlay message to the frame (ids only, frame computes the CSS, logo must be a library URL, plain-text description; accepted only from a working same-origin preview); no autosave — Save and Skip as today, unsaved choices in `sessionStorage`; step 3 alone gets a wider layout; FirstRun and BrandStep retire.
- **Line 5 review fix:** migration 0028 gains a fourth column, `sync_runs.no_prune`: when Shopify sends a node with no usable id, that run skips the prune (logged `sync_prune_held`) and the next clean run prunes; a store without 0028 fails that page as before rather than risk deleting a product.
- **Line 5 builder's calls:** a skipped product already in the store keeps its last copy, except when the cause is a shared web address; onboarding now offers Try again on a finished import whose refresh failed (before, a failed refresh couldn't be retried from onboarding); failure text is built on the server, the browser adds the local "next try at" time; the test fixture gains a `0027` stage that `test-schema-compat` checks.
- **Line 6 review fix:** one preview frame is moved between the side column and a hand-built, non-modal bottom sheet by CSS (Esc and a close button close it; no focus trap since the page stays usable), so crossing 1024px never mints a second preview session; the shadcn Sheet is not used for it.
- **Line 6 builder's calls:** the frame message gains `logo: false` (no picture, show the store name; `null` still means "as rendered"); store name and address reach the panel via a `store` prop on `Onboarding`; read-only roles now see Save, Skip and logo buttons disabled with the reason (the old screen hid them); `SheetContent` passes `forceMount` through and the phone preview sheet is non-modal so it can stay mounted; "Change colours and logo" is a button that scrolls to the form; the footer logo gets the same preview slots as the header.
- **Line 5 (UI):** new `ImportStep` on the new UI; time left is a rough estimate shown only under strict conditions; the old `SyncProgress` stays for the dashboard and Settings until Phase 2.
- **New `components/ui` copies** (Progress, Dialog, RadioGroup, Label, Table, Badge, Textarea, AlertDialog) come from the installed `radix-ui`; no new dependency.
- **Decided by:** Claude, on the owner's behalf

## 2026-11-24 Remove legacy remnants; shared Shopify app later

- **Decision:** everything runs on the new architecture. A Phase 1 line removes every legacy remnant the new code no longer uses (retired modules, routes, screens, components, drills, scripts, docs), including the old operator handoff route that shows invite links to operators, with a test that fails on any unreferenced file. Legacy database tables stay untouched (dropping them would delete data and can't be undone). Old console screens are removed by Phase 2's last line as each is rebuilt. The shared Storeasy Shopify app is a later item; line 4 builds one app per store.
- **Why:** owner: "whatever older code or remnants we have remove them, everything should be based on new architecture"; "shared app later".
- **Decided by:** owner (tables kept and scheduling on the owner's behalf)
- **Slice:** Phase 1 cleanup line; Phase 2 last line

## 2026-11-24 Parallel slices and three heavy-job slots

- **Decision:** up to five slices are built at once, each in its own worktree under `../storeasy26-wt/`, merged into `main` one at a time by the session. Heavy commands (full suites, builds, browser drills) run through `~/.claude/bin/heavy`, which allows three at once on this Mac (15 cores, 24 GB) instead of one. The main checkout stays on `main` so the owner's own server always runs finished code.
- **Why:** owner: "too slow"; the single slot made parallel builders queue for hours.
- **Instead of:** one heavy job at a time (the earlier rule); five at once (risks memory pressure with five browser drills).
- **Decided by:** owner (3 slots); worktree layout on the owner's behalf
- **Slice:** build process

## 2026-11-24 Browser drills run without Turbopack's saved dev cache (on the owner's behalf)

- **Decision:** every drill sets `STOREASY_TURBOPACK_DEV_CACHE=off`, which turns off Next's `turbopackFileSystemCacheForDev` for that run only (`next.config.mjs`). The owner's own `pnpm dev:design` keeps the cache.
- **Why:** when a harness restarted from the saved cache, the new dev server sometimes came up with most of its routes missing (sign-in, dashboard, signup, health all 404) for its whole life: the "sign-in page didn't show" flake, about 4 stages in 45. With the cache off, 54 stages in a row passed, at the same drill time. It was a timing race inside Turbopack's cache restore, not a corrupt file.
- **Instead of:** retrying the sign-in; deleting `.next` before every start.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 1 tooling (drill reliability)

## 2026-11-24 The four-step onboarding page (on the owner's behalf)

- **Decision:**
  - No migration and nothing stored: each step's state is worked out from the store's real state every time (connection, sync runs, home page and brand, opening checks, live release); the page opens on the first step not done, or on `?step=`. A check that fails to read leaves the step not done rather than guessing.
  - Four states: done, in progress, to do, blocked (a failure shows as a problem on a "to do" step), since a step ready to start fits none of the line's three words.
  - Opening is not gated on steps 1–3: only today's opening checks block it, so no new rule appears.
  - "Onboarding" replaces both "Setup" and "Logo and colours" in the nav, for every role, with an `n/4` badge only while the store is closed (logo and colours stay in step 3 afterwards).
  - The Shopify shop domain shows only to roles with settings access. `/api/admin/setup` becomes `/api/admin/onboarding` (the test-order mark moves there; the "preview" and "launch" check-offs retire, old values left in place). `/admin/start` and `/admin/setup` redirect to the new page, and `/admin` sends a closed store to onboarding, so signup, operator-created and existing closed stores all land on the same page.
  - The current starter-store and brand panels are reused inside the old-look wrapper until line 6 rebuilds them.
  - Builder's calls (UI): a disabled control shows its reason as visible text under it (tooltips don't show on disabled buttons); each finished step ends with one "Next: <step>" button; the Open step sends the founder to Publish in the editor until line 7; opening a closed store's onboarding makes the starter store automatically once Brand is the current step; p6 gains seed stage `h` (a support member and saved policy pages); `test-copy.js` skips `lib/onboarding` like `lib/admin` (founder-facing console wording, not shopper copy).
- **Why:** owner: onboarding was chaotic across several screens; one page, from real state, can't drift.
- **Instead of:** a stored step pointer; a new rule that blocks opening until steps 1–3 are done.
- **Decided by:** Claude, on the owner's behalf (one onboarding page by the owner)
- **Slice:** Phase 1, onboarding page

## 2026-11-24 Signup creates the store's Turso database in a job (on the owner's behalf)

- **Decision (schema first):**
  - Migration `platform/0012` adds job, try-count, failure-kind and handoff columns to `signups` (nothing destructive). One `provision_store` job per signup.
  - Verify queues the job and returns at once; the waiting page polls a status route (a POST, same-origin, bound to the signup cookie) that also runs the founder's own job when it's due, so the founder never waits on the one-minute scheduler. The scheduled tick stays as the backstop.
  - Retries are short and counted by the handler (5 s, 15 s, 45 s, 2 min, 5 min; 5 tries) for timeouts, 5xx and 429; auth, payment, quota and bad-request answers stop at once as "needs an operator" with an alert. Try again resumes the same run and never creates a second database.
  - A database name that already exists is adopted only if this run asked to create it; otherwise an operator looks. Schema work uses 1-hour tokens; one never-expiring token is stored encrypted. Turso's "invalidate tokens" call is not used (outside AWS it may reach other databases' tokens).
  - The handoff token is made when a poll first sees the store is ready (at most one live), not inside the job.
  - Signup uses Turso's HTTP API when configured, a local file database outside production otherwise, and is unavailable in production without it. `TURSO_API_URL` must be the real address in production and a loopback address anywhere else.
  - Tests and drills use a local fake of Turso's API (one local database server per store, so the new store's storefront renders locally). The only path to real Turso is `pnpm check:turso-real`, which refuses unless the owner sets an explicit confirmation and flag; nobody runs it but the owner.
- **Why:** owner: onboarding must be simple and reliable; real databases cost money, so nothing creates one without the owner.
- **Instead of:** provisioning inline in the verify request; the queue's 60-second backoff; the `turso` CLI.
- **Accepted risk:** a crash between minting the long token and saving the store leaves one unused token on that database.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 1, Turso provisioning

## 2026-11-24 Self-serve signup (on the owner's behalf)

- **Decision (schema first):**
  - A new `signups` table holds pending signups; the user and the store are created only after the email is verified. A new `platform_mail` table records platform emails (signup codes); the email body is kept only when mail is mocked locally, so codes are never stored in production. `users.email_verified_at` is added (existing users stay empty). Migration `platform/0011`, nothing destructive.
  - Signup is anonymous, on the Storeasy marketing host only (`/signup`); verification is a 6-digit emailed code (15 minutes, 5 tries, resend once a minute up to 5 times) entered in the same tab, bound to a browser cookie so nobody can guess or burn someone else's signup.
  - An email that already has an account gets an identical response and a "sign in instead" email (no enumeration); adding a second store to an existing account comes later.
  - After verification a single-use, 2-minute handoff token (in the URL fragment, never in logs) signs the founder into their new store's console at `/admin/onboarding`, the page line 3 grows into the four steps.
  - Stores live at `<slug>.<SIGNUP_STORE_DOMAIN>`; the slug becomes the store id. The database is created behind `lib/platform/provisioner.js` with a `file` driver (refused in production) that line 2 swaps for Turso; existing provisioning keeps using Turso.
  - Signup is off until an operator turns on the flag `ff_self-signup` (the flag-key rule allows no underscore after `ff_`).
- **Why:** the owner wants onboarding simple; verify-before-create keeps fake signups from making stores.
- **Instead of:** creating an unverified user and store at once; a verification link (can open in another browser); a shared parent-domain cookie (breaks custom domains).
- **Builder's calls (WP-B):** the console shell gains an onboarding mode (no sidebar, one 640px column, top bar and Sign out kept) for `/admin/onboarding`; the support-reads leak sweep allows a member's own email on their own page (the Welcome page shows it) and still fails on anyone else's; after an operator turns the flag on, `/signup` and pricing can show "closed" for up to 30 seconds (each page caches flags).
- **Accepted risk:** an attacker could send their own handoff link and sign someone into the attacker's empty new store; the token lasts 2 minutes and works once.
- **Decided by:** Claude, on the owner's behalf (scope by the owner)
- **Slice:** Phase 1, self-serve signup

## 2026-11-24 Phase 0 audit: job secret and health details (on the owner's behalf)

- **Decision:** the job secret (`CRON_SECRET`) fails closed in production: without it, `/api/jobs/*`, `/api/health?all=1` and `/api/connect/shopify/start` refuse everyone (local development stays open). Signed-out `/api/health` answers only `{status, at}` with the same status code; pending orders, error counts, configured integrations and dependency errors need the job secret.
- **Why:** the Phase 0 least-trusted audit found any visitor could read a store's order backlog and error counts from `/api/health`, and that every job route ran for anyone when the secret was unset, even in production.
- **Instead of:** leaving the details public for uptime monitors (they only need the status code).
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0 end audit (`docs/cms-reviews/PHASE-0-AUDIT.md`)

## 2026-11-24 The new console shell (on the owner's behalf)

- **Decision:**
  - No schema changes. The shell reads only the caller's own name and email and their own store memberships, on the server; the full user row never reaches the browser.
  - The nav has one source of truth, `lib/admin/nav.js`: one read action per item, filtered on the server by role. A section the role can't open is hidden, not shown disabled. Setup stays admin-only in the nav (it needs settings access), as today. Owner and admin see 16 sections; staff and support see 11.
  - For this line, "support sees no write actions" covers the shell itself (sidebar, top bar, switcher, account menu) and the nav. The write buttons inside each existing screen become read-only for support with that screen's Phase 2 line; the shell drill lists which ones support can still see.
  - Old screens keep their exact look inside the new frame through a temporary `data-legacy` wrapper that restores their colours, instead of renaming tokens across about 60 files; Phase 2 removes it. One deliberate change: the editor preview sits lower so it clears the new sticky top bar.
  - The store switcher is a dropdown built on the server (shared with `/api/admin/stores`), always shown, and switching opens the other store's own address. Notice banners move into the shell's content area; the sidebar's open/closed state is a cookie read on the server.
  - The console's own page frame (`<body>` on every console page, including the sign-in pages) now uses the console colours: the page background turns from white to the warm paper of `docs/UI.md`. Old screen content keeps its look; the storefront is untouched. So the storefront comparison treats `/admin/login`'s `<body>` as console frame, not storefront.
  - Builder's calls: the `data-legacy` wrapper also restores the old line height and text colour; the base border rule uses plain descendant selectors (a pseudo-element inside `:is()` makes browsers drop the rule); the style capture looks through the wrapper; the switcher keeps the port from a store's own address on local harnesses; the drill-only "Roles Annex" store lives on the roles harness's third database.
  - The old-screen comparison (`drill:console-styles`) ignores these computed values inside `[data-legacy]`, because the content column is wider in the new frame and each is a resolved px value that follows that width or the frame's geometry, not the old screens' styles: `width`, `height`, `inline-size`, `block-size`, `top`, `right`, `bottom`, `left`, the logical `inset-block-start`/`-end` and `inset-inline-start`/`-end`, `transform-origin`, `perspective-origin`, `grid-template-columns`, `grid-template-rows` (fr and auto tracks resolve to px), and `margin-left`, `margin-right`, `margin-inline-start`, `margin-inline-end` (mx-auto resolves to px). Box sizes are reported, not failed. Because `top` is ignored, a targeted check (`topShiftCheck`) on the owner's editor at 1280 proves the one intended move: the sticky preview's `top` goes from 16px to 72px, and no other sticky, fixed or absolute element's `top` changes.
  - The store switcher always ticks the store you are in: when your store list does not mark it, it is added as the ticked row rather than ticking the first store. The local-harness check for console links matches only `localhost`, `127.0.0.1` and `*.localhost` hostnames, so a public host such as `shop-localhost.com` gets https and no borrowed port.
  - The old `cmsMode` prop goes (documents is the only mode). New drills: `drill:shell` joins `pnpm drill:all`; `drill:console-styles` is a comparison tool outside it; the switcher test uses a drill-only second store.
- **Why:** one frame for every screen now, so Phase 2 can rebuild screens one by one without changing how they look before their turn.
- **Instead of:** disabled nav items with reasons; renaming the old tokens; rebuilding screens in this line.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, console shell

## 2026-11-24 How shadcn/ui is set up for the consoles (on the owner's behalf)

- **Decision:**
  - One Tailwind pipeline: all shadcn console CSS goes in `app/console.css` (already imported by `globals.css`); every new rule is scoped to `.console`, the theme only adds names the storefront never uses, and there are no unscoped base rules. `--color-primary`/`--color-ring` go through `--primary`/`--ring`, with `[data-console]` keeping the legacy console's values.
  - `.console` goes on the console `<body>` (so menus and sheets rendered outside the page tree get the tokens); line 8 applies it. Dark mode is class-based (`.console.dark`) and storefront files may not use `dark:`.
  - No shadcn radius scale: 6px controls are `rounded-md`, 10px surfaces `rounded-card`.
  - The shadcn CLI runs only in a scratch project (`pnpm dlx shadcn@4.23.0`), because it writes global `:root` variables; components are copied in as plain `.js`, restyled, with `components.json` committed as the record. Radix primitives (`radix-ui`), `cn` in `components/ui/utils.js`.
  - Only what this line and the console shell need is installed now, pinned exactly: `radix-ui` 1.8.1, `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `tw-animate-css` 1.4.0. Sonner, react-hook-form, zod, `@hookform/resolvers` and `cmdk` come with their lines. The store switcher uses a dropdown menu; the ⌘K command menu comes later.
  - `tailwind-merge` is pinned to 3.7.0, not 3.7.1 (3.7.1 was too new). shadcn 4.23's own `cn` package and `shadcn/tailwind.css` variants are not used; components use our `cn` and plain `data-[state=open]:` forms.
  - "Storefront unchanged" means: zero changes to any element's computed style or size, and no existing CSS variable changes value. New variable names (from `tw-animate-css` and the console theme) are allowed and listed. Production storefront CSS grew about 6 KB compressed (15.3 → 21.7 KB), measured 2026-11-24. Screenshots are reported but never fail the comparison (two baseline runs already differ by one screenshot). The comparison does not cover hover or focus states, dark colour scheme, animation and transition settings (frozen for stable captures), or the checkout, account and search pages; the unit test guards the animation side by refusing tw-animate and Tailwind animation utilities in storefront files.
  - The proof that the storefront is unchanged is a before/after capture of every element's computed styles and size on storefront pages at three widths (screenshots as a second signal), with a repeatability check and a check that a deliberate change is caught.
- **Why:** shadcn's default setup writes global variables and base styles that would change the storefront, which must keep each store's own brand design.
- **Instead of:** a separate console stylesheet now (possible later if the storefront CSS grows too much); running the shadcn CLI in the repo; installing every component up front.
- **Decided by:** Claude, on the owner's behalf (shadcn itself by the owner)
- **Slice:** Phase 0, shadcn setup

## 2026-11-24 Browser drills run only in a throwaway copy of the code (on the owner's behalf)

- **Decision:**
  - Every browser drill runs in a temporary git worktree of the last commit, with its own data folders, ports (from 6100/7100, never 3017/3018 or their database ports) and no `.env.local`. A guard refuses to run a drill in the main checkout, the runner refuses if there are uncommitted code changes, and it checks the owner's seed files are byte-identical afterwards. Busy ports are skipped, never freed.
  - Drills that tested the retired legacy CMS, the cutover and the agency programme are deleted (p1, p1c, p2, p3 and p4 except their shared libraries, `harness-edge.js`, the legacy stages of p5 and p6); git history keeps them. The kept suite is smoke, p5, p6 and agency-gone (`pnpm drill:all`).
  - A closed store never answers an `/api/*` request with its "Opening soon" page: an unknown API path answers 404 in JSON whatever the store's state, and real API routes keep their own behaviour (found because the agency-gone drill saw 200 everywhere on a closed store).
  - Drill results go to a gitignored `.drill-results/`; the old review packets in `docs/cms-reviews/drills/` stay as they are.
- **Why:** the drill seeds wipe `.design-data/`, and Next 16.2 refuses a second dev server in the same folder, so a separate data folder alone doesn't work.
- **Instead of:** a data-folder option only; a custom Next build folder (it rewrites `tsconfig.json`); keeping the legacy drills unrun.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, browser drills

## 2026-11-24 The all-roles seed is its own local store (on the owner's behalf)

- **Decision:**
  - `pnpm seed:roles` builds a separate local store, `roles.localhost` on port 3018, with its own data folder (`.design-data-roles/`) and database servers. It never touches `.design-data/`, and refuses if a roles store already exists; `--reset` deletes only its own folder and needs the owner's OK.
  - The operator is pre-enrolled for the authenticator; passwords (new random ones each seed), the authenticator secret and link go only into a private file (`.design-data-roles/roles-seed.json`, owner-only permissions, gitignored), never to the screen.
  - The store stays closed: the seed publishes nothing (drafts only, legal text never auto-published). The shopper's order goes through the real order code with totals computed on the server; the shopper is `shopper@roles.test`, not the real test-order address.
  - `pnpm roles:code` prints the shopper's latest sign-in code from the local database, since there is no mail provider locally.
  - The seed writes one audit row with actor kind `cli`.
- **Why:** `pnpm seed:design` wipes `.design-data/`, so a store kept there would be lost; separate host and port keep console cookies apart.
- **Instead of:** adding roles to the existing design store (changes the owner's data); reusing the test fixtures, which mint sessions directly and delete files.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, all-roles seed

## 2026-11-24 How the agency programme is removed (on the owner's behalf)

- **Decision:**
  - The agency tables stay, unused, with no migration (`0010_agency.sql` also creates `case_studies`, and migrations never drop anything).
  - Existing agency sessions, invites and rows are left in place, not revoked or deleted; nothing reads them any more, and tests prove they can't sign in or act.
  - Case studies (the marketing `/customers` pages) stay; their editor moves out of the Partners panel to an operator "Case studies" tab with its own route and suite, and saving or deleting one is now audited (only publishing was).
  - Editing a published case study takes it back to draft, so it must pass the consent and measurement checks again before it is live; deleting a case study stays a permanent delete (it is operator-owned marketing content, not a CMS document) and is audited.
  - The `agency` route class leaves the guard tables; the registry's `agency_kit` hero fixture is renamed `full_hero`; the retired p1/p4 drills are left as they are and allowlisted.
- **Why:** owner's instruction to drop agencies; case studies are marketing, not agency features.
- **Instead of:** a drop migration or a data cleanup script (destructive); removing case studies with the Partners panel.
- **Decided by:** Claude, on the owner's behalf (scope by the owner)
- **Slice:** Phase 0, agency removal

## 2026-11-24 Shopper reads: own data only (on the owner's behalf)

- **Decision:**
  - A checkout retry with the same idempotency key returns the earlier order only to the cart (cookie) that placed it; any other caller gets 409 with no order details. No cart cookie, no retry lookup.
  - Order links and shopper hashes fail closed in production when the store has no secret of its own (no shared `dev-only-secret` fallback outside local development). The Razorpay key secret stays as a fallback for now.
  - Signed-out `GET /api/account` keeps answering 200 `{authenticated:false}`.
  - Asking for too many sign-in codes answers the same "sent" message as normal and sends nothing.
  - Checkout errors to shoppers use plain words, never the raw error.
  - Orders still attach to whoever verifies the email typed at checkout (as designed in S45); the risk is accepted and recorded here.
  - Shoppers get no permission module: their identity comes only from the shopper session cookie and the cart cookie, and every non-admin route and storefront page must be classified in the test or it fails.
- **Why:** the shopper-reads audit found that knowing a checkout's idempotency key was enough to get another shopper's order and a link showing their address and phone.
- **Instead of:** keeping key-only retry lookup; keeping the public fallback secret.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, shopper reads

## 2026-11-24 What support and staff may see in admin reads (on the owner's behalf)

- **Decision:**
  - Team members appear by name only, never by email; a member with no name shows as "Someone on your team" (for every role).
  - Support searches orders by order id only (no email/phone matching), and the orders page redacts customer details the same way the API does.
  - `cart_id` and `idempotency_key` never leave the server in admin order reads, for any role.
  - The Settings, Integrations and Automations pages load nothing unless the role has `settings.read`; staff lose them too, as the matrix says.
  - Values already public on the storefront (Shopify store domain, Razorpay key id, support email, shipping rates) and yes/no flags derived from settings are fine for support.
  - Support may create and use its own preview links, never act on anyone else's; acting on someone else's link answers 404 (not 410), so it doesn't reveal that the link exists.
  - For roles that don't see customer details, order reads also drop `customer_id`; support keeps the Razorpay order and payment ids and the coupon code, which support work needs.
- **Why:** the support-reads audit found customer details on the orders page, settings data on three pages, member emails in edit history, an email/phone search oracle, and the cart cookie value in order reads.
- **Instead of:** hiding fields only in the UI.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, support reads

## 2026-11-24 How support reads are tested (on the owner's behalf)

- **Decision:** a separate suite `test:support-reads`; leaks found by searching raw responses for seeded canary strings, with owner positive controls; callers are every role without `settings.read`; each readable route lists its allowed top-level keys; console pages are checked by compiling them with prop-recording stubs, not a browser.
- **Why:** `test:permissions` is near the per-suite time limit; canaries catch leaks under any field name.
- **Instead of:** extending `test:permissions`; per-field assertions only.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, support reads

## 2026-11-24 Changing or removing an owner needs team.owner (on the owner's behalf)

- **Decision:** in `/api/admin/team`, changing the role of, or removing, a member who is currently an owner requires `team.owner`; `team.manage` covers everyone else.
- **Why:** an admin could demote or remove an owner as long as another owner remained; the matrix says granting or transferring ownership is owner-only.
- **Instead of:** keeping `team.manage` plus the last-owner guard.
- **Decided by:** Claude, on the owner's behalf (architect finding F1)
- **Slice:** Phase 0, permission harness

## 2026-11-24 Same-origin check on every non-GET request (on the owner's behalf)

- **Decision:** `requireAdmin` checks the Origin on every request whose method is not GET/HEAD, read actions included. A request object with no method keeps today's behaviour.
- **Why:** preview-session create/revoke, release preview and the integration test call run under `.read` actions and so skipped the CSRF check.
- **Instead of:** moving those operations to new `.write` actions, which would stop support from previewing.
- **Decided by:** Claude, on the owner's behalf (architect finding F2)
- **Slice:** Phase 0, permission harness

## 2026-11-24 How the permission harness is built (on the owner's behalf)

- **Decision:** a hand-declared route table (`scripts/support/admin-routes.js`) with expected results derived from `roleAllows`; `ACTIONS` exported from `authz.js`; the guard walks the filesystem so untracked routes fail too; "allowed" means not 401/403 (response bodies are line 2's job); auth pages (login, logout, accept-invite, reset, recover, maintenance-pass) are exempt with their own tested rules; support members keep a maintenance curtain pass; a new suite `test:permissions`. Staff and support cannot open Help (it needs `settings.read`) — recorded, not changed.
- **Why:** body-selected actions and handlers in `lib/admin/*` cannot be found by parsing route files alone.
- **Instead of:** deriving actions from source only; git-only guard; growing `test-authz.js`.
- **Decided by:** Claude, on the owner's behalf
- **Slice:** Phase 0, permission harness

## 2026-11-24 Remove the agency partner programme

- **Decision:** drop agencies entirely: routes, screens, links and the suite go; the tables stay unused (migrations are additive).
- **Why:** owner's instruction.
- **Instead of:** keeping it dormant behind a flag, which would be better if agencies might return within a year.
- **Decided by:** owner
- **Slice:** Phase 0, "The agency partner programme is gone"

## 2026-11-24 One onboarding for every way a store starts

- **Decision:** self-serve signup, operator-created stores and the first run all lead into one four-step onboarding page (Connect Shopify, Import products, Brand, Open your store) that replaces `/admin/start` and the setup checklist.
- **Why:** owner: onboarding is "too chaotic" across merchant first run, operator provisioning and signup.
- **Instead of:** polishing each of today's screens separately.
- **Decided by:** owner (scope); the four-step shape on the owner's behalf
- **Slice:** Phase 1

## 2026-11-24 shadcn/ui for the consoles only, built before the roadmap

- **Decision:** rebuild the merchant and operator consoles on shadcn/ui (copied into `components/ui/`, Radix primitives, restyled with `docs/UI.md` tokens), screen by screen on the existing backend. The storefront keeps its brand-token design. New dependencies this brings: `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `sonner`, `react-hook-form`, `zod` (all needed by the shadcn components themselves).
- **Why:** owner asked for shadcn and a better UI; the storefront shows each store's brand, not Storeasy's.
- **Instead of:** a fresh rewrite (loses 80 passing suites as a safety net) or shadcn on the storefront too.
- **Decided by:** owner
- **Slice:** Phase 0 shadcn line; Phases 2–3

## 2026-11-24 Console sidebar: per-console cookie, shortcut skips typing

- **Decision:** the shadcn sidebar's `sidebar_state` cookie is `path=/admin; SameSite=Lax` by default; `SidebarProvider` takes `cookiePath` (the operator console passes `/platform`). Cmd/Ctrl+B is ignored when the key event's target is an input, textarea, select or contenteditable (`isSidebarShortcut`).
- **Why:** shadcn's `path=/` sent the cookie with every storefront request and shared one state between the two consoles; its global Cmd+B stole bold from the rich text editor.
- **Instead of:** dropping the shortcut, or one cookie for both consoles.
- **Decided by:** reviewer finding, fixed by the builder
- **Slice:** Phase 0 shadcn line

## 2026-11-24 Antigravity roadmap (Phases 2A–6) after the UI and onboarding

- **Decision:** the roadmap in `docs/CLAUDE_CODE_HANDOFF_PHASES_2_TO_6.md` becomes Phases 4–9 here, in its own order, written as end-to-end slices.
- **Why:** owner's choice; the plugin and theme engines build on a stable console.
- **Instead of:** its original order (plugin SDK first, console overhaul in its Phase 3).
- **Decided by:** owner
- **Slice:** Phases 4–9

## 2026-11-24 Least-trusted roles: support and the anonymous shopper

- **Decision:** `support` (read-only member) is the least-trusted console role; the signed-out shopper is the least-trusted storefront role. Each gets a test on every new read.
- **Why:** they are the lowest rungs of the existing role table (`lib/platform/authz.js`).
- **Instead of:** —
- **Decided by:** owner confirmed the role list
- **Slice:** Phase 0

## Recorded after the fact (choices already in the code, 2026-11-24)

- **One database per store plus a control-plane database (libSQL/Turso, Kysely, numbered SQL migrations).** Store isolation by database, store chosen by request host. Decided before adoption.
- **Next.js App Router with Edge storefront routes; JavaScript with incremental TypeScript, pinned to TypeScript 5.9.x.** Next 16.2.9 build workers crash on TS 7.
- **Own auth:** member sessions with a role per store, operator sessions with TOTP, shopper email OTP; permissions as `<area>.<verb>` strings in `lib/platform/authz.js`.
- **Documents CMS is the only content engine** (legacy CMS retired in 0026); drafts, versions, releases, publish and undo; generators and AI write drafts only.
- **Shopify is read-only for content;** only allowlisted order calls go to Shopify.
- **Tests are Node scripts run by `scripts/run-tests.js`; browser drills use playwright-core on a local harness.** No test framework dependency.
- **Drill runner warm-up for the next/font/google build error (2026-11-24).** In the throwaway worktree every harness shares one `.next`, and Next 16.2.9 keeps the Turbopack dev build in `.next/cache` across restarts (`turbopackFileSystemCacheForDev` defaults on). When a boot hits "Can't resolve '@vercel/turbopack-next/internal/font/google/font'", every later harness on that `.next` serves 500s. `run-isolated.mjs` now boots the worktree's design harness before each drill (and after a failed one), loads `/` and `/admin/login`, and on that error stops its own harness, deletes `.next` and boots again (up to 2 times), then stops the run with "Google Fonts could not be fetched; check the network"; a drill that failed on such a build reruns once. Chosen over `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`: it is an undocumented test hook needing exact URL keys, and it would change what the drills render. No app change.
- **Signup UI polish (2026-11-24, ui-designer).** The signup handoff page moves from `admin/(auth)/` to its own `admin/(handoff)/` route group (same `/admin/handoff` path) with a non-legacy layout: it is new UI, and inside the old sign-in pages' `data-legacy` region its shadcn Button drew in the old black. Its frame is the signup's centred 640px column with the store's name; it shows no console notices (the Welcome page a moment later does). The signup form is one column in two groups (About you, Your store) rather than two columns, the password rules show up front and tick as they are met, and the store address has its own preview panel with the availability check; the code stays one numeric field (paste keeps only digits) rather than six boxes, so autofill and paste work everywhere. After an empty or invalid submit, focus moves to the first field to fix and the summary banner is dropped (each field says what to fix).
  - **Decided by:** ui-designer, on the owner's "too chaotic" note
  - **Slice:** Phase 1 line 1
- **Signup review fixes (2026-11-24).** (1) `existing` holds its address like `pending` (code list and migration 0011's partial unique index, edited in place: 0011 is not on main), so an address answers the same whichever email is behind it. (3) A daily cap of 10 failed code tries per email across all its signups, counted in `login_limits` (key `signup-codefail:<email>`, read without counting); past it, start, resend and verify give the normal answers (start still makes the row and cookie) but no code is stored and nothing is sent. (4) In production, `lib/mail.js` never mocks: an unconfigured send fails and prints only the subject; `signupClosedAnswer` closes signups when `NODE_ENV=production` and mail is not configured; `platform_mail.body` is written only after the send comes back as a mock. Side effect: invitations and password resets in an unconfigured production now fail instead of logging their links. (5) Pruning deletes only `done`/`expired`/`superseded` rows older than 7 days; `failed`/`verified`/`provisioning` rows stay for operators. The file driver refuses an existing database file unless the resuming run passes the `file:` URL it recorded in its refs (`createStoreDatabase(slug, driver, { resumeUrl })`); a crash after a file was written but before the run saved its refs fails closed. (6) A `failed`/`verified`/`provisioning` signup keeps its password hash until 24 hours past `expires_at` (Try again needs it to make the user); after that the hash is cleared on the next signup start and Try again answers "This signup has lapsed. Start again." (7) Addresses refuse `--` anywhere (so `xn--`), and login, billing, support, security, account(s), checkout, cdn, assets, static, docs, blog, shop, store(s) are reserved. (8) Availability is one query (tenant id, the `domains` registry, `json_each` over `tenants.domains`) instead of reading every tenant into Node; new indexes on `signups(created_at)` and `signups(status, expires_at)`.
  - **Decided by:** feature-builder, on the Line 1 review
  - **Slice:** Phase 1 line 1
- **Signup waiting page and drill (2026-11-24, line 2 WP-B).** The waiting page polls `/api/signup/status` one request at a time: every 1.5 s, every 15 s while the tab is hidden, and at once when it is shown again; a lost connection, 429 or 5xx keeps polling with "We lost touch with Storeasy for a moment. Still checking…" (the store keeps being made on our side). The four steps are a plain list with the step being worked on and the retry note in one `aria-live="polite"` area. A failed signup shows the server's words; needs-operator gets the heading "Your store is waiting on us", the others "We couldn't finish setting up your store"; both keep the step list with the stopped step marked. `done` follows `redirect`, else `loginUrl`; done with neither polls again. The operator panel shows a "Self-serve signup" badge and the failure kind in words. The drill runs the main founder through two 503s on create (retry note, then done) instead of a separate clean signup, so one founder covers the happy path and the retry; a second founder covers 402 → Try again.
  - **Decided by:** feature-builder
  - **Slice:** Phase 1 line 2
- **Signup provisioning review fixes (2026-11-24, line 2).** (1) `refs.dbCreateRequestedAt` now marks a create ask whose outcome is unknown: it is saved before each ask and kept only after a timeout, a network error or a 5xx; a clear 4xx (409 and 429 included) restores the earlier value. A 409 is adopted only when an earlier ask's outcome was unknown, so someone else's database stays "needs us" on every Try again. (2) On a loopback API address `dbUrlFor` returns only the fake's loopback `localUrl` and throws otherwise (no `libsql://` fallback); on the real address a reply without `Hostname` throws. (3) The real check's body moved to `scripts/support/turso-real-check-run.js` (the gates stay in the script) so the suite runs it against the fake; the database counts as asked for before the create call, and after any failure it is deleted, even with `--keep` (a 404 on delete is fine). (4) Schema: migration 0013 adds `signups.alerted_kinds` (",kind," entries); the needs-us alert goes once per signup per kind, never again on Try again. (5) Leases: `renewJobLease(job)` in `lib/platform/jobs.js` renews only while `lease_until` is still the value the runner holds; `runProvision({ holdLease })` asks it before each step, before a step's outcome or refs are saved, and before a failure is written, and stops writing when the lease is lost; the worker passes `job` in the handler's ctx and leaves a lost-lease job untouched. Every write the job makes to its signup (run id, retry, failed, done) is `WHERE status = 'provisioning'` and the signup's `job_id`.
  - **Decided by:** feature-builder, on the Line 2 review
  - **Slice:** Phase 1 line 2
- **Onboarding review fixes (2026-11-24, line 3).** (1) The page re-reads every 10 s only while the Import step is in progress with its sync running or retrying (`pollsWhile` in `lib/onboarding/steps.js`); a connect or brand step in progress waits on a person, so it is read on focus and after saves only. (2) The nav badge and the dashboard nudge use `onboardingProgress()` (`lib/onboarding/service.js`): the same facts without `openingReport()`, so the Open step counts as not done unless a live release exists; the onboarding page keeps the full model. (3) The model carries `openKnown` (false when `release_state` could not be read); the badge and the nudge show only when it is true. (4) A store whose `cms_state` says `legacy` (nothing sets it since tenant migration 0026; only an old export or a hand edit could) is `supported: false` with `reason: "legacy"` and the words "This store uses the old editor … Contact Storeasy support"; `/admin` sends it to the dashboard, never to onboarding. `migrating` keeps its "being updated" block. (6) `/admin` reads `live_release_id` through `liveOpen()` instead of `getLiveReleaseState()`.
  - **Decided by:** feature-builder, on the Line 3 review
  - **Slice:** Phase 1 line 3
