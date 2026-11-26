import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { copilotView } from "@/lib/ai/view";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { CopilotTasks } from "@/components/admin/copilot/CopilotTasks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Copilot · Admin", robots: { index: false } };

// The AI copilot (Phase 9 line 5). Every role reads it (storefront.read):
// today's budget and the last runs; the run buttons follow storefront.write
// (starter, SEO and FAQs) and offers.write (offer ideas). A failed read hands
// the screen null (Try again).
export default async function AdminCopilotPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "storefront.read")) return <NoAccess role={actor.role} page />;
  const initial = await tfetch(async () => {
    try {
      return await copilotView(actor.role);
    } catch {
      return null;
    }
  });
  return <CopilotTasks initial={initial} role={actor.role} />;
}
