import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { listMedia, mediaUrl } from "@/lib/media";
import { siteName } from "@/lib/site";
import AdminNav from "@/components/admin/AdminNav";
import MediaAdmin from "@/components/admin/MediaAdmin";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Media · Admin", robots: { index: false } };

// Media library (S38 / MC12): upload, alt text, copy-URL, safe delete.
export default async function AdminMediaPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [media, name] = await tfetch(async () => {
    let rows = [];
    try {
      rows = (await listMedia()).map((m) => ({ ...m, url: mediaUrl(m.id) }));
    } catch {
      rows = []; // pre-migration tenant
    }
    return [rows, siteName()];
  });

  return (
    <>
      <AdminNav storeName={name} />
      <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
        <h1 className="text-2xl font-bold">Media</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Images for banners, rich text and pages. Files are validated and stored with your store&rsquo;s data; a
          small preview size is generated on upload. Paste a file&rsquo;s URL anywhere content accepts an image.
        </p>
        <div className="mt-5">
          <MediaAdmin initial={media} readOnly={actor.role === "support"} />
        </div>
      </div>
    </>
  );
}
