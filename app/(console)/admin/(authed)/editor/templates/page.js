import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getCmsMode } from "@/lib/cms-mode";
import { libsql } from "@/lib/db";
import { notMigratedYet } from "@/lib/schema-shape";
import { tfetch } from "@/lib/console-request";
import { parseTemplateSections, TEMPLATE_FAMILIES } from "@/lib/admin/saved-templates";
import { PageHeader } from "@/components/console/PageHeader";
import { Banner } from "@/components/console/Banner";
import SavedTemplates from "@/components/admin/SavedTemplates";

// P4-ED05 (DOC-09 partly pulled in; plan decision 12): the store's old saved
// page templates, READ-ONLY, on a documents store. They are not blueprints
// (DOC-09 is P1); "Make a page from this" makes a new draft page from one
// (components/admin/SavedTemplates.js). This page reads cms_templates and
// never writes it: the table is never edited or deleted here.
//   documents   the list, by family
//   legacy      a note: saved templates are used from the page editor
//   migrating   a note: nothing can be made while the store moves
// A mode that can't be read is an error page, never a guess.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Saved templates · Admin", robots: { index: false } };

const FAMILIES = new Set(TEMPLATE_FAMILIES.map((f) => f.family));

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
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const { mode, templates } = await tfetch(async () => {
    const mode = await getCmsMode();
    return { mode, templates: mode === "documents" ? await readSavedTemplates() : [] };
  });

  if (mode === "documents") {
    return (
      <>
        <PageHeader
          title="Saved templates"
          description="Templates you saved with the old page editor. Make a new page from one; the template itself stays as it is."
          breadcrumb={[{ label: "Editor", href: "/admin/editor" }, { label: "Saved templates" }]}
        />
        <div data-saved-templates="">
          <SavedTemplates templates={templates} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Saved templates" />
      <Banner tone={mode === "legacy" ? "info" : "warning"} title={mode === "legacy" ? "Your store still uses the current editors" : "Your store is moving to the new editor"}>
        <p data-templates-note={mode === "legacy" ? "legacy" : "migrating"}>
          {mode === "legacy" ? (
            <>
              Your saved templates are used when you make a page in{" "}
              <Link href="/admin/storefront/pages/new" className="font-medium underline underline-offset-2">
                Pages
              </Link>
              .
            </>
          ) : (
            "While the move runs, nothing can be made here. Come back once the move is done."
          )}
        </p>
      </Banner>
    </>
  );
}
