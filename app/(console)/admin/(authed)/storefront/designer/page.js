import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { runningTestsBySection } from "@/lib/experiments";
import { tfetch } from "@/lib/console-request";
import { getCmsMode } from "@/lib/cms-mode";
import { editorHref, LEGACY_ROUTE_DOCS } from "@/lib/admin/editor-entry";
import Designer from "@/components/admin/cms/Designer";

// S55 / audit slice 3: the HOME-PAGE DESIGNER — section tree, click-to-select
// storefront preview, registry-driven inspector. Same guard + view load as the
// Home page editor; the PageHeader lives inside the client component because
// its actions (Save, the dirty status line) are client state.
export const dynamic = "force-dynamic";
export const metadata = { title: "Designer · Admin", robots: { index: false } };

export default async function StorefrontDesignerPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // P3-ROUTES: a documents store edits this in the new editor (a mode read error keeps this screen; its writes refuse)
  const cmsMode = await tfetch(() => getCmsMode()).catch(() => null);
  if (cmsMode === "documents") redirect(editorHref(LEGACY_ROUTE_DOCS["/admin/storefront/designer"]));

  // PV-08: running tests by section, for the "a test is running" notes. A
  // failed read only costs the note, never the editor.
  const [initial, tests] = await tfetch(() => Promise.all([storefrontView(), runningTestsBySection().catch(() => ({}))]));

  return <Designer initial={initial} tests={tests} />;
}
