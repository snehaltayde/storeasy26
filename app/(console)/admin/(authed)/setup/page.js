import { redirect } from "next/navigation";

// Phase 1 line 3: the setup checklist became the four-step onboarding page.
export default function AdminSetupPage() {
  redirect("/admin/onboarding");
}
