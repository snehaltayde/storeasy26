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
