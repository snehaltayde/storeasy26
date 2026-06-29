"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useCart } from "./CartContext";
import { formatMoney } from "@/lib/format";

export default function CartDrawer() {
  const {
    items,
    subtotal,
    count,
    currency,
    couponStatus,
    appliedOffers,
    gifts,
    discountTotal,
    total,
    open,
    setOpen,
    removeItem,
    setQty,
    setCoupon,
    pending,
  } = useCart();
  const [code, setCode] = useState("");

  // Pop the "You save" figure whenever the total discount jumps up (an offer landed).
  const [savePop, setSavePop] = useState(0);
  const prevDiscount = useRef(0);
  useEffect(() => {
    if (discountTotal > prevDiscount.current) setSavePop((n) => n + 1);
    prevDiscount.current = discountTotal;
  }, [discountTotal]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  function applyCoupon(e) {
    e.preventDefault();
    const c = code.trim();
    if (c) setCoupon(c);
    setCode("");
  }

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
            Your cart {count > 0 && <span className="text-zinc-400">({count})</span>}
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
          pending ? (
            // First item lands here while the request is in flight — show a
            // skeleton instead of flashing "your cart is empty".
            <ul className="flex-1 space-y-4 px-5 py-4">
              {[0, 1].map((i) => (
                <li key={i} className="flex gap-3">
                  <div className="h-20 w-20 shrink-0 animate-pulse rounded-lg bg-zinc-100" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-100" />
                    <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-100" />
                    <div className="h-7 w-24 animate-pulse rounded bg-zinc-100" />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-zinc-500">
              <p className="font-medium text-zinc-700">Your cart is empty</p>
              <p className="text-sm">Add some gains and they’ll show up here.</p>
            </div>
          )
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
                        onClick={() => setQty(it.variantId, it.quantity - 1)}
                        disabled={pending}
                        className="px-2.5 py-1 text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="min-w-7 text-center text-sm">{it.quantity}</span>
                      <button
                        onClick={() => setQty(it.variantId, it.quantity + 1)}
                        disabled={pending}
                        className="px-2.5 py-1 text-zinc-600 hover:text-zinc-900 disabled:opacity-50"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm font-semibold">{formatMoney(it.lineTotal, it.currency)}</span>
                  </div>
                </div>
                <button
                  onClick={() => removeItem(it.variantId)}
                  disabled={pending}
                  aria-label="Remove item"
                  className="self-start text-zinc-300 hover:text-zinc-600 disabled:opacity-50"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}

            {gifts.map((g) => (
              <li key={`gift-${g.variantId}`} className="animate-offer-in flex gap-3 py-4">
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                  {g.image ? (
                    <Image src={g.image} alt={g.title} fill sizes="80px" className="object-cover" />
                  ) : null}
                  <span className="absolute left-1 top-1 rounded bg-lime-400 px-1.5 py-0.5 text-[10px] font-bold text-zinc-900">
                    FREE
                  </span>
                </div>
                <div className="flex flex-1 flex-col justify-center">
                  <p className="line-clamp-2 text-sm font-medium text-zinc-900">{g.title}</p>
                  <p className="text-xs text-zinc-500">Free gift 🎁</p>
                  <div className="mt-1 flex items-center gap-2 text-sm">
                    <span className="font-semibold text-lime-700">FREE</span>
                    {g.value ? (
                      <span className="text-xs text-zinc-400 line-through">
                        {formatMoney(g.value, currency)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {items.length > 0 && (
          <footer className="border-t border-zinc-100 px-5 py-4">
            {/* Coupon — validated by the engine (try BEAST10, FLAT200, SOLO25) */}
            <div className="mb-4">
              {couponStatus?.valid ? (
                <div className="flex items-center justify-between rounded-xl border border-lime-200 bg-lime-50 px-3 py-2.5">
                  <span className="text-sm">
                    <span className="text-zinc-500">Coupon</span>{" "}
                    <span className="font-semibold text-lime-800">{couponStatus.code}</span>
                    {couponStatus.applied ? (
                      <span className="text-lime-700"> · −{formatMoney(couponStatus.applied, currency)}</span>
                    ) : null}
                  </span>
                  <button
                    onClick={() => setCoupon(null)}
                    className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <form onSubmit={applyCoupon} className="flex gap-2">
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="Coupon code"
                      aria-label="Coupon code"
                      className="min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 py-2.5 text-sm uppercase outline-none placeholder:normal-case focus:border-zinc-400"
                    />
                    <button
                      type="submit"
                      disabled={!code.trim() || pending}
                      className="rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </form>
                  {couponStatus && !couponStatus.valid && (
                    <p className="mt-1.5 flex items-center justify-between gap-2 text-xs text-red-600">
                      <span>
                        “{couponStatus.code}” — {couponStatus.reason}
                      </span>
                      <button
                        onClick={() => setCoupon(null)}
                        className="shrink-0 font-medium text-zinc-400 hover:text-zinc-700"
                      >
                        clear
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="mb-3 space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Subtotal</span>
                <span className="text-zinc-700">{formatMoney(subtotal, currency)}</span>
              </div>
              {appliedOffers.filter((o) => o.amount > 0).map((o) => (
                <div
                  key={o.id}
                  className="animate-offer-in flex items-start justify-between gap-3 text-sm text-lime-700"
                >
                  <span className="flex items-start gap-1.5">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
                      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
                      <circle cx="7" cy="7" r="1.4" fill="currentColor" />
                    </svg>
                    <span className="leading-snug">{o.label}</span>
                  </span>
                  <span className="whitespace-nowrap font-medium">−{formatMoney(o.amount, currency)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-zinc-100 pt-2">
                <span className="font-semibold">Total</span>
                <span className="text-base font-bold">{formatMoney(total, currency)}</span>
              </div>
              {discountTotal > 0 && (
                <p
                  key={savePop}
                  className="animate-save-pop origin-right text-right text-xs font-semibold text-lime-700"
                >
                  You save {formatMoney(discountTotal, currency)}
                </p>
              )}
            </div>
            <Link
              href="/checkout"
              onClick={() => setOpen(false)}
              className="block rounded-xl bg-zinc-900 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-zinc-800"
            >
              Checkout →
            </Link>
            <p className="mt-2 text-center text-[11px] text-zinc-400">
              Taxes &amp; shipping calculated at checkout
            </p>
          </footer>
        )}
      </aside>
    </>
  );
}
