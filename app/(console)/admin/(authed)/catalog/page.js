import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { listProductOverrides, getCollectionPins } from "@/lib/catalog-overrides";
import CatalogAdmin from "@/components/admin/CatalogAdmin";
import { BundlesPanel, QuizPanel } from "@/components/admin/CommercePanels";
import { listBundles, bundleCurrency } from "@/lib/bundles";
import { listQuizzes } from "@/lib/quiz";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";
import { getCmsMode } from "@/lib/cms-mode";
import { catalogHref, PRODUCTS_LIST_HREF } from "@/lib/admin/editor-entry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog · Admin", robots: { index: false } };

// Catalog browser (S39 / MC05 + MC06, redesigned S50): Shopify-owned values
// labeled + linked, per-product presentation overrides, per-collection
// pinned ordering. Bundles + quiz panels live below.
//
// P4-ED05 (ED-05): on a documents store product pages are edited in the
// editor. ?product=<gid> (or ?collection=<gid>) redirects to that product
// (collection) there. The page itself stays, because Bundles and Quiz live
// only here until ED-06 gives them their own screens: it shows a link to the
// editor's Products list in place of the old product editor (whose saves
// refuse on a documents store), then the Bundles and Quiz panels. Legacy and
// migrating stores (and a mode that can't be read) render as before.
// P4-FIX3 (P4-EDITOR review): on a documents store, what the editor sets and
// what stays in Shopify, in plain words (CatalogAdmin's CATALOG_DOCUMENTS_LINE
// says the same). Legacy and migrating stores keep their words.
const CATALOG_DOCUMENTS_WORDS = Object.freeze({
  header: "Your products, synced from Shopify. The name, description, photos, brand and product type shoppers see are set in the editor; only price, stock and Shopify's own type and vendor stay in Shopify. Bundles and quizzes stay here.",
  block: "Names, descriptions, photos, the brand and product type shoppers see, badges, modules and pairs are set in the editor now. Price, stock and Shopify's own type and vendor stay in Shopify: change those in Shopify.",
});

// P5-PANEL: the store's currency for the bundle prices (formatMoney). When
// it can't be read the panel gets undefined and formatMoney uses its own
// default, as Price.js does.
const currencyForBundles = async () => {
  try {
    return await bundleCurrency();
  } catch {
    return undefined;
  }
};

export default async function AdminCatalogPage({ searchParams } = {}) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const cmsMode = await tfetch(() => getCmsMode()).catch(() => null);
  if (cmsMode === "documents") {
    const to = catalogHref((await searchParams) || {});
    if (to !== PRODUCTS_LIST_HREF) redirect(to);
    const [bundles, quizzes, currency] = await tfetch(async () => [await listBundles(), await listQuizzes(), await currencyForBundles()]);
    return (
      <>
        <PageHeader title="Catalog" description={CATALOG_DOCUMENTS_WORDS.header} />
        <div data-documents-mode="" className="rounded-card border border-edge bg-surface p-4 shadow-card">
          <p className="text-sm font-semibold text-fg">Product pages</p>
          <p className="mt-0.5 text-sm text-fg-muted" data-catalog-editor-sets="">{CATALOG_DOCUMENTS_WORDS.block}</p>
          <a href={PRODUCTS_LIST_HREF} className="mt-2 inline-flex rounded-ctl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg focus-ring hover:bg-primary-hover">
            Open products in the editor
          </a>
        </div>
        <div className="mt-4 space-y-4">
          <BundlesPanel initial={bundles} currency={currency} />
          <QuizPanel initial={quizzes} />
        </div>
      </>
    );
  }

  const [initial, bundles, quizzes, currency] = await tfetch(async () => {
    const [products, overrides, collections] = await Promise.all([
      db
        .selectFrom("products")
        .select(["id", "handle", "title", "product_type", "price_min", "currency", "available", "featured_image"])
        .orderBy("title", "asc")
        .limit(30)
        .execute()
        .catch(() => []),
      listProductOverrides(),
      db.selectFrom("collections").select(["id", "handle", "title"]).orderBy("handle").execute().catch(() => []),
    ]);
    const overridden = new Set(overrides.map((o) => o.product_id));
    const cols = [];
    for (const c of collections) {
      const pinned = await getCollectionPins(c.id);
      cols.push({ handle: c.handle, title: c.title, pinned: pinned.length });
    }
    return [
      {
        products: products.map((p) => ({ ...p, available: !!p.available, customized: overridden.has(p.id) })),
        overrides,
        collections: cols,
      },
      await listBundles(),
      await listQuizzes(),
      await currencyForBundles(),
    ];
  });

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Your products, synced from Shopify (values stay Shopify’s — edit them there). Here you add per-product page modules, badges, and pinned collection ordering."
      />
      <CatalogAdmin initial={initial} />
      <div className="mt-4 space-y-4">
        <BundlesPanel initial={bundles} currency={currency} />
        <QuizPanel initial={quizzes} />
      </div>
    </>
  );
}
