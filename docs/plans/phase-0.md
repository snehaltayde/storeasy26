# Phase 0 plan

One section per line of `docs/FEATURES.md` Phase 0. Agents read only the section for their line.

## Line 1: per-role permission harness and route guard

**Fit:** Phase 0, first line. Depends on nothing unbuilt. Line 2 (support cannot read outside the matrix, with body assertions) and line 4 (agency removal) build on this harness. Until line 4 lands, `admin/agency-grants` stays in the route table.

### 1. Feature list (what the harness must prove)

1. **Declared route table** in `scripts/support/admin-routes.js`: one row per route × method × action variant. Each row: `path`, `method`, `action` (authz string), `probe` (body / params / formData), optional `via` (lib file holding the `requireAdmin` call), optional `kind` (`gated` default, or an exempt kind below). Body-selected variants get their own rows:
   - `team` POST `{action:"invite",role:"owner"}` → team.owner; `{action:"remove"}` → team.manage
   - `integrations` POST `revoke` → settings.write; `test` → settings.read
   - `orders/[id]` POST `cancel` → orders.cancel; `push` and `reconcile` → orders.push
   - `releases` POST `preview` → storefront.read; anything else → storefront.publish
   - `documents` PUT `{listDocuments:true}` → read; `{saveDraft…}` → write; `{publish…}` → publish (`via` lib/admin/documents-api.js)
   - `preview-session` POST (via lib/admin/preview-session-api.js), `refs` GET (via lib/admin/refs.js), `releases` GET/POST (via lib/admin/releases-api.js)
   - Every other route: one row per exported method with the action found by grep (~41 files, ~80 rows).
2. **Table checked against authz:** every row's `action` is in `ACTIONS` (exported from authz.js). Expected result per role is computed with `roleAllows(role, action)`, never hand-written.
3. **Matrix test:** the test holds a copy of the ARCHITECTURE.md matrix (action → allowed roles); it must equal `ROLES × ACTIONS` from authz.js exactly.
4. **Every gated row called as each caller:**

   | Caller | Allowed | Denied |
   |---|---|---|
   | owner, admin, staff, support (real membership sessions on store A) | status not 401/403 | 403 |
   | signed-out (no cookie) | — | 401 |
   | owner of store B calling store A's host | — | 401 |
   | operator with an active support grant on A (`_platform` cookie + `createSupportGrant`) | same as support | same as support |

5. **Cross-origin:** every row whose action passes `isWriteAction` is also called as owner with `Origin: https://evil.test` → 403. Read actions on POST/PUT (`offers/simulate`, `integrations` test, `releases` preview, `preview-session`, `media` PUT, documents read ops) are marked `crossOrigin:"read"` in the table; after F2 they must also return 403 cross-origin.
6. **Guard test (static):** walks `app/api/admin/**/route.js` on the filesystem (not git). Fails when:
   - (a) a route file or exported method (`export const|async function GET|POST|PUT|PATCH|DELETE`) has no table row;
   - (b) a row points to a missing file or method;
   - (c) a `gated` row's source (or `via` file) has no `requireAdmin(` call or no `!auth.ok` check;
   - (d) a `requireAdmin(…, "x.y")` literal in the source (or `via`) is not in that route's rows;
   - (e) an exempt route calls `requireAdmin`, or is missing its declared rule.
7. **Exempt routes, each with its own tested rule:**

   | Route | Rule |
   |---|---|
   | `admin/login` POST | public; cross-origin → 403; signed-out `{}` → 400; wrong password → 401 with no `_admin` Set-Cookie |
   | `admin/logout` POST | any caller (`allowUnresolved`); cross-origin → 403; signed-out → 200 and clears `_admin`. Called only with a throwaway session (it revokes it) |
   | `admin/accept-invite` POST | public token route; cross-origin → 403; `{}` → 400; bad token → 400; never 401 |
   | `admin/reset` POST | same rule as accept-invite |
   | `admin/recover` POST | cross-origin → 403; `{}` → 400; unknown email → 200 with the generic body |
   | `admin/maintenance-pass` GET | public; always 302 to `/admin/login`; `_mx` cookie only for a verified member or operator session (with `MAINTENANCE_PASS_SECRET`/`PLATFORM_SECRET` set); signed-out gets no cookie |

   `preview-session`, `documents`, `refs`, `releases` are **gated** with `via`, not exempt.
8. **Fail-closed checks:** the tenant has members (bootstrap shared-password path closed), `ADMIN_PASSWORD` unset, and a legacy `_admin` token computed for the store → 401.

### 2. Findings (builder confirms each with a failing row first)

- **F1 (permission bug):** `app/api/admin/team/route.js` POST asks for `team.owner` only when `body.role === "owner"`. With `team.manage` an admin can demote (`{action:"role", userId:<owner>, role:"staff"}`) or remove an owner; the final-owner guard protects only the last owner. **Fix:** after `requireAdmin(team.manage)`, read `membershipRole(userId, tenant.id)`; if it is owner, require `roleAllows(actor.role,"team.owner")`, else 403. Add rows `team POST role-of-owner` / `remove-owner` → team.owner.
- **F2 (CSRF gap):** `requireAdmin` skips the origin check for `.read` actions even on POST/PUT. Mutating calls run under read actions: `preview-session` POST create / showDesign / revoke (storefront.read); `releases` POST preview; `integrations` POST test (outbound provider call). **Fix** in `lib/admin-auth.js`: `if ((isWriteAction(action) || mutatingMethod(request)) && !sameOrigin(request))`, where `mutatingMethod` = `request.method` exists and is not GET/HEAD. A missing method keeps today's behaviour (old fake requests in other suites).
- **F3 (no change, recorded):** `help` GET needs settings.read, so staff and support cannot open Help. `stores` GET uses storefront.read (line 2 checks it lists only the caller's own memberships). `maintenance-pass` gives support members a curtain pass (curtain only).

Everything else matches the matrix.

### 3. File plan (one builder, in this order)

1. `lib/platform/authz.js`: `export const ACTIONS = Object.freeze([...OWNER]);` (pure, edge-safe; not `*_SCOPES`).
2. `lib/admin-auth.js`: F2 method-aware origin check, with a comment.
3. `app/api/admin/team/route.js`: F1 owner-target check.
4. `scripts/support/route-harness.js` (helper): `registerHooks` for `@/` → repo path, `next/server|navigation` → `.js`, `next/headers` stubbed (pattern: `scripts/test-design-doc.js` lines 44-68); `makeRoleStore()` on `makePlatform` + `makeTenant({mode:"documents"})` from `scripts/support/tenant-fixture.js` (store A plus store B), users/memberships for owner/admin/staff/support via `lib/platform/identity.js`, sessions via `createSession`, an operator support grant; `as(caller)` → `call(path, method, {body, params, origin})` building a request (`method`, `url`, `nextUrl.pathname`, `cookies.get`, `headers.get` host/origin, `json()`, `formData()`) and importing `app/api/admin/<path>/route.js`.
5. `scripts/support/admin-routes.js`: the table (1.1) and exempt list (1.7) as plain data; per-row optional `allowStatus` with a one-line reason (never 401/403).
6. `scripts/test-permissions.js`: matrix (1.3); table vs authz (1.2); guard (1.6); role calls (1.4); cross-origin (1.5); exempt rules (1.7); fail-closed (1.8); F1 and F2 regressions. Prints "N rows × 7 callers"; removes its `.test-perm-*.db` files.
7. `package.json`: `"test:permissions": "node scripts/test-permissions.js"` (exactly; `run-tests.js` checks it), and the suite in `scripts/run-tests.js` if it keeps a list.
8. `docs/ARCHITECTURE.md`: matrix intro → "confirmed route by route by `test:permissions`", add the exempt-route list. (Session ticks FEATURES and writes DECISIONS.)

### 4. Decisions (recorded in docs/DECISIONS.md)

D1 hand-declared route table, results derived from `roleAllows`. D2 changing/removing an owner needs `team.owner`. D3 origin check on every non-GET/HEAD request. D4 export `ACTIONS`. D5 guard walks the filesystem. D6 allowed = not 401/403; bodies in line 2. D7 exempt routes with explicit rules; support gets a curtain pass. D8 new suite `test:permissions`.

### 5. Checks to run first

- `node --version` (needs `module.registerHooks`).
- `node scripts/test-authz.js && node scripts/test-design-doc.js`.
- A throwaway loop (in the scratchpad) importing each `app/api/admin/**/route.js` under the hooks; `first-run` and `brand-step` may pull JSX — see `scripts/test-first-run.js` ~line 292 for its loader.
- `grep -rn "requireAdmin(" scripts/test-*.js` for old fake requests without `method`; after F2 run `test-authz`, `test-preview-overlay`, `test-failure-matrix`, `test-documents` one by one.
- `grep -n "MAINTENANCE_PASS\|passSecret" lib/maintenance.js`; `grep -n "CONSOLE_API_PREFIX =" lib/tenant-request.js`.

### 6. Risks

1. Side effects of allowed calls: probes fail validation after the gate (`ord_missing`, `doc_missing`, invalid invite email, empty FormData, `{}`, provider `""`). Throwaway `file:` DBs (`assertLocalDbUrl`), `RATE_LIMIT_DISABLED=1`, Shopify/Razorpay/Resend/Typesense/R2 env blanked and asserted up front; logout last with its own session.
2. Parse before authorize (documents, preview-session): probes must be valid operations; signed-out gets exactly 401 on every gated row.
3. F2 may break old suites (mitigated by missing-method fallback); run the suites in §5.
4. Suite time: ~560 handler calls vs the 2-minute per-suite limit; import each route once, reuse sessions, small `PLATFORM_CACHE_MS` if needed.
5. Allowed routes answering 403 for their own reasons: `allowStatus` override per row with a reason, never 401/403 for an allowed role.
