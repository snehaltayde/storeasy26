// Bundles (Session 46 / BE31 + SF18). SERVER-ONLY, tenant-scoped.
//
// A bundle is a LOCAL curated set priced through the offers engine: each
// bundle keeps a linked offers row ({type:"BUNDLE", scope:"line"}) in sync,
// so the cart, checkout, order snapshot and Shopify push treat it as just
// another offer — zero new money paths. The BE31 capability gate:
// ENABLING a bundle runs the compatibility check (components exist, are
// available, quantities sane, bundle price actually saves money) and
// refuses on failure; a disabled bundle keeps its draft row but its offer
// is disabled too, so shoppers can never hit a broken set.
//
// Selling plans (shopper subscriptions) are NOT built — they need recurring
// shopper payments; recorded in IMPLEMENTATION_STATUS, not pretended here.
import { db } from "./db.js";
import { upsertOffer, setOfferEnabled, deleteOffer } from "./offers/store.js";
import { slog } from "./log.js";
import { byIds } from "./catalog/effective.js";

// dashes, not underscores: the id feeds the linked offer id, which must be
// a valid offer slug ([a-z0-9-])
const rid = () => "bun-" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export const bundleOfferId = (bundleId) => `bundle-${bundleId}`;

// ---- compatibility (the BE31 gate) -------------------------------------------

export async function checkBundleCompatibility({ items, bundle_price }) {
  const problems = [];
  const comps = Array.isArray(items) ? items : [];
  if (comps.length < 2) problems.push("a bundle needs at least 2 components");
  let sum = 0;
  const detailed = [];
  for (const [i, c] of comps.entries()) {
    const qty = Math.max(1, Number(c.quantity) || 1);
    const variant = c.variantId ? await db.selectFrom("variants").selectAll().where("id", "=", c.variantId).executeTakeFirst() : null;
    if (!variant) {
      problems.push(`component ${i + 1}: variant not in the catalog`);
      detailed.push({ ...c, state: "missing" });
      continue;
    }
    // P4-EFFECTIVE (OVL-03): the component's effective title and image
    const [product] = await byIds([variant.product_id]);
    if (!variant.available || !product?.available) problems.push(`component ${i + 1} (${product?.title || c.variantId}): sold out`);
    sum += Number(variant.price || 0) * qty;
    detailed.push({ variantId: variant.id, quantity: qty, title: product?.title, variant_title: variant.title, handle: product?.handle, image: product?.featured_image, price: Number(variant.price || 0), available: Boolean(variant.available && product?.available) });
  }
  const price = Number(bundle_price);
  if (!Number.isFinite(price) || price <= 0) problems.push("bundle price must be a positive number");
  else if (sum > 0 && price >= sum) problems.push(`bundle price ₹${price} doesn't save anything (components sum to ₹${sum})`);
  return { ok: problems.length === 0, problems, components: detailed, componentsSum: sum, saving: sum > 0 && price > 0 ? Math.max(0, sum - price) : 0 };
}

// ---- CRUD + offer sync -------------------------------------------------------

async function syncOffer(bundle) {
  const offer = {
    id: bundleOfferId(bundle.id),
    type: "BUNDLE",
    scope: "line",
    priority: 5, // bundles claim their lines before generic line offers (10+)
    title: bundle.title,
    items: parse(bundle.items, []),
    price: Number(bundle.bundle_price),
  };
  await upsertOffer({ offer, enabled: Boolean(bundle.enabled) });
}

export async function upsertBundle({ id = null, slug, title, description = "", items, bundle_price, enable = false }) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) throw new Error("slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) throw new Error("title required");
  const compat = await checkBundleCompatibility({ items, bundle_price });
  if (enable && !compat.ok) {
    const err = new Error(`can't enable: ${compat.problems.join(" · ")}`);
    err.problems = compat.problems;
    throw err;
  }
  const existing = id
    ? await db.selectFrom("bundles").selectAll().where("id", "=", id).executeTakeFirst()
    : await db.selectFrom("bundles").selectAll().where("slug", "=", slug).executeTakeFirst();
  const row = {
    id: existing?.id || rid(),
    slug,
    title: title.trim().slice(0, 120),
    description: String(description || "").slice(0, 1000),
    items: JSON.stringify((items || []).map((c) => ({ variantId: c.variantId, quantity: Math.max(1, Number(c.quantity) || 1) }))),
    bundle_price: Number(bundle_price),
    enabled: enable ? 1 : 0,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };
  await db
    .insertInto("bundles")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet(row))
    .execute();
  await syncOffer(row);
  slog("bundle_saved", { bundle: row.id, enabled: !!row.enabled });
  return { ...row, compat };
}

export async function setBundleEnabled(id, enabled) {
  const row = await db.selectFrom("bundles").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new Error("bundle not found");
  if (enabled) {
    const compat = await checkBundleCompatibility({ items: parse(row.items, []), bundle_price: row.bundle_price });
    if (!compat.ok) {
      const err = new Error(`can't enable: ${compat.problems.join(" · ")}`);
      err.problems = compat.problems;
      throw err;
    }
  }
  await db.updateTable("bundles").set({ enabled: enabled ? 1 : 0, updated_at: nowIso() }).where("id", "=", id).execute();
  await setOfferEnabled(bundleOfferId(id), enabled);
  return { id, enabled };
}

export async function deleteBundle(id) {
  await db.deleteFrom("bundles").where("id", "=", id).execute();
  await deleteOffer(bundleOfferId(id)).catch(() => {});
}

export async function listBundles() {
  try {
    const rows = await db.selectFrom("bundles").selectAll().orderBy("created_at", "desc").execute();
    const out = [];
    for (const r of rows) {
      const compat = await checkBundleCompatibility({ items: parse(r.items, []), bundle_price: r.bundle_price });
      out.push({ ...r, enabled: !!r.enabled, items: parse(r.items, []), compat: { ok: compat.ok, problems: compat.problems, saving: compat.saving, componentsSum: compat.componentsSum } });
    }
    return out;
  } catch {
    return []; // pre-migration tenant
  }
}

// Storefront read (SF18): full detail, honest availability.
export async function getBundle(slug) {
  try {
    const r = await db.selectFrom("bundles").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (!r || !r.enabled) return null;
    const compat = await checkBundleCompatibility({ items: parse(r.items, []), bundle_price: r.bundle_price });
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description || "",
      bundle_price: Number(r.bundle_price),
      components: compat.components,
      componentsSum: compat.componentsSum,
      saving: compat.saving,
      // every component must be live for the add button — honest state
      available: compat.ok,
      problems: compat.problems,
    };
  } catch {
    return null;
  }
}

export async function listEnabledBundles() {
  try {
    const rows = await db.selectFrom("bundles").select(["slug"]).where("enabled", "=", 1).execute();
    const out = [];
    for (const r of rows) {
      const b = await getBundle(r.slug);
      if (b) out.push(b);
    }
    return out;
  } catch {
    return [];
  }
}
