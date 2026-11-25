import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import OpenGrants from "@/components/platform/support/OpenGrants";

// Phase 3 line 5: every open support grant across stores, with Close.
// Operators only; anyone else goes to /platform (which shows the sign-in).
// Data loads client-side through /api/platform/support?view=open.
export const dynamic = "force-dynamic";
export const metadata = { title: "Support access · Storeasy platform", robots: { index: false } };

export default async function SupportAccessPage() {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return <OpenGrants />;
}
