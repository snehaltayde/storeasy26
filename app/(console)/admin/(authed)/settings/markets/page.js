import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { currentTenant } from "@/lib/tenant-context";
import { tfetch } from "@/lib/console-request";
import { baseCountry, baseCurrency, countryName } from "@/lib/markets";
import { RAZORPAY_CURRENCIES } from "@/lib/money";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { MarketsForm } from "@/components/admin/settings/MarketsForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Markets · Settings · Admin", robots: { index: false } };

// Settings → Markets (Phase 8 line 4). Markets set what shoppers abroad are
// charged, so the tab is settings.write (admin, owner): support and staff get
// the no-access page and no market data. Saved through PUT /api/admin/settings
// { markets }, audited as settings.write with the rate changes.
export default async function SettingsMarketsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.write")) return <NoAccess role={actor.role} />;
  const initial = await tfetch(async () => {
    const t = currentTenant();
    const cfg = t?.config || {};
    const country = baseCountry(cfg);
    return {
      readOnly: !t || t.id === "_default",
      base: { country, name: countryName(country), currency: baseCurrency(cfg) },
      markets: Array.isArray(cfg.markets) ? cfg.markets : [],
      currencies: RAZORPAY_CURRENCIES.filter((c) => c !== baseCurrency(cfg)),
      razorpayKeys: Boolean(cfg.razorpay_key_id),
    };
  });
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Markets</h2>
      <MarketsForm initial={initial} role={actor.role} />
    </>
  );
}
