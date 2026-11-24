import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { currentTenant } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import { getLiveReleaseState } from "@/lib/releases";
import { tfetch } from "@/lib/console-request";
import Welcome from "@/components/admin/onboarding/Welcome";

// Phase 1 line 1: where a founder lands after signing up (the handoff signs
// them in here). "Welcome to {store}", its address, whether shoppers can see
// it yet, the signed-in email and the next step in honest words. Line 3 grows
// this into the four onboarding steps. Every role reads it; nothing here writes.
//   storeName   the store's name
//   address     the store's own address (its first domain)
//   open        a live release exists (its first publish); before that shoppers see "Opening soon"
//   account     the signed-in member's own email and whether it is verified;
//               null for an operator's support session (no member row)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Welcome · Admin", robots: { index: false } };

export default async function OnboardingPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value)).catch(() => null);
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "storefront.read")) redirect("/admin/dashboard");

  const [storeName, address, open] = await tfetch(async () => {
    const live = await getLiveReleaseState().catch(() => null);
    return [await siteName(), currentTenant()?.domains?.[0] || null, live?.state === "live"];
  });
  let account = null;
  if (actor.kind === "merchant") {
    const { getUser } = await import("@/lib/platform/identity");
    const u = await getUser(actor.id).catch(() => null);
    if (u) account = { email: u.email || null, verified: Boolean(u.email_verified_at) };
  }
  return <Welcome storeName={storeName} address={address} open={open} account={account} />;
}
