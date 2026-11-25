import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { platformConfigured } from "@/lib/platform/control";
import { currentTenant } from "@/lib/tenant-context.js";
import { teamView } from "@/lib/admin/team";
import { tfetch } from "@/lib/console-request";
import { TeamPage, TeamNoAccess } from "@/components/admin/team/TeamPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team · Admin", robots: { index: false } };

// The team screen on the new UI (Phase 2 line 8). Gated on team.manage: staff and support get the
// no-access page and the team is never read for them. The view is read fresh
// on every request (nothing caches a role), so after a transfer the reload
// renders the page for the caller's new role. A failed read hands the screen
// null: it shows the error with Try again.
export default async function AdminTeamPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "team.manage")) return <TeamNoAccess />;

  const { supported, initial, storeName } = await tfetch(async () => {
    const tenant = currentTenant();
    if (!tenant || tenant.id === "_default" || !platformConfigured()) return { supported: false, initial: null, storeName: null };
    try {
      return { supported: true, initial: await teamView(tenant.id, actor), storeName: tenant.name || tenant.id };
    } catch {
      return { supported: true, initial: null, storeName: tenant.name || tenant.id };
    }
  });
  return <TeamPage initial={initial} supported={supported} role={actor.role} storeName={storeName} />;
}
