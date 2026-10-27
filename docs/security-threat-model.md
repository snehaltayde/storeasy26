# Storeasy — security threat model (S34 / BE34)

Living document. Each mitigation names the module that enforces it and the suite
that proves it; residual risks are listed honestly at the end. Release gate:
`pnpm test:security` must pass before any commit.

## Assets

1. **Tenant data** — orders (customer PII + money), carts, events, CMS content,
   catalog. One Turso DB per tenant.
2. **Control plane** — tenant registry, encrypted provider secrets (Shopify
   admin tokens, Razorpay keys), users/sessions, audit log, jobs, support grants.
3. **Platform secrets** — `PLATFORM_SECRET` (envelope key root), per-tenant DB
   tokens, operator sessions.
4. **Shopper trust** — storefront serves the right store, never another
   tenant's, never leaks PII via URLs/referrers.

## Trust boundaries & attacker models

| Boundary | Attacker | Primary defenses |
|---|---|---|
| Internet → storefront | anonymous shopper, scraper, token guesser | fail-closed host resolution (`lib/platform/control.js` resolveHost → `lib/tenant-gate.js`); expiring HMAC order proofs (`lib/orders.js`, v2 tokens); rate limits; Referrer-Policy + URL scrubbing (`lib/track/names.js`) |
| Internet → admin console | credential stuffing, session theft, CSRF | scrypt password hashes + login rate limits (`lib/platform/identity.js`); random session tokens hashed at rest, fresh per-request verify = instant cross-instance revocation (`lib/platform/sessions.js`); sameOrigin checks on every write (`lib/origin-check.js`); TOTP mandatory for operators |
| Internet → webhooks | forged provider calls | raw-body HMAC with per-tenant secrets, timing-safe compare (`lib/platform/shopify-webhooks.js` verifyWebhookHmac; Razorpay equivalent); persist-before-ack inbox (replays are idempotent, S29) |
| Tenant ↔ tenant | hostile co-tenant | DB-per-tenant; AsyncLocalStorage context set only from host resolution — URL/body tenant ids never authorize (S25/S27); overlapping-handle fixtures in `test:tenant-boundary` |
| Merchant roles | over-privileged staff, stolen staff session | role lattice owner⊇admin⊇staff⊇support (`lib/platform/authz.js`), enforced server-side per action in `requireAdmin`; final-owner protection; append-only `audit_log` with redacted diffs (S27) |
| Operator → tenant | rogue/compromised operator | support grants (S34/OP10): time-limited (1–72h), reasoned, audited, merchant-visible banner, always the read-only PII-redacted `support` role; expiry checked fresh per request |
| App → providers | SSRF via attacker-controlled hosts | `normalizeHost` rejects paths/whitespace/credentials (`lib/platform/domains.js`); Shopify shop domains validated against `*.myshopify.com` at OAuth; no user-supplied URL is fetched server-side |
| OAuth flow | CSRF, state replay, token theft | HMAC-signed stateless state with 10-min expiry + dual-key rotation window (`lib/platform/oauth.js`); callback HMAC verified; scopes checked at token mint (BE25) |
| Repo / supply chain | leaked secrets in git | secrets only in gitignored `.env.local`/`.env.staging`; `*.db` gitignored; static gates in `test:security` (live-key literal scan, tracked env/db file scan, client-bundle import scan) |

## Key mechanisms (where to look)

- **Secret storage**: AES-GCM envelopes `k1:<keyfp>` with dual-read rotation
  (`lib/platform/crypto.js`, `pnpm rotate:secrets`, S28). Secrets never reach
  the browser; admin/settings views are presence-only.
- **Session revocation**: sessions are rows, not stateless JWTs — revocation is
  effective on the next request on every isolate (S26).
- **PII minimization**: support role sees orders with contact fields stripped
  (`lib/admin/order-view.js`); tracking URLs scrubbed of tokens; events
  consent-stamped and redaction-aware (S33); customer redaction webhook
  executes (`lib/privacy.js`).
- **Migrations**: checksummed ledger per DB; failed migrations are unrecorded
  for clean retry — no half-applied silent state (S28).
- **Jobs/webhooks**: persist-before-ack; leases with expiry; replay is audited
  and idempotent for money effects (S29).

## Residual risks (accepted / scheduled)

1. ~~**Stored XSS via rich content**~~ — **MITIGATED (S35)**: `lib/sanitize.js`
   (edge-safe allowlist sanitizer — script/style/iframe dropped with content,
   event handlers stripped, javascript:/data: URLs rejected including
   entity-encoded forms) now wraps `description_html` at render on the PDP;
   CMS page bodies render as plain text and brand tokens are validated
   hex/enum values. Abuse matrix in `test:content`. Remaining from this item:
   a CSP header pass (needs the pixel/CMS inventory; with releases, S36+).
2. **In-memory rate limiters** are per-isolate; a distributed attacker spread
   across isolates gets N× the budget. Login limits are DB-backed (S26); the
   storefront ones are best-effort. Acceptable at current scale.
3. **Bootstrap password** (shared, env-derived) remains valid per surface until
   the first real user/operator exists — deliberate migration ramp (S26); retire
   by creating real accounts at cutover (tracked in IMPLEMENTATION_STATUS).
4. **32-bit order ids** are guessable; mitigated because every order read
   requires the expiring HMAC proof, but ids themselves stay low-entropy until
   a future id widening.
5. **No CSP headers yet** — Referrer-Policy shipped (S33); a full CSP needs the
   pixel/CMS inventory and lands with BE08/S35.
6. **Operator support grants rely on operator-session integrity** — a stolen
   operator session with an active grant reads (redacted) tenant data; TOTP +
   short operator sessions + the audit/banner trail bound the damage.

## Release gate contents (`scripts/test-security.js`)

Static: live-credential literal scan over tracked files; `.env*`/`*.db`
gitignore + tracked-file check; client-component server-import scan;
process.env-serialization scan on API routes. Dynamic: normalizeHost SSRF
rejections; webhook HMAC abuse matrix; OAuth state tamper/expiry/cross-secret;
support-grant TTL clamp, fresh expiry/revocation, read-only role matrix, audit
trail. Cross-tenant, revoked-session and money-idempotency abuse live in their
own suites (`test:tenant-boundary`, `test:identity`, `test:jobs`) — all part of
the same pre-commit baseline.

## Backup / restore (BE27)

`pnpm restore:drill -- --tenant <slug>` (or `--control-plane`) restores the
hosted DB into an isolated local file and verifies: per-table row counts,
migration-ledger ids+checksums, order money totals, secret-envelope ciphertext
lengths, FK + integrity_check. Measured 2026-10-28: demo tenant 21 tables /
13,579 rows in 1.4s; control plane 0.4s — logical-restore RTO is seconds at
current scale; RPO equals Turso's continuous replication (plus PITR on paid
plans: `turso db create <new> --from-db <db> --timestamp <iso>`). Run the drill
after every schema change and before every production cutover.
