import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Phase 1 line 7: on Settings and Billing when the founder came from
// onboarding step 4 (?from=onboarding). It goes back to that step; the page
// reads the steps again when it opens.
export const BACK_HREF = "/admin/onboarding?step=open";
export const BACK_WORDS = "Back to onboarding";
export const fromOnboarding = (sp) => sp?.from === "onboarding";

export default function BackToOnboarding() {
  return (
    <p className="mb-4 text-sm" data-onboarding="back">
      <Link href={BACK_HREF} className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <ArrowLeft aria-hidden className="size-4" />
        {BACK_WORDS}
      </Link>
    </p>
  );
}
