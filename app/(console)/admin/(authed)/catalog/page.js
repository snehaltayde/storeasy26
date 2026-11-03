import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { listProductOverrides, getCollectionPins } from "@/lib/catalog-overrides";
import CatalogAdmin from "@/components/admin/CatalogAdmin";
import { BundlesPanel, QuizPanel } from "@/components/admin/CommercePanels";
import { listBundles } from "@/lib/bundles";
import { listQuizzes } from "@/lib/quiz";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog · Admin", robots: { index: false } };

// Catalog browser (S39 / MC05 + MC06, redesigned S50): Shopify-owned values
// labeled + linked, per-product presentation overrides, per-collection
// pinned ordering. Bundles + quiz panels live below.
export default async function AdminCatalogPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [initial, bundles, quizzes] = await tfetch(async () => {
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
        <BundlesPanel initial={bundles} />
        <QuizPanel initial={quizzes} />
      </div>
    </>
  );
}
