// Phase 8 line 4: what the suites that compile components with explicit stubs
// (test-copy, test-effective-read, test-product-editor) give the market
// modules: the store's own market (no conversion), so every price renders as
// formatMoney did. scripts/test-markets.js covers the real modules.
import * as markets from "../../lib/markets.js";
import * as money from "../../lib/money.js";
import { formatMoney } from "../../lib/format.js";

const base = { country: "IN", market: null };
export const MARKET_STUBS = {
  "@/lib/markets": markets,
  "@/lib/money": money,
  "@/lib/market-request": { storefrontMarket: async () => base, requestMarket: () => base, MARKET_COOKIE_OPTS: {}, IP_COUNTRY_HEADER: "x-vercel-ip-country" },
  "@/components/MarketContext": {
    __esModule: true,
    useMoney: () => ({ market: null, money: (a, c = "INR") => formatMoney(a, c), price: (a) => a, currency: (c) => c, toBase: (b) => b }),
    useMarket: () => null,
    MarketProvider: ({ children }) => children,
  },
  "@/components/Price": { __esModule: true, default: ({ amount, currency = "INR", quantity = null, prefix = "" }) => `${prefix}${formatMoney(quantity == null ? amount : Number(amount) * quantity, currency)}`, BundleFigure: () => null },
  "@/components/MarketPicker": { __esModule: true, default: () => null },
};
