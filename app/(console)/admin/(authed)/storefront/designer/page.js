import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { tfetch } from "@/lib/console-request";
import Designer from "@/components/admin/cms/Designer";

// S55 / audit slice 3: the HOME-PAGE DESIGNER — section tree, click-to-select
// storefront preview, registry-driven inspector. Same guard + view load as the
// Home page editor; the PageHeader lives inside the client component because
// its actions (Save, the dirty status line) are client state.
export const dynamic = "force-dynamic";
export const metadata = { title: "Designer · Admin", robots: { index: false } };

export default async function StorefrontDesignerPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const initial = await tfetch(() => storefrontView());

  return <Designer initial={initial} />;
}
