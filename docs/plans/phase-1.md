# Phase 1 plan: simple onboarding

One section per line of `docs/FEATURES.md` Phase 1. Agents read only the section for their line.

## Line 1: a founder signs up on their own

**Design:** signup and email verification on the Storeasy marketing host; the store is created only after the email is verified, on a file database behind a driver that line 2 swaps for Turso; a single-use handoff token signs the founder into `<slug>.<domain>/admin/onboarding`. Line 2 swaps the driver and moves provisioning into a job; line 3 grows `/admin/onboarding` into the four steps.

### 1. Feature list (floor)

1. **Signup form** at `/signup` on the platform site host only (`PLATFORM_SITE_HOSTS`); a store host gets 404. Fields: name (1–80), email, password (8–200, not the email), store name (2–60). Store address shown live as `<slug>.<SIGNUP_STORE_DOMAIN>`, derived from the store name, editable. Availability check: bad format, reserved words (`www admin api app platform storeasy mail help status signup` and every label in `PLATFORM_SITE_HOSTS`), existing tenant ids and domains, slugs held by live signups. Pricing's "Get started" → `/signup` when signup is open.
2. **Kill switch:** open only while flag `ff_self-signup` is on (`flagEnabled(..., {fallback:false})`); off → "signups are closed" with a link to `/contact`.
3. **Email code:** 6 digits, 15-minute expiry, 5 wrong tries then dead; resend at most once per 60 s and 5 per signup, each a new code; stored as `sha256(signupId:code)`, compared in constant time.
4. **Browser binding:** submit sets host-only, httpOnly, SameSite=Lax cookie `se_signup` on the marketing host (only its hash stored); verify, resend and retry act only on the signup matching the cookie.
5. **No enumeration:** an existing email gets the same response, code screen and scrypt work; its email says "you already have an account: sign in or reset" with no code; every code fails with the same generic message. Validation errors are per field, never "email taken".
6. **Abuse limits** (`login_limits` throttle + `rateLimitAsync`): start 5/IP/hour, 3/email/hour; verify 20/IP/15 min; every POST runs `sameOrigin()`.
7. **Verify, then create:** verify atomically flips `pending → verified` (single use), then `runProvision` with the file driver: store DB, schema, documents mode, tenant with domain `<slug>.<SIGNUP_STORE_DOMAIN>`, status `active`, closed until first publish, Free plan, `config.onboarding.source = "signup"`. Then create the user (stored password hash, `email_verified_at`), owner membership, delete the password hash from the signup row.
8. **Failure is plain and resumable:** a failed step marks the signup `failed` in plain words; "Try again" resumes the same provision run (cookie-bound); visible in `/platform` provisions.
9. **Handoff:** after verify, a `kind='handoff'` invitation for this tenant only (2-minute TTL, single use); browser goes to `http(s)://<store-host>/admin/handoff#t=<token>` (fragment: never in logs or Referer); the page POSTs it to `/api/admin/handoff`, which sets the merchant session cookie and redirects to `/admin/onboarding`. Not burned when used on the wrong host (existing `consumeInvite`).
10. **Landing page** `/admin/onboarding` in the Phase 0 shell: "Welcome to {store}", the store address, a Closed badge ("Shoppers see Opening soon"), the verified email, a "Next: connect your Shopify store" card in honest words, a link to the dashboard. Every role reads it; no writes.
11. Later sign-ins with the same email and password work at `/admin/login` on the store host; the account belongs to no other store.
12. **Expiry:** unverified signups expire after 24 hours and free their address; no user or store is ever created for them; rows older than 7 days pruned on each insert.

Out of scope: an existing account adding a second store; real Turso and the job (line 2); the four steps (line 3); operator view of signups (line 8).

### 2. Data: `migrations/platform/0011_signup.sql` (nothing destructive)

```sql
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
CREATE TABLE IF NOT EXISTS signups (
  id TEXT PRIMARY KEY,               -- sgn_<16hex>
  email TEXT NOT NULL, name TEXT NOT NULL, store_name TEXT NOT NULL, slug TEXT NOT NULL,
  password_hash TEXT,                -- null for 'existing'; cleared once done
  browser_hash TEXT NOT NULL,        -- sha256 of se_signup cookie
  code_hash TEXT, code_expires_at TEXT, code_attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 0, last_sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|existing|verified|provisioning|failed|done|expired|superseded
  user_id TEXT, tenant_id TEXT, provision_run_id TEXT, error TEXT, ip TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_slug_live ON signups(slug)
  WHERE status IN ('pending','verified','provisioning','failed');
CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_browser ON signups(browser_hash);
CREATE TABLE IF NOT EXISTS platform_mail (
  id TEXT PRIMARY KEY,               -- pml_<16hex>
  kind TEXT NOT NULL,                -- signup_code | signup_existing
  recipient TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT,                         -- kept only when mail is mocked; null after a real send
  status TEXT NOT NULL,              -- sent | mock | failed
  provider_id TEXT, error TEXT, ref TEXT,  -- ref = signup id
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_mail_recipient ON platform_mail(recipient, created_at);
```

Before a new pending row: expired pending rows for that slug → `expired`; the same email's older pending row → `superseded`. `invitations.kind` gains value `handoff` (no schema change).

### 3. Permissions and least-trusted tests

| Action | anonymous | merchant roles | operator |
|---|---|---|---|
| `/signup`, `POST /api/signup` (platform host only) | allowed | n/a | allowed |
| verify, resend, retry | only with the matching `se_signup` cookie and the right code | same | same |
| `POST /api/admin/handoff` | only with a valid token for this host | refused (a session is not a token) | refused |
| `/admin/onboarding` (`storefront.read`) | redirected to login | read (all roles) | support session reads |

Guard tables: `scripts/support/shopper-routes.js` — `signup` (GET, POST) as `collector`; `signup/verify`, `signup/resend` (POST) as `token`; suite `test-signup.js`. `scripts/support/admin-routes.js` `EXEMPT_ROUTES` — `{ path: "handoff", method: "POST", kind: "token" }`. `scripts/support/admin-pages.js` — `{ page: "onboarding", action: "storefront.read" }`.

Least-trusted tests (in `test-signup.js` unless noted): verify with no cookie or another browser's cookie → generic failure, not counted against the victim's tries; a used code can't be replayed; an existing-email probe gives the same status and response keys; random or expired handoff token → 400; a handoff token on another store's host → 400 and still usable on the right host; cross-origin → 403; `/api/signup` on a store host → 404; the new owner gets 401 on another store's `/api/admin/login` and admin routes; support reading `/admin/onboarding` via `test-support-reads`.

### 4. Events

Audit (`lib/platform/audit.js`, tenant id set): `signup.verified` (actor the new owner); `tenant.provisioned` (actor `{kind:"system", id:"signup"}`, diff `{source:"signup", run}`); `auth.login` (diff `{method:"handoff"}`). Pre-verify signups are anonymous: the `signups` row plus `slog` lines `signup_started`, `signup_code_sent`, `signup_verify_failed{reason}`, `signup_provision_failed{run}`, `signup_done`, `admin_handoff`. Read by the `/platform` provisions list, line 8's operator view and line 2's job.

### 5. File plan

**WP-A: server**
1. `migrations/platform/0011_signup.sql`.
2. `lib/platform/provisioner.js` (new): `createStoreDatabase(slug, driver)`; `file` driver writes `<STORE_DB_DIR>/storeasy-t-<slug>.db` (default `.store-dbs/`), refuses when `NODE_ENV=production` or `VERCEL` is set or the dir looks like a URL, returns only `file:` URLs; `turso` driver wraps today's `createTenantDatabase`.
3. `lib/platform/provision.js`: `create_db` through the provisioner with `params.dbDriver` defaulting to `turso` (CLI and operators unchanged); `dbDriver` and `source` saved in run params; `shopDomain` optional when `source==="signup"`; optional `siteUrl`.
4. `lib/platform/identity.js`: `createUser` gains `{ passwordHash, emailVerifiedAt }`; a password-rules helper.
5. `lib/platform/platform-mail.js` (new): `sendPlatformMail({kind,to,subject,text,ref})` records the row, sends inline via `lib/mail.js`, nulls the body after a real send.
6. `lib/platform/signup.js` (new): validation, `slugFor`, `slugAvailable`, `startSignup`, `resendCode`, `verifySignup`, `finishSignup` (provision, user, owner membership, handoff token), `storeHostFor`.
7. Routes (`runtime="nodejs"`, `sameOrigin`, rate-limited): `app/api/signup/route.js` (GET `?slug=` availability, POST start); `app/api/signup/verify/route.js` (POST verify or `{retry:true}`); `app/api/signup/resend/route.js`; `app/api/admin/handoff/route.js` (in `tenantHandler`).
8. Guard-table rows (§3).
9. `scripts/design-harness.js` `harnessEnv`: `PLATFORM_SITE_HOSTS=storeasy.localhost` (after blanking), `SIGNUP_STORE_DOMAIN=localhost`, `STORE_DB_DIR=<dataDir>/stores`; add `SIGNUP_STORE_DOMAIN`, `STORE_DB_DIR` to `KEPT_ENV`; both in `.env.example`.
10. `scripts/support/signup-mail.js` (new): `latestSignupCode({platformUrl, email})` reads the newest `platform_mail` mock row; local DB URLs only (like `assertSeedDbUrl`).
11. `scripts/test-signup.js`; `package.json` `test:signup`, `drill:signup`.

**WP-B: UI and drill**
12. `app/(console)/signup/page.js` + `components/admin/signup/SignupFlow.js` (form → code → "Setting up your store…" → redirect; failure + Try again), from `components/ui/*`.
13. `app/(console)/admin/(handoff)/handoff/page.js` (own route group, see DECISIONS) + `components/admin/HandoffSignIn.js`.
14. `app/(console)/admin/(authed)/onboarding/page.js` + `components/admin/onboarding/Welcome.js`; the `admin-pages.js` row.
15. `app/(storefront)/pricing/page.js`: CTA → `/signup` when the flag is on.
16. `scripts/drills/signup/run.mjs`, registered in `scripts/drills/run-isolated.mjs`: flag on; sign up at `storeasy.localhost`, read the code, verify; land on `<slug>.localhost/admin/onboarding` with the shell, store name and Closed badge; sign out and back in; existing email (same screen); wrong code (generic message); evidence in `docs/cms-reviews/drills/SIGNUP/`.

### 6. Checks first

1. `node scripts/test-provision.js`, `test-shopper-reads.js`, `test-permissions.js`, `test-support-reads.js` pass.
2. `pnpm drill:shell` (or `drill:smoke`) once on HEAD.
3. A tenant with no `shopify_store_domain` (via `scripts/support/tenant-fixture.js`): `/admin/dashboard` and `/admin/onboarding` render, not throw.
4. In the harness, Chromium resolves `storeasy.localhost:<port>` and `<slug>.localhost:<port>`; `resolveHost` matches bare `slug.localhost`.
5. `node scripts/test-schema-compat.js` after adding 0011.

### 7. Risks

1. The new store's storefront can't render locally (Edge libSQL can't open `file:` DBs; `scripts/design-harness.js` lines 4–6); the console (Node) works. The drill must not visit the storefront; say so in the report.
2. Console screens may assume `shopify_store_domain`; fix crashes, don't build Shopify connect.
3. Handoff login CSRF (an attacker's link signs a victim into the attacker's new store): low impact with a 2-minute single-use token; accepted.
4. New `*.localhost/admin` URLs may trip `test:shopify-boundary`/`test:security` (playbook): run both in the neighbour step; commit new routes before `test:security`.
5. Production needs wildcard DNS and a wildcard certificate for `SIGNUP_STORE_DOMAIN`; settle at go-live.

## Line 2: signup creates the store's Turso database for real

**Fit:** builds on line 1. Verify queues a `provision_store` job and returns at once; the waiting page polls a status route bound to the `se_signup` cookie. Tests and drills run against a local fake of Turso's Platform API; no real database is ever created except by the owner's opt-in `pnpm check:turso-real`. Fixes two bugs in `lib/platform/provision.js`: a run resuming at `apply_schema`/`content_mode` has no DB token (it lived only in step memory), and `register_tenant` re-mints only for `libsql://`, so `http://` URLs get none.

### 1. Feature list (floor)

1. **Verify returns at once:** flips the signup to `provisioning`, queues `provision_store {signupId}` (key `provision_store:<signupId>`), returns `{status:"provisioning"}`; `after()` then runs the job with a 50 s budget (`runJobById`).
2. **`POST /api/signup/status`** (marketing host only, `sameOrigin`, only the signup matching `se_signup`): returns the status; four plain-words steps (waiting/working/done/failed) — "Creating your store's database", "Preparing your store", "Registering your store address", "Creating your account"; a retry note ("Our hosting provider is slow to answer. Trying again in 15 seconds (try 2 of 5)"). It also runs the founder's own job if due (this drives retries locally and in drills); the every-minute tick stays as backstop.
3. **Repeatable, resumable steps:** DB name `storeasy-t-<slug>`; `create_db` saves `refs.dbCreateRequestedAt` before asking Turso; a 409 after that is adopted as this run's DB; a 409 the run never asked for → needs an operator. Steps needing a token mint a 1-hour one; `register_tenant` mints the never-expiring token, stored only in `tenants.db_token_enc` (`k1:`).
4. **Retries:** network errors, timeouts (15 s per call), 5xx and 429 retried after 5 s, 15 s, 45 s, 2 min, 5 min; 429 waits at least `Retry-After`, capped at 10 min. After the fifth: `failure_kind='retry_exhausted'`, "We couldn't finish setting up your store. Nothing you entered is lost: press Try again."
5. **Needs us:** 400 (bad group/name), 401, 402, 403, or a 409 the run never asked for stop at once with `failure_kind='needs_operator'`; founder sees "Something on our side needs fixing. We've been told. Press Try again in a while."; operators get `sendAlert` naming the signup, step and HTTP status, never a token.
6. **Try again** (`{retry:true}`) resets the try count and makes the same job due; resumes the same provision run (never a second DB). A lapsed signup still says "start again".
7. **Handoff:** the job finishing sets `done` and `done_at`; no token in the job. A poll that sees `done` deletes any unused earlier handoff invite and makes a new 2-minute token (at most one live), returns `redirect`; once a handoff was used or 30 minutes passed, it returns `loginUrl` instead.
8. **Driver:** Turso HTTP API when `TURSO_API_TOKEN` and `TURSO_ORG` are set (never the `turso` CLI for signup); else a local file DB outside production only; production without the API → 503 "Signups are unavailable".
9. **API address:** the client reads `TURSO_API_URL` (default `https://api.turso.tech`); production refuses any other value; elsewhere a non-default value must be loopback. A test-only `localUrl` in the fake's reply is honoured only for a loopback address.
10. **Secrets:** the API token and minted tokens never appear in logs, `provision_runs`, `jobs.last_error`, `signups.error`, audit diffs or error text; errors are scrubbed of Bearer/JWT-looking strings.
11. **Operator view:** `/platform` provisions shows a "Self-serve signup" badge and the failure kind; resuming a signup run makes its job due (so user and owner membership get made) instead of running inline.
12. **Local harness:** starts the fake; each new store gets its own sqld, so the new store's storefront ("Opening soon") renders in the drill (closes line 1's risk 1).
13. **Opt-in real check:** `pnpm check:turso-real` is the only path to real Turso (§6 item 12).

Out of scope: the four steps (line 3); operator list of signups (line 8).

### 2. Data: `migrations/platform/0012_signup_provision.sql` (nothing destructive)

```sql
ALTER TABLE signups ADD COLUMN job_id TEXT;
ALTER TABLE signups ADD COLUMN provision_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signups ADD COLUMN next_attempt_at TEXT;
ALTER TABLE signups ADD COLUMN failure_kind TEXT;      -- retry_exhausted | needs_operator | lapsed
ALTER TABLE signups ADD COLUMN handoff_invite_id TEXT;
ALTER TABLE signups ADD COLUMN done_at TEXT;
CREATE INDEX IF NOT EXISTS idx_signups_status ON signups(status, updated_at);
```

No change to `jobs` (type `provision_store`, `tenant_id` null) or `provision_runs` (new non-secret refs `dbCreateRequestedAt`, `transientStatus`); `runProvision` returns a new `failedKind`; statuses unchanged.

### 3. Job design

States: `verified` → `provisioning` → `done`, or `failed` with a `failure_kind`. Handler `provision_store` in `lib/platform/signup-provision.js`: load the signup (done → `{already}`); lapsed → fail `lapsed`; run or resume the provision run, then user and owner membership; a retryable failure with tries left → increase the count, set `next_attempt_at`, return `{requeue, runAfter}` (own delays, not the queue's 60 s backoff); otherwise `failed`. Unexpected throws fall back to `failJob` (`maxAttempts=3`). `provision_store` joins `LONG_JOB_TYPES` (only budgeted callers: the tick and the two `after()` paths). The job lease (120 s) replaces line 1's `STUCK_PROVISION_MS` claim.

### 4. Permissions and least-trusted tests

| Action | anonymous | merchant roles | operator |
|---|---|---|---|
| `POST /api/signup/verify`, `/api/signup/status` (marketing host) | only with the matching cookie; else generic `SIGNUP_GONE` | n/a (store host → 404) | same as anonymous |
| `/api/jobs/tick` | needs `CRON_SECRET`; production without it refuses everyone | no access | no access |
| `GET/POST /api/platform/provisions` | 401 | 401 (support included) | allowed, audited `tenant.provision` |

Guard row: `scripts/support/shopper-routes.js` `signup/status` POST as `token`, suite `test-signup-provision.js`. Tests: status with no or another browser's cookie → same generic 400; `pending` and `existing` signups get identical status answers; cross-origin → 403; status on a store host → 404; `/api/jobs/tick` in production with no or wrong secret → 401; a support session → 401 on `/api/platform/provisions`; an earlier poll's handoff token is dead after a newer poll.

### 5. Events

Audit `tenant.provisioned` (system: signup) and `signup.verified` as in line 1; operator resume stays `tenant.provision`. `slog`: `signup_job_queued`, `signup_provision_retry{attempt,status}`, `signup_provision_failed{kind,step}`, `signup_retry`, `signup_done`, `job_*`. `sendAlert` on `needs_operator`.

### 6. File plan

**WP-A: server, fake, tests**
1. `migrations/platform/0012_signup_provision.sql`.
2. `lib/platform/turso-api.js` (new): `POST /v1/organizations/{org}/databases` `{name,group}` → `{database:{DbId,Hostname,Name}}`; `GET …/databases/{name}`; `POST …/databases/{name}/auth/tokens?expiration=&authorization=full-access` → `{jwt}`; errors sorted into retry / needs-operator / conflict; the address rule (item 9); a timeout on every call; secret scrubbing. Turso documents 401, 402, 403, 404, 409, and 400 for "group not found"; no documented quota/rate-limit answer.
3. `lib/platform/provision.js`: `createDbViaApi` → turso-api; `ctx.saveRefs`; `ensureDbToken(ctx)` used by `apply_schema`, `content_mode`, `register_tenant`; the signup-only 409 rule; `failedKind`.
4. `lib/platform/provisioner.js`: `signupDbDriver()`; a `turso-api` path that never uses the CLI.
5. `lib/platform/signup.js`: `finishSignup` → `queueSignupProvision` (verify and retry) and `signupStatus` (steps, handoff minting); 503 when no driver.
6. `lib/platform/signup-provision.js` (new): handler, retry delays, `failure_kind`.
7. `lib/platform/worker.js`: `provision_store` handler and `LONG_JOB_TYPES` entry.
8. Routes: `app/api/signup/verify/route.js` (queue + `after()`, `maxDuration=60`); `app/api/signup/status/route.js` (new); `app/api/platform/provisions/route.js` (signup runs resume through the job).
9. `scripts/support/shopper-routes.js` row.
10. `scripts/support/fake-turso.js` (new): loopback HTTP server with Bearer checking; create, retrieve, token, delete with Turso's reply shapes and 409/404/401; backends `file` (unit tests) and `sqld` (one sqld per DB on base port + 10 + index, in `<dataDir>/fake-turso/registry.json`); `POST /_fake/faults` `{route,status,times,delayMs,commitThenHang}`; a request log.
11. `scripts/design-harness.js`: add `TURSO_API_URL` to `BLANKED_ENV`; after blanking set `TURSO_API_URL=http://127.0.0.1:<sqld+3>`, a random `TURSO_API_TOKEN` per run, `TURSO_ORG=local-fake`, `TURSO_GROUP=default`; in dev mode start/stop the fake and record child pids in the pid file for `stopLeftovers` (never kill by name); repoint stores when ports change; check its ports are free.
12. `scripts/turso-real-check.js` (new): refuses unless `TURSO_REAL_CHECK=yes-i-accept-a-real-database`, `--create-one-database`, the API token and org are set, and the default Turso address is used; `--dry-run`; creates `storeasy-check-<6hex>`, mints a 1-hour token, applies the tenant schema, reads it back, deletes the DB unless `--keep`; prints no token.
13. Suites: `scripts/test-turso-api.js` (new; a fetch guard failing on any non-loopback host; the real-check refusals); `scripts/test-signup-provision.js` (new; a timeout after the DB is made still yields one DB; retry delays on a fake clock; needs-operator words; Try again resumes the same run with create count 1; a token sweep finds no secret in DB or logs; §4 tests); update `test-signup.js`, `test-design-harness.js` (Turso values must be loopback), `test-jobs.js` (long job type).
14. `package.json`: `test:turso-api`, `test:signup-provision`, `check:turso-real`; `.env.example`: `TURSO_API_URL` (blank).

**WP-B: UI and drill**
15. `components/admin/signup/SignupFlow.js`: poll status every 1.5 s (back off when hidden); four-step list with an `aria-live` area; the retry note; both failure cases with Try again; follow the redirect.
16. `components/platform/ProvisionRunsPanel.js`: signup badge and failure kind.
17. `scripts/drills/signup/run.mjs`: happy path through the fake on sqld; visit `<slug>.localhost` and see "Opening soon"; 503 twice on create → retry note → done; a second signup with 402 → needs-operator words → clear the fault → Try again → done; evidence in `docs/cms-reviews/drills/SIGNUP/`.
18. `docs/cms-reviews/MANUAL-CHECKS.md`: the real-check command.

### 7. Checks first

1. `node scripts/test-signup.js && node scripts/test-provision.js && node scripts/test-jobs.js && node scripts/test-design-harness.js`; `pnpm drill:signup` once on HEAD.
2. sqld present (`ls ~/.turso/sqld` or `which sqld`); a sqld without auth accepts a Bearer request: `sqld --http-listen-addr 127.0.0.1:18990 --db-path <scratch>/x.sqld`, then `curl -s -H 'Authorization: Bearer x' -d '{"statements":["select 1"]}' http://127.0.0.1:18990/`.
3. `scripts/run-tests.js` runs only `test:*` (so `check:turso-real` never runs in `pnpm test`).
4. `ls migrations/tenant | wc -l`; time `applyTenantSchema` against a local sqld (vs the 60 s `maxDuration` and 120 s lease).
5. `node scripts/test-schema-compat.js` after adding 0012.

### 8. Risks

1. Schema apply on real Turso may exceed one `after()` window; the ledger resumes, the founder waits longer; only the real check measures it.
2. The harness now sets Turso values (pointing at the fake): the loopback-only rule and `test-design-harness` must hold it shut — a mistake could reach real Turso.
3. No documented quota/rate-limit error: treat 402, 403 and any 400 mentioning "limit" as needs-operator; confirm with the real check.
4. A crash between minting the never-expiring token and saving the tenant leaves one unused valid token on that DB; accepted.
5. A harness killed with `-9` leaves per-store sqld processes; pid-file cleanup covers it; review closely.

## Line 3: the four-step onboarding page

**Fit:** replaces `/admin/start` and `/admin/setup` with one page, `/admin/onboarding`. No migration; the step a founder is on is derived from real store state, never stored. Line 1 already made `/admin/onboarding`, `Welcome.js` and the shell's onboarding mode. Lines 4–7 fill each step for real; this line wires only what today's code can do, so nothing regresses.

### 1. Feature list (floor)

1. **Page:** `/admin/onboarding` (all roles, `storefront.read`): Welcome card at the top (store name, address, Closed/Open badge, verified email; existing `data-onboarding` attributes stay), then four steps each with a state, plain words and a panel; "Go to your dashboard" stays.
2. **Layout** (`docs/UI.md`): no sidebar; content column max 640px; from 1024px a `StepList` on the left, below 1024px a compact progress list above the panel; each step shows number, label and Done / In progress / To do / Blocked; blocked steps show the reason.
3. **Resume:** opens on `?step=<connect|import|brand|open>` when given, else the first step not done; choosing a step does `router.replace('?step=…', {scroll:false})`; an unknown `?step` is ignored.
4. **Step 1, Connect Shopify:** connected or not; shop domain shown only to roles with `settings.read`; honest words (today an operator finishes the connection; line 4 adds the founder's own OAuth); nothing written to Shopify.
5. **Step 2, Import products:** reuses `SyncProgressBody`, `readSync`, `requestSync` (`/api/admin/sync`): progress, Start, Try again with `sync.run`; handles "no products" and "being updated".
6. **Step 3, Brand:** reuses `FirstRun` (starter-store generator, its views, `BrandStep` at `#brand`) inside a `data-legacy` wrapper; line 6 rebuilds it.
7. **Step 4, Open your store:** `openingReport()` items with today's actions — Start a privacy page / Start a returns page, Read it, "I've read it" (via `/api/admin/policy-start`); "I placed a test order"; existing Fix links; an "Open your store" button to the editor's Publish (`EDITOR_PUBLISH_HREF`). Line 7 moves opening into the step.
8. **Live refresh:** re-read `GET /api/admin/onboarding` every 10 s while a step is in progress and the tab is visible, on window focus, and after a save in FirstRun, BrandStep or the policy panels (new optional `onChange` prop).
9. **Every role sees the page:** controls a role can't use are shown disabled with the reason (`RoleGate` pattern); support and operator-support only read.
10. **Already-open stores:** every step Done, "Your store is open", no badge.
11. **`_default` store:** "This store is set up from its environment config" and a dashboard link.
12. **Landing:** `/admin`, login and accept-invite go to `/admin`, which redirects to `/admin/onboarding` while the store is closed, else the dashboard (signup and operator-created stores land in the same onboarding).
13. **Retirements and moves:** `/admin/start` → `/admin/onboarding?step=brand`; `/admin/setup` → `/admin/onboarding`; checklist UI and `buildChecklist` removed; the dashboard's two setup nudges become one "Onboarding: n/4 done"; links in `SettingsAdmin.js` and `DesignForm.js` → `?step=brand`; operator `TenantDetail` shows the four step states.

Out of scope: founder OAuth (line 4), new import UI (5), palette/logo/live preview (6), opening inside the step (7), operator signups list (8), operator create form (9).

### 2. Step model

`lib/onboarding/steps.js`: `deriveSteps(facts, role)` →
```
{ supported, open, current, doneCount, total: 4,
  steps: [{ id, label, state: "done"|"in_progress"|"ready"|"blocked",
            words, blockedBy?: stepId|"updating", problem?: string,
            facts, actions: [{ id, allowed, reason? }] }] }
```

Facts read by `lib/onboarding/service.js` in `withTenant`: tenant config (`shopify_store_domain`, `onboarding.brand_step`); `catalogSyncStatus()` (`linked`, sync view); whether any `sync_runs` row is complete and the product count; whether `doc_home` exists and `storeDesign()`; `getCmsMode()`; `openingReport()`; `release_state` (open = a live release). A failed read leaves that step not done with "We couldn't check this just now"; never done on a guess.

| Step | done | in_progress | blocked | ready |
|---|---|---|---|---|
| connect | linked, or any complete sync, or products > 0 | domain recorded, not linked yet | never | otherwise |
| import | a complete run ever, or legacy products | latest run running or retrying | connect not done; sync paused (store being moved) | no run, or failed/stalled (with `problem`) |
| brand | brand step recorded (or design has a brand/theme) **and** `doc_home` exists | exactly one of those | CMS mode is not `documents` | neither |
| open | a live release | — | any opening item at level `block` (reasons = their titles) | no blocking items |

An open store has every step done. `current` = first step not done (all done → `open`). Open is **not** gated on steps 1–3.

Actions → authz (permissions stay in `lib/platform/authz.js`): sync start/retry `sync.run`; starter store, brand save/skip, policy start/read `storefront.write`; brand description `settings.write`; test-order mark `settings.write`; Open `storefront.publish`; show shop domain `settings.read`.

### 3. Data

No migration. `config.onboarding.manual.test_order` keeps working; `preview` and `launch` check-offs are no longer read (old values left in place). No step stored in config.

### 4. Permissions and least-trusted tests

| Action | owner | admin | staff | support / operator-support | signed out |
|---|---|---|---|---|---|
| page and `GET /api/admin/onboarding` (`storefront.read`) | read | read | read | read, no enabled controls | login redirect / 401 |
| shop domain in the response | yes | yes | omitted | omitted | — |
| `POST /api/admin/onboarding {step:"test_order", done}` (`settings.write`) | yes | yes | 403 | 403 | 401 |
| sync / first-run / brand-step / policy-start | unchanged | unchanged | unchanged | 403 | 401 |
| Open (publish) | yes | yes | disabled, "Only the owner or an admin can open the store" | disabled | — |

Tests (`test-onboarding.js` unless noted): support GET → 200 with exactly keys `["ok","supported","open","current","doneCount","total","steps"]`, no `shopDomain`, tokens or client id; every action `allowed:false` for support; support POST → 403; signed out → 401; another store's session on this host → 401; cross-origin POST → 403; `test-support-reads` sweeps the page's props.

### 5. Events

The test-order mark keeps its audit row (`settings.write`, resource `onboarding:test_order`) plus `slog onboarding_step`. Reads emit nothing.

### 6. File plan (A then B, one branch)

**WP-A: model, API, nav, tests**
1. `lib/onboarding/steps.js` (new, pure; holds `TEST_ORDER_CLOSED_HINT`).
2. `lib/onboarding/service.js` (new): `readOnboardingFacts`, `onboardingFor(actor)`, `markTestOrder(done)`.
3. `lib/documents/opening.js`: one import changes.
4. Delete `lib/admin/onboarding.js`, `components/admin/SetupAdmin.js`, `app/api/admin/setup/route.js`.
5. `app/api/admin/onboarding/route.js` (new): GET and POST.
6. `components/admin/editor/publish/publishModel.js`: `SETUP_URL` → `/api/admin/onboarding`.
7. `lib/admin/nav.js`: `setup` → `{id:"onboarding", label:"Onboarding", href:"/admin/onboarding", page:"onboarding", action:"storefront.read", badgeKey:"onboarding"}`; remove the `start` ("Logo and colours") item.
8. `app/(console)/admin/(authed)/layout.js`: `onboarding` badge `n/4` while closed.
9. Redirects: `app/(console)/admin/(authed)/page.js` (closed → onboarding); `start/page.js` → `?step=brand`; `setup/page.js` → onboarding.
10. `app/api/platform/tenants/[id]/route.js`: use `onboardingFor`.
11. Guard tables: `scripts/support/admin-routes.js` (`onboarding` GET and POST rows; remove `setup`); `support-reads.js` (`onboarding` row; remove `setup`); `admin-pages.js` (notes that `setup` and `start` redirect).
12. `scripts/test-onboarding.js` (new): the state table, resume rules, roles, least-trusted cases; `test:onboarding` in `package.json`.
13. Update `test-provision.js`, `test-design-doc.js`, `test-first-sync.js`, `test-console-shell.js`, `test-editor-routes.js`, `test-brand-step.js`, `test-publish-ui.js`.

**WP-B: UI and drills**
14. `app/(console)/admin/(authed)/onboarding/page.js`: server read; `searchParams.step` (awaited, as `dashboard/page.js` does).
15. `components/admin/onboarding/`: `Onboarding.js` (client: selected step, refresh), `StepList.js`, `StepPanels.js` (Connect, Import, Brand, Open), `Welcome.js` (trimmed to the store card).
16. `components/admin/first-run/FirstRun.js`, `BrandStep.js`: optional `onChange`.
17. `components/admin/shell/AdminShell.js`: onboarding `main` grows to `lg:max-w-[920px]`; the column stays 640px (`data-onboarding="column"`).
18. Dashboard nudge (`dashboard/page.js`); links in `SettingsAdmin.js`, `DesignForm.js`; `LoginForm.js`, `AcceptInviteForm.js` push `/admin`; `components/platform/TenantDetail.js`.
19. Drills: `scripts/drills/p6/{brand,generate,empty,open}.mjs` use `/admin/onboarding?step=brand`; `setup.mjs` becomes step 4's policy starters; new `onboarding.mjs` stage `h` (states, resume, support read-only, open store all done), registered in `run.mjs`; `scripts/drills/shell/run.mjs` deep-links to onboarding; `scripts/drills/signup/run.mjs` checks the step list and the 640px column.

### 7. Checks first

1. `node scripts/test-provision.js && node scripts/test-brand-step.js && node scripts/test-first-run.js && node scripts/test-console-shell.js && node scripts/test-editor-routes.js && node scripts/test-publish-ui.js && node scripts/test-support-reads.js && node scripts/test-permissions.js && node scripts/test-open-checks.js && node scripts/test-policy-start.js`
2. `pnpm drill:p6 -- g` and `pnpm drill:signup` once on HEAD.
3. `rg -n "buildChecklist|lib/admin/onboarding|/admin/start|/admin/setup|api/admin/setup|SetupAdmin|LoginForm.*dashboard" app components lib scripts`
4. What the p6 seed leaves (`sync_runs` complete? Shopify keys blank?) — decides whether step 1 reads as done there.

### 8. Risks

1. Test churn: about eight suites assert on the checklist, `/admin/start` or nav counts (owner/admin 16 → 15; staff/support stay 11); missed references show only in the full run — run `test:security` and `test:shopify-boundary` as neighbours.
2. `openingReport()` reads policies, products and orders on every load and poll: poll only while something is in progress and the tab is visible.
3. Legacy-styled FirstRun and BrandStep inside new-UI pages until line 6: ui-designer to confirm.
4. Step 1 words: a store with a known domain but not connected stays "In progress" until an operator runs OAuth; the words must make clear the founder has nothing to do yet.
5. Login landing changes to `/admin`: update tests asserting `/admin/dashboard`, don't loosen them.

## Line 4: a founder connects Shopify through OAuth from step 1

**Fit:** builds on line 3. Flow: authorization code grant (Shopify's flow for apps outside the admin; token exchange needs embedded-app ID tokens). Shopify requires apps created on or after 2026-12-01 to use **expiring offline tokens** (1 hour; refresh token 90 days; a refresh returns a new pair and retires the old refresh token once the new one is used), so this line requests expiring tokens and refreshes them.

### 1. Feature list (floor)

1. **Step 1 panel** (owner/admin, `settings.write`): a shop field accepting `my-shop`, `my-shop.myshopify.com` or a pasted admin URL, normalised and checked against `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`; a custom domain like `brand.com` gets "Use your myshopify.com address (Shopify, Settings, Domains)"; `/admin/onboarding?step=connect&shop=x.myshopify.com` fills the field, never submits.
2. The domain is saved only while the store is not connected and its Shopify app isn't set up; after that it's locked and shown with "Wrong store? Contact Storeasy support".
3. **App not set up** (no client id/secret): domain saved, step In progress, "Storeasy's team is preparing your Shopify connection."; Connect disabled with the reason.
4. **Connect:** POST returns the authorize URL and sets a nonce cookie; Shopify approval; the callback checks session, state, HMAC, shop (in that order), exchanges the code with `expiring=1`, stores access and refresh tokens encrypted with expiry times, `connected_at`, `connected_by`; checks granted scopes (missing → existing warn alert); registers webhooks on an https platform URL; queues the first sync (`startedBy:"connect"`); redirects to `/admin/onboarding?step=import&connected=1` (step 1 Done, step 2 In progress).
5. **Failures** → `?step=connect&connect_error=<code>`, plain words per code, then the parameter is cleared: `denied` (also "Didn't finish in Shopify? Press Connect again."), `expired` (state > 10 min), `mismatch` (state/session/nonce/store), `hmac`, `wrong_shop`, `other_store` (another active store holds a token for this shop; checked at start and again before saving), `no_app`, `token_failed`, `suspended`; unknown → a general message.
6. **Reconnect** keeps the domain; appears after uninstall (`shopify_app_uninstalled_at`), a permanent refresh failure (`shopify_reauth_needed_at`), or missing scopes; reconnect clears those flags.
7. **Refresh in `getAdminAccessToken`:** ~60 s before expiry; one refresh at a time per tenant per process, with a cached current token; re-read the tenant before saving and use a newer token if another refresh wrote one; retry network/5xx/429; on 401 `invalid_request` clear both tokens, set `reauth_needed_at`, alert; step 1 says "Connect again". Tokens without a refresh token are non-expiring.
8. **Staff and support:** step 1 read-only, no shop domain; Connect disabled with the reason ("Only the owner or an admin can do this." or read-only).
9. **Operator flow keeps working:** shares exchange and storage (so it also gets expiring tokens); its state carries kind `op`, rejected by the founder callback and vice versa; TenantDetail shows "Redirect URLs to add to this store's Shopify app", one per store domain.
10. **Local stand-in Shopify:** authorize (approval page with Install and Cancel, redirect URL checked against an allow-list), token endpoint (code, `expiring`, refresh, single-use codes), Admin and Storefront GraphQL for the sync's queries; fault switches: deny, partial scopes, token 5xx, invalid refresh, wrong shop on return.
11. A browser drill and one owner-run real check.

Out of scope: one shared Shopify app (owner question OQ-06); disconnecting or changing the shop of a connected store; the stand-in in `pnpm dev:design`.

### 2. Data

No migration: new keys in the existing encrypted tenant JSON — secret `shopify_refresh_token`; config `shopify_token_expires_at`, `shopify_refresh_expires_at`, `shopify_reauth_needed_at`, `shopify_connected_by`. The only clear is the documented reaction to a dead refresh token.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support / operator-support | signed out |
|---|---|---|---|---|---|
| `POST /api/admin/shopify/connect` (`settings.write`) | yes | yes | 403 | 403 | 401 |
| `GET /api/admin/shopify/callback` (`settings.write` via `requireAdmin`) | yes | yes | 403 page, no exchange | 403 page | 401 page |
| step 1 `connect_shopify` action | allowed | allowed | disabled, admin-only reason | disabled, read-only reason | — |

Each also asserts zero token calls at the stand-in and nothing written: signed out with a valid signed state; store A's state on store B's host; user X's state with user Y's session; missing or wrong nonce cookie; expired state; operator state on the founder callback and the reverse; tampered HMAC; a different shop than recorded; another store already connected to the shop; cross-origin POST → 403; support's onboarding GET has no domain, token or client id and every action `allowed:false`.

State: `fd|tenantId|sha256(admin cookie)|sha256(nonce)|exp`, HMAC-signed with the platform key; nonce in an httpOnly, SameSite=Lax cookie scoped to the callback path, 10 minutes, cleared on use; tenant always from the request host.

### 4. Events

Audit (`settings.write`): resource `shopify:domain` on domain save; `shopify:connection` on connect (shop, scope count, missing scopes). `slog shopify_connected`, `shopify_connect_failed {code}`, `shopify_token_refreshed`, `shopify_reauth_needed` (no tokens). Alerts: missing scopes (existing), reauth needed (new). A `sync_runs` row queued by the connect.

### 5. File plan (A → B → C)

**WP-A: server and tests**
1. `lib/shopify-origin.js` (new, Edge-safe): `shopifyBase(shop)` uses `SHOPIFY_API_ORIGIN` only when loopback outside production (throws in production or on Vercel); `normalizeShopDomain(input)`.
2. `lib/shopify.js`, `lib/shopify-admin.js`: every URL via `shopifyBase`; `expiring:1`; `refreshAdminToken`; refresh path in `getAdminAccessToken`.
3. `lib/platform/oauth.js`: state with a kind; `signFounderState`, `verifyFounderState`; `buildAuthorizeUrl` via `shopifyBase`; no new `*_SCOPES`.
4. `lib/platform/shopify-connect.js` (new): `completeConnection(...)`, `otherTenantHoldingShop(...)` on `getTenantsByShopDomain`.
5. `lib/onboarding/connect.js` (new): `connectFacts`, `startFounderConnect`, `finishFounderConnect`; `lib/onboarding/connect-words.js` (new, pure): error codes and words.
6. Line 3's files, smallest edits: `lib/onboarding/service.js` adds a `connection` fact; `lib/onboarding/steps.js` changes `connectStep` and `WORDS.connect`, adds `connect_shopify` to `ACTION_PERMS` — Done = token held and not uninstalled, or a sync completed, or products exist (client credentials alone no longer count); In progress = domain recorded but app not set up.
7. New `app/api/admin/shopify/connect/route.js`, `app/api/admin/shopify/callback/route.js`; refactor `app/api/connect/shopify/callback/route.js` onto `completeConnection` and the kind check.
8. New keys in `lib/integrations.js` and `lib/types/tenant.ts`.
9. `scripts/support/fake-shopify.js` (new, loopback only, modelled on `fake-turso-api.js`); answers GraphQL by operation name; no mutation documents (boundary scan stays clean).
10. `scripts/test-shopify-connect.js` (new) + `test:shopify-connect`.
11. Two route rows in `scripts/support/admin-routes.js`.
12. Update `scripts/test-onboarding.js`, `test-first-sync.js`, `test-platform-sync.js` for the state kind and `expiring`.

**WP-B: UI and drill**
13. `components/admin/onboarding/ConnectPanel.js` (new); in `StepPanels.js` only replace the `ConnectPanel` body with a re-export; the panel reads `useSearchParams` itself (`Onboarding.js` untouched).
14. `scripts/drills/connect/run.mjs` (new); register `connect` in `DRILLS` and `ALL` in `scripts/drills/run-isolated.mjs`; `drill:connect`: happy path through import done; cancel; wrong shop; staff and support read-only; screenshots to `docs/cms-reviews/drills/P1-CONNECT/`.

**WP-C: operator and docs**
15. `app/api/platform/tenants/[id]/route.js` GET adds `connect.redirectUrls` and `appReady`; one row in `components/platform/TenantDetail.js`.
16. `scripts/real-checks/shopify-connect.mjs` (new): refuses without `STOREASY_REAL_SHOPIFY=1`; checks expiry, one refresh, a `shop{name}` query and scopes; owner-only; add to `docs/cms-reviews/MANUAL-CHECKS.md`.
17. `docs/onboarding.md`: redirect URLs, expiring tokens.

### 6. Checks first

1. `node scripts/test-first-sync.js && node scripts/test-platform-sync.js && node scripts/test-onboarding.js && node scripts/test-shopify-boundary.js && node scripts/test-permissions.js && node scripts/test-shopper-reads.js && node scripts/test-security.js`.
2. `rg -n "signState|verifyState|exchangeCodeForToken|getAdminAccessToken|mintStorefrontToken" app lib scripts`.
3. `rg -n "SHOPIFY" scripts/drills/run-isolated.mjs` (the drill must set `SHOPIFY_API_ORIGIN` after the runner's blanking).
4. `rg -n "ALLOWED_MUTATIONS" -A12 scripts/test-shopify-boundary.js`.

### 7. Risks

1. Owner question OQ-06: one app per store means a self-serve founder waits for an operator to create their app; a shared public app needs Shopify review, protected customer data approval and a platform-host callback relay.
2. Refresh races across instances plus `patchTenant` overwriting the whole row could save an older token or wipe another write; re-read-before-save narrows it; only the real check proves refresh.
3. The callback is a cross-site GET relying on SameSite=Lax and browsers not sending Origin on GET navigations (verified in Chromium only); each console host must be in the app's redirect list.
4. Merge conflicts with lines 5–7 in `steps.js`, `service.js`, `package.json`, and line 9 in operator files; edits kept to the connect parts.
5. API version `2025-10` in `lib/shopify-admin.js` is past Shopify's 12-month support window; the stand-in can't catch schema drift; separate fix.

## Line 5: live import progress in step 2; a failed import says what to do

**Fit:** builds on line 3. Line 4 (founder OAuth) may not be merged yet: "Reconnect Shopify" selects step 1, whose words must stay true either way.

**Today:** `sync_runs` has `phase`, `products_fetched`, `products_total`, `collections_fetched`, `started_at`, `finished_at`, `error`; `runState` in `lib/admin/sync-view.js` gives none/running/retrying/stalled/failed/complete; `plainSyncError`; the queue retries 429/5xx/network with a known `retryAt`. **Gaps:** one bad product (no handle/title → DB constraint; or `reshapeProduct` throwing on one node) fails the page, retried 5 times, then the whole run; no collections total; the view has no failure kind, next step, time or skipped list.

### 1. Feature list (floor)

1. Step 2 rebuilt on the new UI in `components/admin/onboarding/ImportStep.js`, no `data-legacy` wrapper.
2. **Running:** products "done of total" (or "so far" without an exact count), collections the same; current stage in plain words, one of four: Bringing in products → Bringing in collections → Tidying up → Getting search ready; "Started 4 minutes ago"; a shadcn Progress bar with a percentage only when a total is known, indeterminate otherwise.
3. **Big catalogs:** "About N minutes left" only while products come in, with an exact total, at least 60 s and 2 pages in, never while retrying, rounded ("a minute or two", "about 10 minutes", "about 2 hours"); above 1,000 products "Big catalogs take a while. You can close this page, it keeps going."
4. **Started/finished:** never run → "Bring in products"; complete → "N products and M collections, brought in 5 minutes ago. Took 6 minutes" plus "Refresh from Shopify"; refreshing a store with products uses today's calm words.
5. **Failure by kind** (`view.problem = { kind, words, next }`):

   | Kind | Cause | What the founder sees |
   |---|---|---|
   | `reconnect` | 401/403, token, scope, 404, no link | "Reconnect Shopify" (selects step 1), secondary "Try again" |
   | `busy` | 429, 5xx, network, timeout | Retrying: "Shopify is busy. We'll try again by itself at about 3:40" + "Try now"; gave up: "Try again in a few minutes" + retry |
   | `shop` | 402/423 | "Check your Shopify plan", then "Try again" |
   | `stopped` | stalled | "Try again picks up where it left off" |
   | `unknown` | anything else | "Try again", then contact support |

   A failed run always says "Your store keeps everything already brought in".
6. **Skips:** a product or collection that can't be brought in is skipped, not fatal; the run finishes complete; step 2 Done with "3 products couldn't come in", listing up to 20 (title or handle) with why and what to do, then "and N more". Reasons: no title, no web address (handle), shares a web address with another product, Shopify sent something unreadable, couldn't be saved. A skipped product already in the store keeps its last good copy (prune doesn't delete it); the list says so.
7. **Live updates:** poll `GET /api/admin/sync` every 3 s only while running or retrying and the tab is visible; read once on becoming visible; after 3 failed reads "Lost touch, still trying", backing off to 15 s; when leaving live, call `onChange()`. Line 3's `pollsWhile` unchanged.
8. **Roles:** staff and support see everything with controls disabled and the reason (line 3's `Gated`); support's GET never nudges the sync (exists today; gets a test).
9. **Accessibility:** `aria-live="polite"` on the headline only; `aria-valuenow` only with a known total; Skeleton while loading; keyboard-usable; blocked states are line 3's.
10. **No Shopify writes** (only `collectionsCount` read added).

Out of scope: webhook single-product writes; operator import view (line 8); OAuth (line 4); links to Shopify admin per skipped product.

### 2. Data: `migrations/tenant/0028_sync_progress.sql` (nothing destructive; renumber at merge if taken)

```sql
-- Line 5: progress of N for collections, and products/collections skipped by a run.
-- NOTE: the ALTERs are not re-runnable (migrations/README.md rule 3).
ALTER TABLE sync_runs ADD COLUMN collections_total INTEGER;               -- Shopify's exact count, or NULL
ALTER TABLE sync_runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN skipped TEXT;  -- JSON [{type:"product"|"collection", id, handle, title, reason}], at most 50, deduplicated by id
```

No stage or error-kind column (stage = `phase`; kind derived from `error` + `httpStatusOf`). Skips written inside the page's guarded batch. Stores without 0028 still sync: detect the columns once per DB, cached (like `hasCmsStateTable`); without them skips still skip and are only logged.

### 3. Permissions and least-trusted tests

| Action | owner | admin | staff | support | signed out / other store |
|---|---|---|---|---|---|
| `GET /api/admin/sync` (`storefront.read`) | read, nudges | read, nudges | read, no nudge | read, no nudge | 401 |
| `POST /api/admin/sync` (`sync.run`) | yes | yes | 403, disabled with reason | 403, disabled | 401 |
| "Reconnect Shopify" (selects step 1) | shown | shown | shown; step 1 gates its action | shown | — |

`scripts/test-import-step.js`: support GET — `sync` keys exactly the view contract; a planted raw `error` (incl. a token-looking string in a 401 body) never appears; no shop domain or Shopify URLs; no `catalog_sync` job enqueued; the run row unchanged. POST: support and staff 403; signed out 401; another store's session 401; cross-origin 403. `test-support-reads` gets a row for the new keys.

### 4. Events

Unchanged: POST audit `sync.run` + `slog admin_sync`; first-run generate after a complete run (skips or not); `search_reindex`. New `slog sync_skipped {run, count, reasons}` per page with skips; `slog sync_finished {run, status, kind, products, collections, skipped, ms}`.

### 5. File plan (WP-A then WP-B)

**WP-A: engine and view**
1. `migrations/tenant/0028_sync_progress.sql`.
2. `lib/catalog/sync-vet.js` (new, pure): `vetProducts(nodes)`, `vetCollections(nodes)` → `{ keep, skipped }`; rules: id is `gid://shopify/Product/…`, handle and title non-empty, no duplicate handle within the page, unreadable nodes skipped; `SKIP_REASONS`.
3. `lib/shopify-admin-catalog.js`: guard `reshapeProduct` per node in `fetchProductsPageAdmin` (→ `{ __unreadable, id, handle, title }`; network errors still throw); new `countCollectionsAdmin()`, best effort like `countProductsAdmin`. `lib/shopify.js`: the same guard if it maps per node.
4. `lib/sync.js`: vet in `productsStep` and `collectionsStep`; add skips and protect already-existing skipped rows (`UPDATE … SET sync_generation = run.id`) in the same guarded batch; set `collections_total` on the first collections page; constraint fallback — when a page batch fails on a constraint and the run is unchanged and still ours (not a guard abort), probe each product's statements in a rolled-back transaction, skip failures with `wont_save`, commit the rest once; column detection; the two `slog`s.
5. `lib/admin/sync-view.js`: `syncView` gains `stage {id, label, index, of: 4}`, `collections.total`, `elapsedMs`, `durationMs`, `eta`, `problem`, `skipped {count, items ≤ 20, more}`, `big`; new export `syncProblem(run, state)`; existing fields stay (`SyncProgress.js`, dashboard, Settings unchanged).
6. `scripts/test-import-step.js` (new) + `test:import-step`: engine runs with fetchers from `catalogFor("many"|"few"|"empty")`; faults `Admin GraphQL HTTP 401`, 403 with a scope message, 429, 503, `fetch failed`, timeout, stalled run, no title, no handle, duplicate handle, unreadable node, forced constraint failure; retry resumes from the cursor; a skipped existing product survives the prune; a store at 0027 syncs; every kind's words and `next`; stage labels; ETA rules; big-catalog words; §3 role cases.
7. Update `scripts/test-first-sync.js`, `scripts/test-support-reads.js` if they assert exact view keys.

**WP-B: UI and drill**
8. `components/ui/progress.js` on installed `radix-ui` 1.8.1 (per `components/ui/README.md`).
9. `components/admin/onboarding/ImportStep.js` (new): `ImportStepBody` pure render (tested with `renderToStaticMarkup`); `ImportStep` handles polling, visibility, backoff, act, `onChoose("connect")`.
10. `components/admin/onboarding/StepPanels.js`: only `ImportPanel`, rendering `<ImportStep step onChange onChoose />`; drop the `SyncProgress` import.
11. `components/admin/onboarding/Onboarding.js`: one line — pass `onChoose={choose}` to `Panel` (shared file).
12. `scripts/test-onboarding.js`: one stub-map entry for `@/components/admin/onboarding/ImportStep`.
13. Drill `scripts/drills/p6/import.mjs` (new stage `i`, registered in `run.mjs`; run as `pnpm drill:p6 baseline,i`): plant `sync_runs` rows via `p6Sql` with a live lease (`lease_owner='drill'`, `lease_until` +1 h) so the GET nudge finds the run busy; running — bump 120 → 300 of 480, the count updates without a reload, then the collections stage; retrying 429 — "Next try at about …"; failed 401 — "Reconnect Shopify" selects step 1; complete with 3 skipped — the list shows; no `/api/admin/sync` requests for 10 s after complete or while hidden; support read-only if the seed has a support login; screenshots at 1440 and 390.

### 6. Checks first

1. Base suites: `node scripts/test-first-sync.js && node scripts/test-sync-generations.js && node scripts/test-platform-sync.js && node scripts/test-onboarding.js && node scripts/test-support-reads.js && node scripts/test-schema-compat.js`.
2. 0028 free: `git branch -a`; `git diff main...<each open branch> --name-only -- migrations/tenant`.
3. `collectionsCount` in API 2025-10 (unconfirmed): if missing, `collections_total` stays NULL.
4. `node -e "import('radix-ui').then(m=>console.log('Progress' in m))"`.
5. `rg -n "Object.keys\(|deepEqual|same\(" scripts/test-first-sync.js scripts/test-support-reads.js | rg -i "sync|view"`.
6. `rg -n "stagePlan|logins" scripts/drills/p6/lib.mjs scripts/seed-design-documents.js`.

### 7. Risks

1. The constraint fallback is the most delicate change: tell a guard abort (lost lease, also a constraint error) from a bad row by re-reading the run first (as `commit()` does). Run `test:first-sync`, `test:sync-generations`, `test:shopify-boundary`, `test:security` as neighbours.
2. Writing the new columns on a store without 0028 would break every sync: test column detection on a 0027 fixture.
3. Shared with parallel lines: `Onboarding.js`, `test-onboarding.js`, the 0028 number — keep each edit to one line.
4. "You can close this page, it keeps going" is true only while the GitHub Actions tick runs; say "keeps going", not how fast.
5. The time-left estimate is skewed after resumes (`started_at` includes waiting); strict conditions and rounding limit it; ui-designer to confirm the words.

## Line 6: palette, logo and live preview in step 3

**Fit:** builds on line 3. No migration, no new API route. Lines 4, 5 and 7 edit the other panels in parallel.

### 1. Feature list (floor)

**Starter store**
1. Step 3 rebuilt on the new UI, replacing FirstRun and BrandStep, keeping everything FirstRun does: makes the starter store once automatically (`POST /api/admin/first-run`, only if the role can edit); every view — ready (with `madeSentence`), kept, syncing, sync-failed, making, make-failed with Try again, half (`HALF_WORDS`, `HALF_RETRY`), blocked with its reason. Sync notes use `SyncProgressBody` in `data-legacy` (as ImportPanel). Empty-catalog and no-collections notes and the "Edit the home page" links stay.

**Colours**
2. A shadcn RadioGroup of the six `PALETTES` (swatches from `paletteStyle`); current palette preselected; `paletteId == null` shows the "own colours" words with nothing selected.

**Logo**
3. "Upload a logo" sends the file through `uploadImage` (`lib/media-upload.js`); the logo is used only after Save.
4. "Choose from your library" opens MediaPicker as today, in `data-legacy`.
5. Change logo, Remove logo, alt-text field (empty → store name). `LIBRARY_RE` checked on the client; `mediaInLibrary` stays on the server.

**Description**
6. One line, max 160 characters, live `n/160` counter, small search-result snippet (store name, address, description).
7. A role without `settings.write` sees the field disabled with `cannotDescribe` and never sends it.

**Live preview**
8. A real preview of this store's home page (`/`) with drafts and the design draft.
9. Every palette, logo or description change shows in the frame in under 100 ms via a message to the frame, not a write; nothing saved until Save.
10. After Save the frame reloads and shows the saved draft.
11. After any frame reload the unsaved choices are re-sent.
12. "Loading", "Reconnecting…" and "couldn't open" states with the existing controller's words and re-mint logic.
13. "Phone | Computer" width toggle; Computer renders at 1280px scaled down.
14. Until a home page exists: "Your preview appears once your starting store is made."

**Layout**
15. From 1024px form and preview side by side, preview sticky; below 1024px a sticky "Preview" button opens a bottom Sheet; the frame stays mounted after first open (minted once).

**Save and Skip**
16. Exactly as today: same `POST /api/admin/brand-step` bodies, `savedLines`, `BRAND_STEP_PARTIAL` with the revision, 409 `DOCUMENT_CHANGED` with its words plus a new "Load the latest" control.
17. Skip discards unsaved choices and resets the preview.
18. "Undo my changes" returns the form to what is saved.
19. "Unsaved changes" note while choices differ; `beforeunload` guard.
20. Unsaved choices kept in `sessionStorage` (per store origin) across step switches and reloads; cleared on Save or Skip.
21. `onChange` re-reads the steps after making the store, after a sync settles, after Save or Skip.

**Roles**
22. Support and operator-support: every control disabled with the reason, frame shows saved drafts, nothing ever POSTed.
23. Staff can change palette and logo; description disabled.

**Retirement**
24. Delete `components/admin/first-run/FirstRun.js` and `BrandStep.js`.
25. Fix references: `test-brand-step`, `test-first-run`, `test-onboarding`; `MANUAL-CHECKS.md:1044`; the "Change colours and logo" `#brand` link becomes a scroll to the form.

Out of scope: restyling MediaPicker and SyncProgress (Phase 2, line 5); opening the store (line 7).

### 2. Data

None. `brand-step`, `first-run`, `preview-session` and media routes reused as they are; `sessionStorage` is client-only.

### 3. Preview mechanism

Existing preview session plus a "brand overlay" message to the frame (no draft-render route): one render path, the store's signed preview cookie, Edge-safe storefront code.

- **Console:** new `BrandPreview.js` reuses `createPreviewController` and `startDocumentsPreview({showDesign:true})` from `documentsApi.js`; the controller gets a `hello` option, default `{type:"storeasy:editor:hello", v:2}`, onboarding sends `{…, look:true}`.
- **Frame (`bridge-core.js`):** look mode — clicks and submits still swallowed, no picks posted, no outline classes, class `storeasy-look` hides `[data-preview-bar]`. New message `{type:"storeasy:brand", paletteId|null, logo:{media,alt}|null, description|null}` accepted only when the bridge is v2, the frame is a working preview (`ok === true`), and the message comes from the same origin and `win.parent`. Colour styles are computed inside the frame from the palette id via a resolver `PreviewBridge.js` builds from `paletteById` and `brandCssVars` (both Edge-safe); no CSS text crosses the boundary; unknown ids ignored; styles go into `<style id="brand-vars-draft">` after `#brand-vars`, and `data-kit` is set on `<html>`. Logo accepted only if it matches `^/api/media/[A-Za-z0-9_-]{1,120}$`; sets `src`, `alt`, `hidden` on the logo slots. Description set with `textContent` on `[data-store-tagline]`, capped at 160. All-null clears the overlay.
- **Storefront markup (`Header.js`, `Footer.js`):** only when `editing` is true, the Wordmark renders `<img data-store-logo-img hidden>` and `<span data-store-logo-text>`; the Footer renders `<p data-store-tagline hidden>`. Shopper markup unchanged.

### 4. Permissions and least-trusted tests

| Action | owner | admin | staff | support / operator-support | signed out | shopper |
|---|---|---|---|---|---|---|
| GET first-run and brand-step, preview-session create (`storefront.read`) | yes | yes | yes | yes (read-only frame) | 401 | – |
| POST first-run, brand-step palette/logo/skip, media upload (`storefront.write`) | yes | yes | yes | 403, controls disabled | 401 | – |
| Change the description (`settings.write`) | yes | yes | 403 `DESCRIPTION_NOT_ALLOWED`, disabled | 403 | 401 | – |
| Brand overlay in the frame | founder's frame only | | | saved state only | – | never |

Tests: support panel renders every control `disabled` with the reason and `net.posts()` is `[]`; support POST brand-step and first-run → 403 (kept); staff description change → 403, nothing written; anonymous `GET /` (open and closed) has no `data-store-logo-img` or `data-store-tagline` slot, no bridge, no draft palette or logo; bridge ignores messages from another origin, when `ok:false` (live store, revoked or expired session) and before the v2 hello; unknown palette id, `javascript:` or `https://evil` logo URL, and `<script>` in the description have no effect; look mode posts no picks; another store's preview cookie refused (`test-preview-overlay`, kept).

### 5. Events

Save and Skip keep `slog brand_step_saved` and the audit row (`storefront.write` or `settings.write`, resource `brand-step`); uploads keep the media route's; preview keeps `slog preview_session_created`; the overlay sends and logs nothing.

### 6. File plan (WP-A then WP-B)

**WP-A: frame side (Edge-safe)**
1. `components/preview/bridge-core.js`: look mode and the `storeasy:brand` handler with an injected `brandFor` resolver.
2. `components/preview/PreviewBridge.js`: the resolver from `palettes.js` and `brand.js`; look-mode CSS.
3. `components/Header.js`, `components/Footer.js`: editing-only slots.
4. `components/admin/editor/editorModel.js`: the `hello` option on `createPreviewController`.
5. `scripts/test-preview-frame.js`: the bridge cases above, and an Edge check that `PreviewBridge`'s imports pull in no `node:*`.

**WP-B: console side**
6. `components/ui/radio-group.js`, `components/ui/label.js` (generated in a scratch project, restyled; import from `radix-ui`).
7. `components/admin/onboarding/brandModel.js` (new, pure): moved from FirstRun and BrandStep — words, `viewOf`, `afterMake`, `madeSentence`, `HALF_*`, `REASON_WORDS`, `saveBody`, `savedLines`, `paletteStyle`; new `overlayMessage(form)`, `isDirty(form, saved)`, `DRAFT_KEY`.
8. `components/admin/onboarding/useStarterStore.js` (new): FirstRun's GET and one-time POST as a hook.
9. `components/admin/onboarding/BrandPreview.js` (new): the iframe (keeps `data-preview-frame`), the controller, re-sending the overlay on every ready and change, Phone/Computer toggle, status words.
10. `components/admin/onboarding/BrandStepPanel.js` (new): feature items 1–23; keeps `data-brand-step`, `data-palette`, `data-brand-done`, `data-first-run`.
11. `components/admin/onboarding/StepPanels.js`: `BrandPanel` only — renders `BrandStepPanel`, drops the `FirstRun` import, `BrandPanel.wide = true`.
12. `components/admin/onboarding/Onboarding.js`: wide layout when `Panel.wide` and the step isn't blocked (grid `lg:grid-cols-[200px_minmax(0,1fr)]`, max 1200px), otherwise `lg:max-w-[920px] mx-auto` as today; brand out of the grey tray; Welcome card and step header stay 640px.
13. `components/admin/shell/AdminShell.js:128`: onboarding `main` → `lg:max-w-[1200px]`; update the comment.
14. Delete `components/admin/first-run/FirstRun.js` and `BrandStep.js`.
15. Tests: `scripts/test-brand-step.js` points the rendered section at `BrandStepPanel.js`; `scripts/test-first-run.js:1272` reads `HALF_WORDS` from `brandModel.js`; `scripts/test-onboarding.js` §5 mounts `useStarterStore.js`.
16. New `scripts/test-onboarding-brand.js` (`test:onboarding-brand`): model functions; panel per role (owner, staff, support); unsaved choices keep/undo/clear; overlay message; 409 and partial-save paths; shopper markup check.
17. `scripts/drills/p6/brand.mjs` (and `lib.mjs` if needed): selectors → `[data-palette][aria-checked=true]` (Radix radios); new checks — at 1280px picking Forest puts Forest `frameCssVars` in the frame within 1 s before Save; the logo in the frame header before Save; Skip resets the preview; at 390px the Preview sheet opens and shows the frame; support sees disabled controls and a frame; existing editor and shopper checks kept.
18. Docs: wide-step note in `docs/UI.md`; `docs/cms-reviews/MANUAL-CHECKS.md:1044`.

### 7. Checks first

1. `node scripts/test-brand-step.js && node scripts/test-first-run.js && node scripts/test-onboarding.js && node scripts/test-preview-frame.js && node scripts/test-preview-overlay.js && node scripts/test-support-reads.js`, then `pnpm drill:p6 baseline,b` on HEAD.
2. `cat components.json`; `node -e "import('radix-ui').then(m=>console.log(!!m.RadioGroup,!!m.Label))"`; generate radio-group and label in a scratch project and confirm they import from `radix-ui` (current shadcn docs default to Base UI).
3. `rg -n "storeasy:editor:hello|data-preview-bar|first-run/(FirstRun|BrandStep)" components scripts lib app`.

### 8. Risks

1. `Onboarding.js` and `AdminShell.js` are shared with lines 4, 5 and 7: keep these edits to a few lines.
2. The overlay changes DOM React owns: safe while Header and Footer props don't change, and a reload resets it; the drill must prove the logo survives opening the mobile menu in the frame.
3. One preview cookie per browser: minting in onboarding moves an open editor tab's frame onto the new session; the adopt logic handles it; drill with the editor open in a second tab.
4. Each visit to step 3 adds a 1-hour `preview_sessions` row; accepted (revoking on unmount could end a session an editor tab adopted).
5. About 60 rendered cases in `test-brand-step` are retargeted; run `test:security` and `test:shopify-boundary` alongside.

## Line 7: open the store from onboarding step 4

**Fit:** builds on line 3. No new API route, no new publish function, no migration. Step 4 runs the editor's own client publish flow (`createPublishFlow` in `publishModel.js`) through `documentsApi.call` → `PUT /api/admin/documents` → `publish()` → `openingGate`, so checks, `publish_log` in the release batch, the audit row and "starter drafts are never in the set" are the editor's own code.

### 1. Feature list (floor)

1. Step 4 lists every opening item with its own fix (`openingReport()` plus a "home page" line), role-gated on the server.
2. **Payment:** checkout off → "Turn on checkout" sets cash on delivery inline via `PUT /api/admin/settings {commerce:{checkout_mode:"direct"}}`, beside "Add Razorpay keys" → `/admin/settings?from=onboarding#payments` (keys are never taken in onboarding); COD only → an info line plus the same optional Razorpay link; billing paused → `/admin/billing?from=onboarding`; Shopify checkout mode → "Storeasy's team fixes this."
3. **Back link:** with `?from=onboarding`, Settings and Billing show "Back to onboarding" → `/admin/onboarding?step=open`; the existing focus refresh re-reads the steps.
4. **Privacy and returns:** missing → "Start a privacy page" / "Start a returns page" (`/api/admin/policy-start`); started → "Read it" opens an inline Sheet reader of the draft text (`getDocument`), with "I've read it" only at the end of the text and "Edit in the editor" beside it; saved or live → a status line with "Open in editor"; "These are starting points, not legal advice" stays.
5. **Contact:** while both are empty, an inline support email and phone form saving via `PUT /api/admin/settings {identity:{support_email, support_phone}}`.
6. **Test order:** "Open your preview" plus the existing "I placed a test order" / undo (`POST /api/admin/onboarding`).
7. **Other items:** catalog, design, maintenance keep their links; Settings links disabled with a reason for roles without Settings.
8. **Home page missing:** a blocking item "Make your home page in step 3"; Open disabled.
9. **"Open your store"** enabled only with `storefront.publish` and nothing blocking; otherwise disabled with the reason.
10. **Confirm dialog** (`flow.open([{id:"doc_home"}])`): lists everything going live (home plus the offer the flow folds in — design draft, founder-saved policy pages), each with "first version" or its number of changes; the "Worth checking" warnings; says once that other drafts stay drafts; button "Open my store" or "Open my store anyway" with warnings; sends `confirmOpen`; disabled until every list has loaded (`canConfirm`).
11. **Dialog answers:** `offer` → list the unpublished linked pages, then confirm; `cannotOpen` → the payment fix; `blocked`, `refused`, `conflict`, `noHome` → the server's words plus "Open the editor to fix this" and "Try again"; `checking`/`checked` → a lost answer is resolved, never shown as a failure; busy → no double send; Esc and Cancel close before sending; after sending it says the publish keeps running.
12. **Done state** (after the click and on reload): "Your store is open", the store address linked to the live site (`liveExitUrl("/")`), "Go to your dashboard"; the model refreshes via `onChange`.
13. **Staff and support:** every item and reason, every control disabled with its reason under it; no button is ever refused after a click.

### 2. Data

None.

### 3. Permissions and least-trusted tests

| Action | owner / admin | staff | support | signed out |
|---|---|---|---|---|
| See step 4 (GET onboarding, `storefront.read`) | yes | yes | yes, all controls disabled | 401 |
| Open (`documents publishSet`, `storefront.publish`) | yes | 403, "Only the owner or an admin can open the store" | 403, read-only reason | 401 |
| Turn on checkout, save contact, mark test order (`settings.write`) | yes | 403, disabled | 403, disabled | 401 |
| Settings or Billing link (`settings.read`) | link | disabled with reason | disabled | — |
| Start a policy page, "I've read it" (`storefront.write`) | yes | yes | 403, disabled | 401 |
| Read a policy draft (`getDocument`, `storefront.read`) | yes | yes | yes | 401 |

Tests: support — every open-step action `allowed:false` with a reason; no Razorpay key id or secret flag in the response; `publishSet` 403 with no release, `publish_log` or audit row; settings PUT 403 with `checkout_mode` unchanged. Staff — the same publish and settings 403s. Signed out 401. Anonymous shopper sees the maintenance page before opening and home (200) after (drill).

### 4. Events

None new: `storefront.publish` audit + `publish_log` in the batch; `settings.write` audit for checkout and contact; the policy starter's record; the test-order audit and `slog onboarding_step`.

### 5. File plan (A → B → C)

**WP-A: model and tests**
1. `lib/documents/opening.js`: export `FIX_HREFS` (checkout off, payments, billing, store profile) and use them in the items; response shape unchanged.
2. `lib/onboarding/open-step.js` (new, pure, imports only `authz`): `OPEN_ACTION_PERMS` (`cod_on`, `contact_save`, `settings_link` …), `OPEN_WORDS`, `openStep(f, role, action)` → items with role-gated `fix` descriptors, the home item, done facts `{storeAddress, liveUrl}`.
3. `lib/onboarding/steps.js`: spread `OPEN_ACTION_PERMS` into `ACTION_PERMS`; delegate both open branches to `openStep`; `WORDS.open = OPEN_WORDS`.
4. `lib/onboarding/service.js`: add `storeAddress` and `liveUrl` to the facts (one line).
5. `scripts/test-onboarding-open.js` (new) + `test:onboarding-open`: runs `createDocumentsApi({fetch})` → `handleDocumentsPut` in-process (pattern in `test-open-checks.js`): starter unread → Open not allowed; mark read → the flow can confirm; confirm → live release, `publish_log` rows for every published id with that release, an audit row, starter never in the set; turning checkout on unblocks; contact save keeps other fields; the §3 role matrix; a source guard that `components/admin/onboarding/` never imports `lib/documents/publish*` and never fetches `/api/admin/documents` except through `documentsApi`.
6. Update line 3's word assertions in `scripts/test-onboarding.js`.

**WP-B: UI**
7. `components/ui/dialog.js` (shadcn Dialog on `radix-ui`, per `components/ui/README.md`).
8. `components/admin/onboarding/OpenStepPanel.js`: items and fixes, gating, done state.
9. `components/admin/onboarding/OpenStoreDialog.js`: renders `createPublishFlow` state.
10. `components/admin/onboarding/PolicyReader.js`: the Sheet reader.
11. `components/admin/onboarding/BackToOnboarding.js`: the back link.
12. `components/admin/onboarding/StepPanels.js`: replace the Open section with `export { default as OpenPanel } from "./OpenStepPanel"`; drop the open-only `PANEL_WORDS`.
13. `app/(console)/admin/(authed)/settings/page.js`, `billing/page.js`: read `searchParams.from`, show `BackToOnboarding`.
14. `docs/UI.md`: add Dialog to "Installed so far".

**WP-C: drill**
15. `scripts/drills/p6/seed-p6.mjs`: stage `j` (like `c` plus `checkoutMode:"disabled"` and `supportLogin`). (Stage letter `j`: line 5 uses `i`.)
16. `scripts/drills/p6/open-step.mjs` (new): make the starter (`openStart`), turn on checkout, use the Settings back link, start and read both policies, add contact, open from the dialog, the shopper sees home, support sees everything disabled.
17. Register stage `j` in `scripts/drills/p6/run.mjs`; stages c and d unchanged.

### 6. Checks first

1. `git log --oneline -3` shows line 3's commits.
2. `node scripts/test-onboarding.js && node scripts/test-open-checks.js && node scripts/test-policy-start.js && node scripts/test-publish-ui.js && node scripts/test-api-shapes.js && node scripts/test-support-reads.js && node scripts/test-permissions.js`.
3. `node -e "import('radix-ui').then(m=>console.log(typeof m.Dialog?.Root))"`.
4. `rg -n "openButton|Go to Publish in the editor|Open it from the editor|publishHref" scripts components lib`.
5. `pnpm drill:p6 baseline,c,d,h` once on HEAD.

### 7. Risks

1. Merge collisions in `steps.js`, `service.js`, `StepPanels.js`, `package.json`, `run.mjs`, `seed-p6.mjs` (shared with lines 4–6): keep edits to the named hunks; run `test:security`, `test:shopify-boundary`.
2. Only home and its offer go live; other drafts stay drafts, as with the editor's Publish; the dialog must say so plainly.
3. `buildSettingsPatch` identity writes both `support_email` and `support_phone`, so a value saved in another tab could be cleared: pin it in a test; the form shows only while both are empty.
4. The plain-text reader drops formatting: hence "Edit in the editor" beside "I've read it".
5. A store without `doc_home` must show the home item and a disabled Open, never a dialog ending in `noHome`.

## Line 8: operator sees every signup and onboarding step; helps a stuck store from one screen

**Fit:** needs line 3 on main (`lib/onboarding/service.js` `onboardingFor`, `steps.js`); builds on lines 1–2 (`signups`, `failure_kind`, `alerted_kinds`, `resumeSignupRun`, `createSupportGrant`).

### 1. Feature list (floor)

1. **Page** `/platform/onboarding` on `components/ui`, linked from the `/platform` nav as "Signups & onboarding"; signed-out → redirect to `/platform`.
2. **One row per subject:** a signup has its own row only until its store exists, then the store row carries its details; every store gets a row (closed and open).
3. **Columns:** who (name and email — the signup's, or owners on file); store name and address; status in plain words (waiting for email code, already has an account, setting up, failed — retries used up / needs us / lapsed, address freed, superseded, expired, closed, open, suspended); provisioning step and attempt count, next retry time, "operator alerted"; onboarding step (1–4) with state and problem text; time stuck ("stuck 2 d 4 h"); latest note; "support access open until X".
4. **Filters** (in the URL): views Needs attention (default), In signup, Closed stores, Open stores, Lapsed or freed, All; "stuck more than" 1, 6, 24 (default), 72 hours; a count on each view.
5. **Search:** text with `@` → exact email match (signup or owner email); otherwise substring on store name, address or founder name.
6. **Paging:** 50 rows with keyset cursors; sort stuck longest (default) or newest.
7. **Detail sheet:** signup facts and the provision run's steps with scrubbed errors; live onboarding steps (read fresh; updates the snapshot); owners and pending invites (email, role, expiry; never a token); mail history (kind, recipient, status, time; never the body); support grants, notes, last 20 audit rows.
8. **Help actions** (only when they apply; each refusal says what to do next):
   - **Resume provisioning:** signup runs via `resumeSignupRun` + `after()`; other runs via `runProvision` as `/api/platform/provisions` does.
   - **Resend the email code** (pending or existing signups): same 60 s gap and 5-send limit; still works only in the founder's browser.
   - **Email sign-in help:** the store's `/admin/login` address plus a one-hour single-use reset link, to an owner email chosen from those on file.
   - **Email an owner invite** (store with no owner): a 7-day invite to the email on file; any earlier unused owner invite for that email expired.
   - Neither email action returns a token or link to the operator; the operator can't type a recipient; no handoff token is ever made for an operator.
   - **Open or revoke time-boxed support access:** reason ≥ 5 characters, 1–72 hours; then "Open store console (read-only)" links to the store's `/admin`.
   - **Free a lapsed signup's address** (AlertDialog); refused when the signup isn't lapsed or is still provisioning, a store uses the slug, the run made a database that still exists (via `turso-api` `getDatabase`, or the file for the file driver), or the database can't be checked; optional checkbox emails the founder a "start again" note.
   - **Add a note:** 1–1000 characters, append-only, with operator and time.
9. **Retire the old handoff route** (owner decision: remove legacy remnants): delete `app/api/platform/tenants/[id]/handoff/route.js` and its UI in the operator console (TenantDetail or wherever it shows an invite link), replacing them with this screen's email-only sign-in help and owner invite; guard-table rows removed; a test that the old path answers 404.
10. **Every state:** loading skeleton, empty ("No stores need attention"), error with Try again, many rows (truncated names with tooltip), keyboard use.

Out of scope: the create-a-store form (line 9); the rest of the operator console (Phase 3).

### 2. Data: `migrations/platform/0014_operator_onboarding.sql` (nothing destructive; renumber at merge if taken)

```sql
CREATE TABLE IF NOT EXISTS onboarding_progress (      -- operator cache; the founder page stays live
  tenant_id TEXT PRIMARY KEY, supported INTEGER NOT NULL DEFAULT 1,
  open INTEGER,                    -- 1 | 0 | null unknown
  current_step TEXT,               -- connect|import|brand|open|null
  done_count INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL DEFAULT '[]',-- [{id,state,problem?,blockedBy?}] no facts/actions/domain
  step_since TEXT,                 -- when current_step+state last changed
  checked_at TEXT NOT NULL, check_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_stuck ON onboarding_progress(open, step_since);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_checked ON onboarding_progress(checked_at);
CREATE TABLE IF NOT EXISTS operator_notes (
  id TEXT PRIMARY KEY,             -- opn_<16hex>
  subject TEXT NOT NULL,           -- 'signup:<id>' | 'tenant:<id>'
  body TEXT NOT NULL, operator_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_notes_subject ON operator_notes(subject, created_at);
CREATE INDEX IF NOT EXISTS idx_signups_created ON signups(created_at);
CREATE INDEX IF NOT EXISTS idx_signups_tenant ON signups(tenant_id);
ALTER TABLE signups ADD COLUMN released_at TEXT;
ALTER TABLE signups ADD COLUMN released_by TEXT;
```

`signups.status` gains `released` (outside the live-slug partial index and `LIVE`); new job type `onboarding_sweep`; new `PLATFORM_MAIL_KINDS` `operator_signin_help`, `operator_owner_invite`, `operator_start_again`. When the first snapshot finds a store on step 1, `step_since` = the store's `created_at`; otherwise the check time, shown as "at least".

### 3. Permissions and least-trusted tests

| Action | signed out | any merchant role (owner, admin, staff, support, owner of store B) | operator without TOTP / not an operator | operator (TOTP) |
|---|---|---|---|---|
| page `/platform/onboarding` | redirect | redirect | redirect | allowed |
| `GET /api/platform/onboarding` (list, `?subject=`) | 401 | 401 | 401 | allowed |
| `POST` (every action) | 401 (403 cross-origin) | 401 | 401 | allowed, audited |

All checks via `lib/platform/admin-auth.js`; new `platformOperator(cookie)` → `{id}` so audit rows name the real operator (bootstrap token → `{id:"bootstrap"}`, dead once operators exist); `verifyPlatformToken` unchanged.

`scripts/test-operator-onboarding.js`: merchant roles via `makeRoleStore` (owner, admin, staff, support, owner-b) and no cookie → 401 on list, detail and every action; a merchant token in `_platform` → 401; password without TOTP sets no cookie; an `operator` session for a user with `is_operator=0` → 401; revoked or expired operator session → 401; bootstrap token when an operator exists → 401; cross-origin POST → 403; response keys against an allowlist (no `*_hash`, `ip`, `db_url`, `db_token`, 64-char hex); sign-in help and invite responses carry no token or `token=`; mail goes only to the address on file even if the body names another `to`; freeing refused in each refusal case and afterwards `slugAvailable(slug).ok`; every POST writes exactly one audit row with the operator id; a note's body never in an audit diff; keyset pages hold no duplicates; the stuck filter on a fake clock.

### 4. Events

Audit (real operator id; no email or note text in diffs): Resume `tenant.provision` `{resumed, via:"onboarding", signup}`; Resend code `signup.code_resent`; Sign-in help `founder.signin_help_sent` `{mail}`; Owner invite `team.invite_created` `{role:"owner", via:"operator-onboarding"}`; Free address `signup.address_released` `{slug, db:"none"|"absent", notified}`; Support access `support.grant_created` / `support.grant_revoked`; Note `operator.note_added` `{subject, chars}`. `slog`: `onboarding_sweep{checked, failed}`, `onboarding_snapshot_failed{tenant}`, `operator_help{action, subject}`.

### 5. File plan (A → B → C)

**WP-A: server**
1. `migrations/platform/0014_operator_onboarding.sql`.
2. `lib/platform/admin-auth.js`: `platformOperator()`.
3. `lib/platform/platform-mail.js`: the three new kinds.
4. `lib/platform/signup.js`: `resendCodeById(signupId)` sharing `resendCode`'s internals and limits.
5. `lib/onboarding/snapshot.js` (new): `snapshotTenant(tenant)` (`withTenant` + `onboardingFor({role:"support"})`, upsert with the `step_since` rule); `sweepOnboarding({limit:10})` (never-checked stores first, then closed not checked in 30 min, then open not checked in 24 h; 5 s cap per store); `queueOnboardingSweep(now)` (one job per 10-minute window, deduplicated by key).
6. `lib/platform/onboarding-ops.js` (new): `listOnboarding`, `onboardingCounts`, `onboardingSubject`, `resumeForSubject`, `resendSignupCode`, `sendSigninHelp`, `sendOwnerInvite`, `releaseSignupAddress`, `addOperatorNote`; help emails throttled 5 per store per hour (`loginThrottle`); the list fetches one page of ids first, then enriches only those ≤ 50.
7. `lib/platform/worker.js`: `onboarding_sweep` handler.
8. `app/api/jobs/tick/route.js`: one `queueOnboardingSweep()` call.
9. `app/api/platform/onboarding/route.js` (new; `runtime="nodejs"`, `maxDuration=60`, `sameOrigin`); support grants reuse `createSupportGrant` and `revokeSupportGrant` with the operator id.
10. `scripts/test-operator-onboarding.js` + `test:operator-onboarding`; update `scripts/test-jobs.js`; `latestPlatformMail({kind, recipient})` in `scripts/support/signup-mail.js`.

**WP-B: UI**
11. `components/ui/{table,badge,textarea,alert-dialog,label}.js` (per `components/ui/README.md`; reuse any a sibling line already added).
12. Move the `data-legacy` wrapper out of `app/(console)/platform/layout.js` (becomes a pass-through) into `page.js`, `loading.js`, `error.js`.
13. `app/(console)/platform/onboarding/page.js` (verify the operator, else `redirect("/platform")`) and `loading.js`.
14. `components/platform/onboarding/`: `OnboardingOps.js` (views, filters, search, URL state, paging), `OnboardingTable.js`, `SubjectSheet.js` (detail, actions, notes), `onboardingWords.js` (pure status → words and badge tone; unit-tested).
15. `components/platform/PlatformAdmin.js`: one nav link only (line 9 edits this file).

**WP-C: drill and docs**
16. `scripts/drills/operator-onboarding/run.mjs`, registered in `scripts/drills/run-isolated.mjs`, `drill:operator-onboarding`: a failed signup (fake Turso 402) shows under Needs attention; Resume brings it to done; the store then shows step 1 with a stuck time; sign-in help sends a mock mail whose reset link works on the store host; support access opens and its banner shows; a lapsed signup's address is freed and a new signup can take it; a note shows; evidence in `docs/cms-reviews/drills/OPS-ONBOARDING/`.
17. `docs/UI.md` "Installed so far".

Avoids `components/admin/onboarding/*` and `lib/onboarding/service.js` (lines 4–7).

### 6. Checks first

1. Line 3 on main: `git -C "/Users/snehal/Documents/Projects 2026/storeasy26" log --oneline -1 -- lib/onboarding/service.js`.
2. `ls "/Users/snehal/Documents/Projects 2026/storeasy26-wt"/*/migrations/platform/ "/Users/snehal/Documents/Projects 2026/storeasy26-wt"/*/components/ui/`.
3. `node scripts/test-signup-provision.js && node scripts/test-signup.js && node scripts/test-jobs.js && node scripts/test-identity.js && node scripts/test-security.js && node scripts/test-console-ui.js`; `pnpm drill:signup` once.
4. `rg -n "totpCode|_platform" scripts/drills scripts/drill-maintenance-edge.js scripts/support/route-harness.js`.
5. `rg -n "platform" scripts/test-schema-compat.js` (if platform migrations aren't covered, the suite runs `runMigrations(..., "platform")` on a fresh file DB).

### 7. Risks

1. Merge conflicts: `worker.js`, `tick/route.js`, `PlatformAdmin.js` (line 9), `signup.js`, `platform-mail.js` kinds, migration 0014, shared `components/ui` files — merge one line at a time, renumber if needed.
2. Sweep cost: full `onboardingFor` includes `openingReport`; at 10 stores per 10 min, >~1,000 closed stores could leave stuck times hours stale; the detail sheet reads live.
3. Checking a database is gone depends on `getDatabase` returning 404; with the CLI driver or Turso unreachable, freeing is refused; test against the fake's 404.
4. Reset links in stored mail are credentials: non-production mock mail keeps bodies in `platform_mail`; production never mocks ("Mail isn't set up"). Review closely.
5. The old handoff route is removed here (feature item 9); check nothing else (docs, drills, MANUAL-CHECKS) still points at it.

## Line 9: an operator creates a store for a founder

**Core decision:** an operator-created store is a `signups` row with `source='operator'`, run through the same `provision_store` job, status steps, retry and failure kinds as a signup; line 8's screen and Resume work on it unchanged. When the job finishes it emails an owner invite instead of making a user.

### 1. Feature list (floor)

1. **Page `/platform/stores/new`** on `components/ui`, linked as "New store" from the `/platform` header, its empty state and `/platform/onboarding`; non-operators → `/platform`.
2. **Fields:** store name (2–60); owner email; founder name (optional, 0–80; email greeting and line 8's "who" column); Shopify domain via `normalizeShopDomain` (`x`, `x.myshopify.com` or an admin URL; custom domains get line 4's words); store address (optional, default `slugFor(name)` as typed, shown as `<slug>.<SIGNUP_STORE_DOMAIN>`); Shopify app client id and secret (optional, as a pair; one without the other refused; secret is a password field).
3. **Live checks (debounced):** address via `slugAvailable` (reserved, existing stores and domains, live signups) with the signup words; shop refused if any tenant (any status) has that `shopify_store_domain` ("<store> already uses this Shopify store") or a live operator-created store holds it; an email with an account shows "They'll accept with their existing Storeasy password."
4. **Submit queues the job** (no inline provisioning): insert the row (`verified`, then `claimSignupProvision`), `after(runJobById)`; URL becomes `?signup=sgn_…` so a reload resumes progress; unique indexes refuse a double submit; 20 creates per operator per hour; refuse in plain words if `SIGNUP_STORE_DOMAIN` or a DB driver (`signupDbDriver()`) is missing.
5. **Progress** via line 2's model (`stepStates`), last step relabelled "Sending the owner's invite"; poll every 1.5 s, back off when hidden; `aria-live`; the retry note; both failure kinds with plain words and "Try again" via line 8's `resume` action.
6. **On finish:** a 7-day owner invite emailed to the owner (`operator_store_invite`, the store's own origin); earlier unused owner invites for that email expire; the encrypted client secret cleared from the row; done screen shows "Invite sent to x" (or "Invite not sent" with Resend), the store address, whether the Shopify app is set up, the redirect URL to add to the store's Shopify app (`<host>/api/admin/shopify/callback`), and a link to the store's row on `/platform/onboarding`.
7. **Resend invite** = line 8's `owner_invite` action (5/hour throttle); refused once the store has an owner; the first automatic invite doesn't count.
8. **Accepting:** new account sets name and password, `email_verified_at` set (the invite proved the email); existing account must enter its current password, checked before the token is spent (a wrong password leaves the invite usable); then `/admin` → `/admin/onboarding`, step 1 showing their shop (locked, Connect enabled if the app was set up, else "Storeasy's team is preparing…"); the accept page shows the store name and invited email.
9. **Operator never sees a token or link:** no `stores` or `onboarding` answer contains one; only the local mock mail body has it.
10. **Line 8 integration:** rows carry `source`, badge "Created by Storeasy", never lapse, resume through the job; the provisions panel shows the badge.
11. **States:** field errors, loading skeleton, error with Try again (typed input kept), keyboard-only, long names truncated with tooltip.

Out of scope: shared Shopify app (OQ-06); custom storefront domains at creation; adopting an existing DB or legacy editor (CLI only); the legacy `admin_password` secret (cleanup line).

### 2. Data: `migrations/platform/0015_operator_create_store.sql` (nothing destructive)

```sql
ALTER TABLE signups ADD COLUMN source TEXT NOT NULL DEFAULT 'signup'; -- signup | operator
ALTER TABLE signups ADD COLUMN created_by TEXT;          -- operator user id
ALTER TABLE signups ADD COLUMN shop_domain TEXT;         -- normalised x.myshopify.com
ALTER TABLE signups ADD COLUMN shopify_client_id TEXT;
ALTER TABLE signups ADD COLUMN shopify_secret_enc TEXT;  -- encryptSecret k1:, NULL once done
ALTER TABLE signups ADD COLUMN invite_id TEXT;
ALTER TABLE signups ADD COLUMN invite_status TEXT;       -- sent | mock | failed
CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_shop_live ON signups(shop_domain)
  WHERE shop_domain IS NOT NULL AND status IN ('verified','provisioning','failed');
CREATE INDEX IF NOT EXISTS idx_signups_source ON signups(source, created_at);
```

Operator rows: `browser_hash = sha256(random32)` (no cookie ever matches); `password_hash` NULL; `expires_at = 9999-12-31T23:59:59.999Z`; `signupLapsed` and its copy in `signup.js` return false for `source='operator'`. New mail kind `operator_store_invite`; run params `source:"operator"`.

### 3. Permissions and least-trusted tests

| Action | signed out / shopper | any merchant role (incl. owner of B) | non-operator session, operator without TOTP, bootstrap once operators exist | operator (TOTP) |
|---|---|---|---|---|
| page `/platform/stores/new` | redirect | redirect | redirect | allowed |
| `GET /api/platform/stores` (`?check`, `?signup=`) | 401 | 401 | 401 | allowed |
| `POST /api/platform/stores` | 401 (403 cross-origin) | 401 | 401 | allowed, audited |
| `POST /api/platform/tenants` | 405 | 405 | 405 | 405 (retired) |
| `GET/POST /api/admin/accept-invite` | token on its own store's host only | same; an existing session isn't used | n/a | n/a |

All operator checks via `platformOperator()`. `scripts/test-operator-create-store.js`: every table row; a merchant token in `_platform` → 401; response keys against an allowlist (no `token`, `token=`, `*_enc`, `secret`, `db_*`, 64-char hex); duplicate shop refused (tenant of any status and a live row; case-varied and admin-URL inputs); duplicate or reserved address refused; two simultaneous creates → one row; invite can't be accepted for another email (user B signed in posting the token → no membership; membership only to the invite's email); token on store B's host refused and still usable on the right host; existing account with wrong password refused, token not spent; used or expired token refused; resend expires the earlier invite (only the newest works), refused once there is an owner, 6th within an hour throttled; client secret never in `jobs.payload`, `provision_runs`, `audit_log`, `slog` or answers, NULL once done; fake-Turso 503 retries, 402 needs an operator and Resume via `/api/platform/onboarding` finishes it; rows never lapse; each POST writes exactly one audit row with the operator id. Guard rows: `shopper-routes.js` adds `platform/stores` (GET, POST, operator), `platform/tenants` drops to `["GET"]`; `admin-routes.js` adds the accept-invite GET (token).

### 4. Events

Audit (no emails or secrets in diffs): `tenant.provision` (operator actor) `{via:"operator-form", signup, slug, shop, appReady}`; `tenant.provisioned` (actor `{kind:"system", id:"operator-create"}`) `{source:"operator", run, operator}`; `team.invite_created` (creating operator) `{role:"owner", via:"store-created", mail}`; resend keeps line 8's row; `team.invite_accepted` also carries `tenantId` and `{role, existingAccount}`. `slog`: `operator_store_queued`, `operator_store_invite{status}`, `admin_invite_rejected{reason}`.

### 5. File plan (A → B → C)

**WP-A: server**
1. `migrations/platform/0015_operator_create_store.sql`.
2. `lib/platform/platform-mail.js`: the new kind.
3. `lib/platform/provision.js`: the "409 this run never asked for" rule also for `source==="operator"`.
4. `lib/platform/identity.js`: `peekInvite(token, tenantId)` → `{email, role, existingAccount}`; `acceptInvite` checks an existing account's password before `consumeInvite`; new users get `emailVerifiedAt`.
5. `lib/platform/onboarding-ops.js`: extract `mailOwnerInvite({tenant, to, operatorId, base, kind})` (used by `sendOwnerInvite`); list and subject rows carry `source`.
6. `lib/platform/signup.js`: export `stepStates(row, run, {lastLabel})`; lapse rule skips operator rows.
7. `lib/platform/signup-provision.js` operator branch: pass `shopDomain` and client id/secret (decrypted, also on resume); crash recovery matches `source`; send the invite instead of creating a user; mark done and clear the secret.
8. `lib/platform/operator-stores.js` (new): `validateOperatorStore`, `checkOperatorStore`, `tenantsUsingShop`, `createOperatorStore`, `operatorStoreStatus` (runs a due job like `signupStatus`).
9. `app/api/platform/stores/route.js` (new; `nodejs`, `maxDuration=60`, `sameOrigin`, `no-store`).
10. `app/api/platform/tenants/route.js`: delete POST and the `provisionTenant` import.
11. `app/api/platform/provisions/route.js`: operator source like signup (resume via the job, badge data).
12. `app/api/admin/accept-invite/route.js`: GET peek (rate-limited); POST handles existing accounts.
13. `scripts/support/shopper-routes.js`, `scripts/support/admin-routes.js`.
14. `scripts/test-operator-create-store.js` + `test:operator-create-store`; update `test-identity.js`, `test-operator-onboarding.js` (mail kinds, shared invite helper), `test-signup-provision.js` (lapse rule).

**WP-B: UI**
15. `app/(console)/platform/stores/new/page.js`, `loading.js`.
16. `components/platform/stores/CreateStoreForm.js`, `CreateStoreProgress.js`, `createStoreWords.js` (pure; unit-tested in item 14's suite).
17. `components/platform/PlatformAdmin.js`: remove `NewTenantForm`, the `creating` state, both "New tenant" buttons; add a "New store" link.
18. `components/platform/ProvisionRunsPanel.js`: the badge, new empty-state words.
19. `components/platform/onboarding/OnboardingOps.js` (header link), `onboardingWords.js` (source label).
20. `components/admin/AcceptInviteForm.js`, `app/(console)/admin/(auth)/accept-invite/page.js`: existing-account mode, store name and email shown.

**WP-C: drill and docs**
21. `scripts/drills/operator-create-store/run.mjs`, registered in `scripts/drills/run-isolated.mjs`, `drill:operator-create-store`: operator (TOTP) creates a store with app credentials; progress to done; read the mock invite with `latestPlatformMail`; the founder accepts on `<slug>.localhost`, sets a password, lands on `/admin/onboarding` with step 1 showing the shop and Connect enabled; a second store without credentials shows "preparing"; duplicate shop refused; Resend works; evidence in `docs/cms-reviews/drills/OPS-CREATE-STORE/`.
22. `scripts/drills/shell/run.mjs`: `PLATFORM_CONSOLE` regex "New tenant" → "New store".
23. Docs: `docs/onboarding.md`, `docs/platform.md`, `docs/platform-guide.md` route row, `docs/cms-reviews/MANUAL-CHECKS.md` lines 676 and 680.

### 6. Retired

Removed: `NewTenantForm`, the "New tenant" buttons, its one-time console password reveal, `POST /api/platform/tenants` and its guard-table method. Kept: `provisionTenant` and `scripts/provision-tenant.js` (CLI for adopting a DB or legacy editor), `ProvisionRunsPanel` (history, resume, rollback). Flagged for the cleanup line: the per-tenant `admin_password` secret that `register_tenant` still makes.

### 7. Checks first

1. `ls migrations/platform/ "/Users/snehal/Documents/Projects 2026/storeasy26-wt"/*/migrations/platform/ 2>/dev/null` (0015 free).
2. `node scripts/test-signup-provision.js && node scripts/test-operator-onboarding.js && node scripts/test-identity.js && node scripts/test-tenant-ops.js && node scripts/test-security.js && node scripts/test-shopify-connect.js`.
3. `rg -n "expires_at|signupLapsed|lapsed\(" lib/platform`.
4. `rg -n "PLATFORM_MAIL_KINDS|acceptInvite|accept-invite" scripts`.
5. `rg -n "encryptSecret" lib/platform/crypto.js -A8`; `node scripts/test-schema-compat.js` after 0015.

### 8. Risks

1. Lapse and expiry rules are scattered (line 8's SQL views, `signup.js` pruning read `expires_at`); far-future `expires_at` is the safety net; check 3 finds the rest.
2. The accept-invite change affects team invites too: an existing user now needs their password; tests or drills relying on token-only sign-in break.
3. The client secret sits encrypted until the job finishes (a "needs operator" run keeps it): review scrubbing in job errors.
4. Merge conflicts with line 6 and the cleanup line: `PlatformAdmin.js`, `package.json`, `run-isolated.mjs`, `onboarding-ops.js`.
5. Mail failure leaves a store with no owner ("Invite not sent" with Resend); with production mail unconfigured, every operator store waits for an operator to resend.
