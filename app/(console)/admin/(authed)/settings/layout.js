import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { SETTINGS_SECTIONS } from "@/lib/admin/settings-sections";
import { tfetch } from "@/lib/console-request";
import { SettingsTitle, SettingsColumn } from "@/components/admin/settings/SettingsFrame";
import { SettingsNav } from "@/components/admin/settings/SettingsNav";
import { HashRedirect } from "@/components/admin/settings/HashRedirect";

// Settings on the new UI (Phase 2 line 7, docs/plans/phase-2.md): one tab per
// part under this layout, with the section nav from lib/admin/settings-sections.js
// (only the tabs the role may open). A role without settings.read gets the
// page's own no-access words and no nav: every tab page gates itself, since
// a page renders whether or not its layout shows it.
export default async function SettingsLayout({ children }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value)).catch(() => null);
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "settings.read")) return children;
  const sections = SETTINGS_SECTIONS.filter((s) => roleAllows(actor.role, s.action)).map(({ id, label, href }) => ({ id, label, href }));
  return (
    <>
      <HashRedirect />
      <SettingsTitle />
      <div className="grid gap-6 lg:grid-cols-[208px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <SettingsNav sections={sections} />
        </aside>
        <SettingsColumn>{children}</SettingsColumn>
      </div>
    </>
  );
}
