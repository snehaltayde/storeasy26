import { Progress } from "@/components/ui/progress";

// Today's AI budget (Phase 9 line 5): "38,200 of 100,000 used today; resets at
// midnight". usage: { spent, budget } | null (a store before migration 0043).
const n = (v) => Number(v || 0).toLocaleString("en-IN");

export function budgetWords(usage) {
  if (!usage) return "The daily AI budget isn't available on this store yet.";
  return `${n(usage.spent)} of ${n(usage.budget)} tokens used today; resets at midnight`;
}

export function BudgetMeter({ usage }) {
  const pct = usage && usage.budget > 0 ? Math.min(100, Math.round((100 * usage.spent) / usage.budget)) : 0;
  return (
    <div className="space-y-2" data-copilot-meter={usage ? usage.spent : ""}>
      <Progress value={pct} aria-label="Today's AI budget used" />
      <p className="text-sm tabular-nums text-muted-foreground">{budgetWords(usage)}</p>
    </div>
  );
}
