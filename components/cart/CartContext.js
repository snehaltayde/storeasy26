"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

const CartContext = createContext(null);
const STORAGE_KEY = "storeasy.cart.v1";

export function CartProvider({ children }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setItems(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }, [items, hydrated]);

  const addItem = useCallback((item) => {
    setItems((cur) => {
      const idx = cur.findIndex((x) => x.variantId === item.variantId);
      if (idx >= 0) {
        const next = [...cur];
        next[idx] = { ...next[idx], qty: next[idx].qty + (item.qty || 1) };
        return next;
      }
      return [...cur, { ...item, qty: item.qty || 1 }];
    });
    setOpen(true);
  }, []);

  const removeItem = useCallback((variantId) => {
    setItems((cur) => cur.filter((x) => x.variantId !== variantId));
  }, []);

  const setQty = useCallback((variantId, qty) => {
    setItems((cur) =>
      cur.map((x) => (x.variantId === variantId ? { ...x, qty: Math.max(1, qty) } : x)),
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const count = items.reduce((n, x) => n + x.qty, 0);
  const subtotal = items.reduce((s, x) => s + Number(x.price || 0) * x.qty, 0);

  return (
    <CartContext.Provider
      value={{ items, count, subtotal, addItem, removeItem, setQty, clear, open, setOpen, hydrated }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

// Build a real Shopify checkout permalink: /cart/<variantNumericId>:<qty>,...
export function checkoutUrl(items) {
  const domain = process.env.NEXT_PUBLIC_SHOPIFY_DOMAIN;
  if (!domain || !items.length) return null;
  const parts = items
    .map((x) => `${String(x.variantId).split("/").pop()}:${x.qty}`)
    .join(",");
  return `https://${domain}/cart/${parts}`;
}
