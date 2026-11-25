# Phase 3 least-trusted audit

Date: 2026-11-25. Audited on `main` at `c0376039` (end of Phase 3), read-only, by the reviewer agent. It ran `test-platform-permissions` (89/0: 75 rows × 10 callers, 4 exempt) and `test-support-access` (23/0) through `heavy`. No drills were run during the audit.

**Callers.** The operator console has no roles. Its least-trusted callers are:

- the signed-out visitor
- a merchant session: an `_admin` cookie, or its token put in `_platform`

On the merchant side, `support` is the least-trusted role, and the `__Host-support` session must behave exactly like it.

**Scope.** `1f260e34..c0376039`, 84 commits, about 95 entry points:

- 75 operator route rows that go through `requireOperator`, in 18 route files
- 4 exempt routes: login, logout, the billing webhook and the export GET
- 9 operator pages plus the layout
- the merchant support-access routes: `support-entry` and `support-access`, the changed logout and audit routes, the Team card and the notices

## Entry points

`requireOperator` refuses a cross-origin write (403) before it checks auth. It then requires an `operator`-kind session with `is_operator`. A merchant token, a support token or a support-entry token in `_platform` gets 401. So does bootstrap once an operator exists, and so does a failed lookup. Every operator page redirects anyone who isn't an operator to the sign-in at `/platform` before it reads any store.

| Area | Check | Signed out / merchant session | Proof (suite) |
|---|---|---|---|
| billing, case-studies, costs, domains, themes, flags, incidents, onboarding, overview, privacy, provisions, queues, stores, tenants, tenants/[id], export POST, offboard, support | `requireOperator` | 401 (403 cross-origin); no store id, name or `db_url` in the body | test-platform-permissions plus each line's suite |
| export GET | the link's HMAC token only (store-bound, fails closed without `PLATFORM_SECRET`) | 401 without a valid token | test-platform-permissions, test-tenant-ops |
| login, logout, billing webhook | their own checks (origin and rate limit, revoke, signature) | n/a | test-platform-permissions (the exempt list) |
| operator pages and layout | operator cookie, or redirect | sign-in page only, no shell | test-platform-shell |
| merchant `POST /api/admin/support-entry` | single-use, 60 s token bound to the grant, the store and the console origin; form POST only | 400, no cookie | test-permissions, test-support-access |
| merchant `GET` / `POST /api/admin/support-access` | `audit.read` / `team.manage`; store from the host | staff, support and operator-support get 403 | test-support-access |
| `__Host-support` session | acts as `support` on every `ADMIN_PAGES` row; never an `_mx` pass | — | test-support-reads, test-support-access |

## Gaps (all fixed on `phase3/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P3-A | Medium | A store export link (it carries shopper personal data) could be reused for an hour, travelled in the query string, and its downloads were not audited. | **Decision:** links are single-use and valid for 15 minutes. Each download is audited as `tenant.export_downloaded`, and an operator mints a fresh link when needed. |
| P3-B | Low | The export GET's 422 echoed raw error text that might name the store's database. | Return fixed words; log the scrubbed text. |
| P3-C | Low (test) | The denied-caller jars had no support session or support-entry token in `_platform`, and no `__Host-support` cookie on its own. | Those callers added to `test-platform-permissions` and `test-platform-shell`. |
| P3-D | Low | An incident opened with no public message still wrote its title into a store-tagged audit row that owners can read. | With no public message, the title goes under `operator_only`. |
| P3-E | Low | An operator signing out of `/platform` did not end their `__Host-support` sessions on store hosts. | Operator logout also revokes their support sessions. |
| P3-F | Low (operator only) | Unclamped paging: queues `?limit=-1` read every row; huge page or offset values reached the SQL. | Limits clamped to 1–200; offsets capped. |
| P3-G | Low (operator only) | Several operator catches returned raw driver errors (privacy, offboard, queues, incidents, billing GET, `last_error`). | Scrubbed with the store's database address and token, or replaced with fixed words. |

## Accepted

- Any operator may mint an entry token on any open grant (operators have no roles). Opening a second grant ends the sessions on the first.
- Same-host `_platform` support access and the operator `_mx` pass predate Phase 3.
- The `/platform` CSP `form-action` is widened to `https:` so operators can reach custom store domains.
- Every team member sees the grant's reason and the operator's name.

## Not checked

- Browser markup. That is covered by the Phase 3 `drill:all`.
- Whether the real proxy or hosting keeps query strings in its logs.
- Real Razorpay, Turso and Resend.
- Whether libsql's real error text contains the database URL.
- Timing side channels, and proxy header and Origin spoofing behind a real proxy.
- Rate limits on `support-entry` (the token is 256 bits).
