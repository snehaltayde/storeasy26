import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/console/PageHeader";
import { PagesList } from "@/components/admin/cms/PagesList";
import { tfetch } from "@/lib/tenant-request";

// S52: the Pages area of the storefront CMS — every content page (policies,
// campaigns, journal posts) in one filterable list, with the editor one click
// away. Server-rendered from storefrontView(); PagesList owns the client
// interactions (tabs, search, preview, delete).
export const dynamic = "force-dynamic";
export const metadata = { title: "Pages · Admin", robots: { index: false } };

export default async function StorefrontPagesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { pages, pageRevisions } = await tfetch(async () => {
    const view = await storefrontView();
    // The list rows from listContentPages() don't carry visibility windows,
    // but the Status column derives Scheduled/Expired from them for campaign
    // and journal pages — merge them in from the rows directly.
    let windows = {};
    try {
      const rows = await db.selectFrom("cms_pages").select(["slug", "window_start", "window_end"]).execute();
      windows = Object.fromEntries(rows.map((r) => [r.slug, r]));
    } catch {
      /* pre-migration tenant → no windows, statuses fall back to Visible/Hidden */
    }
    return {
      pages: view.pages.map((p) => ({
        ...p,
        window_start: windows[p.slug]?.window_start ?? null,
        window_end: windows[p.slug]?.window_end ?? null,
      })),
      pageRevisions: view.pageRevisions,
    };
  });

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Pages" }]}
        title="Pages"
        description="Policies, campaign landings and journal posts. Everything saves as a draft — publish from Publishing."
        actions={
          <Link
            href="/admin/storefront/pages/new"
            className="inline-flex items-center gap-1.5 rounded-ctl bg-primary px-3.5 py-2 text-sm font-medium text-primary-fg focus-ring hover:bg-primary-hover"
          >
            <Plus size={15} aria-hidden /> New page
          </Link>
        }
      />
      <PagesList pages={pages} pageRevisions={pageRevisions} />
    </>
  );
}
