import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { signupStoreDomain } from "@/lib/platform/signup";
import CreateStoreForm from "@/components/platform/stores/CreateStoreForm";

// Phase 1 line 9: an operator creates a store for a founder in one form; the
// founder gets an invite into the same onboarding. Operators only; anyone else
// goes to /platform (which shows the sign-in). Built on components/ui, outside
// any [data-legacy] region. ?signup=sgn_… shows that setup's progress.
export const dynamic = "force-dynamic";
export const metadata = { title: "New store · Storeasy platform", robots: { index: false } };

export default async function NewStorePage() {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return (
    <Suspense>
      <CreateStoreForm storeDomain={signupStoreDomain() || "your-store-domain"} />
    </Suspense>
  );
}
