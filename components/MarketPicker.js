"use client";

import { usePathname } from "next/navigation";
import { currencySymbol } from "@/lib/markets";

// Phase 8 line 4 (decision 17): "Ship to: India (₹) ▾". A plain GET form to
// /api/market, so it works without JavaScript (the route then returns to the
// page it came from); with JavaScript a choice submits at once. Shown only
// when the store sells in more than its own market.
//   options: lib/markets.js countryOptions (base first); country: the current one
export default function MarketPicker({ options = [], country }) {
  const pathname = usePathname() || "/";
  if (options.length < 2) return null;
  return (
    <form action="/api/market" method="get" data-part="market-picker" className="flex flex-wrap items-center gap-2 text-sm text-sf-text-subtle sm:text-xs">
      <label htmlFor="market-country">Ship to:</label>
      <select
        id="market-country"
        name="country"
        defaultValue={country}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="sf-field min-h-11 rounded-sf-xs border border-sf-border bg-sf-surface px-2 py-1 text-sf-text sm:min-h-8 sm:text-xs"
      >
        {options.map((o) => (
          <option key={o.country} value={o.country}>
            {`${o.name} (${currencySymbol(o.currency)})`}
          </option>
        ))}
      </select>
      <input type="hidden" name="return" value={pathname} />
      <noscript>
        <button type="submit" className="sf-focus sf-tap underline">
          Change
        </button>
      </noscript>
    </form>
  );
}
