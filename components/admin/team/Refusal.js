import { CircleAlert } from "lucide-react";
import { cn } from "@/components/ui/utils";

// A refusal or failure in plain words (the route's own sentence), the same in
// every team dialog and on the page: a quiet danger-tinted box with an icon,
// announced to screen readers. Nothing typed is cleared when it shows.
//   children: the sentence; className
export function Refusal({ children, className }) {
  if (!children) return null;
  return (
    <div role="alert" data-team="refusal" className={cn("flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive", className)}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
