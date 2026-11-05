// P6-DRILLS: the writes of one phase 6 drill stage (seed-design-documents.js
// --p6 --stage <a..g> [--variant …]). Called by that script inside
// withHarnessStore (the harness stopped, its three local sqld started there),
// so every database here is this checkout's own local harness server. Never a
// hosted database, never Shopify, never Typesense, never a payment provider.
//
// What one stage seed does, in order (P6-PLAN.md, P6-BATCHES.json P6-DRILLS):
//   1. refuses when the environment names a Shopify store or a payment secret
//   2. parks the P3 closed store (design-closed): its domain row is taken off,
//      because its database is the harness's third server, which this stage
//      wipes. The last step of pnpm drill:p6 re-seeds --p3, which brings it back.
//   3. wipes the third server (every table, view and trigger dropped), so
//      DOCUMENTS_FOR_FRESH_STORE_SQL sees empty content tables
//   4. provisions tenant 'p6' there the way lib/platform/provision.js does it:
//      applyTenantSchema, applyContentMode (documents, or legacy for stage f),
//      the tenant row with a control-plane domain row for p6.localhost, and
//      config.onboarding as record_onboarding writes it. No Shopify fields.
//   5. the founder's login (an owner membership on p6), its password fresh and
//      written only to .design-data/p6-seed.json by the caller
//   6. the perf fixture's library photos copied from the design store (the
//      catalog's photos are /api/media/<id> addresses), then the catalog
//      through lib/sync.js runCatalogSync with injected fetchers and a no-op
//      indexer: a real, complete sync_runs row, no network
//   7. what the stage needs on top (below)
//
// Stages:
//   a, b, g   a fresh closed documents store, 24 products in 6 collections
//   c         the same, returns_window_days 10, no support email (contact
//             warns), and a PNG logo already in the media library
//   d         the same, checkout_mode disabled, a support email, and a privacy
//             page and a terms page the founder has saved (startPolicyPage, then
//             markPolicyRead as the founder: the founder's own save), so
//             payment is the only block
//   e         --variant empty (default): a complete sync of an empty catalog
//             --variant refill: NOT wiped; a second complete sync, with products
//             --variant no-collections: products, no collections
//   f         a fresh LEGACY store (applyContentMode legacy), the same catalog
// The P3 closed store stays parked through every stage.

export const P6_STORE = Object.freeze({ id: "p6", host: "p6.localhost", name: "Fernway Goods" });
export const P6_LOGIN = Object.freeze({ email: "founder@p6.test", name: "Priya Founder", role: "owner" });
export const P6_STAGES = Object.freeze(["a", "b", "c", "d", "e", "f", "g"]);
export const P6_VARIANTS = Object.freeze({ e: ["empty", "refill", "no-collections"] });
export const P6_PRODUCTS = 24;
export const P6_RETURNS_DAYS = 10;
export const P6_SUPPORT_EMAIL = "help@p6.test";
// the media route serves med_ plus 18 hex digits only (sha256 of "p6-drills:logo")
export const P6_LOGO_MEDIA = Object.freeze({ id: "med_bad998b5f514fa6058", filename: "fernway-logo.png", width: 480, height: 160 });
const CLOSED_ID = "design-closed";

// The environment names that would reach Shopify or a payment provider.
export const REAL_KEYS = Object.freeze([
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_STOREFRONT_TOKEN",
  "SHOPIFY_ADMIN_TOKEN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "NEXT_PUBLIC_SHOPIFY_DOMAIN",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "PLATFORM_RAZORPAY_KEY_ID",
  "PLATFORM_RAZORPAY_KEY_SECRET",
]);
export const realKeysSet = (env = process.env) => REAL_KEYS.filter((k) => String(env[k] ?? "").trim() !== "");

// The stage's settings (pure): what the tenant config and the catalog are.
export function stagePlan(stage, variant = null) {
  if (!P6_STAGES.includes(stage)) throw new Error(`--p6 needs --stage with one of ${P6_STAGES.join(", ")}, not "${stage}"`);
  const allowed = P6_VARIANTS[stage] || [];
  if (variant != null && !allowed.includes(variant)) throw new Error(allowed.length ? `stage ${stage} takes --variant ${allowed.join(" | ")}, not "${variant}"` : `stage ${stage} takes no --variant`);
  const v = variant ?? allowed[0] ?? null;
  return {
    stage,
    variant: v,
    wipe: !(stage === "e" && v === "refill"),
    mode: stage === "f" ? "legacy" : "documents",
    catalog: stage === "e" ? (v === "empty" ? "empty" : v === "refill" ? "products" : "no-collections") : "products",
    returnsWindowDays: stage === "c" ? P6_RETURNS_DAYS : null,
    supportEmail: stage === "c" ? null : P6_SUPPORT_EMAIL,
    checkoutMode: stage === "d" ? "disabled" : "direct",
    logoInLibrary: stage === "c",
    founderPolicies: stage === "d",
  };
}

// ---------------------------------------------------------------------------
// the catalog: the perf fixture as Shopify's Storefront API hands it over
// ---------------------------------------------------------------------------

const money = (amount) => ({ amount: String(amount), currencyCode: "INR" });

export async function perfCatalog({ products: n = P6_PRODUCTS, collections = true } = {}) {
  const { buildPerfFixture } = await import("../../perf-fixture.js");
  const fx = buildPerfFixture();
  const picked = fx.products.slice(0, n);
  const ids = new Set(picked.map((p) => p.id));
  const products = picked.map((p) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    descriptionHtml: p.description_html,
    productType: p.product_type,
    vendor: p.vendor,
    tags: p.tags,
    priceRange: { minVariantPrice: money(p.price_min), maxVariantPrice: money(p.price_max) },
    compareAtPriceRange: p.compare_at_min ? { minVariantPrice: money(p.compare_at_min) } : null,
    availableForSale: Boolean(p.available),
    totalInventory: p.total_inventory,
    featuredImage: { url: p.featured_image, altText: p.featured_image_alt },
    images: { nodes: p.images.map((i) => ({ url: i.url, altText: i.alt, width: i.width, height: i.height })) },
    options: p.options,
    variants: {
      nodes: p.variants.map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        price: money(v.price),
        compareAtPrice: v.compare_at_price ? money(v.compare_at_price) : null,
        availableForSale: Boolean(v.available),
        selectedOptions: v.selected_options,
        image: null,
      })),
    },
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));
  const cols = !collections
    ? []
    : fx.collections
        .map((c) => ({ ...c, productIds: c.productIds.filter((id) => ids.has(id)) }))
        .filter((c) => c.productIds.length >= 2)
        .slice(0, 6)
        .map((c) => ({
          id: c.id,
          handle: c.handle,
          title: c.title,
          description: c.description,
          image: { url: c.image, altText: c.image_alt },
          updatedAt: new Date().toISOString(),
          products: { nodes: c.productIds.map((id) => ({ id })) },
        }));
  return { products, collections: cols, mediaIds: [...new Set(fx.media.map((m) => m.id))] };
}

// ---------------------------------------------------------------------------
// database work
// ---------------------------------------------------------------------------

async function wipe(client) {
  const skip = "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'";
  for (const type of ["trigger", "view", "table"]) {
    const r = await client.execute(`SELECT name FROM sqlite_master WHERE type = '${type}' AND ${skip}`);
    for (const row of r.rows) await client.execute(`DROP ${type.toUpperCase()} IF EXISTS "${row.name}"`);
  }
  const left = await client.execute(`SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table','view','trigger') AND ${skip}`);
  return Number(left.rows[0]?.n || 0);
}

async function copyMedia(from, to, ids) {
  const list = [...ids];
  if (!list.length) return 0;
  const r = await from.execute({ sql: `SELECT * FROM media WHERE id IN (${list.map(() => "?").join(",")})`, args: list });
  for (const row of r.rows) {
    const cols = r.columns;
    await to.execute({ sql: `INSERT OR REPLACE INTO media (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => row[c]) });
  }
  return r.rows.length;
}

// A small PNG logo: a leaf mark and the store's initials, made locally.
export async function logoPng({ width = P6_LOGO_MEDIA.width, height = P6_LOGO_MEDIA.height, colour = "#166534" } = {}) {
  const sharp = (await import("sharp")).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/><circle cx="${height / 2}" cy="${height / 2}" r="${height / 2.6}" fill="${colour}"/><text x="${height * 1.15}" y="${height * 0.64}" font-family="Helvetica" font-weight="700" font-size="${Math.round(height * 0.42)}" fill="${colour}">Fernway</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function addLogoMedia(client) {
  const { createHash } = await import("node:crypto");
  const bytes = await logoPng();
  await client.execute({
    sql: "INSERT OR REPLACE INTO media (id, filename, mime, size, width, height, alt, variant, parent_id, sha256, data, created_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)",
    args: [P6_LOGO_MEDIA.id, P6_LOGO_MEDIA.filename, "image/png", bytes.length, P6_LOGO_MEDIA.width, P6_LOGO_MEDIA.height, "", createHash("sha256").update(bytes).digest("hex"), bytes, new Date().toISOString()],
  });
  return P6_LOGO_MEDIA.id;
}

const NO_INDEX = async () => ({ indexed: 0 });

// Everything a stage seed writes. `urls` are the harness's local sqld
// (withHarnessStore). Returns what the drill needs (no password in it except
// logins.owner.password, which the caller writes to the 600 seed file only).
export async function seedP6Stage({ urls, stage, variant = null, H }) {
  const plan = stagePlan(stage, variant);
  const real = realKeysSet();
  if (real.length) throw new Error(`Refusing to seed: the environment names a Shopify store or a payment secret (${real.join(", ")}). The phase 6 drill only runs with them blank.`);
  for (const [k, u] of Object.entries(urls)) H.assertLocalDbUrl(`the harness ${k} database`, u);
  const { createClient } = await import("@libsql/client");
  const C = await import("../../../lib/platform/control.js");
  const I = await import("../../../lib/platform/identity.js");
  const P = await import("../../../lib/platform/provision.js");
  const { withTenant } = await import("../../../lib/tenant-context.js");

  // 2. park the P3 closed store (its database is the one this stage wipes)
  const closed = await C.getTenant(CLOSED_ID, { fresh: true }).catch(() => null);
  let parked = null;
  if (closed) {
    parked = { id: CLOSED_ID, domains: closed.domains };
    if ((closed.domains || []).length) await C.patchTenant(CLOSED_ID, { domains: [] });
  }

  const client = createClient({ url: urls.default });
  const out = { plan, parked, store: { ...P6_STORE }, wiped: false, contentMode: null };
  try {
    if (plan.wipe) {
      const left = await wipe(client);
      if (left) throw new Error(`the harness's third database still holds ${left} tables after the wipe`);
      out.wiped = true;
      await P.applyTenantSchema(client);
      const mode = await P.applyContentMode(client, { contentMode: plan.mode });
      if (mode.contentMode !== plan.mode) throw new Error(`the p6 store did not start on ${plan.mode}: ${mode.contentModeReason}`);
      out.contentMode = mode;
    } else {
      const m = (await client.execute("SELECT mode FROM cms_state WHERE id = 1")).rows[0]?.mode;
      if (m !== "documents") throw new Error(`--variant refill needs the stage e store from before (a documents store), and the p6 store is in ${m ?? "no"} mode`);
      out.contentMode = { contentMode: m, contentModeReason: "kept" };
    }

    // 4. the tenant row, as register_tenant and record_onboarding write it (no Shopify fields)
    const existing = await C.getTenant(P6_STORE.id, { fresh: true }).catch(() => null);
    if (plan.wipe || !existing) {
      const { randomBytes } = await import("node:crypto");
      const site = { name: P6_STORE.name, ...(plan.supportEmail ? { support_email: plan.supportEmail } : {}) };
      await C.upsertTenant({
        id: P6_STORE.id,
        name: P6_STORE.name,
        domains: [P6_STORE.host],
        dbUrl: urls.default,
        config: {
          currency: "INR",
          merchant_timezone: "Asia/Kolkata",
          site_url: `http://${P6_STORE.host}`,
          site,
          checkout_mode: plan.checkoutMode,
          ...(plan.returnsWindowDays != null ? { returns_window_days: plan.returnsWindowDays } : {}),
          onboarding: { provisioned_at: new Date().toISOString(), run_id: `p6-drill-${stage}`, manual: {} },
        },
        secrets: { admin_password: randomBytes(9).toString("base64url"), order_link_secret: randomBytes(32).toString("hex") },
      });
    }
    const tenant = await C.getTenant(P6_STORE.id, { fresh: true });
    H.assertLocalDbUrl("the p6 store's database", tenant.dbUrl || tenant.db_url);
    const rowText = JSON.stringify({ config: tenant.config, secrets: Object.keys(tenant.secrets || {}) });
    if (/shopify_(store_domain|client|admin_token|storefront)|razorpay_key/i.test(rowText)) throw new Error("Refusing: the p6 store's row names a Shopify store or a payment key");

    // 5. the founder (an owner membership), a fresh password every seed
    const { randomBytes } = await import("node:crypto");
    const password = `p6-${randomBytes(9).toString("hex")}`;
    let user = await I.findUserByEmail(P6_LOGIN.email);
    if (user) await I.setUserPassword(user.id, password);
    else user = await I.createUser({ email: P6_LOGIN.email, name: P6_LOGIN.name, password });
    await I.addMembership(user.id, P6_STORE.id, P6_LOGIN.role);
    await I.clearThrottle(`login:${P6_LOGIN.email}`).catch(() => {});
    out.logins = { owner: { id: user.id, email: P6_LOGIN.email, name: P6_LOGIN.name, role: P6_LOGIN.role, password } };

    // 6. photos, then the catalog through the real sync (injected fetchers)
    const cat = await perfCatalog({ products: plan.catalog === "empty" ? 0 : P6_PRODUCTS, collections: plan.catalog !== "no-collections" });
    const design = createClient({ url: urls.tenant });
    try {
      out.media = await copyMedia(design, client, cat.mediaIds);
    } finally {
      design.close();
    }
    if (plan.logoInLibrary) out.logoMedia = await addLogoMedia(client);
    const S = await import("../../../lib/sync.js");
    out.sync = await withTenant(tenant, () => S.runCatalogSync({ fetchers: { products: async () => cat.products, collections: async () => cat.collections }, indexer: NO_INDEX, startedBy: "p6-drill" }));
    out.confirmed = await withTenant(tenant, () => S.confirmedCatalogSync());
    if (!out.confirmed.confirmed) throw new Error(`the p6 catalog sync is not confirmed (${out.confirmed.reason})`);

    // 7. stage d: a privacy page and a terms page the founder has saved
    if (plan.founderPolicies) {
      const PS = await import("../../../lib/first-run/policy-start.js");
      const actor = { kind: "merchant", id: user.id, role: "owner", email: P6_LOGIN.email };
      out.policies = {};
      for (const kind of ["privacy", "returns"]) {
        const s = await withTenant(tenant, () => PS.startPolicyPage({ kind, actor }));
        if (s.status !== 200) throw new Error(`starting the ${kind} page answered ${s.status}: ${JSON.stringify(s.body).slice(0, 200)}`);
        const doc = s.body.document;
        const m = await withTenant(tenant, () => PS.markPolicyRead({ id: doc.id, revision: doc.revision, actor }));
        if (m.status !== 200) throw new Error(`saving the ${kind} page as the founder answered ${m.status}: ${JSON.stringify(m.body).slice(0, 200)}`);
        out.policies[kind] = { id: doc.id, slug: doc.slug ?? null };
      }
    }

    // what the store holds now (read back)
    const one = async (sql) => (await client.execute(sql)).rows[0] || {};
    out.state = {
      mode: (await one("SELECT mode FROM cms_state WHERE id = 1")).mode ?? null,
      liveRelease: (await one("SELECT live_release_id AS id FROM release_state WHERE id = 1")).id ?? null,
      documents: Number((await one("SELECT count(*) AS n FROM documents")).n || 0),
      products: Number((await one("SELECT count(*) AS n FROM products")).n || 0),
      collections: Number((await one("SELECT count(*) AS n FROM collections")).n || 0),
      media: Number((await one("SELECT count(*) AS n FROM media")).n || 0),
      latestSync: { ...(await one("SELECT id, status, source, products, collections, finished_at FROM sync_runs ORDER BY started_at DESC LIMIT 1")) },
    };
    return out;
  } finally {
    client.close();
  }
}

// check --p6, read only: what the p6 store and the parked closed store hold.
export async function p6State({ urls, H }) {
  for (const [k, u] of Object.entries(urls)) H.assertLocalDbUrl(`the harness ${k} database`, u);
  const C = await import("../../../lib/platform/control.js");
  const { createClient } = await import("@libsql/client");
  const tenant = await C.getTenant(P6_STORE.id, { fresh: true }).catch(() => null);
  const closed = await C.getTenant(CLOSED_ID, { fresh: true }).catch(() => null);
  const out = { tenant: tenant ? { id: tenant.id, domains: tenant.domains, dbUrl: tenant.dbUrl, checkoutMode: tenant.config?.checkout_mode ?? null, returnsWindowDays: tenant.config?.returns_window_days ?? null, brandStep: tenant.config?.onboarding?.brand_step ?? null } : null, closedStore: closed ? { domains: closed.domains } : null };
  if (!tenant) return out;
  const client = createClient({ url: urls.default });
  try {
    const one = async (sql) => (await client.execute(sql)).rows[0] || {};
    out.store = {
      mode: (await one("SELECT mode FROM cms_state WHERE id = 1")).mode ?? null,
      liveRelease: (await one("SELECT live_release_id AS id FROM release_state WHERE id = 1")).id ?? null,
      documents: (await client.execute("SELECT id, type, slug, updated_by, revision, published_version_id IS NOT NULL AS live FROM documents ORDER BY id")).rows.map((r) => ({ ...r })),
      products: Number((await one("SELECT count(*) AS n FROM products")).n || 0),
      collections: Number((await one("SELECT count(*) AS n FROM collections")).n || 0),
      orders: Number((await one("SELECT count(*) AS n FROM orders")).n || 0),
      latestSync: { ...(await one("SELECT id, status, products, collections FROM sync_runs ORDER BY started_at DESC LIMIT 1")) },
    };
  } catch (e) {
    out.store = { error: String(e?.message || e).slice(0, 200) };
  } finally {
    client.close();
  }
  return out;
}
