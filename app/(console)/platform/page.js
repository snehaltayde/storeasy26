import { cookies } from "next/headers";
import { verifyPlatformToken, platformAdminConfigured, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import PlatformLogin from "@/components/platform/PlatformLogin";
import PlatformAdmin from "@/components/platform/PlatformAdmin";

// Platform OPERATOR console (Session 22): tenant registry + health + create
// wizard. Control-plane-scoped — host/tenant context is irrelevant here, and
// everything data-ish loads client-side through the operator-gated API.
export const dynamic = "force-dynamic";
export const metadata = { title: "Storeasy platform", robots: { index: false } };

export default async function PlatformPage() {
  if (!platformAdminConfigured()) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-xl font-bold">Platform console</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Not configured — set <code className="rounded bg-zinc-100 px-1">PLATFORM_ADMIN_PASSWORD</code> in the environment.
        </p>
      </div>
    );
  }
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  const authed = await verifyPlatformToken(token);
  return authed ? <PlatformAdmin /> : <PlatformLogin />;
}
