import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import FlagsScreen from "@/components/platform/flags/FlagsScreen";

// Phase 3 line 4: the operator's feature flags, on components/ui inside the operator
// shell. Operators only; anyone else goes to /platform (which shows the
// sign-in). Data loads client-side through /api/platform/flags.
export const dynamic = "force-dynamic";
export const metadata = { title: "Feature flags · Storeasy platform", robots: { index: false } };

export default async function FlagsPage() {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return <FlagsScreen />;
}
