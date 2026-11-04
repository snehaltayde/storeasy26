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
the **console password (shown once — hand it over securely)** and the
order-link secret, registers the tenant, and starts a Free-plan subscription.
Nothing brand-flavored is seeded (S41): offers, CMS content and pages start
empty. (Also available from `/platform` → **New tenant** — the preferred,
console-first path. S51 additions on the tenant row: **More → Edit details**
fixes domains/app credentials/order-id prefix after the fact, **More → Share
access** creates the merchant's single-use owner invite or rotates the
console password, and **View store** opens the storefront.)

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

Open `https://<platform>/api/connect/shopify/start?tenant=<slug>` (as a
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

Give the merchant `https://<their-domain>/admin` + the generated password:

- **Settings** → rotate the console password (first thing), add Razorpay keys
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
