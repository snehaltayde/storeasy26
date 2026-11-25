"use client";

import { useMoney } from "@/components/MarketContext";
import { convertLine, marketBundleFigures } from "@/lib/markets";
import { formatMoney } from "@/lib/format";

// Phase 8 line 4: a base price as the shopper's market shows it, for server
// components (ProductCard, bundle pages) that can't use the hook. Renders the
// text only, so a store with no market renders exactly what formatMoney did.
// `quantity`: price × quantity the way the cart line computes it.
export default function Price({ amount, currency = "INR", quantity = null, prefix = "" }) {
  const { market, money } = useMoney();
  if (quantity == null) return `${prefix}${money(amount, currency)}`;
  return `${prefix}${formatMoney(convertLine(amount, quantity, market), market ? market.currency : currency)}`;
}

// A bundle's set price, products' sum or saving in the market.
//   bundle: { bundle_price, componentsSum, saving, currency, components: [{ price, quantity }] }
export function BundleFigure({ bundle, kind = "price", prefix = "" }) {
  const { market } = useMoney();
  const f = marketBundleFigures(bundle, market);
  return `${prefix}${formatMoney(f[kind], f.currency ?? undefined)}`;
}
