import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { MEDIA_MIME } from "@/lib/media";
import { listLibrary } from "@/lib/admin/media-library";
import { tfetch } from "@/lib/console-request";
import { MediaLibrary } from "@/components/admin/media/MediaLibrary";

export const dynamic = "force-dynamic";
export const metadata = { title: "Media · Admin", robots: { index: false } };

// The media screen on the new UI (Phase 2 line 5; lib/admin/new-ui-routes.js
// lists /admin/media). The first page of the library comes from the server;
// a failed read hands the screen null, and it shows the error with Try again.
// The screen gets the caller's role and the upload limits, nothing a write
// needs: support's view has no write control at all.
export default async function AdminMediaPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(async () => {
    try {
      return await listLibrary({ archived: "active", sort: "newest" });
    } catch {
      return null;
    }
  });
  const limits = Object.fromEntries(Object.entries(MEDIA_MIME).map(([k, v]) => [k, v.max]));
  return <MediaLibrary initial={initial} role={actor.role} limits={limits} />;
}
