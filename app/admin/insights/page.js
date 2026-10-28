import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listInsights, aiBudget, aiConfigured, AI_MODEL } from "@/lib/ai/insights";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import InsightsAdmin from "@/components/admin/InsightsAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights · Admin", robots: { index: false } };

export default async function AdminInsightsPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const [initial, name] = await tfetch(async () => [
    { ok: true, configured: aiConfigured(), model: AI_MODEL(), budget: await aiBudget(), insights: await listInsights() },
    siteName(),
  ]);
  return (
    <>
      <AdminNav storeName={name} />
      <InsightsAdmin initial={initial} />
    </>
  );
}
