import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { listInsights, aiBudget, aiConfigured } from "@/lib/ai/insights";
import { tfetch } from "@/lib/console-request";
import { InsightsList } from "@/components/admin/insights/InsightsList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights · Admin", robots: { index: false } };

// Insights on the new UI (Phase 2 line 9). Every role reads them (storefront.read); the screen gets
// the caller's role and hides Generate, Apply, Dismiss and Restore from a
// role without storefront.write. A failed read hands the screen null (Try again).
export default async function AdminInsightsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const initial = await tfetch(async () => {
    try {
      return { configured: aiConfigured(), budget: await aiBudget(), insights: await listInsights() };
    } catch {
      return null;
    }
  });
  return <InsightsList initial={initial} role={actor.role} />;
}
