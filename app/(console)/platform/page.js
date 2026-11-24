import { cookies } from "next/headers";
import { verifyPlatformToken, platformAdminConfigured, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import PlatformLogin from "@/components/platform/PlatformLogin";
import PlatformAdmin from "@/components/platform/PlatformAdmin";

// Platform OPERATOR console (Session 22, redesigned S50): tenant registry +
// health + create wizard. Control-plane-scoped — host/tenant context is
// irrelevant here, and everything data-ish loads client-side through the
// operator-gated API.
export const dynamic = "force-dynamic";
export const metadata = { title: "Storeasy platform", robots: { index: false } };

export default async function PlatformPage() {
  if (!platformAdminConfigured()) {
    return (
      <div data-legacy className="contents">
      <div className="mx-auto max-w-md px-6 py-24">
        <Card>
          <CardHeader title="Platform console" />
          <Banner tone="warning">
            Not configured — set <code className="rounded bg-surface-sunken px-1 font-mono text-xs">PLATFORM_ADMIN_PASSWORD</code> in the
            environment.
          </Banner>
        </Card>
      </div>
      </div>
    );
  }
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  const authed = await verifyPlatformToken(token);
  return (
    <div data-legacy className="contents">
      {authed ? <PlatformAdmin /> : <PlatformLogin />}
    </div>
  );
}
