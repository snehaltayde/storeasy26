import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

// The signup handoff's own frame (Phase 1 line 1). It is new UI, so it sits
// outside the old sign-in pages' data-legacy region (admin/(auth)/layout.js):
// the same centred 640px column and words as /signup and the Welcome page, so
// the founder's first three screens read as one flow. The store's name heads
// it; the notices wait for the Welcome page a moment later.
export default async function AdminHandoffLayout({ children }) {
  const name = await tfetch(() => siteName()).catch(() => null);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-4 pt-8 pb-16 text-sm text-foreground md:px-6 md:pt-16">
      <p className="mb-12 text-base font-semibold tracking-[-0.01em]">{name || "Your store"}</p>
      {children}
    </main>
  );
}
