// P5-BUNDLEREAD (COM-01, COM-02): the bounded, honest bundle read that
// blocks, publish checks and the editor's picker use. Edge-safe: it imports
// lib/db.js, lib/schema-compat.js, lib/catalog/effective.js and ./bundle-compat.js only (never
// lib/offers/*, never a node: module). The offers table is read with plain SQL.
//
//   bundlesByIds(ids) -> Map id -> {
//     id, slug, title, description, enabled, bundle_price, currency,
//     componentsSum, saving, state, reasons, overlapsWith: [{ id, title }],
//     components: [{ variantId, quantity, title, image, available,
//                    state: 'ok' | 'sold_out' | 'missing' }]
//   }
//
// state: available | sold_out | no_saving | not_ready | scheduled | disabled | missing.
//   scheduled  (Phase 8 line 5) the bundle is on, but now is outside the
//              bundle row's own window (decided before the offer row is
//              compared, so a drifted offer never shows a hidden bundle) (starts_at inclusive,
//              ends_at exclusive, UTC ISO; checked on every read). Shoppers
//              don't see it. reasons [{ kind: 'scheduled', phase:
//              'upcoming' | 'ended', starts_at, ends_at }].
//   A bundle row window (0038, read through hasColumns) that differs from its
//   offer row's window is not_ready, { kind: 'not_synced', detail: 'offer_differs' }.
//   missing    no bundle row with that id
//   disabled   the bundle is turned off
//   not_ready  compat says so (too few, duplicate, bad price, mixed
//              currency), or the bundle is on but its `bundle-<id>` offer row
//              is missing, turned off, outside its schedule, or holds a price
//              or item set that differs from the bundle row (reason
//              { kind: 'not_synced', detail }). The cart prices from that
//              offer row, so a card must not promise a saving it won't give.
//   sold_out, no_saving, available: from compat.
// saving is compat's liveSaving: the engine's BUNDLE discount for one set.
// currency is the components' own (variant, then product); mixed currencies
// are not_ready; none is null. Callers format with
// formatMoney(amount, currency ?? undefined).
// overlapsWith: the other turned-on bundles that share a variant with this
// one. Every BUNDLE offer has priority 5 and no fixed order, so overlapping
// bundles can change which saving the cart gives.
//
// Cost: at most 3 statements for any number of ids (not counting the
// schema-compat probes this file and effective.js make once per database):
//   1. bundles LEFT JOIN offers, the requested ids and every turned-on bundle
//   2. the components' variants
//   3. their products, through effective.byIds (effective titles and images)
// A database fault throws; it is never folded into `missing` or an empty Map.
// Payloads carry effective titles only, never Shopify's raw title or a SKU.
import { libsql } from "../db.js";
import { hasColumns } from "../schema-compat.js";
import { byIds } from "../catalog/effective.js";
import { compatFrom, stateOf } from "./bundle-compat.js";

const offerIdOf = (bundleId) => `bundle-${bundleId}`;

const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

const itemsOf = (row) => {
  const v = parse(row.items, []);
  return Array.isArray(v) ? v : [];
};

// The multiset of (variant, quantity) entries, order-free.
const itemKey = (items) =>
  (Array.isArray(items) ? items : [])
    .map((c) => `${c?.variantId ?? ""}\u0000${Math.max(1, Number(c?.quantity) || 1)}`)
    .sort()
    .join("\u0001");

// Does the bundle's linked offer row sell what the bundle row says, right
// now? The offer's config is the engine-shaped object lib/bundles.js
// syncOffer writes ({ id, type: 'BUNDLE', scope: 'line', priority, title,
// items, price }), read back as lib/offers/store.js rowToOffer does
// ({ ...JSON.parse(config), id, type }).
const sameInstant = (a, b) => (a ?? null) === (b ?? null);
function offerProblem(row, now, windowed) {
  if (row.offer_id == null) return "offer_missing";
  if (!Number(row.offer_enabled)) return "offer_disabled";
  // the bundle's window must be its offer row's window, to the millisecond
  if (windowed) return sameInstant(row.starts_at, row.offer_starts_at) && sameInstant(row.ends_at, row.offer_ends_at) ? configProblem(row) : "offer_differs";
  if ((row.offer_starts_at && row.offer_starts_at > now) || (row.offer_ends_at && row.offer_ends_at <= now)) return "offer_scheduled";
  return configProblem(row);
}

function configProblem(row) {
  let cfg = null;
  try {
    cfg = JSON.parse(row.offer_config);
  } catch {
    cfg = null;
  }
  if (!cfg || typeof cfg !== "object") return "offer_differs";
  const type = row.offer_type ?? cfg.type;
  if (type !== "BUNDLE" || cfg.scope !== "line") return "offer_differs";
  if (Number(cfg.price) !== Number(row.bundle_price)) return "offer_differs";
  if (itemKey(cfg.items) !== itemKey(itemsOf(row))) return "offer_differs";
  return null;
}

const placeholders = (n) => Array.from({ length: n }, () => "?").join(", ");

const missingBundle = (id) => ({
  id,
  slug: null,
  title: null,
  description: "",
  enabled: false,
  starts_at: null,
  ends_at: null,
  bundle_price: null,
  currency: null,
  componentsSum: 0,
  saving: 0,
  state: "missing",
  reasons: [],
  overlapsWith: [],
  components: [],
});

export async function bundlesByIds(ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  const out = new Map();
  if (!wanted.length) return out;

  // 1. the requested rows, and every turned-on bundle (for overlaps), each
  //    with its linked offer row (and the bundle's window, once 0038 is in)
  const windowed = await hasColumns("bundles", ["starts_at", "ends_at"]);
  const res = await libsql.execute({
    sql:
      "SELECT b.id, b.slug, b.title, b.description, b.items, b.bundle_price, b.enabled, " +
      (windowed ? "b.starts_at, b.ends_at, " : "") +
      "o.id AS offer_id, o.type AS offer_type, o.enabled AS offer_enabled, o.starts_at AS offer_starts_at, o.ends_at AS offer_ends_at, o.config AS offer_config " +
      "FROM bundles b LEFT JOIN offers o ON o.id = 'bundle-' || b.id " +
      `WHERE b.id IN (${placeholders(wanted.length)}) OR b.enabled = 1`,
    args: wanted,
  });
  const rows = res.rows.map((r) => ({ ...r }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const requested = wanted.map((id) => byId.get(id)).filter(Boolean);

  // 2. the variants of the requested bundles
  const variantIds = [...new Set(requested.flatMap((r) => itemsOf(r).map((c) => c?.variantId)).filter((v) => typeof v === "string" && v))];
  const variantsById = new Map();
  if (variantIds.length) {
    const v = await libsql.execute({
      sql: `SELECT id, product_id, title, price, currency, available FROM variants WHERE id IN (${placeholders(variantIds.length)})`,
      args: variantIds,
    });
    for (const r of v.rows) variantsById.set(r.id, { ...r });
  }

  // 3. their products, effective
  const productIds = [...new Set([...variantsById.values()].map((v) => v.product_id).filter(Boolean))];
  const productsById = new Map();
  if (productIds.length) for (const p of await byIds(productIds)) productsById.set(p.id, p);

  // overlap: variant -> turned-on bundles that use it
  const enabledRows = rows.filter((r) => Number(r.enabled) === 1);
  const usedBy = new Map();
  for (const r of enabledRows) {
    for (const vid of new Set(itemsOf(r).map((c) => c?.variantId).filter(Boolean))) {
      if (!usedBy.has(vid)) usedBy.set(vid, []);
      usedBy.get(vid).push(r);
    }
  }

  const now = new Date().toISOString();
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) {
      out.set(id, missingBundle(id));
      continue;
    }
    const items = itemsOf(row);
    const compat = compatFrom({ items, bundle_price: row.bundle_price, variantsById, productsById });
    const enabled = Number(row.enabled) === 1;
    const reasons = compat.reasons.slice();
    // Review fix: the bundle row's own window decides first, so a bundle
    // outside its dates stays hidden (scheduled) even when its offer row drifted
    let outside = null;
    if (enabled) {
      if (windowed && row.starts_at && row.starts_at > now) outside = "upcoming";
      else if (windowed && row.ends_at && row.ends_at <= now) outside = "ended";
      if (outside) reasons.unshift({ kind: "scheduled", phase: outside, starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null });
      else {
        const detail = offerProblem(row, now, windowed);
        if (detail) reasons.unshift({ kind: "not_synced", detail });
      }
    }
    const state = !enabled ? "disabled" : outside ? "scheduled" : reasons.some((r) => r.kind === "not_synced") ? "not_ready" : stateOf(reasons);

    const overlaps = new Map();
    for (const vid of new Set(items.map((c) => c?.variantId).filter(Boolean))) {
      for (const other of usedBy.get(vid) || []) if (other.id !== id) overlaps.set(other.id, { id: other.id, title: other.title });
    }

    const components = items.map((c) => {
      const quantity = Math.max(1, Number(c?.quantity) || 1);
      const variant = c?.variantId ? variantsById.get(c.variantId) : null;
      const product = variant ? productsById.get(variant.product_id) : null;
      if (!variant || !product) return { variantId: c?.variantId ?? null, quantity, title: product?.title ?? null, image: product?.featured_image ?? null, available: false, state: "missing" };
      const available = Boolean(Number(variant.available) && product.available);
      return { variantId: variant.id, quantity, title: product.title ?? null, image: product.featured_image ?? null, available, state: available ? "ok" : "sold_out" };
    });

    out.set(id, {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description || "",
      enabled,
      starts_at: windowed ? (row.starts_at ?? null) : null,
      ends_at: windowed ? (row.ends_at ?? null) : null,
      bundle_price: Number(row.bundle_price),
      currency: compat.currency,
      componentsSum: compat.componentsSum,
      saving: compat.liveSaving,
      state,
      reasons,
      overlapsWith: [...overlaps.values()],
      components,
    });
  }
  return out;
}
