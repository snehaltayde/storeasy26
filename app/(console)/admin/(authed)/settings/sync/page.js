import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { db } from "@/lib/db";
import { catalogSyncStatus } from "@/lib/sync";
import { gateAction } from "@/lib/onboarding/open-step";
import { SyncPanel } from "@/components/admin/settings/SyncPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Products from Shopify · Settings · Admin", robots: { index: false } };

// Settings → Products from Shopify (Phase 2 line 7): the sync's own record
// (catalogSyncStatus) and the store's product and collection counts, each read
// on its own (a failed read shows its own words). Run sync is gated on sync.run.
export default async function SettingsSyncPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const [view, counts] = await tfetch(async () => {
    const sync = await catalogSyncStatus().catch(() => null);
    let counts = null;
    try {
      const [p, c] = await Promise.all([
        db
          .selectFrom("products")
          .select((eb) => eb.fn.countAll().as("n"))
          .executeTakeFirst(),
        db
          .selectFrom("collections")
          .select((eb) => eb.fn.countAll().as("n"))
          .executeTakeFirst(),
      ]);
      counts = { products: Number(p?.n || 0), collections: Number(c?.n || 0) };
    } catch {}
    return [sync?.view ?? null, counts];
  });
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Products from Shopify</h2>
      <SyncPanel view={view} counts={counts} gate={gateAction("sync.run", actor.role)} canReconnect={roleAllows(actor.role, "settings.write")} />
    </>
  );
}
