import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listExperiments } from "@/lib/experiments";
import ExperimentsAdmin from "@/components/admin/ExperimentsAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Experiments · Admin", robots: { index: false } };

// PageHeader renders inside the client component — its actions are
// client-interactive (the "New experiment" form toggle).
export default async function AdminExperimentsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const experiments = await tfetch(() => listExperiments());
  return <ExperimentsAdmin initial={experiments} />;
}
