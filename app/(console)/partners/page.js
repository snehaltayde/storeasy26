import { cookies } from "next/headers";
import { agencyFromToken, AGENCY_COOKIE } from "@/lib/platform/agency";
import PartnersConsole from "@/components/partners/PartnersConsole";
import PartnersLogin from "@/components/partners/PartnersLogin";

// Agency workspace (S48 / AG01–06): portfolio of GRANTED stores only, client
// invitations, scrubbed kits, hash-bound approvals, referrals, reports.
export const dynamic = "force-dynamic";
export const metadata = { title: "Partner console", robots: { index: false } };

export default async function PartnersPage() {
  const jar = await cookies();
  const actor = await agencyFromToken(jar.get(AGENCY_COOKIE)?.value).catch(() => null);
  if (!actor) return <PartnersLogin />;
  return <PartnersConsole agency={actor.agency} email={actor.email} />;
}
