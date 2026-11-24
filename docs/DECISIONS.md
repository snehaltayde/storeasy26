# Decisions

Newest first. One entry per choice that someone might later ask "why" about. Entries made
without asking the owner are marked so they are easy to review.

## 2026-11-24 The new console shell (on the owner's behalf)

- **Decision:**
  - No schema changes. The shell reads only the caller's own name and email and their own store memberships, on the server; the full user row never reaches the browser.
  - The nav has one source of truth, `lib/admin/nav.js`: one read action per item, filtered on the server by role. A section the role can't open is hidden, not shown disabled. Setup stays admin-only in the nav (it needs settings access), as today. Owner and admin see 16 sections; staff and support see 11.
  - For this line, "support sees no write actions" covers the shell itself (sidebar, top bar, switcher, account menu) and the nav. The write buttons inside each existing screen become read-only for support with that screen's Phase 2 line; the shell drill lists which ones support can still see.
  - Old screens keep their exact look inside the new frame through a temporary `data-legacy` wrapper that restores their colours, instead of renaming tokens across about 60 files; Phase 2 removes it. One deliberate change: the editor preview sits lower so it clears the new sticky top bar.
  - The store switcher is a dropdown built on the server (shared with `/api/admin/stores`), always shown, and switching opens the other store's own address. Notice banners move into the shell's content area; the sidebar's open/closed state is a cookie read on the server.
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
