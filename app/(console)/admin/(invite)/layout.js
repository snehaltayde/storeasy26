import { consoleNotices } from "@/lib/admin/notices";
import { ConsoleNotices } from "@/components/admin/shell/ConsoleNotices";

// Accepting an invite (Phase 1 line 9; the sign-in frame since Phase 2 line
// 11): the same centred 384px column as the sign-in pages
// (admin/(auth)/layout.js); the page draws its lockup and card
// (components/admin/auth/AuthFrame.js). The incident notices show above it.
export default async function AdminInviteLayout({ children }) {
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
