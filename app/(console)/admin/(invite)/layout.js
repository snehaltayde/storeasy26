import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";
import { consoleNotices } from "@/lib/admin/notices";
import { ConsoleNotices } from "@/components/admin/shell/ConsoleNotices";

// Accepting an invite (Phase 1 line 9 polish): new UI on components/ui, so it
// sits outside the old sign-in pages' data-legacy region (admin/(auth)/layout.js),
// in the same flat 640px column as /signup and the signup handoff, headed by
// the store's name. The support-access and incident notices keep their old
// Banner look, so only they sit in a data-legacy region.
export default async function AdminInviteLayout({ children }) {
  const [name, notices] = await Promise.all([tfetch(() => siteName()).catch(() => null), consoleNotices()]);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-4 pt-8 pb-16 text-sm text-foreground md:px-6 md:pt-16">
      <div data-legacy className="contents">
        <ConsoleNotices {...notices} className="mb-8 space-y-2" />
      </div>
      <p className="mb-12 truncate text-base font-semibold tracking-[-0.01em]" title={name || undefined}>
        {name || "Your store"}
      </p>
      {children}
    </main>
  );
}
