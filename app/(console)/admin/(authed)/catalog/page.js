import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { BundlesPanel, QuizPanel } from "@/components/admin/CommercePanels";
import { listBundles, bundleCurrency } from "@/lib/bundles";
import { listQuizzes } from "@/lib/quiz";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";
import { catalogHref, PRODUCTS_LIST_HREF } from "@/lib/admin/editor-entry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog · Admin", robots: { index: false } };

const CATALOG_DOCUMENTS_WORDS = Object.freeze({
  header: "Your products, synced from Shopify. The name, description, photos, brand and product type shoppers see are set in the editor; only price, stock and Shopify's own type and vendor stay in Shopify. Bundles and quizzes stay here.",
  block: "Names, descriptions, photos, the brand and product type shoppers see, badges, modules and pairs are set in the editor now. Price, stock and Shopify's own type and vendor stay in Shopify: change those in Shopify.",
});

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
