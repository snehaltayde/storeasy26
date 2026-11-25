import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listExperiments } from "@/lib/experiments";
import { tfetch } from "@/lib/console-request";
import { ExperimentsList } from "@/components/admin/experiments/ExperimentsList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Experiments · Admin", robots: { index: false } };

// Experiments on the new UI (Phase 2 line 9). Every role reads the list (storefront.read); the
// screen gets the caller's role and hides "New experiment" from a role
// without storefront.write. A failed read hands the screen null (Try again).
export default async function AdminExperimentsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const experiments = await tfetch(async () => {
    try {
      return await listExperiments();
    } catch {
      return null;
    }
  });
  return <ExperimentsList initial={experiments} role={actor.role} />;
}
