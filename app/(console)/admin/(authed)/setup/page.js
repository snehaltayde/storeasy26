import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { buildChecklist } from "@/lib/admin/onboarding";
import { siteName } from "@/lib/site";
import SetupAdmin from "@/components/admin/SetupAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup · Admin", robots: { index: false } };

// Onboarding checklist (S41 / MC02): connect → catalog → brand → policies →
// billing → domain → preview → test order → launch, resumable and honest.
export default async function AdminSetupPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [initial, name] = await tfetch(async () => [await buildChecklist(), siteName()]);

  return (
    <>
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Setup</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Everything between here and your first sale. Most steps tick themselves off as the work lands; the
          last three are your call.
        </p>
        <div className="mt-5">
          <SetupAdmin initial={initial} />
        </div>
      </div>
    </>
  );
}
