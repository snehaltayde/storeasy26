import { Lock } from "lucide-react";
import { NO_ACCESS_WORDS } from "@/lib/admin/settings-sections";

// What a role without settings.read gets on any settings, integrations or
// billing URL (Phase 2 line 7): the words and a way out, and nothing else.
// The page never reads settings data for it, so there is none to hand in.
// role: the caller's role, named in the sentence (never anything of the store's)
export function NoAccess({ role = null }) {
  return (
    <section data-settings="no-access" className="mx-auto mt-6 flex max-w-md flex-col items-center gap-2 rounded-card border border-dashed border-border px-6 py-12 text-center">
      <span aria-hidden className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted">
        <Lock className="size-5 text-muted-foreground" />
      </span>
      <h1 className="text-[1.125rem] font-semibold text-foreground">{NO_ACCESS_WORDS.title}</h1>
      <p className="text-sm text-muted-foreground">{NO_ACCESS_WORDS.body(role)}</p>
      <a
        href="/admin/dashboard"
        data-read-control
        className="mt-2 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {NO_ACCESS_WORDS.back}
      </a>
    </section>
  );
}
