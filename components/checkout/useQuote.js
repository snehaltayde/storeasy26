"use client";

// Phase 8 line 2 (decision 10): the server's quote for this cart and PIN code,
// asked for 400 ms after the PIN code or the cart last changed. A quote is used
// only while it still matches the PIN code and cart it was asked for; until
// then CheckoutFlow draws with the same pure function on the store's own
// configs. Placing an order always reprices on the server.
import { useEffect, useRef, useState } from "react";

export const quoteKey = (cart, pincode) => `${String(pincode || "").trim()}|${cart?.subtotal}|${cart?.discountTotal}|${cart?.total}`;

export default function useQuote({ cart, address }) {
  const [quote, setQuote] = useState(null); // { key, terms }
  const seq = useRef(0);
  const key = quoteKey(cart, address?.pincode);
  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "quote", address }),
        });
        const data = await res.json();
        if (mine === seq.current && data?.ok && data.quote) setQuote({ key, terms: data.quote });
      } catch {
        // the preview stays; placing the order reprices anyway
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // a refusal hands back a fresh quote for the cart it priced
  const replace = (terms, forCart) => setQuote(terms ? { key: quoteKey(forCart, address?.pincode), terms } : null);
  return { terms: quote?.key === key ? quote.terms : null, replace };
}
