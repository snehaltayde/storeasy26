import { redirect } from "next/navigation";

// Phase 1 line 3: "Start your store" is the onboarding page's Brand step.
export default function StartPage() {
  redirect("/admin/onboarding?step=brand");
}
