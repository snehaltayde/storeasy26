# Phase 2 least-trusted audit

Date: 2026-11-25, on `main` at `8a243eb` (end of Phase 2). This was a read-only audit by the reviewer agent. The unit suites were run through `heavy`; no drills were run during the audit.

**Roles:** `support` in the merchant console (read-only, customer details hidden; operator-support reads as support) and the anonymous shopper on the storefront. Support holds `offers.read`, `orders.read`, `storefront.read` and `upsells.read`.

**Scope:** `5e091e5..8a243eb`, 138 commits. About 63 entry points: 26 API methods, 33 pages and layouts, 1 CSV export, 1 AI path and 2 shopper paths. No `"use server"` actions.

## Entry points

Every admin route checks `requireAdmin(request, action)` inside `tenantHandler`, so the store always comes from the request host. Writes are checked before the body is read. Every page reads its own actor, and the `(authed)` layout redirects to sign-in when there is none. `test-support-reads` sweeps all 33 `admin-pages.js` rows as support.

| Area | Check | Support gets | Proof (suite) |
|---|---|---|---|
| orders list and detail, push, reconcile, cancel | `orders.read`, and `orders.push` / `orders.cancel` checked before the existence check | Customer details redacted; search matches the order id only; writes are 403 with no 404 oracle | test-orders-console, test-support-reads, test-permissions |
| catalog views | `storefront.read`; another store's gid is 404 | Read-only; no sync control | test-catalog-browse |
| media library | `storefront.read` | Page and counts; writes 403 | test-media-library |
| quizzes (console) | `storefront.read`, and `storefront.write` plus the publish gate | Reads including Off quizzes; writes 403 with no audit row | test-quizzes-ui |
| experiments, insights, automations | `storefront.write`, then `storefront.publish`; automations need `settings.*` | 403 on writes; automations 403 | test-growth-ui |
| integrations, audit, settings tabs | `settings.read`, `audit.read`; the tenant filter comes first | No-access page | test-settings-ui, test-support-reads |
| team | `team.manage` / `team.owner`, with guards inside the SQL | 403, no email in the body; another store's user or invite is 404 | test-team |
| dashboard, analytics | `storefront.read`; sales only with `orders.read` | Aggregates only, no customer details, no settings links | test-dashboard, test-growth-ui |
| offers, bundles, editor, releases | actor, `canWrite` / `can.*` | All false; another store's or an unknown id is not-found | test-offers-console, test-editor-ui |
| shopper: `/api/quiz/<slug>`, `/quiz/<slug>` | An Off quiz is 404; another store's slug is 404 | — | test-quizzes-ui, test-shopper-reads |
| shopper: checkout order number, self-hosted fonts | Order status still needs the signed token | — | test-shopper-reads |

## Gaps (all fixed on `phase2/audit-fixes`)

| # | Severity | Gap | Fix |
|---|---|---|---|
| P2-A | Medium | Support sees raw Shopify push-failure text (`order.sync_error`, `events[].meta.error`), which can name env vars or echo `userErrors`. | Support gets fixed plain words; the raw text stays in the server log. Tested with a canary. |
| P2-B | Low | Support sees the shopper's free-text return reason and note. | Decision: shopper free text counts as customer details, so it is hidden from support in the route and the page. |
| P2-C | Low (test) | Order tab counts as support are untested with `?q=<email>`, so a future refactor could turn the counts into an "email exists" check. | Counts asserted to be 0. |
| P2-D | Low (test) | test-support-reads has no probes for Phase 2's new read views and uses missing ids on dynamic pages. | Probes and fixture ids added. |
| P2-E | Low (test) | Nothing pins the audit log's filters to the current store. | Cross-store filter test added. |
| P2-F | Low (latent) | The analytics page has no `orders.read` gate. | Gate and no-access page added, plus a guard that every page's row action is gated in its source. |
| P2-G | Low (carry-over) | Inviting an existing member at or above the invited role still creates an invite. | The route refuses it with 409 `ALREADY_MEMBER`: no row, no mail. |

**Accepted:** the team route's raw 422 text goes only to `team.manage` roles. Owners and admins see raw operator ids in audit entries. Support sees Off quizzes in the console. Quizzes are hard-deleted (they are not documents, and the delete is audited).

## Not checked

- Support's rendered markup in a browser (the drills were running elsewhere; covered by the Phase 2 `drill:all`).
- The operator console beyond `test-platform-permissions`.
- Real Shopify, Turso and Resend, including whether Shopify `userErrors` echo customer values.
- Timing side channels and `x-forwarded-for` spoofing.
- AI insight generation, which is unchanged in Phase 2.
