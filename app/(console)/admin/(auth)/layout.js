import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";
import { consoleNotices } from "@/lib/admin/notices";
import { ConsoleNotices } from "@/components/admin/shell/ConsoleNotices";

// Auth shell (S50): login and reset render as a centered
// card — store context above, no sidebar, no storefront chrome. Phase 0
// line 8: an old screen, so it sits in a [data-legacy] region (the old
// tokens, app/console.css); the support-access and incident notices show
// above it, as they did before the shell moved them.
export default async function AdminAuthLayout({ children }) {
  // no member on this page, so incidents only: never the support-access banner (Phase 2 line 7)
  const [name, notices] = await Promise.all([tfetch(() => siteName()).catch(() => "Store"), consoleNotices()]);
  return (
    <div data-legacy className="contents">
      <ConsoleNotices {...notices} className="space-y-2 px-4 pt-4 sm:px-6" />
      <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
        <div className="mb-6 text-center">
          <p className="text-lg font-semibold tracking-tight text-fg">{name}</p>
          <p className="text-xs text-fg-subtle">
            Store console · powered by Store<span className="font-semibold text-caccent">asy</span>
          </p>
        </div>
        <div className="w-full max-w-sm rounded-card border border-edge bg-surface p-6 shadow-card">{children}</div>
      </div>
    </div>
  );
}
