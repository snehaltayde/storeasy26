import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";
import { consoleNotices } from "@/lib/admin/notices";
import { ConsoleNotices } from "@/components/admin/shell/ConsoleNotices";

// Signing in and resetting a password (S50; new UI since Phase 2 line 11):
// the same flat 640px column as accepting an invite and /signup, headed by
// the store's name; no sidebar, no storefront chrome. The incident notices
// show above it.
export default async function AdminAuthLayout({ children }) {
  // no member on this page, so incidents only: never the support-access banner (Phase 2 line 7)
  const [name, notices] = await Promise.all([tfetch(() => siteName()).catch(() => null), consoleNotices()]);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-4 pt-8 pb-16 text-sm text-foreground md:px-6 md:pt-16">
      <ConsoleNotices {...notices} className="mb-8 space-y-2" />
      <div className="mb-12 min-w-0">
        <p className="truncate text-base font-semibold tracking-[-0.01em]" title={name || undefined}>
          {name || "Your store"}
        </p>
        <p className="text-[0.8125rem] text-muted-foreground">Store console · powered by Storeasy</p>
      </div>
      {children}
    </main>
  );
}
