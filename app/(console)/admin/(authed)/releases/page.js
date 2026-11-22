import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getCmsMode, MIGRATING_MESSAGE } from "@/lib/cms-mode";
import { roleAllows } from "@/lib/platform/authz";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/console-request";
import { PublishingHistory } from "@/components/admin/editor/DocumentEditor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Publishing · Admin", robots: { index: false } };

export default async function AdminReleasesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const cmsMode = await tfetch(() => getCmsMode().catch(() => "documents"));
  if (cmsMode === "migrating") {
    return (
      <>
        <PageHeader title="Publishing" description="What went live recently, and Undo. Publish each page from the editor." />
        <div data-documents-mode="" className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-950">
          {MIGRATING_MESSAGE}
        </div>
      </>
    );
  }

  const canPublish = actor.kind === "bootstrap" ? true : roleAllows(actor.role, "storefront.publish");
  const access = {
    canPublish,
    reason: canPublish ? null : "Only the store owner or an admin can publish or undo. You can edit and preview.",
  };

  return (
    <>
      <PageHeader title="Publishing" description="What went live recently, and Undo. Publish each page from the editor." />
      <div data-documents-mode="" data-recently-published-page="">
        <PublishingHistory access={access} />
      </div>
    </>
  );
}
