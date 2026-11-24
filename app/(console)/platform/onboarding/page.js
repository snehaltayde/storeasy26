import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import OnboardingOps from "@/components/platform/onboarding/OnboardingOps";

// Phase 1 line 8: every signup and each store's onboarding step, and the help
// an operator can give a stuck store, on one screen. Operators only; anyone
// else goes to /platform (which shows the sign-in). Built on components/ui,
// outside any [data-legacy] region. Data loads client-side through
// /api/platform/onboarding.
export const dynamic = "force-dynamic";
export const metadata = { title: "Signups & onboarding · Storeasy platform", robots: { index: false } };

export default async function OnboardingPage() {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return <OnboardingOps />;
}
