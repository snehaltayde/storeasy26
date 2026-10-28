import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listReleases, getLiveRelease, snapshotContent, validateRelease } from "@/lib/releases";
import { siteName } from "@/lib/site";
import ReleasesAdmin from "@/components/admin/ReleasesAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Releases · Admin", robots: { index: false } };

export default async function AdminReleasesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [initial, name] = await tfetch(async () => {
    const [list, live, snap] = await Promise.all([listReleases({ limit: 20 }), getLiveRelease(), snapshotContent()]);
    const validation = await validateRelease(snap.content);
    return [{ ...list, liveHash: live?.content_hash || null, draftHash: snap.hash, dirty: !live || live.content_hash !== snap.hash, validation }, siteName()];
  });

  return (
    <>
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Releases</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Publishing discipline for your storefront: edits stay draft until you publish an immutable
          release. Preview shows drafts to you only; rollback flips live back without touching drafts.
        </p>
        <div className="mt-5">
          <ReleasesAdmin initial={initial} />
        </div>
      </div>
    </>
  );
}
