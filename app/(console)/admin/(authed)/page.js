import { redirect } from "next/navigation";
import { currentTenant } from "@/lib/tenant-context";
import { liveOpen } from "@/lib/onboarding/service";
import { getCmsMode } from "@/lib/cms-mode";
import { tfetch } from "@/lib/console-request";

// Phase 1 line 3: /admin is where login, accept-invite and signup land. A
// store that is not open yet goes to its onboarding; an open store, the
// _default store (set up from its environment config) or a store still on the
// old editor (it has no onboarding steps) to the dashboard. A read that fails
// goes to the dashboard (it never guesses the store is closed).
export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const closed = await tfetch(async () => {
    const t = currentTenant();
    if (!t || t.id === "_default") return false;
    if ((await liveOpen().catch(() => null)) !== false) return false;
    return (await getCmsMode().catch(() => null)) !== "legacy";
  }).catch(() => false);
  redirect(closed ? "/admin/onboarding" : "/admin/dashboard");
}
