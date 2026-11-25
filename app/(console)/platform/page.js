import { cookies } from "next/headers";
import { verifyPlatformToken, platformAdminConfigured, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { platformConfigured } from "@/lib/platform/control";
import { operatorsExist } from "@/lib/platform/sessions";
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

// "Not set up" only when nobody could sign in: no setup password AND no
// active operator account. A failed operator lookup shows the sign-in (the
// sign-in itself still fails closed).
async function consoleSetUp() {
  if (platformAdminConfigured()) return true;
  if (!platformConfigured()) return false;
  try {
    return await operatorsExist();
  } catch {
    return true;
  }
}

export default async function PlatformPage() {
  if (!(await consoleSetUp())) return <PlatformLogin configured={false} />;
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (!(await verifyPlatformToken(token))) return <PlatformLogin />;
  return (
    <div data-legacy className="contents">
      <PlatformAdmin />
    </div>
  );
}
