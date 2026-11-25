# Phase 1 end-of-phase least-trusted audit

Date: 2026-11-25. Branch `phase1/audit`. Method: `steelthread:least-trusted-audit`, "Phase-end audit".
Least-trusted roles (CLAUDE.md, `docs/ARCHITECTURE.md` matrix): **support** in the merchant console
(read-only, PII redacted), with **operator-support** (an operator under a support grant, who reads as
support) wherever a store console route applies; and the **anonymous visitor** for signup,
accept-invite, the handoff and the OAuth callbacks.

Inventory: `git diff --name-status fec5d51..main -- app` (Phase 0's retro commit to the end of
Phase 1; the brief's `21cfe0e~40..main` starts mid-phase, at line 5, so lines 1 to 4 were added from
the wider range), every new or changed `route.js`, `page.js` and `layout.js` read by hand, the job
types in `lib/platform/worker.js` `HANDLERS`, the operator actions in `lib/platform/onboarding-ops.js`
`ACTIONS`, and the preview frame's `postMessage` listener (`components/preview/bridge-core.js`).
`grep "use server"`: still none. **66 entry points**: 14 new API methods, 17 changed API methods,
9 operator actions, 22 pages and layouts, 3 job types, 1 frame message.

Test names below are the `t("…")` labels. Suites:

- PR = `scripts/test-permissions.js` (every `scripts/support/admin-routes.js` row as every caller,
  operator-support included; the guard that every route, method and action has its row)
- SR = `scripts/test-support-reads.js` (every probe as staff, support and operator-under-grant: listed
  keys only, no canary); SH = `scripts/test-shopper-reads.js` (the shopper route map)
- SG = `test-signup.js`, SP = `test-signup-provision.js`, ON = `test-onboarding.js`,
  SC = `test-shopify-connect.js`, IS = `test-import-step.js`, OB = `test-onboarding-brand.js`,
  PF = `test-preview-frame.js`, OP = `test-onboarding-open.js`, OO = `test-operator-onboarding.js`,
  OC = `test-operator-create-store.js`, DOC = `test-documents.js`, ND = `test-no-dead-code.js`
- DS = `pnpm drill:shell` (browser; this audit added `phase1Support` and `phase1Anonymous`)

## 1. Self-serve signup and the handoff (line 1, line 2)

Marketing host only (`signupClosedAnswer`: a store host is 404, the `ff_self-signup` kill switch is 403).
Every write is same-origin and rate-limited; each acts only on the signup bound to this browser's
`se_signup` cookie (a hash at rest), never an id in the body.

| Entry point | Check | Scope filter | Anonymous gets | Proof |
|---|---|---|---|---|
| `signup` GET (address check) | host, rate limit 60/min | the address only | `{slug, available, reason?, message?, address}`; "taken" for a live signup's address (inherent: addresses are public) | SG fields and addresses tests |
| `signup` POST | host, same origin, 5/hour per IP | a new row | an email with an account gets the same status, keys and cookie, and no code | SG "least-trusted: an existing-email probe gets the same status, the same response keys and a cookie; its email has no code", "least-trusted (fix 1): an existing-email signup holds its address exactly like a new-email signup" |
| `signup/verify` POST (code, `retry`) | cookie + emailed code; 20/15 min; per-IP verify throttle | the cookie's own row | no cookie, another browser's cookie, a made-up one: the same words, none of the victim's tries spent; a used code can't be replayed; a released, superseded or expired signup: generic, no job | SG "least-trusted: verify with no cookie or another browser's cookie fails generically …", "least-trusted: a used code can't be replayed …", **SG "least-trusted (Phase 1 audit): a signup an operator freed (released) or that was superseded is dead in its old browser …" (new)** |
| `signup/resend` POST | cookie; once a minute, 5 per signup | own row | 400 without a cookie; no code for an existing-email signup | SG verify test above; same new test |
| `signup/status` POST (runs that signup's own due job) | cookie; 900/15 min | own row | the same generic 400 with no or another cookie; a pending and an existing-email signup answer identically; a store host 404; cross-origin 403 | SP "least-trusted: status with no cookie or another browser's cookie: the same generic 400", "least-trusted: a pending signup and an existing-email signup get identical status answers", "least-trusted: status cross-origin is 403; on a store host 404" |
| Handoff token (minted by `status` once done) | single use, kind `handoff`, bound to the store; at most one live; 30 minutes on, a sign-in link instead | `consumeInvite` checks kind and tenant inside its `UPDATE` | an earlier poll's token refused; a done signup 30 min on gets `loginUrl`, never a token | SP "status: done … a newer poll kills the earlier token (at most one live)", "least-trusted: the earlier poll's token is refused by the handoff route …", "a done signup 30 minutes on gets loginUrl, never a new token" |
| `admin/handoff` POST | token (exempt row in PR); same origin; 10/min | this host's store | random, malformed, expired: 400 one message; another store's token refused unspent; a merchant session is not a token; an invite or reset token is refused unspent (probe, this audit) | SG "least-trusted: a random, malformed or expired handoff token is 400; a merchant session is not a token", "least-trusted: the handoff token on another store's host is 400 and still works once on the right host …"; DS "anonymous: a made-up handoff token is 400 with the generic words and no session" |
| New owner's session | ordinary merchant session | own store only | 401 on another store's admin routes | SG "least-trusted: the new owner gets 401 on another store's admin routes …" |
| `/signup` page, `/admin/handoff` page + layout, `pricing` ("Get started" link) | host; the handoff page reads nothing (the token is in the fragment) | — | store host: 404 | DS "anonymous: signup's page and APIs on a store host are 404"; SG cross-origin test |
| Job `provision_store` | enqueued by verify/retry, operator create or resume | the signup's own row, under a lease | only its own signup, through its cookie | SP "two runners racing on one signup …", "secret sweep: the API token and every minted token appear nowhere …" |

## 2. Merchant onboarding (lines 3 to 7)

Check: `requireAdmin(request, "<action>")` on every method; the store from the host (`tenantHandler`).

| Entry point | Check (action) | Scope | Support / operator-support gets | Anonymous | Proof |
|---|---|---|---|---|---|
| `onboarding` GET | `storefront.read` | host store | the four steps; no shop domain or `locked` key (only `settings.read` roles); every action disabled with the read-only reason | 401 | ON "the shop domain is in the connect step's facts only for roles with settings.read …", "actions per role come from lib/platform/authz.js …"; SR probe "onboarding"; SC "after connecting: … support's GET has no domain, client id or token and Connect is disabled" |
| `onboarding` POST (test-order mark) | `settings.write` | host store | 403 | 401 | PR row; DS "support: publish, the onboarding test-order mark … answer 403" |
| `/admin/onboarding` page, `(authed)/page.js` (closed store lands here), `(authed)/layout.js` (onboarding shell) | `storefront.read` | host store | every step read-only, no enabled write, no Shopify address | → `/admin/login` | SR page sweep (row `onboarding`); **DS "support at onboarding step connect\|import\|brand\|open: read-only, no enabled write, no Shopify address" (new)**; DS "anonymous: all … console pages redirect to /admin/login" |
| `shopify/connect` POST | `settings.write` | host store; a shop another store holds is 409 `other_store` | 403, nothing saved, no Shopify call | 401 | SC "least-trusted: staff and support get 403, operator-support 403, signed out 401, another store's owner 401, cross-origin 403; nothing saved and no Shopify call"; DS (new) |
| `shopify/callback` GET (founder) | `settings.write`, then signed state (store, session cookie, nonce, 10 min) and Shopify's HMAC, in that order | host store | 403 page, zero token calls, nonce cleared | 401 page | SC "least-trusted: signed out → 401 page, staff → 403 page, support and operator-support → 403 page …", "refusals in order … another session (mismatch), no nonce, a wrong nonce, store A's state on store B, an operator state, an expired state, a tampered HMAC"; DS (new, both) |
| `connect/shopify/callback` GET (operator, changed) | operator `op` state + HMAC | the state's store | a founder's state refused | refused | SC "the founder's state on the operator callback is refused there (no token call)" |
| Token refresh (no entry point; every Admin call) | — | the store's own row | — | — | SC refresh tests (one at a time, two workers, refused refresh clears both tokens) |
| `sync` GET (import progress) / POST | `storefront.read` / `sync.run`; GET only nudges a retrying job for `sync.run` | host store | plain words only (`plainSyncError`), skip list capped at its shown count; no nudge; POST 403 | 401 | IS "positive control: the owner's GET on a retrying run queues its job (the nudge); staff's GET doesn't", "GET signed out 401; another store's owner 401"; SR probe "sync"; DS (new, POST) |
| `brand-step` GET/POST, `preview-session` (brand preview) | `storefront.read` / `storefront.write` | host store; a session belongs to its creator | every control disabled, nothing POSTed; POST 403 | 401 | OB "least-trusted: support (and operator-support) sees every control disabled …"; PR rows; SR "preview-session: a read-only caller makes only its own links"; DS (new) |
| Frame message `storeasy:brand` (preview bridge, brand overlay) | only after a look hello, in a working preview, from this origin and `window.parent` | the frame only; nothing stored | ignored on the live store, a revoked or expired preview, another origin or window; a `javascript:` or outside logo and a `<script>` description do nothing | — | PF "line 6, brand overlay refusals: …", "line 6, brand overlay inputs: …" |
| `policy-start`, `first-run` POST (step 3/4 starters) | `storefront.write` (drafts only) | host store | 403 | 401 | PR rows; DS (new) |
| Open store (step 4): `documents` publish / publishSet | `storefront.publish`, the opening gate, `publish_log` in the batch | host store | 403, no release, `publish_log` or audit row | 401 | OP "staff and support: publishSet 403 with no release, publish_log or audit row; settings PUT 403 with checkout_mode unchanged"; DS "support: publish …" |
| Contact form (step 4): `settings` PUT identity | `settings.write` | host store | 403, nothing changed | 401 | OP same test; OP "support: every control disabled with the read-only reason except reading a draft"; DS (new) |
| `settings`, `billing` pages (`?from=onboarding`), `dashboard` | `settings.read` gate; `storefront.read` | host store | the permission note (settings, billing) | → `/admin/login` | SR page sweep; DS "support deep link /admin/settings …", "/admin/billing" |

## 3. Operator console (lines 8, 9)

Check: `platformOperator(_platform)` (a TOTP operator session, or the bootstrap token while no operator
exists); writes same-origin first, audited with the operator's id; no answer holds a token or a link.

| Entry point | Support (merchant session) / anonymous gets | Proof |
|---|---|---|
| `platform/onboarding` GET (list, `?subject=` sheet, `q`, `cursor`) and POST (9 actions: resume, resend_code, signin_help, owner_invite, support_open, support_revoke, release, cancel_store, note) | 401 for signed out, every merchant role and store B's owner; a merchant token in `_platform`, a non-operator's operator session, a revoked or expired session: 401; cross-origin 403 | OO "§3: signed out and every merchant role … get 401 on the list, the sheet and every action", "§3: a merchant session token put in _platform is refused (401)", "§3: revoked and expired operator sessions are refused (401)", "§3: a cross-origin POST is refused (403) …"; DS "anonymous: the operator onboarding and New store APIs are 401" (new) |
| Paging past own rows (`cursor`) | keyset cursors, 50 a page, no duplicates or gaps (operator only) | OO "paging: 50 rows a page with keyset cursors …" |
| `signin_help` / `owner_invite` recipients | only an owner on file / the founder's email on file; a `to` in the body is ignored; tokens never returned | OO "sign-in help: … a 'to' in the body is ignored", "owner invite: … no token returned" |
| `support_open` / `support_revoke` (support access) | the grant reads as support (all of section 2's operator-support rows); revoke closes it | OO "support access: …"; section 2 |
| `platform/stores` GET (checks, progress) / POST (create) | 401 as above; 20 creates per operator per hour | OC "§3: signed out and every merchant role … get 401 on the checks, the progress and create", "§3: a merchant token in _platform …", "20 creates per operator per hour …" |
| `cancel_store` (cancel-setup) | only an operator-made row not provisioning; runs superseded, secret cleared; merchant roles 401 | OC "review 2: an operator row that isn't provisioning can be cancelled …" |
| `/platform/onboarding`, `/platform/stores/new` (+ loading), `/platform` page + layout | → `/platform` (the operator sign-in) | **DS "support at /platform/onboarding …", "anonymous at /platform/stores/new …" (new)** |
| `platform/provisions` GET, `platform/tenants` GET (POST retired), `tenants/[id]` (handoff route removed) | 401; POST 405 | SP "least-trusted: a support member's session (and a signed-out caller) gets 401 on /api/platform/provisions"; OC "§3: POST /api/platform/tenants is retired (405, no handler) …"; ND (the removed handoff route) |
| Job `onboarding_sweep` (queued by `jobs/tick`) | `jobs/tick` needs `CRON_SECRET` in production | SP "least-trusted: /api/jobs/tick in production with no secret, or a wrong one, is 401" |

## 4. Accept-invite (line 9)

| Entry point | Check | Anonymous / another user gets | Proof |
|---|---|---|---|
| `accept-invite` GET (peek, never spends) | token, kind `invite`, this store; 20/min | another store's token, a used or expired one: 400 one message; a handoff or reset token: 400 (probe, this audit) | OC "accept: the page's peek shows the store and the invited email; user B signed in posting the token gets nothing; store B's host refuses it without spending it", "the accept page's peek is rate-limited"; DS "anonymous: a made-up invite token's peek is 400" (new) |
| `accept-invite` POST | token; an existing account proves its password before the token is spent, sharing login's lockout; only an active account | user B's session is never used; wrong password leaves the invite usable; expired 400; **a member already at the invite's role or above: 409, the token spent; the write is raise-only in SQL; a team role change or removal expires that member's pending invites (gap P1-A)** | OC "an existing account accepts with its current password …", "review 1: an existing account accepting an invite shares login's lockout …", "an expired invite is refused", **OC "Phase 1 audit gap P1-A: …", "P1-A review: every held role x invited role …", "P1-A review: a 409'd token can't be replayed after a demotion …", "P1-A review (race): two accepts at once never lower a role …" (new)** |
| `/admin/accept-invite` page + `(invite)` layout | the POST/GET above | a made-up token: "invalid, expired, or already used" | DS "anonymous: the accept page with a made-up token says the invitation is invalid, no error" (new) |
| `recover` POST (changed: an invited account may reset) | exempt; same body for every email | PR "exempt recover: … an unknown email 200 with the generic body" |

## 5. Legacy cleanup (line 10)

| Entry point | Support gets | Anonymous | Proof |
|---|---|---|---|
| `media` DELETE (refusal while used, `MEDIA_CHANGED`) | 403 before any read (`storefront.write`), so the 409 usage list is never shown to it | 401 | PR row; DOC "a media id used only in a doc_home draft … deleteMedia refuses it (even forced)"; DS (new) |
| `STORE_MODE_INVALID` (documents, preview-session, releases, media, editor pages) | the permission check runs first; on a broken store a reader gets 500 with fixed words and the code, never the stored mode | 401 first | DOC "API: a tenant whose stored mode is not documents ('legacy', 'migrating') gets 500 STORE_MODE_INVALID on writes … and 200 on reads"; test-editor-routes "rendered: /admin/editor on a store whose stored mode isn't documents …" |
| Removed routes and screens (old operator handoff, setup, start, storefront designer pages …) | gone (404) | gone | ND (fails on any file nothing imports or routes to); PR guard (no stale rows) |

## 6. Side doors tried

- **Another tenant's id or host:** handoff, invite peek and accept, the founder's Shopify state, onboarding
  and connect all take the store from the host; store A's tokens and state on store B's host are refused
  and stay unspent (SG, OC, SC). Store B's owner gets 401 on store A's routes (PR, SC, IS).
- **Another user's token:** another browser's `se_signup` cookie (SG, SP), another session's OAuth state
  (SC "mismatch"), user B posting user A's invite (OC), kind confusion: an invite or reset token on the
  handoff route and a handoff or reset token on accept-invite are all 400 and left unspent (scratch probe
  this audit, matching `consumeInvite`/`liveInvite`'s kind filter).
- **Expired or used tokens:** handoff (SG), code (SG), invite (OC), OAuth state (SC), the earlier
  handoff poll (SP).
- **Stalled or cancelled signups:** lapsed (SP "a lapsed signup's job fails as lapsed …"), racing runners
  (SP), operator cancel (OC), and the founder's old browser after release, supersede or expiry (SG, new).
- **Bulk and paging:** support has no paged Phase 1 read; the import skip list is capped; the operator
  list's keyset paging is operator-only (OO).
- **Error messages that reveal a record:** signup and status answer an existing email exactly like a new
  one; handoff and invite refusals use one message each; the accept-invite POST echoed raw error text
  (gap P1-A, fixed). Accepted, not gaps: the address check says an address is taken (addresses are
  public); `shopify/connect` tells an admin (not support) that another Storeasy store holds a shop
  (needed to stop two stores claiming one shop; it names no store); the invite peek tells the token's
  holder whether the invited email has an account.

## Gaps found and fixed

| Gap | Scenario | Test (red first, `d199840`) | Fix |
|---|---|---|---|
| P1-A | Line 9 lets an existing account accept an invite with its password, and `acceptInvite` then ran `addMembership`, which overwrites the role. An admin (`team.manage`) could invite an owner's email as support: a second owner who accepted was silently demoted (a side door around Phase 0 F1, "an admin can neither demote nor remove an owner"); the sole owner got the token spent and the raw guard text "cannot demote the last owner — grant owner to someone else first" in the 400. | OC "Phase 1 audit gap P1-A: an invite never lowers an existing member's role …" | `0ad0332`: `acceptInvite` refuses a member already at the invite's role or above (409 `ALREADY_MEMBER`, "You're already on this store's team …"); an invite still adds a member or raises a role. The route's catch-all answers the generic invalid-invite words and logs the raw error. Review fixes (`12e03a4` red, `7c8c03e`): the 409 spends the token, so it can't undo a later demotion; the write is `addInviteMembership`, raise-only in one statement (`ON CONFLICT … DO UPDATE … WHERE rank(new) < rank(held)`; the team route keeps `addMembership`); the team route's role change and removal expire that member's pending invites to the store. Tested over the full 4 × 4 grid of held × invited role, an account with no membership here, a replay after a demotion, and two accepts at once. |
| P1-B (was open item 2) | An operator's owner invite for a store with no owner and no signup on file went to the store's support email, which an admin can set in Settings: an admin could make themselves owner of an ownerless store by asking Storeasy support for an owner invite. | OO "owner invite with no signup on file is refused: the store's support email … is never the recipient (Phase 1 audit) …" (red `d78d7f7`) | `5f8eed9`: `ownerInviteEmail` returns only the signup's email; a store with none gets the existing "no email on file" refusal. |

## Open gaps (not fixed here)

| # | Scenario | Why not fixed |
|---|---|---|
| 1 | Phase 0 open gaps 1 to 4 stand (quiz email to any address, login timing, legacy write buttons, collector route suites). | Unchanged by Phase 1. |
| 2 | The team route still lets an admin create a support invite for an existing member's email (the accept now refuses it, so it does nothing). | Harmless after P1-A; tidier refusal at invite time is Phase 2's team screen. |

## Not checked

- Real Shopify, Turso and Resend (stand-ins only; owner checks in `docs/cms-reviews/MANUAL-CHECKS.md`).
- Timing side channels in the signup, handoff and invite routes; rate-limit bypass through
  `x-forwarded-for` spoofing (accept-invite reads it for the lockout key).
- The operator console's own screens beyond the sign-in redirect in the browser (`pnpm drill:operator-onboarding`
  and `drill:operator-create-store` cover them as an operator; not rerun here).
- Hosted behaviour (nothing is hosted).

## Browser pass result

`~/.claude/bin/heavy pnpm drill:shell` at `6db5fcd`: **297 passed, 0 failed** in 319 s
(`docs/cms-reviews/drills/SHELL/results-main.json`). This audit's 21 new checks all passed. Support:
each of the four onboarding steps opens read-only (no enabled write, no Shopify address on the page);
Connect, the founder's Shopify callback, brand, policy start, starter store, import, the contact form
and media delete answer 403; `/platform/onboarding` and `/platform/stores/new` go to the operator
sign-in. Anonymous: a made-up handoff token is 400 with the generic words and no session; a made-up
invite token's peek is 400 and the accept page says the invitation is invalid; the founder's Shopify
callback is 401; the operator onboarding and New store APIs are 401; signup's page and APIs on a store
host are 404; both operator screens go to the sign-in. Support still sees 45 write controls inside the
old `[data-legacy]` screens (`support-write-controls.json`; Phase 0 open gap 3, refused by the server).

## Verification

`~/.claude/bin/heavy steelthread-verify` at `994f98f`: PASS lint (`pnpm typecheck`); PASS slice
(test-permissions 110, test-support-reads 30, test-shopper-reads 35, test-security 19, all 0 failed);
PASS changed suites (test-operator-create-store 34, test-signup 44, test-identity 23, test-tenant-ops 10,
test-operator-onboarding 34, test-drills 35, test-shopify-boundary 42, all 0 failed).

Review fixes, `~/.claude/bin/heavy steelthread-verify` at `5f8eed9`: PASS lint; PASS slice (test-permissions,
test-support-reads, test-shopper-reads, test-security, 0 failed); PASS changed (test-operator-create-store 37,
test-operator-onboarding 34, test-identity, test-tenant-ops, test-signup, test-shopify-boundary, 0 failed).
drill:shell was not rerun (no screen or route changed).
