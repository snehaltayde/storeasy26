"use client";

import { createContext, useContext, useState, useCallback } from "react";
import { track } from "@/lib/track/client";

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
  progress: { nudges: [], unlocked: [] },
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
      return next;
    } catch {
      /* keep current state on network error */
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  const addItem = useCallback(
    // Phase 9 line 2: subscriptionInterval (days) or null for one-time; the server decides whether it applies
    async (variantId, quantity = 1, { subscriptionInterval = null } = {}) => {
      const next = await mutate({ action: "add", variantId, quantity, ...(subscriptionInterval ? { subscriptionInterval } : {}) }, { openDrawer: true });
      const it = next?.items?.find((i) => i.variantId === variantId);
      if (it) {
        track("add_to_cart", {
          value: it.price * quantity,
          currency: it.currency || "INR",
          items: [{ id: it.variantNumericId, name: it.title, price: it.price, quantity }],
        });
      }
      return next;
    },
    [mutate],
  );
  const addItems = useCallback(
    async (items, { requireAvailable = false } = {}) => {
      if (!Array.isArray(items) || items.length === 0) return null;
      const next = await mutate({ action: "add_many", items, requireAvailable }, { openDrawer: true });
      if (next?.items) {
        const added = items
          .map((req) => {
            const it = next.items.find((i) => i.variantId === req.variantId);
            return it ? { id: it.variantNumericId, name: it.title, price: it.price, quantity: req.quantity ?? 1 } : null;
          })
          .filter(Boolean);
        if (added.length) {
          track("add_to_cart", {
            value: added.reduce((s, x) => s + x.price * x.quantity, 0),
            currency: next.currency || "INR",
            items: added,
          });
        }
      }
      return next;
    },
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
    shippingRatesSet: Boolean(cart.shippingRatesSet), // GEN-03: false = starter rates
    grandTotal: cart.grandTotal ?? cart.total ?? cart.subtotal,
    couponStatus: cart.couponStatus || null,
    changes: cart.changes || [], // S32 (SF06): price/availability change notices
    heldCart: Boolean(cart.heldCart),
    notice: typeof cart.notice === "string" ? cart.notice : null, // Phase 9 line 2: shown once (the server clears it) // Phase 9 line 2: the shopper's own cart waits behind a renewal
    // Phase 7 line 3: the server's nudges (lib/offers/progress.js), shown as sent; never posted back
    progress: cart.progress || EMPTY.progress,
    open,
    setOpen,
    pending,
    addItem,
    addItems,
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
