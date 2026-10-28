import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listMedia, mediaUrl } from "@/lib/media";
import MediaAdmin from "@/components/admin/MediaAdmin";
import { tfetch } from "@/lib/tenant-request";
import { PageHeader } from "@/components/console/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Media · Admin", robots: { index: false } };

// Media library (S38 / MC12, redesigned S50): upload, alt text, copy-URL,
// safe delete.
export default async function AdminMediaPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const media = await tfetch(async () => {
    try {
      return (await listMedia()).map((m) => ({ ...m, url: mediaUrl(m.id) }));
    } catch {
      return []; // pre-migration tenant
    }
  });

  return (
    <>
      <PageHeader
        title="Media"
        description="Images for banners, rich text and pages. Files are validated and stored with your store’s data; a small preview size is generated on upload. Paste a file’s URL anywhere content accepts an image."
      />
      <MediaAdmin initial={media} readOnly={actor.role === "support"} />
    </>
  );
}
