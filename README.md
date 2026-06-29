# storeasy26 — BeastLife fast storefront

A fast, PWA storefront that browses BeastLife's **real Shopify catalog**. The catalog is
synced into a local edge database and rendered from there (sub-ms reads), with search powered
by Typesense.

## Stack (locked)

- **Next.js 16** (App Router, JavaScript) + PWA shell (manifest + service worker)
- **Turso / libSQL + Kysely** — local catalog cache the pages read from
- **Shopify Storefront API** — source of truth, pulled by a sync job
- **Typesense** — product search (with an automatic SQL fallback until configured)

## Quick start

```bash
pnpm install
cp .env.example .env.local      # then fill in the Shopify values

pnpm migrate                    # create the catalog tables
pnpm shopify:token --write      # mint a Storefront token from the app's client ID/secret
pnpm sync                       # pull the real BeastLife catalog
# …or preview with fake data, no token needed:
pnpm seed:demo

pnpm dev                        # http://localhost:3007 (see .claude/launch.json)
```

Open the app: **Home → Collection → PDP** all render from the synced catalog, and the header
search box returns real products.

## Environment (`.env.local`)

| Variable | Required | Notes |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | yes | `*.myshopify.com` |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | yes | Dev Dashboard app credentials (post-Jan-2026 flow) |
| `SHOPIFY_STOREFRONT_TOKEN` | auto | minted by `pnpm shopify:token --write` |
| `SHOPIFY_API_VERSION` | no | defaults to `2025-10` |
| `NEXT_PUBLIC_SHOPIFY_DOMAIN` | no | customer domain for cart→checkout permalinks |
| `DATABASE_URL` | no | defaults to `file:local.db`; set `libsql://…` for Turso |
| `DATABASE_AUTH_TOKEN` | for Turso | Turso auth token |
| `TYPESENSE_HOST` / `TYPESENSE_ADMIN_API_KEY` | no | until set, search uses the DB fallback |

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | dev server on :3007 |
| `pnpm build` / `pnpm start` | production build / serve |
| `pnpm migrate` | apply the catalog schema (`--reset` to drop first / `pnpm db:reset`) |
| `pnpm sync` | Shopify → Turso → Typesense |
| `pnpm sync:search` | reindex Typesense from the local DB (no Shopify pull) |
| `pnpm seed:demo` | seed a tiny demo catalog (no Shopify needed) |
| `pnpm shopify:token` | mint a Storefront token from the app client/secret (`--write` saves it) |

## How it works

```
Shopify Storefront API ──pnpm sync──▶ Turso/libSQL ──Kysely──▶ Next.js pages (Home / Collection / PDP)
                                         └──────────▶ Typesense ──▶ /api/search ──▶ search box
```

- `lib/shopify.js` — paginated Storefront GraphQL pulls
- `lib/schema.sql` + `lib/db.js` — catalog tables + Kysely/libSQL client
- `lib/repo.js` — read queries the pages use (+ the `LIKE` search fallback)
- `scripts/sync.js` — the pipeline; `scripts/migrate.js` — schema
- Search prefers Typesense and **transparently falls back** to a SQL query over the catalog, so
  search works before Typesense is configured and upgrades automatically once it is.

## Going to production (edge + Turso)

1. Create a Turso DB, set `DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`, run `pnpm migrate && pnpm sync`.
2. The libSQL client speaks HTTP, so pages can run on the edge runtime (`export const runtime = "edge"`).
3. Set the `TYPESENSE_*` vars and run `pnpm sync:search` to power search with typo tolerance + ranking.
