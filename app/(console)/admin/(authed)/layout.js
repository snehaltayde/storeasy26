import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";
import { ConsoleShell } from "@/components/console/nav/ConsoleShell";

// Authed admin shell (S50): ONE auth gate + ONE sidebar mount for all 18
// screens (pages keep their own adminActor guards — defense in depth, no
// contract change). Nav badges are best-effort: a failed count never
// breaks the console.
export default async function AdminAuthedLayout({ children }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value)).catch(() => null);
  if (!actor) redirect("/admin/login");

  const [name, host, badges] = await tfetch(async () => {
    const badges = {};
    try {
      const { listReturns } = await import("@/lib/returns");
      const open = (await listReturns({ status: "requested" })).length;
      if (open > 0) badges.returns = open;
    } catch {}
    try {
      const { buildChecklist } = await import("@/lib/admin/onboarding");
      const c = await buildChecklist();
      if (c?.supported && !c.launched) badges.setup = `${c.doneCount}/${c.total}`;
    } catch {}
    try {
      // S52: unpublished-changes dot on Publishing (hash compare, cheap).
      // P2-GUARD: in documents mode, one count over documents_dirty instead.
      const { publishingBadge } = await import("@/lib/releases");
      const publish = await publishingBadge();
      if (publish) badges.publish = publish;
    } catch {}
    return [siteName(), currentTenant()?.domains?.[0] || null, badges];
  }).catch(() => ["Store", null, {}]);

  return (
    <ConsoleShell storeName={name} host={host} role={actor.role} actorKind={actor.kind} badges={badges}>
      {children}
    </ConsoleShell>
  );
}
