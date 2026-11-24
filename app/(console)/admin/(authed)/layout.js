import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";
import { navFor, navItems } from "@/lib/admin/nav";
import { listMyStores } from "@/lib/admin/stores";
import { consoleNotices } from "@/lib/admin/notices";
import { AdminShell } from "@/components/admin/shell/AdminShell";
import { ConsoleNotices } from "@/components/admin/shell/ConsoleNotices";

// The signed-in console (S50; the new shell in Phase 0 line 8): one auth gate
// and one shell for every screen (pages keep their own adminActor guards).
// What reaches the browser is decided here, on the server:
//   - the nav: navFor(role); a hidden item is never sent
//   - badges: counted only for visible items, best-effort (a failed count
//     never breaks the console)
//   - the account: a member's name and email only (never the user row);
//     bootstrap and operator-support sessions have none, and getUser is not called
//   - the stores: the caller's own active memberships (listMyStores)
//   - the sidebar's saved state: the sidebar_state cookie
const BADGES = {
  async returns() {
    const { listReturns } = await import("@/lib/returns");
    const open = (await listReturns({ status: "requested" })).length;
    return open > 0 ? open : null;
  },
  // Phase 1 line 3: "n/4" on Onboarding while the store is known to be
  // closed. The light read (no opening report): this runs on every page.
  async onboarding() {
    const { onboardingProgress } = await import("@/lib/onboarding/service");
    const o = await onboardingProgress();
    return o.supported && o.openKnown && !o.open ? `${o.doneCount}/${o.total}` : null;
  },
  // S52 / P2-GUARD: the unpublished-changes dot on Publishing
  async publish() {
    const { publishingBadge } = await import("@/lib/releases");
    return (await publishingBadge()) || null;
  },
};

export default async function AdminAuthedLayout({ children }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value)).catch(() => null);
  if (!actor) redirect("/admin/login");

  const nav = navFor(actor.role);
  const keys = [...new Set(navItems(nav).map((i) => i.badgeKey).filter(Boolean))];
  const [storeName, storeId, badges, account, stores] = await tfetch(async () => {
    const badges = {};
    for (const k of keys) {
      try {
        const v = await BADGES[k]?.();
        if (v != null && v !== "") badges[k] = v;
      } catch {}
    }
    let account = null;
    if (actor.kind === "merchant") {
      try {
        const { getUser } = await import("@/lib/platform/identity");
        const u = await getUser(actor.id);
        if (u) account = { name: u.name || null, email: u.email || null };
      } catch {}
    }
    const stores = await listMyStores(actor).catch(() => []);
    return [siteName(), currentTenant()?.id || null, badges, account, stores];
  }).catch(() => ["Store", null, {}, null, []]);
  const notices = await consoleNotices();

  return (
    <AdminShell
      nav={nav}
      badges={badges}
      actor={{ kind: actor.kind, role: actor.role, ...(actor.kind === "operator-support" ? { id: actor.id } : {}) }}
      account={account}
      stores={stores}
      storeName={storeName}
      storeId={storeId}
      defaultOpen={jar.get("sidebar_state")?.value !== "false"}
      notices={<ConsoleNotices {...notices} />}
    >
      {children}
    </AdminShell>
  );
}
