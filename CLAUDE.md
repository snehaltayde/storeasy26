# Storeasy

Storeasy is a multi-tenant storefront platform for D2C founders whose catalog lives in Shopify. Each store gets its own fast storefront, a merchant console with a document CMS, offers, bundles, checkout (Razorpay and COD) and orders, and Storeasy operators run every store from one platform console. It must never write storefront content back to Shopify, never let one store read another store's data, and never publish anything a founder did not publish.

## Stack (do not swap without asking)

| Layer | Choice | Version | Why |
|---|---|---|---|
| Language / runtime | JavaScript (ESM) with incremental TypeScript (`allowJs`, `strict: false`), Node on consoles and the Edge runtime on storefront routes | Node 26 locally, TypeScript 5.9.3 (stay on 5.9.x: Next 16.2.9 build workers crash on TS 7) | Existing code; types are added module by module in `lib/types/` |
| Framework | Next.js App Router with Turbopack, React | Next 16.2.9, React 19.2.4 | Existing code |
| UI | Tailwind CSS 4 with lucide-react icons; consoles move to shadcn/ui (copy-in components, `shadcn` CLI 4.x, Radix primitives) | Tailwind ^4, lucide-react 0.544.0 | Owner asked for shadcn in the consoles (see `docs/DECISIONS.md`); the storefront keeps its own brand-token design |
| Database and migrations | libSQL (SQLite locally, Turso hosted), one database per store plus one control-plane database, Kysely query builder, plain numbered SQL migrations | @libsql/client ^0.17.4, kysely ^0.29.2 | Store isolation by database |
| Search | Typesense, with a SQL fallback when unset | typesense ^3.0.6 | Existing |
| Auth | Own sessions: merchant members (email + password, role per store), operators (email + password + TOTP), shoppers (email OTP); role checks in `lib/platform/authz.js` | in-repo | Existing |
| Tests (unit, browser) | Node test scripts (`scripts/test-*.js`, 80 suites, run by `scripts/run-tests.js`); browser drills with playwright-core on a local harness (`scripts/drills/*`) | playwright-core 1.64.1 | Existing |
| Hosting | Vercel (Edge storefront, Node consoles and APIs) + Turso + Typesense; Cloudflare R2 and Upstash optional | — | Existing plan; nothing is hosted yet |

## Folder layout

- `app/(storefront)/` — shopper pages (Edge-safe). `app/(console)/admin/` — merchant console. `app/(console)/platform/` — operator console. `app/api/` — routes (`admin/`, `platform/`, `cart/`, `checkout/`, webhooks, `jobs/tick`).
- `components/` — storefront components at the top level; `components/admin/`, `components/console/`, `components/platform/` for consoles. New shadcn components go in `components/ui/` (consoles only).
- `lib/` — domain code: `documents/` (the CMS), `registry/` (section and document schemas), `content/` (storefront readers), `catalog/` (effective product reads), `offers/`, `platform/` (control plane, auth, jobs, billing), `first-run/`, `types/` (TypeScript contracts).
- `migrations/tenant/`, `migrations/platform/` — numbered SQL migrations. `lib/schema.sql` — base store tables.
- `scripts/` — `test-*.js` suites, `run-tests.js`, CLIs, `drills/` browser drills, `support/` test helpers.
- `docs/` — this project's docs; `docs/cms-reviews/` holds the CMS build's review packets.

A new feature's files go in: a migration in `migrations/tenant/` (or `platform/`), domain code in `lib/<domain>/`, the route in `app/api/admin/<domain>/route.js`, the screen in `app/(console)/admin/(authed)/<domain>/page.js` with components in `components/admin/<domain>/`, and its suite in `scripts/test-<domain>.js`.

## Non-negotiable rules

- **Permissions:** merchant actions are `<area>.<verb>` strings in `lib/platform/authz.js`, checked by `requireAdmin()` (`lib/admin-auth.js`) on every admin API route; operator routes use `lib/platform/admin-auth.js`. Nothing reads or writes without going through them.
- **Data scoping:** every store query runs inside `withTenant()` (`lib/tenant-context.js`) against that store's own database; the store comes from the request host, never from a URL or body id. Cache tags use `tenantTag()`; media keys start `tenants/<tenantId>/`.
- **Least-trusted role:** `support` in the merchant console (read-only); the anonymous shopper on the storefront. Each gets a test on every new read.
- **Audit trail:** merchant and operator writes record an `audit_log` row (control plane) through `lib/platform/audit.js`; CMS publishes write `publish_log` in the same batch as the publish.
- **Data formats:** prefixed random ids (`doc_`, `ver_`, `rel_`, `med_` …); money as numbers in the store currency, always recomputed on the server at checkout; times as ISO 8601 UTC strings; documents are archived, not deleted.
- **Shopify boundary:** never write content to Shopify; only the allowlisted order calls. No constant named `*_SCOPES =` outside `lib/platform/oauth.js` (`test:shopify-boundary`).
- **Edge safety:** nothing a storefront route imports may use `node:*` modules.
- **Drafts only:** generators and AI write drafts; only a founder's Publish puts content live. Legal text is never auto-published.
- **Tests wiring:** every `scripts/test-*.js` has a `test:*` script in `package.json`; every new API route is tracked by git before `test:security` runs.
- **Dependencies:** no new dependency without a stated reason in `docs/DECISIONS.md`.
- **Hands off:** never modify `docs/CMS_CLAUDE_DIRECTION_BRIEF.md`, `docs/CMS_ENTERPRISE_AUDIT_2026-10-29.md` or `docs/CMS_SESSION_HANDOFF.md`.

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Run locally | `pnpm dev:design` (a local harness store on http://localhost:3017; seeds itself on first run; `pnpm dev` needs a `.env.local`); `pnpm dev:roles` (the role store on http://roles.localhost:3018; seeds itself if it has no data, deletes nothing) |
| Lint | `pnpm typecheck` (there is no linter; the TypeScript check is the closest real check) |
| Unit tests (all) | `pnpm test` |
| Unit tests (one file) | `node scripts/test-authz.js` (any `scripts/test-<name>.js`) |
| Migrate a fresh database | `node scripts/test-schema-compat.js` (runs the store migration chain on new file databases; `pnpm migrate` needs a `.env.local`) |
| Browser tests (one spec) | `pnpm drill:<name>` (p5, p6, smoke, agency-gone): runs in a throwaway git worktree at HEAD on its own ports and data, so commit first; results in `.drill-results/<stamp>/` |
| Browser tests (all) | `pnpm drill:all` (one worktree: smoke, p5, p6, agency-gone; never run a drill script directly) |
| Seed | `pnpm seed:roles` (a fresh store with every role on http://roles.localhost:3018; refuses if one exists; logins in `.design-data-roles/roles-seed.json`; `--reset` only with the owner's OK). `pnpm seed:design` wipes `.design-data/`: ask the owner first, and stop the harness first |

<!-- The working agreement from the steelthread plugin goes below this line. -->
# Working agreement: how software is built here

These rules apply whenever a session builds or changes software in this project. The
project's own rules above win where they say something different.

## Before any code

- A project needs four documents before feature work: `CLAUDE.md` (stack, folder layout,
  non-negotiable rules, commands), `docs/ARCHITECTURE.md`, `docs/FEATURES.md` (phases of
  checkboxes, in build order) and `docs/DECISIONS.md`; plus `docs/UI.md` if it has screens.
  If they are missing, run `/steelthread:new-project` first.
- The stack and the non-negotiable rules are chosen per project and then not swapped.
- Check a library's current docs before using its API. Do not write from memory.

## One slice at a time, end to end

- A slice is one `docs/FEATURES.md` line taken from data model to tests: schema → migration →
  permission checks → reads and writes → UI → tests. No empty screens for later phases.
- Flow per slice: `steelthread:architect` plans (full feature list, file plan, decisions) →
  `steelthread:feature-builder` builds → `steelthread:ui-designer` for any new or changed
  screen → `steelthread:reviewer` on the result → fix → verify.
  `/steelthread:feature <line>` runs this.
- **No scope cutting.** The architect's feature list is a floor. Lean code is welcome (reuse,
  no speculative options, no new dependency without a stated reason); fewer features is not.
- Permissions live in one place per domain and are tested for every role before the reads
  that depend on them. The least-trusted role gets a test on every new read.

## Deciding without me

- Do not stop for my approval of plans, decisions, merges or the next task. Take the
  architect's recommendation, record it in `docs/DECISIONS.md`, keep going, and list the
  decisions made on my behalf in the report (schema and permission decisions first).
- When a slice is finished and checked, start the next line in order.
- Still ask first: deleting or re-seeding my data, the first push or first production deploy
  of a project, anything that costs money, anything that cannot be undone.
- If a requirement is truly ambiguous, ask one precise question and carry on with the rest.

## Verifying

- After coding: lint, the full unit suite, and migrations against a fresh database, run
  through `steelthread-verify`. Builders run only the slice's own tests; the session does
  the one full run. A slice runs only its own browser spec; the full browser suite runs
  once per phase.
- Never say something works unless it was run. Every report says what was run, what failed,
  and what was not verified. A test that fails only in full runs is reported, not hidden.
- The main branch never holds an unverified state. One session owns merges into it.

## Running agents

- Model split: the session model plans and reviews; `opus` writes server, permission,
  security and hard UI code; `sonnet` does docs, seed data and simple packages.
- Never two writers in one checkout. Independent feature blocks may run side by side, each in
  its own git worktree, branch and database. Heavy commands (test suites, builds) run through
  `steelthread-lock` so only one runs at a time on the machine.
- Keep usage low: briefs name exact files; agents do not read large docs whole; one plan file
  per phase (`docs/plans/phase-<n>.md`) instead of a fresh plan per agent; about 150 tool
  calls per agent; reports of about ten lines.
- Never kill processes by name pattern or port sweep.

## Reporting to me

- Short, plain updates. A status table only when a slice finishes or something goes wrong.
- Progress updates name the slice, its stage and the estimated time left.

Lessons this project has learned live in `docs/PLAYBOOK.md`. Deeper notes for long builds
are in the `steelthread:orchestrating-builds`, `steelthread:migration-safety` and
`steelthread:go-live` skills; load them when the work calls for them.
