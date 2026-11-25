import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { roleAllows } from "@/lib/platform/authz";
import { getOfferRow, listOffers } from "@/lib/offers/store";
import { offerTargetNames, storeCurrency } from "@/lib/offers/catalog";
import { merchantTz } from "@/lib/reporting";
import { OfferEditor } from "@/components/admin/offers/OfferEditor";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offer · Admin", robots: { index: false } };

// Phase 2 line 4: one offer ("new" is the create form). An unknown id is a
// not-found; a bundle's own offer opens its bundle (it is changed there).
// Support reads the offer with every field disabled; "new" is for writers only.
export default async function AdminOfferPage({ params }) {
  const { id } = await params;
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "offers.read")) return <NoAccess role={actor.role} page />;
  const canWrite = roleAllows(actor.role, "offers.write");
  if (id === "new" && !canWrite) redirect("/admin/offers");
  const data = await tfetch(async () => {
    const offers = await listOffers();
    const existing = id === "new" ? null : await getOfferRow(id);
    if (id !== "new" && !existing) return null;
    const configs = offers.flatMap((o) => [o.config, o.previous?.config].filter(Boolean));
    const [names, currency] = await Promise.all([offerTargetNames(configs), storeCurrency()]);
    return { offers, existing, names, currency, timezone: merchantTz() };
  });
  if (!data) notFound();
  if (data.existing?.type === "BUNDLE") redirect(`/admin/bundles/${encodeURIComponent(String(data.existing.id).replace(/^bundle-/, ""))}`);
  return <OfferEditor existing={data.existing} offers={data.offers} names={data.names} currency={data.currency} timezone={data.timezone} role={actor.role} canWrite={canWrite} />;
}
