import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import PlatformAdmin from "@/components/platform/PlatformAdmin";

// The OLD operator console (Session 22, redesigned S50), moved unchanged from
// /platform by Phase 3 line 1 so no operator tool disappears before its new
// screen lands (nav item "Old console"; removed by Phase 3 line 7). It keeps
// its own [data-legacy] region inside the operator shell. Operators only;
// anyone else goes to /platform (which shows the sign-in).
export const dynamic = "force-dynamic";
export const metadata = { title: "Old console · Storeasy platform", robots: { index: false } };

export default async function LegacyPlatformPage() {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  return (
    <div data-legacy className="contents">
      <PlatformAdmin />
    </div>
  );
}
