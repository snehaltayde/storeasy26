"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui/utils";
import { sectionFor } from "@/lib/admin/settings-sections";
import BackToOnboarding from "@/components/admin/onboarding/BackToOnboarding";

// The settings section nav (Phase 2 line 7): a vertical list from 1024px, a
// native select below it (the phone's own picker). Moving between tabs is a
// read, so every control is marked as one. A founder who came from
// onboarding (?from=onboarding) keeps the "Back to onboarding" link on every tab.
// sections: the rows of lib/admin/settings-sections.js the caller's role may open.
const SELECT =
  "h-10 w-full rounded-md border border-input bg-muted px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-input/30";

export function SettingsNav({ sections }) {
  const router = useRouter();
  const pathname = usePathname();
  const fromOnboarding = useSearchParams()?.get("from") === "onboarding";
  const current = sectionFor(pathname);
  const href = (h) => (fromOnboarding ? `${h}?from=onboarding` : h);
  return (
    <div className="space-y-3">
      {fromOnboarding && <BackToOnboarding />}
      <label className="block lg:hidden">
        <span className="sr-only">Settings section</span>
        <select className={SELECT} value={current?.href ?? ""} onChange={(e) => router.push(href(e.target.value))} data-read-control>
          {sections.map((s) => (
            <option key={s.id} value={s.href}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <nav aria-label="Settings sections" className="hidden lg:block">
        <ul className="flex flex-col gap-0.5">
          {sections.map((s) => {
            const on = current?.id === s.id;
            return (
              <li key={s.id}>
                <Link
                  href={href(s.href)}
                  aria-current={on ? "page" : undefined}
                  data-read-control
                  className={cn(
                    "relative flex min-h-8 items-center rounded-md px-3 py-1.5 text-sm outline-none motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background pointer-coarse:min-h-10",
                    on
                      ? "bg-muted font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {s.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
