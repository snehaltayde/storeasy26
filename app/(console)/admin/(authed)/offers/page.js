import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listOffers } from "@/lib/offers/store";
import OffersAdmin from "@/components/admin/OffersAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offers · Admin", robots: { index: false } };

export default async function AdminOffersPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const offers = await tfetch(() => listOffers());
  // PageHeader renders inside OffersAdmin: the "New offer" action needs client
  // state, and OfferForm swaps the whole view (breadcrumb header included).
  return <OffersAdmin initialOffers={offers} />;
}
