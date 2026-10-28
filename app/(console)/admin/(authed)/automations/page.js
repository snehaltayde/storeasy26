import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listAutomations, automationRuns, automationsDisabled, AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from "@/lib/automations";
import AutomationsAdmin from "@/components/admin/AutomationsAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations · Admin", robots: { index: false } };

// PageHeader renders inside the client component — its actions are
// client-interactive (disable-all confirm, the "New rule" form toggle).
export default async function AdminAutomationsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const initial = await tfetch(async () => ({
    ok: true,
    disabled: await automationsDisabled(),
    automations: await listAutomations(),
    runs: await automationRuns({ limit: 30 }),
    triggers: AUTOMATION_TRIGGERS,
    actions: AUTOMATION_ACTIONS,
  }));
  return <AutomationsAdmin initial={initial} />;
}
