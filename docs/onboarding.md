# Onboarding a design partner (v1 runbook)

v1 is hand-onboarding: 3–10 partners, one **custom-distribution Shopify app
per tenant**, billing off-platform. Everything here is operator work; the
merchant only clicks the Shopify install screen and later uses `/admin`.

## 0. Prerequisites (once per platform)

- `PLATFORM_DB_URL` / `PLATFORM_DB_TOKEN` / `PLATFORM_SECRET` (+`PLATFORM_URL`,
  `PLATFORM_ADMIN_PASSWORD`, `CRON_SECRET`) set in the runtime env.
- Operator machine: `turso auth login` (provisioning shells out to the CLI;
  set `TURSO_API_TOKEN`+`TURSO_ORG` instead for CI).

## 1. Partner supplies

| Item | Why |
|---|---|
| Shopify store domain (`x.myshopify.com`) | catalog + webhooks + order push |
| A custom-distribution app in THEIR Shopify Dev Dashboard → client id + secret | per-tenant OAuth + webhook HMAC |
| Storefront domain(s) they'll point at us | host → tenant routing |
| Brand basics: name, logo split, support email/phone, legal name | `config.site` |
| (later, in console) Razorpay keys, GA4/Meta creds | payments + tracking |

The app needs redirect URL `https://<platform>/api/connect/shopify/callback`
allowlisted, and the scopes in [lib/platform/oauth.js](../lib/platform/oauth.js).

## 2. Provision

```bash
pnpm tenant:provision <slug> --shop <x.myshopify.com> --name "Store Name" \
  --domain shop.partner.in --client-id <id> --client-secret <secret>
```

Creates `storeasy-t-<slug>` on Turso, applies the commerce schema, generates
a bootstrap console password (don't hand it over: the merchant gets their own
account by email, §5) and the order-link secret, registers the tenant, and starts a Free-plan subscription.
Nothing brand-flavored is seeded (S41): offers, CMS content and pages start
empty. (Also available from `/platform` → **New tenant** — the preferred,
console-first path. S51 additions on the tenant row: **More → Edit details**
fixes domains/app credentials/order-id prefix after the fact, **More → Help
this store…** opens it in **Signups & onboarding** (§5), and **View store**
opens the storefront. Phase 1 line 8 removed the old Share access dialog: an
operator never sees an invite link, a reset link or a password.)

**Which editor the store starts on (phase 4, owner answer OQ-4).** A new,
empty store starts on the **new editor** (documents mode). It stays
**private** until its first publish: shoppers see an "Opening soon" page, the
sitemap lists only the front door, and checkout refuses shoppers. The founder
can still walk the store and place a cash-on-delivery test order from the
editor's preview. The first publish from the editor opens the store; nothing
else does. Nothing is made for the store in advance: no pages, no release, no
saved look. The editor makes the home page and the other parts when they are
first opened.

- The closing summary of `pnpm tenant:provision` says which editor the store
  starts on. The run records it too (`/platform` → the provisioning run).
- A database that already holds store content (an existing one given with
  `--db-url`, or a `--force` re-provision of a store that has content) keeps
  the **old editor**, and the run says why in plain words. Such a store moves
  to the new editor only by the owner's cutover
  (`docs/cms-reviews/P4-CUTOVER-RUNBOOK.md`).
- `--legacy-content` starts a new store on the old editor instead (an
  operator escape, recorded in the run). Use it only when the owner asks.
- Existing stores are never moved by provisioning. They move only by the
  owner's cutover runbook.

## 3. Connect Shopify

**Founder flow (Phase 1 line 4).** The founder enters the shop's address in
onboarding step 1. Until the store's Shopify app is set up (client id and
secret on the store), the address is saved and the step says "Storeasy's team
is preparing your Shopify connection." Set the app up: in its Shopify app add
the redirect URL(s) the operator console lists under the store ("Redirect URLs
to add to this store's Shopify app", one per store domain:
`https://<store domain>/api/admin/shopify/callback`), then save the client id
and secret in `/platform`. The address is then locked (a wrong store needs
support), and the founder presses Connect to Shopify and approves. Tokens are
Shopify's expiring offline tokens (1 hour, refresh token 90 days): Storeasy
refreshes them about a minute before they expire. If Shopify refuses a refresh,
both tokens are cleared, an alert goes out and step 1 says "Connect again".
The operator flow below shares the same exchange, so it gets expiring tokens
too. Only an owner or an admin can connect.

**Operator flow.** Open `https://<platform>/api/connect/shopify/start?tenant=<slug>` (as a
signed-in operator, or append `&secret=$CRON_SECRET`), have the PARTNER click
Install/Approve on the Shopify screen. The callback stores the permanent
admin token encrypted, registers the 11 webhooks (catalog ×6, app/uninstalled,
refunds, fulfillments ×2, orders/cancelled — https platform URLs only; on
localhost run `pnpm webhooks:register <slug>` later), and queues the first
sync (GEN-02). The sync is a recorded run that goes one Shopify page at a
time and remembers where it is, so any catalog size finishes. The first
~45 seconds run straight after the callback. After that it moves when one of
these runs: the job tick (`/api/jobs/tick`, OQ-19 — `jobs-tick.yml` does
nothing until its secrets are set); the merchant's sync card while it is open
and showing progress (dashboard or Settings; each 3-second poll gives the
sync its next slice, and a slice the platform cut off is picked up again
once its leases run out, two to three minutes); or the card's Try again. With
no tick and nobody watching, a big catalog waits. After 30 minutes without
progress the card reads "stopped partway" and stops polling; Try again picks
it up from the last page that went in. A failure shows a plain message and
the same Try again. `pnpm tenant:sync <slug>` still works and joins a sync
already under way. Shopify implies read access when write is granted
(write_orders covers read_orders) — the scope check knows this (S51).

## 4. Domain

Point the partner's domain at the deployment (Vercel: add the domain to the
project; DNS CNAME per Vercel's instructions). It must appear in the tenant's
`domains` — provision set it, `patchTenant` edits it.

## 5. Merchant hand-off

Access goes out by email only, from `/platform` → **Signups & onboarding**
(open the store's row):

- **Email an owner invite** (a store with no owner yet): a 7-day, single-use
  invite to the email on file (the founder's signup email, else the store's
  support email). The merchant picks their own password. An earlier unused
  owner invite for that email stops working once the new one is sent.
- **Send sign-in help** (a store with owners): the store's `/admin/login`
  address and a one-hour, single-use password-reset link, to an active owner
  chosen from those on file.
- You can't type a recipient, and neither action shows you a token or a link.
  At most 5 help emails per store per hour.
- **Open support access** (a reason, 1–72 hours) lets you look at the store's
  console read-only; the merchant sees a banner while it is open.

Once they are signed in:

- **Settings** → add Razorpay keys
  (checkout is COD-only until then), GA4/Meta creds, shipping rules, identity.
- **Setup** → the checklist. On a new-editor store every step opens the
  editor or the console screen where the work happens: Design for the look
  and brand, the editor's Pages for the privacy and terms (or refund) pages,
  the editor's preview for the draft walk-through and the test order, and
  Publish for the launch. "Launch" ticks itself the moment the first publish
  opens the store.
- **Editor** (new-editor stores) → home page, pages, announcement, header and
  footer, design; publish to open the store.
- **Storefront** (old-editor stores) → announcement, hero, nav, content pages.
- **Offers / Upsells** → merchandising.

## 6. Verify (operator checklist)

```bash
pnpm tenant:sync <slug>                  # full catalog lands
curl https://<their-domain>/api/health   # status ok/degraded, right DB
# /platform row: products count · synced · Shopify ✓
```

- [ ] New-editor store, before its first publish: the domain shows "Opening
      soon" and the Setup checklist's links all open working screens.
- [ ] Storefront renders THEIR brand on their domain (title, logo, footer)
      (a new-editor store: after its first publish).
- [ ] Mutate a product in their Shopify admin → row updates within seconds
      (webhook), `shopify_webhook_applied` in logs with `tenant: <slug>`.
- [ ] Test COD order end-to-end (a new-editor store before its first publish:
      from the editor's preview) → appears in /admin orders → draft order in
      THEIR Shopify → `pnpm order:cancel <id> --tenant <slug>` cleans up.
- [ ] `/api/health?all=1&secret=…` includes the new tenant, status ok.
- [ ] Payments: after they add Razorpay keys, a ₹1 live-mode capture+refund
      (their account, their call) before real traffic.

## Ops quick reference

- Crons (`/api/jobs/sync-shopify`, `/api/jobs/forward-events`) and
  `/api/health?all=1` loop every active tenant automatically.
- Logs and alerts carry `tenant:` — filter Vercel logs by slug.
- Suspend from `/platform` (host falls back to the default store, never 500s).
- `pnpm order:trace <id> --tenant <slug>` / `pnpm order:cancel … --tenant <slug>`.
- Full reconcile: `POST /api/jobs/sync-catalog {tenant}` or `pnpm tenant:sync`.
