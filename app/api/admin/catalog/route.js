import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { db } from "@/lib/db";
import { getProductOverride, setProductOverride, listProductOverrides, getCollectionPins, setCollectionPins } from "@/lib/catalog-overrides";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { getBlock } from "@/lib/cms/store";
import { effectiveSurfaceTemplate } from "@/lib/cms/defaults";
import { numericId } from "@/lib/ids";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Catalog browser API (S39 / MC05 + MC06). Shopify owns catalog VALUES —
// this surface is read-only on them (the console labels + links to Shopify
// admin) and writes only per-tenant PRESENTATION overrides.
//   GET ?q=            → product search + overrides (orphans flagged) + collections
//   GET ?product=gid   → one product's Shopify-owned fields + its override
//   POST {product:{handle, modules, badge}}         → set per-product override
//   POST {collection:{handle, pinnedHandles:[…]}}   → set pinned order
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shopifyAdminBase = () => {
  const d = tenantOwnCfg("shopify_store_domain", "SHOPIFY_STORE_DOMAIN", "") || "";
  const store = d.replace(/\.myshopify\.com$/, "");
  return store ? `https://admin.shopify.com/store/${store}` : null;
};

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const url = new URL(request.url);

  const productGid = url.searchParams.get("product");
  if (productGid) {
    const p = await db.selectFrom("products").selectAll().where("id", "=", productGid).executeTakeFirst();
    if (!p) return NextResponse.json({ error: "product not found" }, { status: 404 });
    const base = shopifyAdminBase();
    return NextResponse.json({
      ok: true,
      product: {
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
      },
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
    listProductOverrides(),
    db.selectFrom("collections").select(["id", "handle", "title"]).orderBy("handle").execute(),
  ]);
  const overridden = new Set(overrides.map((o) => o.product_id));
  const pins = {};
  for (const c of collections) {
    const pinned = await getCollectionPins(c.id);
    if (pinned.length) pins[c.handle] = pinned.length;
  }
  return NextResponse.json({
    ok: true,
    products: products.map((p) => ({ ...p, available: !!p.available, customized: overridden.has(p.id) })),
    overrides,
    collections: collections.map((c) => ({ handle: c.handle, title: c.title, pinned: pins[c.handle] || 0 })),
    shopify_admin: shopifyAdminBase(),
  });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
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
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), ...(e.errors ? { errors: e.errors } : {}) }, { status: 422 });
  }
});
