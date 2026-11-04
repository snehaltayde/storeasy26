# P3 · SESSION · Logout ends preview, and the console's documents client

Branch `cms/p3-session`, cut from `407b88a`. Plan: `docs/cms-reviews/P3-PLAN.md` (decision 12, batch 1) and `P3-BATCHES.json`. Requirements: PV-01, PUB-11, ED-02 (the parts this item owns: logout ends preview, and the client the editor uses to call the documents APIs). No migration.

No tenant changes mode. Legacy releases, editors and the Designer preview keep working (tested). The legacy client `components/admin/cms/api.js` is not changed.

## Status by stage

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes. `pnpm test:logout-preview`: 32 passed, 0 failed, in 0.6 to 0.9 s. `pnpm test`: 81 of 81 suites passed in 123.4 s. `pnpm build` passes |
| Browser verified | **NOT DONE.** Every acceptance item is proved by a unit test against the real route handlers. No dev server ran, and ports 3660 and 4660 to 4669 were not used. A real-browser logout is an owner check below |
| Staging verified | **NOT DONE.** Nothing ran against hosted Turso |
| Production enabled | **NOT DONE.** Nothing pushed or deployed |

## What and why

**Drills finding 1.** Logging out of the console left the browser's `_preview` cookie and its preview session alive. Anyone using that browser next still saw the founder's unpublished drafts for up to an hour. Now logout does three things:

1. It ends every preview session this person opened on this store, on every device.
2. It clears `_preview` and `_admin`.
3. It does this in every mode, legacy included.

Platform (operator) logout also clears `_preview`.

**The console's client.** The new editor (P3-STORE, P3-PUBLISHUI and later items) needs one way to call `PUT /api/admin/documents` and the preview-session route. It must turn every answer into a small set of results the screens can show, and it must never throw. `components/admin/editor/documentsApi.js` is that client. It reads `lib/admin/documents-api-shapes.js` and does not restate the shapes.

## Design

### `lib/preview-sessions.js`

- **`revokePreviewSessionsFor({ actor, now })`** runs `UPDATE preview_sessions SET revoked_at = ? WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL` and returns the number of rows changed. `created_by` is `actorKey(actor)`, the same key the create path writes. An actor with no kind or id (`"unknown"`) revokes nothing, so rows with no known author are never swept up. Like the other writes in this file, it throws on a database error.
- **`endPreviewsAtLogout({ storeResolved, resolveActor, now })`** is the logout route's call, and it never throws:
  - When `storeResolved` is false, it logs `preview_logout_revoke_failed` with reason `no_tenant` and stops.
  - When `resolveActor()` gives no one, it does nothing and logs nothing.
  - When the revoke fails, it logs `preview_logout_revoke_failed` with reason `no_table` (a store before 0022, found with `notMigratedYet`) or `error`, plus the driver's message cut to 200 characters.
  - When it revokes one or more rows, it logs `preview_logout_revoked` with the count.

  The try/catch sits here and not in the route for a reason. `test-failure-matrix.js` checks every `} catch (e) {` in an `/api/admin` route for the request-error pattern, and a log-only catch there would trip that check.

The module stays edge-safe. It uses no new imports, only `notMigratedYet` and `slog`, which it already imported.

### `app/api/admin/logout/route.js`

- Wrapped in `tenantHandler(…, { allowUnresolved: true })`. A host that no longer resolves to a store still gets the normal logout answer.
- The same-origin check still comes first. A cross-origin POST gets 403 and nothing is revoked (tested).
- The actor is worked out **before** `revokeSessionByToken`, because afterwards the token names no one. `verifySession(token, "merchant")` gives `{kind: "merchant", id: userId}`. Failing that, `verifyAdminToken(token)` gives `{kind: "bootstrap", id: "bootstrap"}`, the bootstrap actor exactly as `requireAdmin` names it.
- "No store" means platform mode with no resolved tenant. In legacy single-store mode (no `PLATFORM_DB_URL`), the env-default store's database is used, as everywhere else.
- The answer is always `{ok: true}`, with `_admin` and `_preview` both cleared with the attributes `/api/preview` sets: `httpOnly`, `sameSite: "lax"`, `path: "/"`, `secure` in production, `maxAge: 0`. Before this change, `_admin` was cleared with only `path` and `maxAge`. The browser matches cookies by name, domain and path, so the change in attributes does not stop it replacing the cookie.

### `app/api/platform/logout/route.js`

This route also clears `_preview`, with the same attributes. Preview sessions an operator opened are rows in each store's own database, and the platform has no per-store revoke, so they are not revoked here (known limit).

### `components/admin/editor/documentsApi.js`

Plain JS with one import (the shapes file). It has no React, DOM, `node:` or env access. `createDocumentsApi({ fetch })` builds an instance with fetch injected. The named exports `call`, `sendKeepalive`, `startDocumentsPreview` and `setShowDesign` use the browser's own `fetch`, looked up on each request.

- **`call(op, args, extra?)`** sends `PUT /api/admin/documents` with `{ ...extra, [op]: args }`, same-origin credentials and a JSON content type. `extra` carries the top-level keys, which today means `revision`. Taking `const { [op]: v, ...extra } = SHAPES[op].request` and calling `call(op, v, extra)` sends exactly the contract's request (tested for all 17 operations).
  - An op that is not a key of `SHAPES` is not sent. It answers `UNKNOWN_OPERATION` with the contract's words.
  - Args that JSON can't hold (a cycle, a BigInt) answer `MALFORMED`.
- **`mapResponse(status, body)`** is pure and exported. Its results:
  - 2xx with a JSON object: `{ok: true, data}`. 2xx with an unreadable body: `{error, code: "UNREADABLE_RESPONSE"}`.
  - 409 `DOCUMENT_CHANGED` or `PUBLISHED_ELSEWHERE`: `{conflict: true, code, current, message}`, plus `conflicts` when the body has them. `current` is the server's document, so it carries `updatedByName` when the server sends it. It is `null` when a set refused for several documents and the body has no top-level `current`.
  - Any other 409: `{refused: true, code, message}`, plus `other`, `offer` and `current` when the body has them. `current` is an addition to the brief's list (`DOCUMENT_ARCHIVED` and `DOCUMENT_EXISTS` carry it). `DRAFT_CHANGED` is a refusal, not a conflict, as the brief lists only the two codes.
  - 422: `{issues, code, message}`, plus `offer` and `documents` when present. `documents` is an addition: it names the blocked documents of a publish.
  - 428: `{needsRevision: true, code, message}`. 501: `{notBuilt: true, code, message}`.
  - Any other status: `{error: true, code, message}`. The message is the server's words (`failure()`'s). When the body has none, it uses the contract's words for that status: `malformed`, `notFound`, `notBuilt` or `databaseUnavailable`, else `internalError`.
  - The two server strings that are not plain words, "Unauthorized" and "Cross-origin request rejected", are replaced. A 401 becomes "You're signed out, so nothing was saved. Sign in again in another tab, then try again. Your changes are still here." (code `UNAUTHORIZED`). A 403 without a code gets code `FORBIDDEN`.
- **A rejected fetch** (or a fetch that throws at once) gives `{error: true, code: "NETWORK_ERROR", message}`, with words that say nothing was saved and the changes are still here. Nothing in `call` can throw: the body read, the mapping and the request build are all guarded.
- **`sendKeepalive(op, args, extra?)`** builds the same body. It returns `false`, and sends nothing, when the body's UTF-8 size is over `KEEPALIVE_MAX_BYTES` (60,000 bytes, not characters), the op is unknown or fetch throws. Otherwise it hands a `keepalive: true` PUT to the browser, swallows a later rejection and returns `true`.
- **`startDocumentsPreview({ showDesign })`**:
  1. It posts `{create: true}` to `/api/admin/preview-session`.
  2. When asked, it posts `{showDesign: {sid, on: true}}`.
  3. It fetches `previewUrl` same-origin, which sets the httpOnly cookie through the 302. It fetches only when `previewUrl` starts with `/api/preview?` and has no backslash: an absolute or protocol-relative URL is never fetched.

  It returns `{ok: true, sid, expiresAt, showDesign}`, or the first mapped error. A legacy store gives `{refused: true, code: "STORE_USES_LEGACY", message: "This store still uses the current Storefront editor, so it previews from there. Use Preview in Storefront instead."}`, and no cookie is fetched.
- **`setShowDesign(sid, on)`** wraps the existing `{showDesign: {sid, on}}` call and returns the mapped result.

## Acceptance, with evidence

All tests are in `scripts/test-logout-preview.js`. They run the real `POST` of both logout routes, the real login route, `handlePreviewSessionPost`, `handleReleasesPost`, the real `/api/preview` GET and `contentSource`, on file databases with every tenant migration applied. "Fails without" means I put back the `HEAD` versions of the two routes and `lib/preview-sessions.js`, kept the new suite, and ran it: 17 passed and 14 failed. I also ran 11 single mutations, and each one was caught (listed under Tests).

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: after logout, every unrevoked `preview_sessions` row created_by this actor on this tenant is revoked; another actor's rows are untouched (merchant and bootstrap) | DONE | Section 1, "merchant": Asha's two devices are both revoked, and `readPreviewSession` says `revoked`. Ravi's row still counts. Asha's row on another store stays, and so does a row with another `tenant_id` in the same database. "bootstrap": both `bootstrap:bootstrap` rows (minted through the real route with the shared-password cookie) are revoked, and a merchant row on that store stays. An already-revoked row keeps its first `revoked_at`. No cookie, or a cookie that names no one, revokes nothing | Yes: "merchant" and "bootstrap" fail on `HEAD`. Mutations caught: no `created_by` term, no `tenant_id` term, revoke after `revokeSessionByToken`, no bootstrap fallback |
| 2 | unit: the logout Set-Cookie clears `_preview` (Max-Age=0, Path=/) and `_admin`, on a legacy and on a documents store; platform logout clears `_preview` | DONE | Section 2 parses `getSetCookie()`. On a documents store, a legacy store with a merchant, and a legacy store with bootstrap, both cookies come back as empty, `Max-Age=0`, `Path=/`, `HttpOnly`, `SameSite=lax`, and not `Secure` outside production. A source check confirms `secure` follows `NODE_ENV === "production"`. Platform logout clears `_preview` the same way and still clears `_platform` | Yes: all four fail on `HEAD`. Mutation caught: dropping the `_preview` clear |
| 3 | unit: after logout, `contentSource` with the old `_preview` cookie on a documents store serves live content only | DONE | Section 3. With the cookie, before logout: `{hero: "Draft hero", preview: true}`. The same cookie after logout: `{hero: "Live hero", preview: false}`, the same as no cookie | Yes |
| 4 | unit: a revoke failure (no table, thrown DB error, unresolved tenant) still returns the normal logout answer with both cookies cleared, and logs `preview_logout_revoke_failed` | DONE | Section 4. Each case gets 200 `{ok: true}`, both cookies cleared, and the log line with its reason. **No table:** the table is renamed, reason `no_table`, and the console session is still revoked. **Database refuses:** a `BEFORE UPDATE` trigger raises, reason `error`, and the driver's words are logged. **Client throws:** `execute` is stubbed to throw "socket hang up". **Unresolved host:** `nobody.test`, reason `no_tenant`, and the console session is still revoked. **Actor lookup throws:** `endPreviewsAtLogout` returns 0 and logs `error` | Yes: all four route cases fail on `HEAD`. Mutation caught: ignoring `storeResolved`; removing `allowUnresolved` (the gate's 404 answers instead) |
| 5 | unit: legacy store, logout then a new login, the Designer's preview-session mint succeeds (no stale revoked state blocks it) | DONE | Section 5. Legacy merchant: the real login, then `handleReleasesPost {action: "preview"}` (200), then logout. The old cookie now gets 401, as it should. After a new login the mint is 200 again, `/api/preview` answers 302 with a fresh `_preview` (`Max-Age > 0`), and `contentSource` with it is the legacy draft preview. Legacy bootstrap: the same with the shared password. Documents store: after logout and a new login, a new session counts and shows the draft, and the old one stays revoked | **No.** These pass on `HEAD` too. They guard against the change adding state that blocks a re-login; they are not a fix. The documents-store case does fail on `HEAD`, because its old session is not revoked |
| 6 | unit: `documentsApi.call` maps every example outcome in `documents-api-shapes.js` to the listed shape with a stubbed fetch; a rejected fetch gives `NETWORK_ERROR`; nothing throws | DONE | Section 6 covers all 17 operations, each with its own outcomes plus every `COMMON` outcome: 360 mappings, and `publishSet` follows `sameOutcomesAs`. For each one the test checks: the request (one PUT of exactly `SHAPES[op].request`); the result kind worked out from status and code; no key outside the brief's list; code; words; `current` and `updatedByName` for conflicts; `offer`, `other` and `issues`; and no ids in the words. A set conflict without `current` gives `null`. Rejected and synchronously throwing fetches give `NETWORK_ERROR`. Nothing throws for: a non-JSON 200, a 502 or 503 with no body, an unknown op (not sent), cyclic or BigInt args, a missing response, a `json` getter that throws, or a 401/403 with a technical string | Yes: the module is new (without it the suite cannot load). Mutations caught: dropping `PUBLISHED_ELSEWHERE` from the conflict codes, dropping `offer` on 422, letting a fetch rejection throw |
| 7 | unit: `sendKeepalive` returns false above 60,000 bytes; `startDocumentsPreview` returns `{sid, expiresAt}` and maps 409 `STORE_USES_LEGACY` to plain words | DONE | Section 6b. A body of exactly 60,000 bytes is sent with `keepalive: true`. 60,001 bytes gives `false` and nothing is sent. So do 25,000 "₹" (25,000 characters, 75,000 bytes). No unhandled rejection. Section 6c uses a fetch wired to the real routes. On a documents store the result is `{ok, sid, expiresAt (future), showDesign}`; the requests are the create POST, then the same-origin GET; the cookie holds this sid and previews the draft; the row's `created_by` is Asha. With `showDesign: true`, the flag is set before the cookie fetch, and `setShowDesign(sid, false)` turns it off. On a legacy store: refused, `STORE_USES_LEGACY`, the route's own words, no cookie fetched. Signed out gives `UNAUTHORIZED`, offline gives `NETWORK_ERROR`, and four bad `previewUrl`s are never fetched | Yes: the module is new. Mutation caught: counting characters instead of bytes |

## Tests

- `pnpm test:logout-preview`: 32 passed, 0 failed, 0.6 to 0.9 s. It writes `.test-lop-*.db` files in the worktree root and removes them, with their `-wal`, `-shm` and `-journal` files, at the start and the end.
- Negative run: the three changed server files put back to `HEAD`, giving 17 passed and 14 failed (listed above).
- Mutation run (`scratchpad/p3-b1/P3-SESSION/mut.py`; each mutation applied alone, then the file restored). All 11 were caught:
  1. revoke after `revokeSessionByToken`;
  2. no `allowUnresolved`;
  3. no `created_by` term;
  4. no `tenant_id` term;
  5. `storeResolved` ignored;
  6. no bootstrap fallback;
  7. no `_preview` clear;
  8. `PUBLISHED_ELSEWHERE` not a conflict;
  9. characters instead of bytes;
  10. no `offer` on 422;
  11. a fetch rejection rethrown.
- `pnpm test`: 81 of 81 suites passed in 123.4 s. The legacy suites in plan section 3 (`test-admin-console`, `test-cms-api`, `test-sections`, `test-sections-render`, `test-releases`, `test-themes`, `test-editor-layout`) are green. `test-failure-matrix` (122 passed) is green after the try/catch moved into the lib (see Design).
- `pnpm build`: passes. `/api/admin/logout` and `/api/platform/logout` stay dynamic nodejs routes.

## Known changes (owner-visible, plan decision 12 and section 3)

- **Logout ends that person's previews on every device**, not just in this browser. A founder signed in on a laptop and a phone who logs out on the phone loses the laptop's preview too. The laptop's console session stays signed in, and opening the preview again mints a new session.
- **On a legacy store, logout now also ends the Designer's preview**, because the `_preview` cookie is cleared. Logging in again and opening the preview mints a new one (tested).
- A bootstrap (shared password) logout ends every bootstrap preview on that store. Bootstrap is one shared actor, so every browser signed in with the shared password counts as the same person.

## Known limits

- **Platform logout does not revoke preview sessions** an operator opened. They live in each store's database, and the platform has no per-store revoke. The cookie is cleared, and the sessions expire within the hour.
- **A legacy preview token copied out of the browser** (the old format `p.<exp>.<hmac>`, with no session row) keeps working until it expires. Logout clears the cookie only. This is unchanged from today.
- **Support actors** (an operator under a support grant) use the platform cookie, not `_admin`. Admin logout does not name them, so it does not end their previews.
- **A merchant whose membership was removed:** logout still revokes their rows on this store, because the actor comes from `verifySession` alone (as the brief says). That is the safe direction.
- **`secure` in production** is checked on the source line, not by a run under `NODE_ENV=production`, because the attribute is read when the module loads.
- **The client's 401 words** are the client's own. The server's "Unauthorized" carries no code and is not plain words.
- **The `call(op, args, extra)` signature:** the brief writes `call(op, args)`. Top-level keys such as `revision` go in the third argument. P3-STORE should use it this way.
- **The local legacy single-store mode** (no `PLATFORM_DB_URL`) is not run by this suite. That would need a second process with other env. The code path is the same as for a resolved store, against the env database.

## Owner checks

- **Real browser logout (desktop Chrome):** on a documents-mode test tenant, open the preview, log out, and reload the preview tab. It should show the live store with no preview bar. On a legacy test tenant, the Designer preview should come back after logging in again.
- **Ruling on the known changes above** (every device, legacy Designer, bootstrap is one actor). The plan's section 5 already lists this.
- **CI sqld download** (standing): this item does not touch `.github/`. Approving the sqld binary's source and checksum for CI is still the owner's call.
