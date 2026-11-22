import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { numericId } from "@/lib/ids";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { StoreUsesDocumentsError } from "@/lib/cms-mode";
import { shopifyAdminBase } from "@/lib/admin/shopify-admin-url";
import { publishedGetters } from "@/lib/cms/view";

// Catalog browser API (Documents-only). Shopify owns catalog VALUES;
// published presentation overlays come from product_content_live /
// collection_content_live through publishedGetters(). Writes go through the
// unified Documents editor (/api/admin/documents).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE_NOTE = "We couldn't read what's published right now, so modules, badges, templates and pinned products aren't shown here. The products themselves are listed.";

function unavailable(e, part) {
  slog("catalog_published_unreadable", {
    part,
    error: String(e?.message || e).slice(0, 300),
    ...(e?.detail ? { detail: String(e.detail).slice(0, 300) } : {}),
  });
  return null;
}

async function mapLimited(items, fn, limit = 8) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const part = items.slice(i, i + limit);
    const done = await Promise.all(part.map((x) => fn(x)));
    for (let j = 0; j < done.length; j++) out[i + j] = done[j];
  }
  return out;
}

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

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const url = new URL(request.url);
  const getters = await publishedGetters().catch((e) => unavailable(e, "release"));

  const productGid = url.searchParams.get("product");
  if (productGid) {
    const p = await db.selectFrom("products").selectAll().where("id", "=", productGid).executeTakeFirst();
    if (!p) return NextResponse.json({ error: "product not found" }, { status: 404 });
    const base = shopifyAdminBase();
    const shown = getters
      ? await Promise.all([getters.resolvedProductOverride(p.id), getters.resolvedSurfaceTemplateFor("pdp", p.id)])
          .then(([o, surface]) => ({ override: { modules: o?.modules ?? [], badge: o?.badge ?? "" }, surface }))
          .catch((e) => unavailable(e, "product"))
      : null;
    if (!shown) {
      return NextResponse.json({
        ok: true,
        product: productView(p, base),
        override: { modules: [], badge: "" },
        surface: null,
        published: "unavailable",
        note: UNAVAILABLE_NOTE,
      });
    }
    return NextResponse.json({ ok: true, product: productView(p, base), ...shown });
  }

  const q = (url.searchParams.get("q") || "").trim();
  let query = db
    .selectFrom("products")
    .select(["id", "handle", "title", "product_type", "price_min", "currency", "available", "featured_image"]);
  if (q) {
    const term = `%${q.replace(/[%_]/g, "")}%`;
    query = query.where((eb) => eb.or([eb("title", "like", term), eb("handle", "like", term), eb("product_type", "like", term)]));
  }
  const [products, collections] = await Promise.all([
    query.orderBy("title", "asc").limit(30).execute(),
    db.selectFrom("collections").select(["id", "handle", "title"]).orderBy("handle").execute(),
  ]);
  const overridden = new Set();
  const pins = {};
  let published = null;
  const read = getters
    ? await Promise.all([
        mapLimited(products, (p) => getters.resolvedProductOverride(p.id)),
        mapLimited(collections, (c) => getters.resolvedCollectionPins(c.handle)),
      ]).catch((e) => unavailable(e, "list"))
    : null;
  if (read) {
    const [os, pinned] = read;
    os.forEach((o, i) => {
      if (o?.modules?.length || o?.badge) overridden.add(products[i].id);
    });
    pinned.forEach((list, i) => {
      if (list.length) pins[collections[i].handle] = list.length;
    });
  } else {
    published = "unavailable";
  }
  return NextResponse.json({
    ok: true,
    products: products.map((p) => ({ ...p, available: !!p.available, customized: overridden.has(p.id) })),
    overrides: [],
    collections: collections.map((c) => ({ handle: c.handle, title: c.title, pinned: pins[c.handle] || 0 })),
    shopify_admin: shopifyAdminBase(),
    ...(published ? { published, note: UNAVAILABLE_NOTE } : {}),
  });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const err = new StoreUsesDocumentsError("documents");
  return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
});
