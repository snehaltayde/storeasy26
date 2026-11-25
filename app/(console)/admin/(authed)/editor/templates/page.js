import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { getCmsMode } from "@/lib/cms-mode";
import { libsql } from "@/lib/db";
import { notMigratedYet } from "@/lib/schema-shape";
import { tfetch } from "@/lib/console-request";
import { parseTemplateSections, TEMPLATE_FAMILIES } from "@/lib/admin/saved-templates";
import { listDocuments } from "@/lib/documents/service";
import { PageHeader } from "@/components/kit/page-header";
import TemplatesList from "@/components/admin/editor/templates/TemplatesList";

// P4-ED05 (DOC-09 partly pulled in; plan decision 12): the store's old saved
// page templates, READ-ONLY, on a documents store. They are not blueprints
// (DOC-09 is P1); "Make a page from this" makes a new draft page from one. This page reads cms_templates and
// never writes it: the table is never edited or deleted here.
// Phase 2 line 6 (6a): on the new UI (components/admin/editor/templates/
// TemplatesList.js, which replaced the old SavedTemplates). Besides "Make a page
// from this", "Insert into a page" adds a template's sections to the end of a
// page that exists (the editor at ?doc=<id>&template=<id>, through its draft).
// Both are storefront.write (RoleGate, hidden for anyone without it).
// A store not in documents mode (500 STORE_MODE_INVALID) or a mode that can't
// be read is an error page, never a guess.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Saved templates · Admin", robots: { index: false } };

const FAMILIES = new Set(TEMPLATE_FAMILIES.map((f) => f.family));
const SECTION_PAGES = new Set(["home", "page", "campaign", "journal"]);

async function readSavedTemplates() {
  let r;
  try {
    r = await libsql.execute("SELECT id, name, family, sections, updated_at FROM cms_templates ORDER BY name, id");
  } catch (e) {
    if (notMigratedYet(e, { table: "cms_templates" })) return [];
    throw e;
  }
  return r.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    family: FAMILIES.has(String(row.family)) ? String(row.family) : "page",
    sections: parseTemplateSections(row.sections),
  }));
}

export default async function SavedTemplatesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { templates, pages } = await tfetch(async () => {
    await getCmsMode();
    const templates = await readSavedTemplates();
    // the pages a template can go into: the store's own pages with sections
    const pages = templates.length ? (await listDocuments()).filter((d) => SECTION_PAGES.has(d.type)).map((d) => ({ id: d.id, label: d.label || "Untitled" })) : [];
    return { templates, pages };
  });
  const role = actor?.role ?? null;

  return (
    <>
      <PageHeader
        title="Saved templates"
        description="Templates you saved with the old page editor. Make a new page from one; the template itself stays as it is."
        breadcrumb={[{ label: "Editor", href: "/admin/editor" }, { label: "Saved templates" }]}
      />
      <div data-saved-templates="">
        <TemplatesList templates={templates} pages={pages} role={role} />
      </div>
    </>
  );
}
