import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { settingsView } from "@/lib/admin/settings";
import { paymentItem } from "@/lib/documents/opening";
import { currentTenant } from "@/lib/tenant-context";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { CheckoutForm } from "@/components/admin/settings/CheckoutForm";
import { smsAvailable } from "@/lib/messaging/sms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checkout and payments · Settings · Admin", robots: { index: false } };

// Settings → Checkout and payments (Phase 2 line 7). The payment line comes
// from the open checks' payment item (its words only; a failed read shows none).
export default async function SettingsCheckoutPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return <NoAccess role={actor.role} />;
  const [v, payment] = await tfetch(async () => {
    let p = null;
    try {
      const it = paymentItem();
      p = { level: it.level, title: it.title, message: it.message };
    } catch {}
    return [settingsView(currentTenant()), p];
  });
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Checkout and payments</h2>
      <CheckoutForm
        initial={{ readOnly: v.readOnly, commerce: { checkout_mode: v.commerce.checkout_mode, timezone: v.commerce.timezone }, payments: v.payments, payment, payment_config: v.payment_config, shipping: v.shipping, smsAvailable: smsAvailable() }}
        role={actor.role}
      />
    </>
  );
}
