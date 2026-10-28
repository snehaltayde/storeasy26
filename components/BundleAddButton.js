"use client";

import { useState } from "react";
import { useCart } from "@/components/cart/CartContext";

// Add-the-set button (S46 / SF18): adds every component through the normal
// cart API — the BUNDLE offer prices the set server-side, so the drawer
// shows the saving the moment the last component lands.
export default function BundleAddButton({ components, disabled }) {
  const { addItem, setOpen } = useCart();
  const [state, setState] = useState("idle");

  async function addAll() {
    setState("adding");
    for (const c of components) {
      if (c.available) await addItem(c.variantId, c.quantity);
    }
    setState("done");
    setOpen(true);
  }

  if (disabled) {
    return (
      <button type="button" disabled className="w-full cursor-not-allowed rounded-xl bg-zinc-200 px-6 py-3.5 text-sm font-bold text-zinc-400">
        Currently unavailable
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={state === "adding"}
      onClick={state === "done" ? () => setOpen(true) : addAll}
      className="w-full rounded-xl bg-accent-400 px-6 py-3.5 text-sm font-bold text-accent-label transition hover:bg-accent-300 disabled:opacity-60"
    >
      {state === "adding" ? "Adding the set…" : state === "done" ? "Added ✓ — view cart" : "Add the set to cart"}
    </button>
  );
}
