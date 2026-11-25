import { cn } from "@/components/ui/utils";

// The Storeasy mark (Phase 3 line 0): the lime is the logo's colour only, never
// a console UI colour (docs/UI.md). Decorative: the name always sits beside it.
export function StoreasyMark({ className }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-6 shrink-0 rounded-md", className)}>
      <rect width="24" height="24" rx="6" fill="#84cc16" />
      <path d="M15.5 8.2c-.8-.9-2-1.4-3.4-1.4-2 0-3.4 1.1-3.4 2.6 0 3.4 6.8 1.9 6.8 5.2 0 1.6-1.5 2.6-3.5 2.6-1.5 0-2.8-.6-3.6-1.6" fill="none" stroke="#1a2e05" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
