import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { listReleases, getLiveRelease, snapshotContent, validateRelease, releaseDiff } from "@/lib/releases";
import ReleasesAdmin from "@/components/admin/ReleasesAdmin";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/console-request";
import { getCmsMode, DOCUMENTS_MESSAGE } from "@/lib/cms-mode";

export const dynamic = "force-dynamic";
export const metadata = { title: "Publishing · Admin", robots: { index: false } };

export default async function AdminReleasesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  // S55: edit ≠ publish — storefront.publish is admin+ (staff drafts, admin
  // flips live). Computed HERE (server) so the client stays authz-free; the
  // API re-gates every action regardless.
  const canPublish = actor.kind === "bootstrap" ? true : roleAllows(actor.role, "storefront.publish");

  // P2-GUARD: a store on the new editor (or whose live release is a documents
  // list) publishes from the editor; this legacy panel would show a
  // meaningless diff and offer actions the API refuses.
  const documents = await tfetch(async () => {
    const [mode, live] = await Promise.all([getCmsMode(), getLiveRelease()]);
    return mode !== "legacy" || live?.documents ? { mode, live } : null;
  });
  if (documents) {
    return (
      <>
        <PageHeader title="Publishing" description="Review and publish your store's changes." />
        {/* plain markup, not <Banner>: scripts/test-console-fresh.js loads this page with require() */}
        <div className="rounded-ctl border border-info-edge bg-info-bg px-3.5 py-2.5 text-sm text-info" data-documents-mode="">
          <p className="font-semibold">{DOCUMENTS_MESSAGE}</p>
          <p className="mt-0.5 text-[13px] leading-snug">Publish each page from the editor. This page only works for stores on the old editor.</p>
        </div>
      </>
    );
  }

  // Same shape as GET /api/admin/releases (the client refreshes from that
  // view after every action, so the two must stay aligned — incl. `diff`).
  const initial = await tfetch(async () => {
    const [list, live, snap, diff] = await Promise.all([listReleases({ limit: 20 }), getLiveRelease(), snapshotContent(), releaseDiff()]);
    const validation = await validateRelease(snap.content, { live: live?.content ?? null });
    return { ...list, liveHash: live?.content_hash || null, draftHash: snap.hash, dirty: !live || live.content_hash !== snap.hash, diff, validation };
  });

  return (
    <>
      <PageHeader
        title="Publishing"
        description="Edits stay draft until you publish an immutable release. Preview shows drafts to you only; rollback flips live back without touching drafts."
      />
      <ReleasesAdmin initial={initial} canPublish={canPublish} />
    </>
  );
}
