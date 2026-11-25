import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { QuizPanel } from "@/components/admin/CommercePanels";
import { listQuizzes } from "@/lib/quiz";
import { tfetch } from "@/lib/console-request";
import { roleAllows } from "@/lib/platform/authz";
import { storeCurrency } from "@/lib/offers/catalog";
import { browseProducts, catalogHeader } from "@/lib/admin/catalog-browse";
import { catalogHref, PRODUCTS_LIST_HREF } from "@/lib/admin/editor-entry";
import { PageHeader } from "@/components/kit/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CatalogTabs } from "@/components/admin/catalog/CatalogTabs";
import { SyncHeader } from "@/components/admin/catalog/SyncHeader";
import { QuizTray } from "@/components/admin/catalog/QuizTray";

// The Catalog page on the new UI (Phase 2 line 3, docs/plans/phase-2.md
// "Line 3"; lib/admin/new-ui-routes.js lists /admin/catalog). Browse products
// and collections, read-only (Shopify owns the values; the editor owns the
// content). ?product= and ?collection= still open that one in the editor.
export const dynamic = "force-dynamic";
export const metadata = { title: "Catalog · Admin", robots: { index: false } };

export const CATALOG_WORDS = Object.freeze({
  header: "Your products, synced from Shopify. The name, description, photos, brand and product type shoppers see are set in the editor; only price, stock and Shopify's own type and vendor stay in Shopify.",
  block: "Names, descriptions, photos, the brand and product type shoppers see, badges, modules and pairs are set in the editor. Price, stock and Shopify's own type and vendor stay in Shopify: change those in Shopify.",
  bundles: "Bundles are with your offers",
  bundlesWhy: "Make and change bundles on the Bundles page, next to your offers.",
});

const LINK = "mt-1 inline-flex w-fit items-center gap-1 rounded-md text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export default async function AdminCatalogPage({ searchParams } = {}) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const to = catalogHref((await searchParams) || {});
  if (to !== PRODUCTS_LIST_HREF) redirect(to);

  const role = actor.role;
  // storefront.write: the quiz tray, and the card's link into the editor's
  // list. Support opens a product's content from its sheet ("View content");
  // the editor's own reads are PUTs to /api/admin/documents, which the shell
  // drill's support rule (no non-GET from a read) would count.
  const canWrite = roleAllows(role, "storefront.write");
  const [initial, currency, quizzes] = await tfetch(async () => [await browseProducts({}), await storeCurrency(), await listQuizzes()]);
  const header = await tfetch(() => catalogHeader({ products: initial.counts.all }));

  return (
    <div data-catalog="page" className="space-y-6">
      <PageHeader
        title="Catalog"
        description={<span className="block max-w-prose">{CATALOG_WORDS.header}</span>}
        actions={<SyncHeader role={role} canSync={roleAllows(role, "sync.run")} lastSynced={header.lastSynced} products={header.products} sync={header.sync} />}
        className="mb-0"
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Card size="sm" data-documents-mode="">
          <CardHeader>
            <CardTitle>Product pages</CardTitle>
            <CardDescription data-catalog-editor-sets="">{CATALOG_WORDS.block}</CardDescription>
            {canWrite && (
              <Link href={PRODUCTS_LIST_HREF} data-read-control className={LINK}>
                Open products in the editor
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            )}
          </CardHeader>
        </Card>
        <Card size="sm" data-catalog="bundles-moved">
          <CardHeader>
            <CardTitle>{CATALOG_WORDS.bundles}</CardTitle>
            <CardDescription>{CATALOG_WORDS.bundlesWhy}</CardDescription>
            <Link href="/admin/bundles" data-read-control className={LINK}>
              Go to bundles
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </CardHeader>
        </Card>
      </div>
      <CatalogTabs initial={initial} currency={currency} role={role} />
      {/* support's one-line summary sits under a rule, apart from the table; the writer's tray is its own card */}
      <div className={canWrite ? undefined : "border-t border-border pt-4"}>
        <QuizTray canWrite={canWrite} count={quizzes.length}>
          {canWrite ? <QuizPanel initial={quizzes} /> : null}
        </QuizTray>
      </div>
    </div>
  );
}
