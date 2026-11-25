import { consoleNotices } from "@/lib/admin/notices";
import { ConsoleNotices } from "@/components/admin/shell/ConsoleNotices";

// Signing in and resetting a password (S50; new UI since Phase 2 line 11):
// one centred 384px column, no sidebar, no storefront chrome; each page draws
// its own lockup and card (components/admin/auth/AuthFrame.js), the shape of
// the operator sign-in. The incident notices show above it.
export default async function AdminAuthLayout({ children }) {
  // no member on this page, so incidents only: never the support-access banner (Phase 2 line 7)
  const notices = await consoleNotices();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12 text-sm text-foreground">
      <div className="w-full max-w-sm">
        <ConsoleNotices {...notices} className="mb-6 space-y-2" />
        {children}
      </div>
    </main>
  );
}
