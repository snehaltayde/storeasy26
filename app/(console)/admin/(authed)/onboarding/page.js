import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { currentTenant } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";
import { onboardingFor } from "@/lib/onboarding/service";
import { resumeStep } from "@/lib/onboarding/steps";
import { EDITOR_PUBLISH_HREF } from "@/lib/admin/editor-entry";
import Welcome from "@/components/admin/onboarding/Welcome";
import Onboarding from "@/components/admin/onboarding/Onboarding";

// Phase 1 lines 1 and 3: where a founder lands while the store is closed.
// The Welcome card (store name, address, Closed/Open, the signed-in email),
// then the four steps of lib/onboarding/steps.js, worked out from real store
// state on every read. Every role reads it; a control the role can't use is
// shown disabled with the reason (the model's actions carry it).
//   ?step=<connect|import|brand|open>  opens on that step; anything else is
//   ignored and the page opens on the first step not done.
// The _default store (environment config) and a store still on the old editor
// get the card and one sentence (the model's words, else DEFAULT_STORE_WORDS).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Onboarding · Admin", robots: { index: false } };

export const DEFAULT_STORE_WORDS = "This store is set up from its environment config, so there are no onboarding steps here.";

export default async function OnboardingPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value)).catch(() => null);
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "storefront.read")) redirect("/admin/dashboard");
  const sp = await searchParams;

  const [storeName, address, model] = await tfetch(async () => [await siteName(), currentTenant()?.domains?.[0] || null, await onboardingFor(actor)]);
  let account = null;
  if (actor.kind === "merchant") {
    const { getUser } = await import("@/lib/platform/identity");
    const u = await getUser(actor.id).catch(() => null);
    if (u) account = { email: u.email || null, verified: Boolean(u.email_verified_at) };
  }
  const welcome = <Welcome storeName={storeName} address={address} open={model.open} account={account} />;

  if (!model.supported) {
    return (
      <div data-onboarding="column" className="mx-auto w-full max-w-[640px] min-w-0 space-y-8">
        {welcome}
        <div className="space-y-3 border-t border-border pt-6">
          <p data-onboarding="default-store" className="text-sm text-foreground">
            {model.words || DEFAULT_STORE_WORDS}
          </p>
          <p className="text-sm">
            <Link href="/admin/dashboard" className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              Go to your dashboard
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return <Onboarding initial={model} initialStep={resumeStep(sp?.step, model)} canSync={roleAllows(actor.role, "sync.run")} publishHref={EDITOR_PUBLISH_HREF} welcome={welcome} store={{ name: storeName, address }} />;
}
