import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listExperiments } from "@/lib/experiments";
import { siteName } from "@/lib/site";
import ExperimentsAdmin from "@/components/admin/ExperimentsAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Experiments · Admin", robots: { index: false } };

export default async function AdminExperimentsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const [experiments, name] = await tfetch(async () => [await listExperiments(), siteName()]);
  return (
    <>
      <ExperimentsAdmin initial={experiments} />
    </>
  );
}
