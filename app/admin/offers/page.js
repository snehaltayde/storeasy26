import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listOffers } from "@/lib/offers/store";
import OffersAdmin from "@/components/admin/OffersAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offers · Admin", robots: { index: false } };

export default async function AdminOffersPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  const authed = await tfetch(() => verifyAdminToken(token));
  if (!authed) redirect("/admin/login");
  const offers = await tfetch(() => listOffers());
  return <OffersAdmin initialOffers={offers} />;
}
