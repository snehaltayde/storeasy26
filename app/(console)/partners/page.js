import { cookies } from "next/headers";
import { agencyFromToken, AGENCY_COOKIE } from "@/lib/platform/agency";
import PartnersConsole from "@/components/partners/PartnersConsole";
import PartnersLogin from "@/components/partners/PartnersLogin";

// Agency workspace (S48 / AG01–06, redesigned S50): portfolio of GRANTED
// stores only, client invitations, scrubbed kits, hash-bound approvals,
// referrals, reports. Signed-out renders as a centered auth card, matching
// the admin (auth) shell.
export const dynamic = "force-dynamic";
export const metadata = { title: "Partner console", robots: { index: false } };

export default async function PartnersPage() {
  const jar = await cookies();
  const actor = await agencyFromToken(jar.get(AGENCY_COOKIE)?.value).catch(() => null);
  if (!actor) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
        <div className="mb-6 text-center">
          <p className="text-lg font-semibold tracking-tight text-fg">Partner console</p>
          <p className="text-xs text-fg-subtle">
            Agency workspace · powered by Store<span className="font-semibold text-caccent">asy</span>
          </p>
        </div>
        <div className="w-full max-w-sm rounded-card border border-edge bg-surface p-6 shadow-card">
          <PartnersLogin />
        </div>
      </div>
    );
  }
  return <PartnersConsole agency={actor.agency} email={actor.email} />;
}
