import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listInsights, aiBudget, aiConfigured, AI_MODEL } from "@/lib/ai/insights";
import InsightsAdmin from "@/components/admin/InsightsAdmin";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights · Admin", robots: { index: false } };

// PageHeader renders inside the client component — its action (Generate,
// with its busy "Thinking…" state) is client-interactive.
export default async function AdminInsightsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const initial = await tfetch(async () => ({
    ok: true,
    configured: aiConfigured(),
    model: AI_MODEL(),
    budget: await aiBudget(),
    insights: await listInsights(),
  }));
  return <InsightsAdmin initial={initial} />;
}
