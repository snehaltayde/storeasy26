import { cn } from "@/components/ui/utils";

// docs/UI.md "States": one sentence and, when there is one, the next step's
// action (a link or a button the page passes in, already role-gated).
export function EmptyState({ title, description = null, action = null, icon: Icon = null, className }) {
  return (
    <div data-kit="empty-state" className={cn("flex flex-col items-center gap-2 rounded-card border border-dashed border-border px-6 py-10 text-center", className)}>
      {Icon && <Icon aria-hidden className="size-6 text-muted-foreground" />}
      <p className="text-base font-medium text-foreground">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
