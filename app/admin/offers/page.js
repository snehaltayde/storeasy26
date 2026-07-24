import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { listOffers } from "@/lib/offers/store";
import OffersAdmin from "@/components/admin/OffersAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offers · Admin", robots: { index: false } };

export default async function AdminOffersPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!(await verifyAdminToken(token))) redirect("/admin/login");
  const offers = await listOffers();
  return <OffersAdmin initialOffers={offers} />;
}
