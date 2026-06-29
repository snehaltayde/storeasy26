import { formatMoney, discountPercent } from "@/lib/format";

// Inline price with optional strikethrough + saving. Server-renderable.
export default function Price({
  amount,
  compareAt,
  currency = "INR",
  showSaving = false,
  className = "",
}) {
  const onSale = compareAt != null && Number(compareAt) > Number(amount);
  const pct = onSale ? discountPercent(amount, compareAt) : 0;
  return (
    <span className={`inline-flex items-baseline gap-2 ${className}`}>
      <span className="font-semibold text-zinc-900">{formatMoney(amount, currency)}</span>
      {onSale && (
        <span className="text-sm text-zinc-400 line-through">
          {formatMoney(compareAt, currency)}
        </span>
      )}
      {onSale && showSaving && pct > 0 && (
        <span className="rounded bg-lime-100 px-1.5 py-0.5 text-xs font-semibold text-lime-800">
          Save {pct}%
        </span>
      )}
    </span>
  );
}
