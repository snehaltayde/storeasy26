import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listPlacements } from "@/lib/cms/placements";
import { db } from "@/lib/db";
import UpsellsAdmin from "@/components/admin/UpsellsAdmin";
import { tfetch } from "@/lib/console-request";
import { getCmsMode } from "@/lib/cms-mode";
import { upsellsHref } from "@/lib/admin/editor-entry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upsells · Admin", robots: { index: false } };

// P4-ED05 (ED-05): a documents store edits upsells in the editor: a
// product's pairs on that product (?product=<gid>), the cart's offer in the
// cart document. Legacy and migrating stores (and a mode that can't be read,
// whose writes still refuse) render as before.
export default async function AdminUpsellsPage({ searchParams } = {}) {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const cmsMode = await tfetch(() => getCmsMode()).catch(() => null);
  if (cmsMode === "documents") redirect(upsellsHref((await searchParams) || {}));

  const placements = await tfetch(async () => {
    const rows = await listPlacements();
    const ids = [...new Set(rows.flatMap((r) => [r.source_product_id, ...r.target_product_ids]).filter(Boolean))];
    const handles = new Map();
    if (ids.length) {
      const prods = await db.selectFrom("products").select(["id", "handle"]).where("id", "in", ids).execute();
      for (const p of prods) handles.set(p.id, p.handle);
    }
    return rows.map((r) => ({
      ...r,
      source_handle: r.source_product_id ? handles.get(r.source_product_id) || "(missing)" : null,
      target_handles: r.target_product_ids.map((id) => handles.get(id) || "(missing)"),
    }));
  });

  // PageHeader renders inside UpsellsAdmin: the "New placement" action and the
  // inline create/edit form both need client state.
  return <UpsellsAdmin initial={placements} />;
}
