"use client";

import { createContext, useContext, useState, useCallback } from "react";
import { numericId } from "@/lib/ids";

const CartContext = createContext(null);
const EMPTY = {
  id: null,
  items: [],
  subtotal: 0,
  count: 0,
  coupon: null,
  currency: "INR",
  appliedOffers: [],
  gifts: [],
  discountTotal: 0,
  total: 0,
  couponStatus: null,
};

// DB-backed cart. State is seeded from the server (SSR-read cookie → Turso) so
// the count is correct on first paint and survives refresh; every mutation hits
// the edge /api/cart and replaces state with the server's authoritative cart.
export function CartProvider({ children, initialCart }) {
  const [cart, setCart] = useState(initialCart || EMPTY);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const mutate = useCallback(async (body, { openDrawer = false } = {}) => {
    if (openDrawer) setOpen(true);
    setPending(true);
    try {
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const next = await res.json();
      setCart((prev) => ({ ...prev, ...next }));
    } catch {
      /* keep current state on network error */
    } finally {
      setPending(false);
    }
  }, []);

  const addItem = useCallback(
    (variantId, quantity = 1) => mutate({ action: "add", variantId, quantity }, { openDrawer: true }),
    [mutate],
  );
  const setQty = useCallback(
    (variantId, quantity) => mutate({ action: "setQty", variantId, quantity }),
    [mutate],
  );
  const removeItem = useCallback((variantId) => mutate({ action: "remove", variantId }), [mutate]);
  const setCoupon = useCallback((coupon) => mutate({ action: "setCoupon", coupon }), [mutate]);
  const clear = useCallback(() => mutate({ action: "clear" }), [mutate]);

  const value = {
    items: cart.items,
    count: cart.count,
    subtotal: cart.subtotal,
    currency: cart.currency,
    coupon: cart.coupon,
    appliedOffers: cart.appliedOffers || [],
    gifts: cart.gifts || [],
    discountTotal: cart.discountTotal || 0,
    total: cart.total ?? cart.subtotal,
    shipping: cart.shipping || null,
    grandTotal: cart.grandTotal ?? cart.total ?? cart.subtotal,
    couponStatus: cart.couponStatus || null,
    open,
    setOpen,
    pending,
    addItem,
    setQty,
    removeItem,
    setCoupon,
    clear,
  };
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

// Shopify checkout permalink from cart items — numeric ids at the API boundary.
export function checkoutUrl(items) {
  const domain = process.env.NEXT_PUBLIC_SHOPIFY_DOMAIN;
  if (!domain || !items?.length) return null;
  const parts = items.map((i) => `${i.variantNumericId || numericId(i.variantId)}:${i.quantity}`).join(",");
  return `https://${domain}/cart/${parts}`;
}
