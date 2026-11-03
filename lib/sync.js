import { db, libsql } from "./db.js";
import { tenantSecret, tenantCfg, tenantOwnSecret, tenantOwnCfg, currentTenant, withTenant } from "./tenant-context.js";
import {
  fetchProductsPage as fetchProductsPageStorefront,
  fetchCollectionsPage as fetchCollectionsPageStorefront,
} from "./shopify.js";
import {
  fetchProductsPageAdmin,
  fetchCollectionsPageAdmin,
  fetchCollectionMembersPageAdmin,
  countProductsAdmin,
  fetchProductAdmin,
  fetchCollectionAdmin,
} from "./shopify-admin-catalog.js";
import { getAdminClient, typesenseConfigured, productsCollectionSchema, productsCollection } from "./typesense.js";
import { runState, syncView, ACTIVE_STATES } from "./admin/sync-view.js";

// Catalog sync engine (Session 21) — extracted from scripts/sync.js so it runs
// per TENANT: `withTenant(t, () => runCatalogSync())` routes every read/write
// (Shopify creds, db, Typesense collection) through that tenant. The script
// stays a thin wrapper; webhooks use the single-entity functions below for
// incremental freshness (targeted REFETCH via Admin GraphQL → the exact same
// reshape/write path as the full sync — no third payload format to maintain).
//
// GEN-02: a full sync is a recorded RUN (sync_runs) that advances one page at
// a time. A step fetches one Shopify page and writes it, together with the
// run's new position, in ONE atomic batch, so a runner killed anywhere leaves
// the run at its last committed page and the next runner picks up there:
//
//   products pages → collections pages → prune → search index → complete
//
// Any runner can drive a run — a queued job slice (lib/platform/sync-jobs.js),
// a console nudge, or the CLI loop in runCatalogSync — and a lease on the run
// row means only one at a time. Prune and indexing happen only once every
// page of the generation is in; a failed or unfinished run removes nothing.
// Every write is idempotent (upserts, delete-then-insert of children inside
// the same batch), so re-running a page after an unknown outcome is safe
// whether or not the db layer retried it.

const nowIso = () => new Date().toISOString();
const num = (x) => (x == null || x === "" ? null : Number(x));
const noop = () => {};
const errText = (e) => String(e?.message || e).slice(0, 300);

export const SYNC_TIMING = {
  RUN_LEASE_MS: 90_000, // renewed by every committed page; a killed runner frees the run within this
  SLICE_MS: 40_000, // most work one queued slice does (routes have 60s)
  MIN_PAGE_MS: 8_000, // never start a page with less time than this left
};

const NO_CREDS = "No Shopify credentials for this tenant (admin token or storefront token required)";

// S53 (audit A3): a PLATFORM tenant's source comes from ITS OWN row only —
// the env fallback used to let a credential-less tenant select the
// storefront source and then ingest the env-configured shop's catalog into
// its own database (wrong-shop ingestion). The env path remains for the
// legacy/_default store alone.
const platformTenant = () => {
  const t = currentTenant();
  return t && t.id !== "_default" ? t : null;
};

// Per-call source detection (tenant-own on the platform; env for legacy).
function catalogSource() {
  if (platformTenant()) {
    const hasStorefront = Boolean(
      tenantOwnCfg("shopify_store_domain", null, null) &&
        (tenantOwnSecret("shopify_storefront_token") || tenantOwnSecret("shopify_storefront_private_token")),
    );
    const hasAdmin = Boolean(
      tenantOwnSecret("shopify_admin_token") ||
        (tenantOwnCfg("shopify_client_id", null, null) && tenantOwnSecret("shopify_client_secret")),
    );
    return hasAdmin ? "admin" : hasStorefront ? "storefront" : null;
  }
  const hasStorefront = Boolean(
    tenantSecret("shopify_storefront_token", "SHOPIFY_STOREFRONT_TOKEN") ||
      tenantSecret("shopify_storefront_private_token", "SHOPIFY_STOREFRONT_PRIVATE_TOKEN"),
  );
  const hasAdmin = Boolean(
    tenantSecret("shopify_admin_token", "SHOPIFY_ADMIN_TOKEN") ||
      (tenantCfg("shopify_client_id", "SHOPIFY_CLIENT_ID") &&
        tenantSecret("shopify_client_secret", "SHOPIFY_CLIENT_SECRET")),
  );
  // Admin is preferred on the platform (single-credential onboarding).
  return hasAdmin ? "admin" : hasStorefront ? "storefront" : null;
}

// Storefront-source credentials: the tenant's own, verbatim (shopify.js
// throws on a provided-but-incomplete creds object instead of touching env);
// null = the legacy env-configured store.
function storefrontCreds() {
  if (!platformTenant()) return null;
  return {
    domain: tenantOwnCfg("shopify_store_domain", null, null),
    privateToken: tenantOwnSecret("shopify_storefront_private_token") || null,
    publicToken: tenantOwnSecret("shopify_storefront_token") || null,
  };
}

// ---- idempotent write statements --------------------------------------------
// Plain {sql, args} so one page's rows and the run's new position go out as
// ONE batch (one transaction). Re-running any of these is a no-op in effect.

function upsertStmt(table, row, conflictCol = "id") {
  const cols = Object.keys(row);
  const sets = cols.filter((c) => c !== conflictCol).map((c) => `${c} = excluded.${c}`);
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(${conflictCol}) DO UPDATE SET ${sets.join(", ")}`,
    args: cols.map((c) => row[c] ?? null),
  };
}

// Multi-row upsert, chunked. ON CONFLICT DO UPDATE (not a plain INSERT) so a
// statement that already ran — its answer lost, then retried — can't fail
// the page on a duplicate key.
function upsertManyStmts(table, rows, chunk = 80) {
  const out = [];
  if (!rows.length) return out;
  const cols = Object.keys(rows[0]);
  const sets = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    out.push({
      sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${slice.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ")} ON CONFLICT(id) DO UPDATE SET ${sets.join(", ")}`,
      args: slice.flatMap((r) => cols.map((c) => r[c] ?? null)),
    });
  }
  return out;
}

// Shopify handles are unique at any moment, so a row holding this handle
// under ANOTHER id is a product deleted (or renamed) upstream. Without this,
// a recreated product with a reused handle hits the UNIQUE(handle) constraint
// and the sync can never get past that page.
const OTHER_WITH_HANDLE = (table) => `SELECT id FROM ${table} WHERE handle = ? AND id != ?`;

export function productStatements(p, syncedAt = nowIso(), generation = null) {
  const currency = p.priceRange?.minVariantPrice?.currencyCode || null;
  const clash = [p.handle, p.id];
  return [
    { sql: `DELETE FROM variants WHERE product_id IN (${OTHER_WITH_HANDLE("products")})`, args: clash },
    { sql: `DELETE FROM product_images WHERE product_id IN (${OTHER_WITH_HANDLE("products")})`, args: clash },
    { sql: `DELETE FROM collection_products WHERE product_id IN (${OTHER_WITH_HANDLE("products")})`, args: clash },
    { sql: "DELETE FROM products WHERE handle = ? AND id != ?", args: clash },
    upsertStmt("products", {
      id: p.id,
      ...(generation !== null ? { sync_generation: generation } : {}),
      handle: p.handle,
      title: p.title,
      description: p.description || null,
      description_html: p.descriptionHtml || null,
      product_type: p.productType || null,
      vendor: p.vendor || null,
      tags: JSON.stringify(p.tags || []),
      price_min: num(p.priceRange?.minVariantPrice?.amount),
      price_max: num(p.priceRange?.maxVariantPrice?.amount),
      compare_at_min: num(p.compareAtPriceRange?.minVariantPrice?.amount) || null,
      currency,
      available: p.availableForSale ? 1 : 0,
      total_inventory: p.totalInventory ?? null,
      featured_image: p.featuredImage?.url || null,
      featured_image_alt: p.featuredImage?.altText || null,
      options: JSON.stringify(p.options || []),
      created_at: p.createdAt || null,
      updated_at: p.updatedAt || null,
      synced_at: syncedAt,
    }),
    { sql: "DELETE FROM product_images WHERE product_id = ?", args: [p.id] },
    ...upsertManyStmts(
      "product_images",
      (p.images?.nodes || []).map((img, i) => ({
        id: `${p.id}::img::${i}`,
        product_id: p.id,
        url: img.url,
        alt: img.altText || null,
        width: img.width ?? null,
        height: img.height ?? null,
        position: i,
      })),
    ),
    { sql: "DELETE FROM variants WHERE product_id = ?", args: [p.id] },
    ...upsertManyStmts(
      "variants",
      (p.variants?.nodes || []).map((v, i) => ({
        id: v.id,
        product_id: p.id,
        title: v.title || null,
        sku: v.sku || null,
        price: num(v.price?.amount),
        compare_at_price: num(v.compareAtPrice?.amount) || null,
        currency: v.price?.currencyCode || currency,
        available: v.availableForSale ? 1 : 0,
        selected_options: JSON.stringify(v.selectedOptions || []),
        image_url: v.image?.url || null,
        position: i,
      })),
    ),
  ];
}

// Memberships keep only products that exist in this database: the join runs
// inside the statement, so it is exact even while webhooks write. (Admin
// collections list drafts too; those never reach `products`.) Positions are
// Shopify's own order; `startAt` continues a long collection's later pages.
function memberStatements(collectionId, nodes, { onlyExistingProducts = true, startAt = 0 } = {}) {
  const members = [];
  const seen = new Set();
  (nodes || []).forEach((node, i) => {
    if (!node?.id || seen.has(node.id)) return;
    seen.add(node.id);
    members.push([node.id, startAt + i]);
  });
  const out = [];
  for (let i = 0; i < members.length; i += 200) {
    const slice = members.slice(i, i + 200);
    out.push(
      onlyExistingProducts
        ? {
            sql: `INSERT OR REPLACE INTO collection_products (collection_id, product_id, position)
                  SELECT ?, v.column1, v.column2 FROM (VALUES ${slice.map(() => "(?, ?)").join(", ")}) AS v JOIN products p ON p.id = v.column1`,
            args: [collectionId, ...slice.flat()],
          }
        : {
            sql: `INSERT OR REPLACE INTO collection_products (collection_id, product_id, position) VALUES ${slice.map(() => "(?, ?, ?)").join(", ")}`,
            args: slice.flatMap(([pid, pos]) => [collectionId, pid, pos]),
          },
    );
  }
  return out;
}

export function collectionStatements(c, { onlyExistingProducts = true } = {}, syncedAt = nowIso(), generation = null) {
  const clash = [c.handle, c.id];
  const memberStmts = memberStatements(c.id, c.products?.nodes, { onlyExistingProducts });
  return [
    { sql: `DELETE FROM collection_products WHERE collection_id IN (${OTHER_WITH_HANDLE("collections")})`, args: clash },
    { sql: "DELETE FROM collections WHERE handle = ? AND id != ?", args: clash },
    upsertStmt("collections", {
      id: c.id,
      ...(generation !== null ? { sync_generation: generation } : {}),
      handle: c.handle,
      title: c.title,
      description: c.description || null,
      image: c.image?.url || null,
      image_alt: c.image?.altText || null,
      updated_at: c.updatedAt || null,
      synced_at: syncedAt,
    }),
    { sql: "DELETE FROM collection_products WHERE collection_id = ?", args: [c.id] },
    ...memberStmts,
  ];
}

// Write ONE storefront-shaped product (the exact S1 shape) + images + variants,
// atomically. `generation` (S30): full syncs stamp their run id; webhook
// writes leave it null — their fresh synced_at is what protects them from the
// post-run prune.
export async function writeProduct(p, syncedAt = nowIso(), generation = null) {
  await libsql.batch(productStatements(p, syncedAt, generation), "write");
}

export async function writeCollection(c, { onlyExistingProducts = true } = {}, syncedAt = nowIso(), generation = null) {
  await libsql.batch(collectionStatements(c, { onlyExistingProducts }, syncedAt, generation), "write");
}

// ---- incremental (webhook-driven) operations -------------------------------

export async function deleteProductByGid(gid) {
  await db.deleteFrom("variants").where("product_id", "=", gid).execute();
  await db.deleteFrom("product_images").where("product_id", "=", gid).execute();
  await db.deleteFrom("collection_products").where("product_id", "=", gid).execute();
  await db.deleteFrom("products").where("id", "=", gid).execute();
  return { deleted: gid };
}

export async function deleteCollectionByGid(gid) {
  await db.deleteFrom("collection_products").where("collection_id", "=", gid).execute();
  await db.deleteFrom("collections").where("id", "=", gid).execute();
  return { deleted: gid };
}

// Refetch one product from the Admin API and upsert; a product that is gone
// or no longer active is REMOVED (matching the full sync's status:active view).
export async function syncProductByGid(gid, { gql } = {}) {
  const p = await fetchProductAdmin(gid, { gql });
  if (!p) return deleteProductByGid(gid);
  await writeProduct(p);
  return { synced: gid, handle: p.handle };
}

export async function syncCollectionByGid(gid, { gql } = {}) {
  const c = await fetchCollectionAdmin(gid, { gql });
  if (!c) return deleteCollectionByGid(gid);
  await writeCollection(c);
  return { synced: gid, handle: c.handle, members: c.products?.nodes?.length ?? 0 };
}

// ---- search index ----------------------------------------------------------

// NON-FATAL since S21: a dead search cluster must never fail catalog freshness
// (the storefront's SQL fallback keeps search working).
export async function indexTypesense({ log = noop } = {}) {
  if (!typesenseConfigured()) {
    log("• Typesense not configured — search uses the DB fallback");
    return { indexed: 0, skipped: "not configured" };
  }
  // S53 (audit A3 boundary): no own namespace → never index into a shared one
  if (!productsCollection()) {
    log("• No Typesense namespace for this tenant — search uses the DB fallback");
    return { indexed: 0, skipped: "no tenant namespace" };
  }
  try {
    const client = getAdminClient();
    try {
      await client.collections(productsCollection()).delete();
    } catch {
      /* collection didn't exist yet */
    }
    await client.collections().create(productsCollectionSchema());

    const rows = await db
      .selectFrom("products")
      .select(["handle", "title", "description", "product_type", "vendor", "tags", "price_min", "currency", "available", "featured_image"])
      .execute();
    const docs = rows.map((r) => {
      let tags = [];
      try {
        tags = JSON.parse(r.tags || "[]");
      } catch {
        tags = [];
      }
      return {
        id: r.handle,
        handle: r.handle,
        title: r.title,
        description: r.description || "",
        product_type: r.product_type || "",
        vendor: r.vendor || "",
        tags,
        image: r.featured_image || "",
        price: r.price_min ?? 0,
        currency: r.currency || "INR",
        available: !!r.available,
      };
    });
    if (!docs.length) return { indexed: 0 };
    const results = await client.collections(productsCollection()).documents().import(docs, { action: "upsert" });
    const failed = results.filter((x) => x && x.success === false);
    log(`  ✓ indexed ${docs.length - failed.length}/${docs.length} into Typesense (${productsCollection()})`);
    return { indexed: docs.length - failed.length, failed: failed.length };
  } catch (e) {
    log(`  ! search index failed (catalog sync unaffected): ${String(e?.message || e).slice(0, 120)}`);
    return { indexed: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

// ---- runs (S30 generations; GEN-02 resumable) ---------------------------------

const hex = (bytes) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
};
const genId = () => "sync_" + hex(8);
const newOwner = () => "lease_" + hex(8);
const leaseUntil = () => new Date(Date.now() + SYNC_TIMING.RUN_LEASE_MS).toISOString();
const plain = (row) => (row ? { ...row } : null);

export async function listSyncRuns({ limit = 10 } = {}) {
  const rows = await db
    .selectFrom("sync_runs")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(Math.min(Number(limit) || 10, 50))
    .execute();
  return rows.map((r) => ({ ...r }));
}

export async function getSyncRun(id) {
  const r = await libsql.execute({ sql: "SELECT * FROM sync_runs WHERE id = ?", args: [id] });
  return plain(r.rows[0]);
}

export async function latestSyncRun() {
  const r = await libsql.execute("SELECT * FROM sync_runs ORDER BY started_at DESC, rowid DESC LIMIT 1");
  return plain(r.rows[0]);
}

async function startRun({ source, startedBy }) {
  const id = genId();
  const now = nowIso();
  // Open the run BEFORE fetching: started_at is the webhook-race watermark —
  // anything written after it survives the prune.
  await libsql.execute({
    sql: `INSERT INTO sync_runs (id, kind, status, phase, started_at, updated_at, source, started_by)
          VALUES (?, 'full', 'running', 'products', ?, ?, ?, ?)`,
    args: [id, now, now, source, startedBy],
  });
  // retention: keep the last ~50 runs
  await libsql
    .execute("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT 50)")
    .catch(() => {});
  return getSyncRun(id);
}

// Start a sync, or hand back the one already under way. One run at a time per
// store: a second request while a run is active joins it. `retry` (the
// founder's "Try again") resumes a failed run from its stored position when
// that position is still meaningful (same Shopify API, new-style run).
//   → { run, action: "joined" | "resumed" | "started" }
export async function requestCatalogSync({ startedBy = "manual", retry = false, fetchers = null } = {}) {
  let latest = await latestSyncRun();
  let state = runState(latest);
  if (ACTIVE_STATES.has(state) && !latest.phase) {
    // A run from before resumable syncs (no phase, no position): it can't be
    // continued, and leaving it "running" would block every new sync.
    await failSyncRun(latest.id, "an older sync stopped partway and can't be continued");
    latest = await getSyncRun(latest.id);
    state = runState(latest);
  }
  if (ACTIVE_STATES.has(state)) {
    if (retry && (state === "stalled" || latest.error)) {
      await libsql.execute({
        sql: "UPDATE sync_runs SET error = NULL, updated_at = ? WHERE id = ? AND status = 'running'",
        args: [nowIso(), latest.id],
      });
      return { run: await getSyncRun(latest.id), action: "resumed" };
    }
    return { run: latest, action: "joined" };
  }
  const source = fetchers ? "injected" : catalogSource();
  if (
    retry &&
    state === "failed" &&
    latest.phase &&
    latest.phase !== "done" &&
    latest.source &&
    latest.source === source &&
    !/source changed/i.test(latest.error || "")
  ) {
    await libsql.execute({
      sql: `UPDATE sync_runs SET status = 'running', error = NULL, finished_at = NULL, updated_at = ?,
              lease_owner = NULL, lease_until = NULL
            WHERE id = ? AND status = 'failed'`,
      args: [nowIso(), latest.id],
    });
    return { run: await getSyncRun(latest.id), action: "resumed" };
  }
  if (!source) throw new Error(NO_CREDS);
  return { run: await startRun({ source, startedBy }), action: "started" };
}

// Lease the run for one runner. Re-acquiring your own lease succeeds, so a
// retried acquire whose first answer was lost still counts.
async function acquireLease(runId, owner) {
  const now = nowIso();
  const stmt = {
    sql: `UPDATE sync_runs SET lease_owner = ?, lease_until = ?
          WHERE id = ? AND status = 'running' AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`,
    args: [owner, leaseUntil(), runId, owner, now],
  };
  try {
    const r = await libsql.execute(stmt);
    return Number(r.rowsAffected) === 1;
  } catch (e) {
    const fresh = await getSyncRun(runId).catch(() => null);
    if (fresh?.lease_owner === owner) return true;
    throw e;
  }
}

async function releaseLease(runId, owner) {
  await libsql
    .execute({ sql: "UPDATE sync_runs SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?", args: [runId, owner] })
    .catch(() => {});
}

// Mark a run failed. Without an owner (the queue giving up), only when no live
// runner holds it. Nothing is pruned: a failed run keeps every good row.
export async function failSyncRun(runId, message, { owner = null } = {}) {
  const now = nowIso();
  await libsql.execute({
    sql: `UPDATE sync_runs SET status = 'failed', error = ?, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_until = NULL
          WHERE id = ? AND status = 'running' AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`,
    args: [String(message || "failed").slice(0, 300), now, now, runId, owner, now],
  });
}

// A queued slice failed but will be retried: say so on the run (the console
// shows "trying again") and free it for the next attempt.
async function noteRetry(runId, message, owner) {
  await libsql
    .execute({
      sql: "UPDATE sync_runs SET error = ?, updated_at = ?, lease_owner = NULL, lease_until = NULL WHERE id = ? AND status = 'running' AND lease_owner = ?",
      args: [message, nowIso(), runId, owner],
    })
    .catch(() => {});
}

// Errors no retry can fix: fail the run at once with the plain message.
const PERMANENT = /no shopify credentials|source changed|no shopify_admin_token|client_id\/secret not set|store domain is not configured|no storefront token|no shopify store domain|\b(401|402|403|404|423)\b|access_denied|invalid api key/i;
export const isPermanentSyncError = (e) => PERMANENT.test(errText(e));

// ---- one step = one committed page ----------------------------------------------

// The guard every step commits behind: this runner still holds the run, at
// the position it read. If not, the batch must not write: when the UPDATE
// matched nothing, the second statement re-inserts the run's own id, the
// primary key refuses it, and the whole batch rolls back.
const GUARD_WHERE = "id = ? AND status = 'running' AND phase = ? AND lease_owner = ? AND pages_done = ?";
const guardArgs = (run, owner) => [run.id, run.phase, owner, run.pages_done];
const abortUnlessGuarded = (runId) => ({ sql: "INSERT INTO sync_runs (id) SELECT ? WHERE changes() = 0", args: [runId] });

// Commit one step. On any error, re-read the run: the commit may have landed
// with only its answer lost (Turso over HTTP), or the db layer may have retried
// it into the guard. → the fresh run, or { lost: true } when another runner
// owns it now.
async function commit(run, owner, guard, stmts) {
  try {
    await libsql.batch([guard, abortUnlessGuarded(run.id), ...stmts], "write");
  } catch (e) {
    const fresh = await getSyncRun(run.id).catch(() => null);
    const advanced = fresh && Number(fresh.pages_done) === Number(run.pages_done) + 1;
    if (advanced && (fresh.lease_owner === owner || fresh.status === "complete")) return fresh;
    if (fresh && (fresh.lease_owner !== owner || Number(fresh.pages_done) !== Number(run.pages_done) || fresh.status !== "running")) {
      return { lost: true, run: fresh };
    }
    throw e;
  }
  return getSyncRun(run.id);
}

function checkPage(page, cursor) {
  if (!page || !Array.isArray(page.nodes)) throw new Error("Shopify returned a page Storeasy couldn't read");
  if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) throw new Error("Shopify returned the same page twice");
}

async function productsStep(run, ctx, owner) {
  const page = await ctx.productsPage(run.cursor);
  checkPage(page, run.cursor);
  let total = null;
  if (Number(run.pages_done) === 0 && ctx.countProducts) {
    const c = await ctx.countProducts().catch(() => null);
    if (c && !c.atLeast) total = c.count; // "at least N" is no denominator
  }
  const syncedAt = nowIso();
  const fetched = Number(run.products_fetched || 0) + page.nodes.length;
  const guard = {
    sql: `UPDATE sync_runs SET cursor = ?, products_fetched = ?, phase = ?, products_total = COALESCE(?, products_total),
            pages_done = pages_done + 1, error = NULL, updated_at = ?, lease_until = ?
          WHERE ${GUARD_WHERE}`,
    args: [page.endCursor ?? run.cursor, fetched, page.hasNextPage ? "products" : "collections", total, nowIso(), leaseUntil(), ...guardArgs(run, owner)],
  };
  const res = await commit(run, owner, guard, page.nodes.flatMap((p) => productStatements(p, syncedAt, run.id)));
  ctx.log(`  fetched ${fetched} products…`, true);
  return res;
}

// One page of collections with their first 250 members each. A collection
// with more becomes a "tail", drained a page per step (membersStep) before
// the next collections page, so every step stays a couple of Shopify calls.
async function collectionsStep(run, ctx, owner) {
  const page = await ctx.collectionsPage(run.collections_cursor);
  checkPage(page, run.collections_cursor);
  const syncedAt = nowIso();
  const fetched = Number(run.collections_fetched || 0) + page.nodes.length;
  const after = page.hasNextPage ? "collections" : "prune";
  const tails = ctx.membersPage
    ? page.nodes
        .filter((c) => c.products?.pageInfo?.hasNextPage && c.products.pageInfo.endCursor)
        .map((c) => ({ c: c.id, cursor: c.products.pageInfo.endCursor, at: c.products.nodes.length }))
    : [];
  const guard = {
    sql: `UPDATE sync_runs SET collections_cursor = ?, collections_fetched = ?, phase = ?, member_tails = ?,
            pages_done = pages_done + 1, error = NULL, updated_at = ?, lease_until = ?
          WHERE ${GUARD_WHERE}`,
    args: [
      page.endCursor ?? run.collections_cursor,
      fetched,
      tails.length ? "members" : after,
      tails.length ? JSON.stringify({ then: after, tails }) : null,
      nowIso(),
      leaseUntil(),
      ...guardArgs(run, owner),
    ],
  };
  const res = await commit(run, owner, guard, page.nodes.flatMap((c) => collectionStatements(c, { onlyExistingProducts: true }, syncedAt, run.id)));
  ctx.log(`  fetched ${fetched} collections…`, true);
  return res;
}

// One more page of one long collection's members.
async function membersStep(run, ctx, owner) {
  let queue;
  try {
    queue = JSON.parse(run.member_tails || "null");
  } catch {
    queue = null;
  }
  if (!queue?.tails?.length || !ctx.membersPage) throw new Error(`sync run ${run.id} has no collection members left to read`);
  const [tail, ...others] = queue.tails;
  const page = await ctx.membersPage(tail.c, tail.cursor);
  checkPage(page, tail.cursor);
  const rest = page.hasNextPage ? [{ ...tail, cursor: page.endCursor, at: tail.at + page.nodes.length }, ...others] : others;
  const guard = {
    sql: `UPDATE sync_runs SET phase = ?, member_tails = ?, pages_done = pages_done + 1, error = NULL, updated_at = ?, lease_until = ?
          WHERE ${GUARD_WHERE}`,
    args: [rest.length ? "members" : queue.then, rest.length ? JSON.stringify({ then: queue.then, tails: rest }) : null, nowIso(), leaseUntil(), ...guardArgs(run, owner)],
  };
  return commit(run, owner, guard, memberStatements(tail.c, page.nodes, { startAt: tail.at }));
}

// The COMPLETE generation removes what it didn't see — unless something (a
// webhook) wrote it after the run started. Children go first so nothing
// orphans. This is also the missed-delete repair. The guard requires the run
// to be at phase 'prune' in the database, which only the last collections page
// sets, so no partial generation can ever reach these deletes. Exported for
// the suite, which proves that guard on a forged run.
export async function pruneGeneration(run, owner) {
  const stale = "(sync_generation IS NULL OR sync_generation != ?) AND (synced_at IS NULL OR synced_at < ?)";
  const w = [run.id, run.started_at];
  const guard = {
    sql: `UPDATE sync_runs SET phase = 'index',
            pruned_products = (SELECT COUNT(*) FROM products WHERE ${stale}),
            pruned_collections = (SELECT COUNT(*) FROM collections WHERE ${stale}),
            pages_done = pages_done + 1, error = NULL, updated_at = ?, lease_until = ?
          WHERE ${GUARD_WHERE} AND phase = 'prune'`,
    args: [...w, ...w, nowIso(), leaseUntil(), ...guardArgs(run, owner)],
  };
  return commit(run, owner, guard, [
    { sql: `DELETE FROM variants WHERE product_id IN (SELECT id FROM products WHERE ${stale})`, args: w },
    { sql: `DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE ${stale})`, args: w },
    { sql: `DELETE FROM collection_products WHERE product_id IN (SELECT id FROM products WHERE ${stale})`, args: w },
    { sql: `DELETE FROM products WHERE ${stale}`, args: w },
    { sql: `DELETE FROM collection_products WHERE collection_id IN (SELECT id FROM collections WHERE ${stale})`, args: w },
    { sql: `DELETE FROM collections WHERE ${stale}`, args: w },
  ]);
}

async function pruneStep(run, ctx, owner) {
  const res = await pruneGeneration(run, owner);
  if (!res.lost && (res.pruned_products || res.pruned_collections)) {
    ctx.log(`  ✓ pruned ${res.pruned_products} stale product(s), ${res.pruned_collections} stale collection(s)`);
  }
  return res;
}

async function indexStep(run, ctx, owner) {
  const search = await ctx.index({ log: ctx.log });
  const now = nowIso();
  const guard = {
    sql: `UPDATE sync_runs SET status = 'complete', phase = 'done', products = products_fetched, collections = collections_fetched,
            pages_done = pages_done + 1, error = NULL, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_until = NULL
          WHERE ${GUARD_WHERE} AND phase = 'index'`,
    args: [now, now, ...guardArgs(run, owner)],
  };
  const res = await commit(run, owner, guard, []);
  return res.lost ? res : { ...res, search };
}

const STEPS = { products: productsStep, collections: collectionsStep, members: membersStep, prune: pruneStep, index: indexStep };

// The Shopify page readers for this run. A run keeps the API it started on: a
// cursor from one is meaningless to the other.
function fetchContext(run, { fetchers, indexer, log }) {
  const index = indexer || indexTypesense;
  if (fetchers) {
    // Injected readers (tests). Page-shaped ({ productsPage, collectionsPage })
    // or whole-catalog functions ({ products, collections }), read as one page.
    const whole = (fn, extra) => async () => {
      let last = null;
      const nodes = await fn({ pageSize: 50, ...extra, onPage: (_n, c) => (c != null ? (last = c) : null) });
      return { nodes, endCursor: last, hasNextPage: false };
    };
    return {
      productsPage: fetchers.productsPage || whole(fetchers.products),
      collectionsPage: fetchers.collectionsPage || whole(fetchers.collections, { productsFirst: 250 }),
      membersPage: fetchers.membersPage || null,
      countProducts: fetchers.countProducts || null,
      index,
      log,
    };
  }
  const source = catalogSource();
  if (!source) throw new Error(NO_CREDS);
  if (run.source && run.source !== source) throw new Error(`Shopify source changed (${run.source} → ${source}) during the run`);
  if (source === "admin") {
    return {
      productsPage: (cursor) => fetchProductsPageAdmin({ cursor }),
      collectionsPage: (cursor) => fetchCollectionsPageAdmin({ cursor, drainMembers: false }),
      membersPage: (id, cursor) => fetchCollectionMembersPageAdmin({ id, cursor }),
      countProducts: () => countProductsAdmin(),
      index,
      log,
    };
  }
  // Storefront: collections carry their first 250 members only (no tails),
  // as before.
  const creds = storefrontCreds();
  return {
    productsPage: (cursor) => fetchProductsPageStorefront({ cursor, pageSize: 50, creds }),
    collectionsPage: (cursor) => fetchCollectionsPageStorefront({ cursor, pageSize: 50, productsFirst: 250, creds }),
    membersPage: null,
    countProducts: null,
    index,
    log,
  };
}

// Drive a run forward from its stored position until it completes, fails, or
// the time runs out. `deadline` (epoch ms on `now`'s clock) bounds a queued
// slice inside a 60s route; with none (the CLI) it runs to the end.
// `mode`: "queued" — a failure the queue can retry is noted on the run and
// rethrown into the job's backoff; "inline" — any failure fails the run (no
// queue behind it), and the caller reports it.
//   → { done, status?, run, busy?, yielded?, lost?, error?, search? }
export async function runSyncSlice(runId, { deadline = null, now = Date.now, mode = "queued", log = noop, fetchers = null, indexer = null } = {}) {
  let run = await getSyncRun(runId);
  if (!run) return { done: true, missing: true, run: null };
  if (run.status !== "running") return { done: true, status: run.status, run };
  if (deadline != null && deadline - now() < SYNC_TIMING.MIN_PAGE_MS) return { done: false, yielded: true, run };
  const owner = newOwner();
  if (!(await acquireLease(run.id, owner))) return { done: false, busy: true, run: await getSyncRun(run.id) };
  run = await getSyncRun(run.id);
  let lastMs = 0;
  let committed = 0;
  try {
    const ctx = fetchContext(run, { fetchers, indexer, log });
    for (;;) {
      if (deadline != null && now() + Math.max(lastMs, SYNC_TIMING.MIN_PAGE_MS) > deadline) {
        await releaseLease(run.id, owner);
        return { done: false, yielded: true, committed, run };
      }
      const step = STEPS[run.phase];
      if (!step) throw new Error(`sync run ${run.id} is at an unknown phase "${run.phase}"`);
      const t0 = now();
      const res = await step(run, ctx, owner);
      if (res.lost) return { done: false, lost: true, committed, run: res.run };
      committed++;
      lastMs = now() - t0;
      const search = res.search;
      run = res;
      delete run.search;
      if (run.status === "complete") return { done: true, status: "complete", committed, run, search };
    }
  } catch (e) {
    const msg = errText(e);
    if (mode === "inline" || isPermanentSyncError(e)) {
      await failSyncRun(run.id, msg, { owner }).catch(() => {});
      return { done: true, status: "failed", error: msg, committed, run: await getSyncRun(run.id).catch(() => run) };
    }
    await noteRetry(run.id, msg, owner);
    // pages this slice did commit: the queue should not count this as a
    // wasted attempt (a flaky store still finishes)
    e.syncCommitted = committed;
    throw e;
  }
}

// ---- reading it back --------------------------------------------------------------

// The one question first-run generation (GEN-01) asks before it builds a
// store: is there a confirmed, complete copy of the catalog? Yes only when the
// MOST RECENT sync finished every page, prune and index. A failed, unfinished,
// stalled or never-run sync says no, and says why.
//   → { confirmed, runId?, finishedAt?, products?, collections?, reason? }
export async function confirmedCatalogSync({ nowMs = Date.now() } = {}) {
  let latest;
  try {
    latest = await latestSyncRun();
  } catch {
    return { confirmed: false, reason: "none" };
  }
  const state = runState(latest, nowMs);
  if (state !== "complete" || !latest.finished_at) return { confirmed: false, reason: state };
  return {
    confirmed: true,
    runId: latest.id,
    finishedAt: latest.finished_at,
    products: Number(latest.products || 0),
    collections: Number(latest.collections || 0),
  };
}

export const hasConfirmedSync = async (opts) => (await confirmedCatalogSync(opts)).confirmed;

// Progress for the console, read from sync_runs. A store synced before runs
// were recorded (no rows, products present) reads as complete.
export async function catalogSyncStatus({ nowMs = Date.now(), retryAt = null } = {}) {
  let latest = null;
  let hasComplete = false;
  try {
    latest = await latestSyncRun();
    if (latest) {
      const r = await libsql.execute("SELECT 1 AS x FROM sync_runs WHERE status = 'complete' LIMIT 1");
      hasComplete = r.rows.length > 0;
    }
  } catch {
    latest = null;
  }
  if (!latest) {
    const [p, c] = await Promise.all([
      libsql.execute("SELECT COUNT(*) AS n FROM products").catch(() => null),
      libsql.execute("SELECT COUNT(*) AS n FROM collections").catch(() => null),
    ]);
    const products = Number(p?.rows?.[0]?.n || 0);
    if (products > 0) {
      const legacy = { status: "complete", products, collections: Number(c?.rows?.[0]?.n || 0), finished_at: null };
      return { run: null, view: syncView(legacy, { hasComplete: true, nowMs }) };
    }
  }
  return { run: latest, view: syncView(latest, { hasComplete, nowMs, retryAt }) };
}

// ---- inline full sync (CLI, legacy, tests) ---------------------------------------------

// Run a full sync to the end in this process: `pnpm sync`, `pnpm tenant:sync`,
// and the suites. Same page steps as the queue; joins a sync already under
// way instead of racing it. Throws if the run fails.
export async function runCatalogSync({ searchOnly = false, log = noop, schemaSql = null, fetchers = null, indexer = null, startedBy = "cli" } = {}) {
  if (schemaSql) await libsql.executeMultiple(schemaSql);
  if (searchOnly) {
    const search = await (indexer || indexTypesense)({ log });
    return { products: 0, collections: 0, search };
  }
  const source = fetchers ? "injected" : catalogSource();
  if (!source) throw new Error(NO_CREDS);
  log(`→ catalog source: ${source}`);
  // requestCatalogSync joins a run already under way (a queued sync)
  const { run, action } = await requestCatalogSync({ startedBy, fetchers });
  if (action === "joined") log(`→ continuing the sync already under way (${run.id}, ${run.products_fetched} products so far)`);
  log("→ pulling products and collections, page by page…");
  for (;;) {
    const res = await runSyncSlice(run.id, { mode: "inline", log, fetchers, indexer });
    if (res.status === "complete") {
      const r = res.run;
      log(`  ✓ ${r.products} products, ${r.collections} collections written`);
      return {
        products: Number(r.products),
        collections: Number(r.collections),
        pruned: { products: Number(r.pruned_products), collections: Number(r.pruned_collections) },
        runId: r.id,
        search: res.search || { indexed: 0, skipped: "finished by another runner" },
      };
    }
    if (res.status === "failed") throw new Error(res.error || res.run?.error || "sync failed");
    if (res.missing) throw new Error(`sync run ${run.id} disappeared`);
    if (res.busy) {
      // another runner holds it (a queued slice): wait for its lease
      const until = Date.parse(res.run?.lease_until || "") || Date.now();
      await new Promise((r) => setTimeout(r, Math.min(Math.max(until - Date.now(), 250), 5_000)));
    }
  }
}

// Convenience for operator flows: run a full sync AS a tenant.
export const syncTenantCatalog = (tenant, opts = {}) => withTenant(tenant, () => runCatalogSync(opts));
