import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { settingsView } from "@/lib/admin/settings";
import { currentTenant } from "@/lib/tenant-context.js";
import { siteName } from "@/lib/site";
import { db } from "@/lib/db";
import AdminNav from "@/components/admin/AdminNav";
import SettingsAdmin from "@/components/admin/SettingsAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Admin", robots: { index: false } };

export default async function AdminSettingsPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const authed = await tfetch(() => verifyAdminToken(token));
  if (!authed) redirect("/admin/login");

  const [view, name] = await tfetch(async () => {
    let counts = null;
    try {
      const [p, c] = await Promise.all([
        db.selectFrom("products").select([(eb) => eb.fn.countAll().as("n"), (eb) => eb.fn.max("synced_at").as("last")]).executeTakeFirst(),
        db.selectFrom("collections").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst(),
      ]);
      counts = { products: Number(p?.n || 0), collections: Number(c?.n || 0), lastSyncedAt: p?.last || null };
    } catch {
      counts = null;
    }
    return [settingsView(currentTenant(), { counts }), siteName()];
  });

  return (
    <>
      <AdminNav storeName={name} />
      <SettingsAdmin initial={view} />
    </>
  );
}
