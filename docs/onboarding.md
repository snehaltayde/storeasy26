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

## 3. Connect Shopify

Open `https://<platform>/api/connect/shopify/start?tenant=<slug>` (as a
signed-in operator, or append `&secret=$CRON_SECRET`), have the PARTNER click
Install/Approve on the Shopify screen. The callback stores the permanent
admin token encrypted, registers the 11 webhooks (catalog ×6, app/uninstalled,
refunds, fulfillments ×2, orders/cancelled — https platform URLs only; on
localhost run `pnpm webhooks:register <slug>` later), and kicks the first
sync. Big catalogs: run `pnpm tenant:sync <slug>` yourself. Shopify implies
read access when write is granted (write_orders covers read_orders) — the
scope check knows this (S51).

## 4. Domain

Point the partner's domain at the deployment (Vercel: add the domain to the
project; DNS CNAME per Vercel's instructions). It must appear in the tenant's
`domains` — provision set it, `patchTenant` edits it.

## 5. Merchant hand-off

Give the merchant `https://<their-domain>/admin` + the generated password:

- **Settings** → rotate the console password (first thing), add Razorpay keys
  (checkout is COD-only until then), GA4/Meta creds, shipping rules, identity.
- **Storefront** → announcement, hero, nav, content pages.
- **Offers / Upsells** → merchandising.

## 6. Verify (operator checklist)

```bash
pnpm tenant:sync <slug>                  # full catalog lands
curl https://<their-domain>/api/health   # status ok/degraded, right DB
# /platform row: products count · synced · Shopify ✓
```

- [ ] Storefront renders THEIR brand on their domain (title, logo, footer).
- [ ] Mutate a product in their Shopify admin → row updates within seconds
      (webhook), `shopify_webhook_applied` in logs with `tenant: <slug>`.
- [ ] Test COD order end-to-end → appears in /admin orders → draft order in
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
