import { redirect } from "next/navigation";
import { currentTenant } from "@/lib/tenant-context";
import { getLiveReleaseState } from "@/lib/releases";
import { tfetch } from "@/lib/console-request";

// Phase 1 line 3: /admin is where login, accept-invite and signup land. A
// store that is not open yet goes to its onboarding; an open store (or the
// _default store, set up from its environment config) to the dashboard. A read
// that fails goes to the dashboard (it never guesses the store is closed).
export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const closed = await tfetch(async () => {
    const t = currentTenant();
    if (!t || t.id === "_default") return false;
    const live = await getLiveReleaseState().catch(() => null);
    return live?.state === "none";
  }).catch(() => false);
  redirect(closed ? "/admin/onboarding" : "/admin/dashboard");
}
