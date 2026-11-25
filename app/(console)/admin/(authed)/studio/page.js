import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { getCmsMode } from "@/lib/cms-mode";
import { listDocuments } from "@/lib/documents/service";
import { editorEntry, editorHref, entityEditorHref, parseEditorTarget } from "@/lib/admin/editor-entry";
import { canEdit } from "@/lib/admin/entity-entry";
import { tfetch } from "@/lib/console-request";
import { roleAllows } from "@/lib/platform/authz";
import { slog } from "@/lib/log";
import Studio from "@/components/admin/studio/Studio";

// Phase 6 step 0 (docs/plans/phase-6.md): the studio's address.
//   /admin/studio               the home page
//   /admin/studio?doc=<id>      that document (editorEntry's rules: an id this
//                               store doesn't have opens home with a note)
//   /admin/studio?path=<path>   the document at that store address
// Product and collection content stay in the editor: ?product=, ?collection=
// and a ?doc= of a product's or collection's content redirect to
// /admin/editor with the same target. A writer's store with no home page yet
// goes to /admin/editor, which makes the starting store first (P6-GEN).
// Every console role opens it (storefront.read); can = { write, publish }
// (storefront.write, storefront.publish) decides the controls, and without
// write the studio's api is read-only. The store's mode is read fresh on
// every request: a store not in documents mode is the error page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Studio · Admin", robots: { index: false } };

const ENTITY_TYPES = new Set(["product_content", "collection_content"]);

// the design form's Reset (as editor/page.js; template-literal imports so a
// suite compiling this page alone doesn't follow them)
async function startingBrandHere() {
  try {
    const [{ currentTenant }, { paletteById, startingPaletteId }] = await Promise.all([import(`@/lib/tenant-context`), import(`@/lib/themes/palettes`)]);
    return { ...paletteById(startingPaletteId(currentTenant()?.config?.onboarding ?? null)).brand };
  } catch (e) {
    slog("studio_starting_brand_failed", { error: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

export default async function StudioPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const query = (await searchParams) || {};
  const target = parseEditorTarget(query);
  if (target.product || target.collection) redirect(entityEditorHref(target));
  const can = { write: canEdit(actor), publish: roleAllows(actor?.role, "storefront.publish") };
  const { entry, startingBrand, noHome } = await tfetch(async () => {
    await getCmsMode();
    const docs = await listDocuments();
    return { entry: editorEntry(query, docs), startingBrand: await startingBrandHere(), noHome: !docs.some((d) => d.id === "doc_home") };
  });
  if (ENTITY_TYPES.has(entry.document?.type)) redirect(editorHref(entry.document.id));
  if (can.write && noHome) redirect("/admin/editor");

  return <Studio document={entry.document} note={entry.note} can={can} role={actor?.role ?? null} startingBrand={startingBrand} />;
}
