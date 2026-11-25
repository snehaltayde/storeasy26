import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listAutomations, automationRuns, automationsDisabled, AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from "@/lib/automations";
import { tfetch } from "@/lib/console-request";
import { roleAllows } from "@/lib/platform/authz";
import { PageHeader } from "@/components/kit/page-header";
import { PermissionNote, RulesList } from "@/components/admin/automations/RulesList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations · Admin", robots: { index: false } };

// Automations on the new UI (Phase 2 line 9; lib/admin/new-ui-routes.js lists
// /admin/automations). Admins and owners only: rules can email customers, so
// a role without settings.read (staff, support) gets the no-access note and
// no rule, run or setting is read for it (Phase 0 line 2, S2).
export default async function AdminAutomationsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) {
    return (
      <>
        <PageHeader title="Automations" />
        <PermissionNote role={actor.role} />
      </>
    );
  }
  const initial = await tfetch(async () => ({
    disabled: await automationsDisabled(),
    automations: await listAutomations(),
    runs: await automationRuns({ limit: 30 }),
    triggers: AUTOMATION_TRIGGERS,
    actions: AUTOMATION_ACTIONS,
  }));
  return <RulesList initial={initial} role={actor.role} />;
}
