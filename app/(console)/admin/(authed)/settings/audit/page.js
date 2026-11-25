import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { AuditTable } from "@/components/admin/settings/AuditTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log · Settings · Admin", robots: { index: false } };

// Settings → Audit log (Phase 2 line 7): gated on audit.read; the rows are read
// in the browser from GET /api/admin/audit (paged and filtered there).
export default async function SettingsAuditPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "audit.read")) return <NoAccess role={actor.role} />;
  return (
    <>
      <h2 className="mb-4 text-[1.125rem] font-semibold">Audit log</h2>
      <AuditTable />
    </>
  );
}
