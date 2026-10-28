import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { buildBillingView } from "@/lib/admin/billing-view";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import BillingAdmin from "@/components/admin/BillingAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing · Admin", robots: { index: false } };

// Billing tab (S40 / MC24): plan, subscription state (grace/degraded shown
// honestly), quotas with pre-limit warnings, charge history, plan changes.
export default async function AdminBillingPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const name = await tfetch(() => siteName());
  if (!roleAllows(actor.role, "settings.read")) {
    return (
      <>
        <AdminNav storeName={name} />
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="mt-4 rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
            Your role ({actor.role}) can&rsquo;t view billing — ask an owner or admin.
          </p>
        </div>
      </>
    );
  }

  const initial = await tfetch(buildBillingView);

  return (
    <>
      <AdminNav storeName={name} />
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Your plan, usage and charges. Numbers come from the payment provider&rsquo;s confirmed events — never
          estimates.
        </p>
        <div className="mt-5">
          <BillingAdmin initial={initial} />
        </div>
      </div>
    </>
  );
}
