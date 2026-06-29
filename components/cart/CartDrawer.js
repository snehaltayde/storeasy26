"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useCart, checkoutUrl } from "./CartContext";
import { formatMoney } from "@/lib/format";

export default function CartDrawer() {
  const { items, subtotal, open, setOpen, removeItem, setQty } = useCart();

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const currency = items[0]?.currency || "INR";
  const url = checkoutUrl(items);

  return (
    <>
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden="true"
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col bg-white shadow-xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="Shopping cart"
      >
        <header className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h2 className="text-lg font-bold">
            Your cart {items.length > 0 && <span className="text-zinc-400">({items.length})</span>}
          </h2>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close cart"
            className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-zinc-500">
            <p className="font-medium text-zinc-700">Your cart is empty</p>
            <p className="text-sm">Add some gains and they’ll show up here.</p>
          </div>
        ) : (
          <ul className="flex-1 divide-y divide-zinc-100 overflow-y-auto px-5">
            {items.map((it) => (
              <li key={it.variantId} className="flex gap-3 py-4">
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                  {it.image ? (
                    <Image src={it.image} alt={it.title} fill sizes="80px" className="object-cover" />
                  ) : null}
                </div>
                <div className="flex flex-1 flex-col">
                  <p className="line-clamp-2 text-sm font-medium text-zinc-900">{it.title}</p>
                  {it.variantTitle && it.variantTitle !== "Default Title" && (
                    <p className="text-xs text-zinc-500">{it.variantTitle}</p>
                  )}
                  <div className="mt-auto flex items-center justify-between pt-2">
                    <div className="inline-flex items-center rounded-lg border border-zinc-200">
                      <button
                        onClick={() => setQty(it.variantId, it.qty - 1)}
                        className="px-2.5 py-1 text-zinc-600 hover:text-zinc-900"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="min-w-7 text-center text-sm">{it.qty}</span>
                      <button
                        onClick={() => setQty(it.variantId, it.qty + 1)}
                        className="px-2.5 py-1 text-zinc-600 hover:text-zinc-900"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm font-semibold">
                      {formatMoney(Number(it.price) * it.qty, it.currency)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => removeItem(it.variantId)}
                  aria-label="Remove item"
                  className="self-start text-zinc-300 hover:text-zinc-600"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        {items.length > 0 && (
          <footer className="border-t border-zinc-100 px-5 py-4">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="text-zinc-500">Subtotal</span>
              <span className="text-base font-bold">{formatMoney(subtotal, currency)}</span>
            </div>
            {url ? (
              <a
                href={url}
                className="block rounded-xl bg-zinc-900 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-zinc-800"
              >
                Checkout on Shopify →
              </a>
            ) : (
              <p className="rounded-xl bg-zinc-100 px-4 py-3 text-center text-xs text-zinc-500">
                Set <code className="font-mono">NEXT_PUBLIC_SHOPIFY_DOMAIN</code> to enable secure
                Shopify checkout.
              </p>
            )}
            <p className="mt-2 text-center text-[11px] text-zinc-400">
              Taxes &amp; shipping calculated at checkout
            </p>
          </footer>
        )}
      </aside>
    </>
  );
}
