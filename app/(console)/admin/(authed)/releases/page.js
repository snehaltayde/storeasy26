import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { PageHeader } from "@/components/kit/page-header";
import { tfetch } from "@/lib/console-request";
import PublishingPage from "@/components/admin/releases/PublishingPage";

// Publishing (PUB-04; Phase 2 line 6): the pages waiting to publish, with
// Publish selected, and what went live recently, with Undo. The page reads
// nothing but the actor: both lists come from the documents API in the
// browser (which refuses a store not in documents mode). access: who may
// publish (storefront.publish); everyone else reads the reason, with no
// Publish, Undo or selection.
export const dynamic = "force-dynamic";
export const metadata = { title: "Publishing · Admin", robots: { index: false } };

const STAFF_REASON = "Only the store owner or an admin can publish or undo. You can edit and preview.";
const READ_ONLY_REASON = "You can look at what is waiting and what was published, but not publish or undo.";

export default async function AdminReleasesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const canPublish = actor.kind === "bootstrap" ? true : roleAllows(actor.role, "storefront.publish");
  const canWrite = actor.kind === "bootstrap" ? true : roleAllows(actor.role, "storefront.write");
  const access = { canPublish, reason: canPublish ? null : canWrite ? STAFF_REASON : READ_ONLY_REASON };

  return (
    <div className="space-y-6">
      <PageHeader title="Publishing" description="Pages with changes waiting to go live, and what went live recently. Undo puts a page back the way it was." />
      <PublishingPage access={access} />
    </div>
  );
}
