import { cookies } from "next/headers";
import { PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { operatorFromCookie } from "@/lib/platform/require-operator";
import { PLATFORM_NAV, operatorAccount } from "@/lib/platform/nav";
import { PlatformShell } from "@/components/platform/shell/PlatformShell";

// The operator console (Phase 3 line 0). A signed-in operator (a TOTP session,
// or the bootstrap token before the first operator user) gets the shell built
// on components/ui; anyone else gets the page alone, which is the sign-in (or a
// redirect to it): no shell, no nav, no operator name. Every screen in it is
// built on components/ui (the old console went in Phase 3 line 7).
export const dynamic = "force-dynamic";

export default async function PlatformLayout({ children }) {
  const jar = await cookies();
  const operator = await operatorFromCookie(jar.get(PLATFORM_COOKIE)?.value);
  if (!operator) return children;
  return (
    <PlatformShell nav={PLATFORM_NAV} account={operatorAccount(operator)} defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
      {children}
    </PlatformShell>
  );
}
