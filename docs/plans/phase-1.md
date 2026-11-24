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
