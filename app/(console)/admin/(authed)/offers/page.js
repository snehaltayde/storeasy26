import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { roleAllows } from "@/lib/platform/authz";
import { listOffers } from "@/lib/offers/store";
import { offerTargetNames, storeCurrency } from "@/lib/offers/catalog";
import { merchantTz } from "@/lib/reporting";
import { OffersList } from "@/components/admin/offers/OffersList";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offers · Admin", robots: { index: false } };

// Phase 2 line 4: the offers list on the new UI.
// offers.read for every role; canWrite says whether the page shows writes
// (support reads only; the API refuses writes regardless).
export default async function AdminOffersPage() {
  const jar = await cookies();
  // S34 (OP10): an operator passes only under an active support grant (support role)
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "offers.read")) return <NoAccess role={actor.role} page />;
  const { offers, names, currency, timezone } = await tfetch(async () => {
    const offers = await listOffers();
    const [names, currency] = await Promise.all([offerTargetNames(offers.flatMap((o) => [o.config, o.previous?.config].filter(Boolean))), storeCurrency()]);
    return { offers, names, currency, timezone: merchantTz() };
  });
  return <OffersList initialOffers={offers} initialNames={names} currency={currency} timezone={timezone} role={actor.role} canWrite={roleAllows(actor.role, "offers.write")} />;
}
