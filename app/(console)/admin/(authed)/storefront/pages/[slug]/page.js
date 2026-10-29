import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getContentPage, pageRevisions } from "@/lib/cms/store";
import { normalizePageSections } from "@/lib/cms/schemas";
import { db } from "@/lib/db";
import { PageEditor } from "@/components/admin/cms/PageEditor";
import { tfetch } from "@/lib/tenant-request";

// S52: the page editor route. /admin/storefront/pages/new creates (optionally
// duplicating ?from=<slug>); any other slug edits that page. The editor itself
// is a client component; this page only authenticates, loads and hands over.
export const dynamic = "force-dynamic";
export const metadata = { title: "Page · Admin", robots: { index: false } };

const BLANK = { slug: "", title: "", description: "", enabled: true, effective_at: null, family: "page", window_start: null, window_end: null, sections: [] };

// getContentPage() is the EFFECTIVE page for shoppers, so it hides disabled
// rows (the storefront 404s them) — but the editor must still open hidden
// pages. Read the row directly first; fall back to the effective getter for
// the BeastLife built-in defaults (which have no row).
async function loadPage(slug) {
  try {
    const row = await db.selectFrom("cms_pages").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (row) {
      let sections = [];
      try {
        sections = JSON.parse(row.sections || "[]");
      } catch {
        sections = [];
      }
      return {
        slug: row.slug,
        title: row.title,
        description: row.description || "",
        sections: normalizePageSections(sections),
        enabled: !!row.enabled,
        effective_at: row.effective_at || null,
        family: row.family || "page",
        window_start: row.window_start || null,
        window_end: row.window_end || null,
      };
    }
  } catch {
    /* table missing (pre-migration tenant) → defaults below */
  }
  const page = await getContentPage(slug);
  return page ? { ...page, enabled: true } : null;
}

export default async function StorefrontPageEditorPage({ params, searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { slug } = await params;

  if (slug === "new") {
    const sp = await searchParams;
    const from = typeof sp?.from === "string" ? sp.from : null;
    const [source, tenantTemplates] = await tfetch(async () => {
      const { listTemplates } = await import("@/lib/cms/templates-store");
      return [from ? await loadPage(from) : null, await listTemplates()];
    });
    const initial = source
      ? { ...source, slug: "", title: source.title ? `Copy of ${source.title}` : "", enabled: true }
      : BLANK;
    return <PageEditor mode="create" page={initial} revision={null} fromMissing={Boolean(from && !source)} tenantTemplates={tenantTemplates} />;
  }

  const [page, revs] = await tfetch(async () => [await loadPage(slug), await pageRevisions()]);
  if (!page) notFound();
  return <PageEditor mode="edit" page={page} revision={revs[slug] ?? null} />;
}
