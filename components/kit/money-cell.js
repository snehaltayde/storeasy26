import { cn } from "@/components/ui/utils";
import { formatMoney } from "@/lib/format";

// Money in a table (docs/UI.md "Type"): formatMoney, Geist Mono, tabular and
// right-aligned, in the store currency the page passes in. No default
// currency: a missing amount or currency shows a dash, never "₹0" or a guess
// (and a missing currency warns outside production).
export function MoneyCell({ amount, currency, className }) {
  if (!currency && process.env.NODE_ENV !== "production") console.warn("MoneyCell: no currency given; showing a dash");
  const text = currency ? formatMoney(amount, currency) : "";
  return (
    <span data-kit="money-cell" className={cn("block text-right font-mono tabular-nums", className)}>
      {text || <span aria-label="No amount">—</span>}
    </span>
  );
}
