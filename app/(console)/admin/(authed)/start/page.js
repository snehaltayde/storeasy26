import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getCmsMode } from "@/lib/cms-mode";
import { roleAllows } from "@/lib/platform/authz";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";
import { Banner } from "@/components/console/Banner";
import FirstRun from "@/components/admin/first-run/FirstRun";

// P6-START-UI (GEN-01, GEN-04, US-01, US-04): "Start your store". The store
// made from the founder's catalog (what was made, what was kept, where to
// change it) and the brand step (colours, logo, one-line description). The
// client parts read and write through /api/admin/first-run and
// /api/admin/brand-step; this page only decides who sees what:
//   signed out        the login page
//   legacy store      Setup (its own checklist and brand screens stay as they are)
//   moving store      a note; nothing to do here until the move is done
//   documents store   the page. A role that can't edit (storefront.write)
//                     reads it and never writes; running a sync needs sync.run.
// Reachable any time, also after the store opens.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Start your store · Admin", robots: { index: false } };

export default async function StartPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const mode = await tfetch(() => getCmsMode());
  if (mode === "legacy") redirect("/admin/setup");

  const header = <PageHeader title="Start your store" description="Your store, made from your products. Change anything, then open it when you're ready." />;
  if (mode !== "documents") {
    return (
      <>
        {header}
        <Banner tone="info" title="Your store is being updated">
          <p>Your store is moving to the new editor right now. Come back in a few minutes.</p>
        </Banner>
      </>
    );
  }

  return (
    <>
      {header}
      <FirstRun canEdit={roleAllows(actor.role, "storefront.write")} canSync={roleAllows(actor.role, "sync.run")} />
    </>
  );
}
