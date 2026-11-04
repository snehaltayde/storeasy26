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
import { compatFrom, mergeItems } from "./commerce/bundle-compat.js";

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

// P5-BUNDLEREAD: the rules live in lib/commerce/bundle-compat.js (pure, shared
// with the bounded read). This reads the rows they need in two statements
// (the variants, then their products through effective.byIds) and returns
// the full compat: { ok, state, reasons, problems, components,
// componentsSum, saving, liveSaving, currency }.
export async function bundleCompat({ items, bundle_price }) {
  const comps = Array.isArray(items) ? items : [];
  const ids = [...new Set(comps.map((c) => c?.variantId).filter((v) => typeof v === "string" && v))];
  const variantsById = new Map();
  if (ids.length) for (const v of await db.selectFrom("variants").selectAll().where("id", "in", ids).execute()) variantsById.set(v.id, v);
  const productIds = [...new Set([...variantsById.values()].map((v) => v.product_id).filter(Boolean))];
  // P4-EFFECTIVE (OVL-03): the components' effective titles and images
  const productsById = new Map();
  if (productIds.length) for (const p of await byIds(productIds)) productsById.set(p.id, p);
  return compatFrom({ items: comps, bundle_price, variantsById, productsById });
}

// The legacy shape, byte for byte: { ok, problems, components, componentsSum,
// saving } (the getBundle snapshot in test-effective-read reads it).
export async function checkBundleCompatibility({ items, bundle_price }) {
  const c = await bundleCompat({ items, bundle_price });
  return { ok: c.ok, problems: c.problems, components: c.components, componentsSum: c.componentsSum, saving: c.saving };
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

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SLUG_MAX = 61;

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const slugTaken = () => fail("SLUG_TAKEN", "A bundle with this link already exists.");
const isSlugConflict = (e) => /UNIQUE constraint failed: bundles\.slug/i.test(`${e?.message || ""} ${e?.cause?.message || ""}`);

// The "can't enable" refusal: its words stay as they were (legacy callers
// and tests read the prefix); code and reasons are new.
const cantEnable = (compat) => fail("BUNDLE_INCOMPATIBLE", `can't enable: ${compat.problems.join(" · ")}`, { problems: compat.problems, reasons: compat.reasons, state: compat.state });

async function slugOwner(slug) {
  return db.selectFrom("bundles").select(["id"]).where("slug", "=", slug).executeTakeFirst();
}

// Write the row, then its offer. A UNIQUE(slug) race is SLUG_TAKEN, never a
// database error. `create` inserts only: it can never overwrite a row.
async function writeRow(row, { create }) {
  try {
    if (create) await db.insertInto("bundles").values(row).execute();
    else
      await db
        .insertInto("bundles")
        .values(row)
        .onConflict((oc) => oc.column("id").doUpdateSet(row))
        .execute();
  } catch (e) {
    if (isSlugConflict(e)) throw slugTaken();
    throw e;
  }
  try {
    await syncOffer(row);
  } catch (e) {
    // A turned-off draft the engine can't hold (one product, no price): the
    // row is saved, and any older offer for it is turned off, never left on.
    if (e?.code !== "OFFER_INVALID" || row.enabled) throw e;
    await setOfferEnabled(bundleOfferId(row.id), false);
  }
  slog("bundle_saved", { bundle: row.id, enabled: !!row.enabled });
}

// Create (id null) or edit (id given).
//   · items are merged on every write (mergeItems): a variant listed twice
//     becomes one entry with the summed quantity.
//   · create with a slug another bundle has: SLUG_TAKEN, nothing written.
//     An edit onto another bundle's slug: SLUG_TAKEN too.
//   · edit: slug, description and enable left undefined keep the stored
//     values. An edit of a turned-on bundle whose new items or price fail
//     the check is refused (BUNDLE_INCOMPATIBLE), with no row or offer
//     change; it is never turned off quietly. enable: false turns it off;
//     enable: true runs the check as it always has.
export async function upsertBundle({ id = null, slug, title, description, items, bundle_price, enable } = {}) {
  const existing = id ? await db.selectFrom("bundles").selectAll().where("id", "=", id).executeTakeFirst() : null;
  const nextSlug = slug === undefined && existing ? existing.slug : slug;
  if (!SLUG_RE.test(nextSlug || "")) throw new Error("slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) throw new Error("title required");
  const owner = await slugOwner(nextSlug);
  if (owner && owner.id !== existing?.id) throw slugTaken();
  const merged = mergeItems(items);
  const compat = await bundleCompat({ items: merged, bundle_price });
  if (enable === true && !compat.ok) throw cantEnable(compat);
  const wasOn = Boolean(existing && Number(existing.enabled) === 1);
  if (enable === undefined && wasOn && !compat.ok) {
    throw fail("BUNDLE_INCOMPATIBLE", "This bundle is on, and with this change shoppers couldn't buy it, so nothing was saved. Fix what is listed, or turn the bundle off first.", {
      problems: compat.problems,
      reasons: compat.reasons,
      state: compat.state,
    });
  }
  const row = {
    id: existing?.id || rid(),
    slug: nextSlug,
    title: title.trim().slice(0, 120),
    description: String((description === undefined && existing ? existing.description : description) || "").slice(0, 1000),
    items: JSON.stringify(merged),
    bundle_price: Number(bundle_price),
    enabled: (enable === undefined ? wasOn : Boolean(enable)) ? 1 : 0,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };
  await writeRow(row, { create: !existing });
  return { ...row, compat };
}

// The slug a new bundle gets from its name: lower-case ASCII letters and
// digits, everything else a hyphen, no hyphen at either end; "bundle" when
// nothing is left (a name in another script). Cut so that with its "-N"
// suffix it still fits the slug rule (61 characters at most).
export function slugBase(title) {
  const s = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "bundle";
}

export function slugWithSuffix(base, n) {
  const suffix = n > 1 ? `-${n}` : "";
  const cut = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, "") || "bundle";
  return `${cut}${suffix}`;
}

// A new bundle from a name, products and a price; the slug is derived (see
// slugBase), with -2, -3 … until one is free, and tried again on a
// UNIQUE(slug) race.
//   mustPass: true  -> a bundle that fails the check is refused
//                      (BUNDLE_INCOMPATIBLE, reasons) and nothing is saved
//   otherwise       -> it is saved turned off, and the reasons come back
// enable: true turns it on when it passes.
export async function createBundle({ title, items, bundle_price, description = "", enable = false, mustPass = false } = {}) {
  if (!String(title || "").trim()) throw fail("BUNDLE_INVALID", "Give the bundle a name.");
  const merged = mergeItems(items);
  const compat = await bundleCompat({ items: merged, bundle_price });
  if (mustPass && !compat.ok) {
    throw fail("BUNDLE_INCOMPATIBLE", "This bundle can't be sold as it is, so it was not saved.", { problems: compat.problems, reasons: compat.reasons, state: compat.state });
  }
  const base = slugBase(title);
  const taken = new Set(
    (await db.selectFrom("bundles").select(["slug"]).where("slug", "like", `${base.slice(0, SLUG_MAX - 4)}%`).execute()).map((r) => r.slug),
  );
  const ts = nowIso();
  let n = 1;
  for (let attempt = 0; attempt < 25; attempt++) {
    while (taken.has(slugWithSuffix(base, n))) n++;
    const row = {
      id: rid(),
      slug: slugWithSuffix(base, n),
      title: String(title).trim().slice(0, 120),
      description: String(description || "").slice(0, 1000),
      items: JSON.stringify(merged),
      bundle_price: Number(bundle_price),
      enabled: enable && compat.ok ? 1 : 0,
      created_at: ts,
      updated_at: ts,
    };
    try {
      await writeRow(row, { create: true });
      return { ...row, compat };
    } catch (e) {
      if (e?.code !== "SLUG_TAKEN") throw e;
      taken.add(row.slug); // someone took it between the read and the write
    }
  }
  throw slugTaken();
}

export async function setBundleEnabled(id, enabled) {
  const row = await db.selectFrom("bundles").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw new Error("bundle not found");
  if (enabled) {
    const compat = await bundleCompat({ items: parse(row.items, []), bundle_price: row.bundle_price });
    if (!compat.ok) throw cantEnable(compat);
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
      const compat = await bundleCompat({ items: parse(r.items, []), bundle_price: r.bundle_price });
      out.push({ ...r, enabled: !!r.enabled, items: parse(r.items, []), compat: { ok: compat.ok, problems: compat.problems, saving: compat.saving, componentsSum: compat.componentsSum, state: compat.state, reasons: compat.reasons } });
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
