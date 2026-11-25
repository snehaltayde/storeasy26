import { cookies } from "next/headers";
import { verifyPlatformToken, platformAdminConfigured, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import PlatformLogin from "@/components/platform/PlatformLogin";
import PlatformAdmin from "@/components/platform/PlatformAdmin";

// Platform OPERATOR console (Session 22, redesigned S50): tenant registry +
// health + create wizard. Control-plane-scoped — host/tenant context is
// irrelevant here, and everything data-ish loads client-side through the
// operator-gated API. Phase 3 line 0: the sign-in and the "not set up" state
// are on components/ui; the signed-in console is still the old screen, in its
// own [data-legacy] region inside the operator shell (layout.js).
export const dynamic = "force-dynamic";
export const metadata = { title: "Storeasy platform", robots: { index: false } };

export default async function PlatformPage() {
  if (!platformAdminConfigured()) return <PlatformLogin configured={false} />;
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (!(await verifyPlatformToken(token))) return <PlatformLogin />;
  return (
    <div data-legacy className="contents">
      <PlatformAdmin />
    </div>
  );
}
