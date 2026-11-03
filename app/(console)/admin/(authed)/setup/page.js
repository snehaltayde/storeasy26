import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { buildChecklist } from "@/lib/admin/onboarding";
import SetupAdmin from "@/components/admin/SetupAdmin";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup · Admin", robots: { index: false } };

// Onboarding checklist (S41 / MC02): connect → catalog → brand → policies →
// billing → domain → preview → test order → launch, resumable and honest.
export default async function AdminSetupPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(() => buildChecklist());

  return (
    <>
      <PageHeader
        title="Setup"
        description="Everything between here and your first sale. Most steps tick themselves off as the work lands; the last three are your call."
      />
      <SetupAdmin initial={initial} />
    </>
  );
}
