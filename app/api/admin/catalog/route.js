import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { db } from "@/lib/db";
import { getProductOverride, setProductOverride, listProductOverrides, getCollectionPins, setCollectionPins } from "@/lib/catalog-overrides";
import { getBlock } from "@/lib/cms/store";
import { effectiveSurfaceTemplate } from "@/lib/cms/defaults";
import { numericId } from "@/lib/ids";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { legacyWritesRefusal, getCmsMode } from "@/lib/cms-mode";
import { shopifyAdminBase } from "@/lib/admin/shopify-admin-url";
import { publishedGetters } from "@/lib/cms/view";

// Catalog browser API (S39 / MC05 + MC06). Shopify owns catalog VALUES —
// this surface is read-only on them (the console labels + links to Shopify
// admin) and writes only per-tenant PRESENTATION overrides.
//   GET ?q=            → product search + overrides (orphans flagged) + collections
//   GET ?product=gid   → one product's Shopify-owned fields + its override
//   POST {product:{handle, modules, badge}}         → set per-product override
//   POST {collection:{handle, pinnedHandles:[…]}}   → set pinned order
//
// P4-ED05 (ED-05, spec 8.13): the GET keeps answering on a documents store,
// where the old tables are frozen. There a product's template, modules and
// badge, and each collection's pins, are what is PUBLISHED (the live rows and
// the layout documents, through the storefront's getters over the live
// release: lib/cms/view.js publishedGetters), never the frozen
// surface_templates block, product_overrides or collection_overrides, and
// `overrides` is empty (nothing there is a draft). Legacy and migrating
// stores answer as before. The POST's mode refusal, before or inside the
// write's own batch, answers 409 with its plain words (never the catch-all).
// shopifyAdminBase is the shared one (lib/admin/shopify-admin-url.js).
//
// P4-FIX4: the editor's product and collection pickers read this GET, so on a
// documents store whose live release can't be read (a broken release, a
// failed read) it still answers: the Shopify catalog with no overlays (no
// template, modules, badge or pins; never the frozen tables), with
// `published: "unavailable"` and a plain note, and the failure is logged. The
// per-product and per-collection reads run a few at a time, not one by one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE_NOTE = "We couldn't read what's published right now, so modules, badges, templates and pinned products aren't shown here. The products themselves are listed.";

// The published presentation of a documents store, or null on any other.
// { getters } when the live release reads, { unavailable: true } when it
// doesn't (logged). A mode that can't be read still throws (a 5xx), as before.
async function publishedPresentation() {
  if ((await getCmsMode()) !== "documents") return null;
  // (a promise .catch, not a catch block: this is a deliberate fallback that
  // answers 200, not a failure the route's catch-alls would map)
  const getters = await publishedGetters().catch((e) => unavailable(e, "release"));
  return getters ? { getters } : { unavailable: true };
}

// logs why the published presentation can't be shown; answers null
function unavailable(e, part) {
  slog("catalog_published_unreadable", { part, error: String(e?.message || e).slice(0, 300), ...(e?.detail ? { detail: String(e.detail).slice(0, 300) } : {}) });
  return null;
}

// run fn over items, a few at a time (each getter does one or two reads)
async function mapLimited(items, fn, limit = 8) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const part = items.slice(i, i + limit);
    const done = await Promise.all(part.map((x) => fn(x)));
    for (let j = 0; j < done.length; j++) out[i + j] = done[j];
  }
  return out;
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const url = new URL(request.url);

  const productGid = url.searchParams.get("product");
  const live = await publishedPresentation();
  if (productGid) {
    const p = await db.selectFrom("products").selectAll().where("id", "=", productGid).executeTakeFirst();
    if (!p) return NextResponse.json({ error: "product not found" }, { status: 404 });
    const base = shopifyAdminBase();
    if (live) {
      const shown = live.getters
        ? await Promise.all([live.getters.resolvedProductOverride(p.id), live.getters.resolvedSurfaceTemplateFor("pdp", p.id)])
            .then(([o, surface]) => ({ override: { modules: o?.modules ?? [], badge: o?.badge ?? "" }, surface }))
            .catch((e) => unavailable(e, "product"))
        : null;
      if (!shown) return NextResponse.json({ ok: true, product: productView(p, base), override: { modules: [], badge: "" }, surface: null, published: "unavailable", note: UNAVAILABLE_NOTE });
      return NextResponse.json({ ok: true, product: productView(p, base), ...shown });
    }
    return NextResponse.json({
      ok: true,
      product: productView(p, base),
      override: (await getProductOverride(p.id)) || { modules: [], badge: "" },
      // S57: which PDP template THIS product renders with, and why — the
      // editor explains the selected template (audit requirement). Draft view:
      // what the next publish makes live.
      surface: effectiveSurfaceTemplate(await getBlock("surface_templates"), "pdp", p.id),
    });
  }

  const q = (url.searchParams.get("q") || "").trim();
  let query = db
    .selectFrom("products")
    .select(["id", "handle", "title", "product_type", "price_min", "currency", "available", "featured_image"]);
  if (q) {
    const term = `%${q.replace(/[%_]/g, "")}%`;
    query = query.where((eb) => eb.or([eb("title", "like", term), eb("handle", "like", term), eb("product_type", "like", term)]));
  }
  const [products, overrides, collections] = await Promise.all([
    query.orderBy("title", "asc").limit(30).execute(),
    live ? [] : listProductOverrides(),
    db.selectFrom("collections").select(["id", "handle", "title"]).orderBy("handle").execute(),
  ]);
  const overridden = new Set(overrides.map((o) => o.product_id));
  const pins = {};
  let published = null;
  if (live) {
    // what is published (the live rows), never the frozen tables; when that
    // can't be read, the catalog alone (no overlays), logged
    const g = live.getters;
    const read = g
      ? await Promise.all([mapLimited(products, (p) => g.resolvedProductOverride(p.id)), mapLimited(collections, (c) => g.resolvedCollectionPins(c.handle))]).catch((e) => unavailable(e, "list"))
      : null;
    if (read) {
      const [os, pinned] = read;
      os.forEach((o, i) => {
        if (o?.modules?.length || o?.badge) overridden.add(products[i].id);
      });
      pinned.forEach((list, i) => {
        if (list.length) pins[collections[i].handle] = list.length;
      });
    } else published = "unavailable";
  } else {
    for (const c of collections) {
      const pinned = await getCollectionPins(c.id);
      if (pinned.length) pins[c.handle] = pinned.length;
    }
  }
  return NextResponse.json({
    ok: true,
    products: products.map((p) => ({ ...p, available: !!p.available, customized: overridden.has(p.id) })),
    overrides,
    collections: collections.map((c) => ({ handle: c.handle, title: c.title, pinned: pins[c.handle] || 0 })),
    shopify_admin: shopifyAdminBase(),
    ...(published ? { published, note: UNAVAILABLE_NOTE } : {}),
  });
});

const productView = (p, base) => ({
  id: p.id,
  handle: p.handle,
  title: p.title,
  product_type: p.product_type,
  vendor: p.vendor,
  price_min: p.price_min,
  price_max: p.price_max,
  currency: p.currency,
  available: !!p.available,
  featured_image: p.featured_image,
  shopify_url: base ? `${base}/products/${numericId(p.id)}` : null,
});

// A deliberate refusal raised inside the write (the mode guard in its own
// batch, P4-GUARD): its own 4xx status and plain words, before the catch-all.
const refusalBody = (e) => ({ error: String(e.message).slice(0, 300), ...(e.code ? { code: e.code } : {}) });
const refusalStatus = (e) => (Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 409);

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  // P2-GUARD: a store on the new editor refuses this write (409 STORE_USES_DOCUMENTS)
  const refused = await legacyWritesRefusal({ route: "admin/catalog" });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
  try {
    if (body.product) {
      const p = await db.selectFrom("products").select(["id", "handle"]).where("handle", "=", String(body.product.handle || "")).executeTakeFirst();
      if (!p) return NextResponse.json({ error: `Unknown product handle "${body.product.handle || ""}"` }, { status: 422 });
      const r = await setProductOverride(p.id, { modules: body.product.modules, badge: body.product.badge });
      slog("product_override_saved", { product: p.handle, removed: !!r.removed });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `product_override:${p.handle}`, diff: { modules: r.modules?.length ?? 0, badge: !!r.badge } });
      return NextResponse.json({ ok: true, override: r });
    }
    if (body.collection) {
      const c = await db.selectFrom("collections").select(["id", "handle"]).where("handle", "=", String(body.collection.handle || "")).executeTakeFirst();
      if (!c) return NextResponse.json({ error: `Unknown collection handle "${body.collection.handle || ""}"` }, { status: 422 });
      const handles = (body.collection.pinnedHandles || []).map((h) => String(h).trim()).filter(Boolean);
      let ids = [];
      if (handles.length) {
        const rows = await db.selectFrom("products").select(["id", "handle"]).where("handle", "in", handles).execute();
        const byHandle = new Map(rows.map((r) => [r.handle, r.id]));
        const missing = handles.filter((h) => !byHandle.has(h));
        if (missing.length) return NextResponse.json({ error: `Unknown product handle(s): ${missing.join(", ")}` }, { status: 422 });
        ids = handles.map((h) => byHandle.get(h));
      }
      const r = await setCollectionPins(c.id, ids);
      slog("collection_pins_saved", { collection: c.handle, pinned: ids.length });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `collection_pins:${c.handle}`, diff: { pinned: ids.length } });
      return NextResponse.json({ ok: true, pins: r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    if (e?.expose) return NextResponse.json(refusalBody(e), { status: refusalStatus(e) });
    if (e?.errors) return NextResponse.json({ error: String(e.message).slice(0, 300), errors: e.errors }, { status: 422 }); // the edit's own problems
    const infra = infraResponse(e, { route: "admin/catalog" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
