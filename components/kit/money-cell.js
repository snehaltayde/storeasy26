import { cn } from "@/components/ui/utils";
import { formatMoney } from "@/lib/format";

// Money in a table (docs/UI.md "Type"): formatMoney, Geist Mono, tabular and
// right-aligned. An empty amount shows a dash, never "₹0".
export function MoneyCell({ amount, currency = "INR", className }) {
  const text = formatMoney(amount, currency);
  return (
    <span data-kit="money-cell" className={cn("block text-right font-mono tabular-nums", className)}>
      {text || <span aria-label="No amount">—</span>}
    </span>
  );
}
