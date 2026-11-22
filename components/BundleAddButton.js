"use client";

import { useState } from "react";
import { useCart } from "@/components/cart/CartContext";

// Add-the-set button (S46 / SF18 + Phase 1.2 atomic batch): adds every component
// in one atomic `add_many` cart mutation so a bundle never lands half-added.
export default function BundleAddButton({ components, disabled }) {
  const { addItems, setOpen } = useCart();
  const [state, setState] = useState("idle");

  async function addAll() {
    const items = (components || [])
      .filter((c) => c.available && c.variantId)
      .map((c) => ({ variantId: c.variantId, quantity: c.quantity ?? 1 }));
    if (!items.length) return;
    setState("adding");
    const res = await addItems(items, { requireAvailable: true });
    if (res) {
      setState("done");
      setOpen(true);
    } else {
      setState("idle");
    }
  }

  if (disabled) {
    return (
      <button type="button" disabled className="w-full cursor-not-allowed rounded-sf-control bg-sf-surface-strong px-6 py-3.5 text-sm font-bold text-sf-text-faint">
        Currently unavailable
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={state === "adding"}
      onClick={state === "done" ? () => setOpen(true) : addAll}
      className="w-full rounded-sf-control bg-sf-accent px-6 py-3.5 text-sm font-bold text-sf-on-accent transition hover:bg-sf-accent-hover disabled:opacity-60"
    >
      {state === "adding" ? "Adding the set…" : state === "done" ? "Added ✓ — view cart" : "Add the set to cart"}
    </button>
  );
}
