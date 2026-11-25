"use client";

import { createContext, createElement, useContext, useCallback } from "react";
import { convertPrice, boundToBase } from "@/lib/markets";
import { formatMoney } from "@/lib/format";

// Phase 8 line 4: the shopper's market on the client. The storefront layout
// hands over publicMarket(storefrontMarket().market) (null = the store's own
// market). Every shopper-facing price goes through useMoney, which converts a
// base price with lib/markets.js convertPrice, the same function the cart and
// checkout price with, so a card, the product page and the cart line agree.
// With no market, money(a, c) is formatMoney(a, c): base HTML is unchanged.
const MarketContext = createContext(null);

export function MarketProvider({ market = null, children }) {
  // createElement, not JSX: scripts/test-markets.js renders this file in plain Node
  return createElement(MarketContext.Provider, { value: market }, children);
}

export const useMarket = () => useContext(MarketContext);

// → { market, money(baseAmount, baseCurrency), price(baseAmount), currency(baseCurrency), toBase(bound, side) }
export function useMoney() {
  const market = useContext(MarketContext);
  const price = useCallback((amount) => (market ? convertPrice(amount, market) : amount), [market]);
  const currency = useCallback((c) => (market ? market.currency : c), [market]);
  const money = useCallback((amount, c = "INR") => (market ? formatMoney(convertPrice(amount, market), market.currency) : formatMoney(amount, c)), [market]);
  const toBase = useCallback((bound, side) => boundToBase(bound, market, side), [market]);
  return { market, money, price, currency, toBase };
}
