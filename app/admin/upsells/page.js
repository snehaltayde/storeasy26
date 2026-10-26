import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listPlacements } from "@/lib/cms/placements";
import { db } from "@/lib/db";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import UpsellsAdmin from "@/components/admin/UpsellsAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upsells · Admin", robots: { index: false } };

export default async function AdminUpsellsPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const authed = await tfetch(() => verifyAdminToken(token));
  if (!authed) redirect("/admin/login");

  const [placements, name] = await tfetch(async () => {
    const rows = await listPlacements();
    const ids = [...new Set(rows.flatMap((r) => [r.source_product_id, ...r.target_product_ids]).filter(Boolean))];
    const handles = new Map();
    if (ids.length) {
      const prods = await db.selectFrom("products").select(["id", "handle"]).where("id", "in", ids).execute();
      for (const p of prods) handles.set(p.id, p.handle);
    }
    return [
      rows.map((r) => ({
        ...r,
        source_handle: r.source_product_id ? handles.get(r.source_product_id) || "(missing)" : null,
        target_handles: r.target_product_ids.map((id) => handles.get(id) || "(missing)"),
      })),
      siteName(),
    ];
  });

  return (
    <>
      <AdminNav storeName={name} />
      <UpsellsAdmin initial={placements} />
    </>
  );
}
