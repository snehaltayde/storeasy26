import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { roleAllows } from "@/lib/platform/authz";
import { listBundles, withComponentNames } from "@/lib/bundles";
import { storeCurrency } from "@/lib/offers/catalog";
import { BundlesList } from "@/components/admin/bundles/BundlesList";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bundles · Admin", robots: { index: false } };

// Phase 2 line 4: the bundles list on the new UI,
// under offers.read like GET /api/admin/bundles. canWrite says whether the
// page shows writes; the API refuses them regardless.
export default async function AdminBundlesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "offers.read")) return <NoAccess role={actor.role} page />;
  // each row's products by name (the list API answers ids and quantities only)
  const { bundles, currency } = await tfetch(async () => {
    const bundles = await withComponentNames(await listBundles());
    return { bundles, currency: await storeCurrency() };
  });
  return <BundlesList initialBundles={bundles} currency={currency} role={actor.role} canWrite={roleAllows(actor.role, "offers.write")} />;
}
