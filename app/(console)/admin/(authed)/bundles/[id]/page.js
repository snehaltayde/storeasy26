import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { bundleCompat, listBundles } from "@/lib/bundles";
import { storeCurrency } from "@/lib/offers/catalog";
import { BundleEditor } from "@/components/admin/bundles/BundleEditor";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bundle · Admin", robots: { index: false } };

// Phase 2 line 4: one bundle ("new" is the create form); an unknown id is a
// not-found. The first check runs here, so the products have names and the
// state its reasons before any change (support cannot run POST {check}:
// offers.write). "new" is for writers only.
export default async function AdminBundlePage({ params }) {
  const { id } = await params;
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const canWrite = roleAllows(actor.role, "offers.write");
  if (id === "new" && !canWrite) redirect("/admin/bundles");
  const data = await tfetch(async () => {
    const currency = await storeCurrency();
    if (id === "new") return { bundle: null, check: null, currency };
    const bundle = (await listBundles()).find((b) => b.id === id);
    if (!bundle) return null;
    const c = await bundleCompat({ items: bundle.items, bundle_price: bundle.bundle_price });
    return { bundle, check: { ok: c.ok, state: c.state, reasons: c.reasons, components: c.components, componentsSum: c.componentsSum, saving: c.saving }, currency };
  });
  if (!data) notFound();
  return <BundleEditor initial={data.bundle} initialCheck={data.check} currency={data.currency} role={actor.role} canWrite={canWrite} />;
}
