"use client";

import { useEffect, useRef, useState } from "react";
import Image from "@/components/StoreImage";
import Link from "next/link";
import { useCart } from "./CartContext";
import OfferProgress from "./OfferProgress";
import { formatMoney } from "@/lib/format";
import { useMoney } from "@/components/MarketContext";

// Cart-drawer upsell slot (Session 23): shown only when the merchant has a
// cart_upsell placement configured. Lazy-fetched on open, re-fetched when the
// cart's product mix changes; one-tap add through the normal cart pipeline.
function UpsellSlot({ open, items, addItem, pending, currency }) {
  const { money } = useMoney(); // Phase 8 line 4: catalog prices, shown in the shopper's market
  const [slot, setSlot] = useState(null);
  const keyRef = useRef("");

  useEffect(() => {
    if (!open) return;
    const key = items
      .map((i) => i.productId)
      .filter(Boolean)
      .sort()
      .join(",");
    if (key === keyRef.current) return;
    keyRef.current = key;
    fetch(`/api/upsell?exclude=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setSlot(data?.products?.length ? data : null))
      .catch(() => setSlot(null));
  }, [open, items]);

  if (!slot || items.length === 0) return null;
  return (
    <div className="border-t border-sf-border-soft px-5 py-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-sf-text-subtle">{slot.title}</p>
      <ul className="space-y-2">
        {slot.products.map((p) => (
          <li key={p.handle} className="flex items-center gap-3">
            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
              {p.featured_image ? (
                <Image src={p.featured_image} alt={p.title} fill sizes="48px" className="object-cover" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-sm font-medium text-sf-text">{p.title}</p>
              <p className="text-xs text-sf-text-subtle">{money(p.variant_price ?? p.price_min, p.currency || currency)}</p>
            </div>
            <button
              onClick={() => addItem(p.variant_id)}
              disabled={pending}
              className="shrink-0 rounded-sf-small border border-sf-border-strong px-2.5 py-1 text-xs font-semibold text-sf-text-body hover:bg-sf-surface-muted disabled:opacity-50"
            >
              Add
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Phase 7 line 3: the drawer is a modal dialog. Focus moves in on open and
// Tab / Shift+Tab stay inside; Escape closes it and focus goes back to the
// control that opened it (the buy bar, the header's cart button, …). The page
// behind doesn't scroll while it is open.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function CartDrawer() {
  const {
    items,
    subtotal,
    count,
    currency,
    changes,
    couponStatus,
    appliedOffers,
    gifts,
    discountTotal,
    total,
    shipping,
    grandTotal,
    open,
    setOpen,
    addItem,
    removeItem,
    setQty,
    setCoupon,
    pending,
    progress,
  } = useCart();
  const panelRef = useRef(null);
  const tierNudge = progress?.nudges?.find((n) => n.kind === "tier") || null;
  const [code, setCode] = useState("");

  // Pop the "You save" figure whenever the total discount jumps up (an offer landed).
  const [savePop, setSavePop] = useState(0);
  const prevDiscount = useRef(0);
  useEffect(() => {
    if (discountTotal > prevDiscount.current) setSavePop((n) => n + 1);
    prevDiscount.current = discountTotal;
  }, [discountTotal]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const opener = document.activeElement instanceof HTMLElement && !panel?.contains(document.activeElement) ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel?.querySelector("[data-cart-close]")?.focus({ preventScroll: true });
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const els = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const inside = panel.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      // back to the opener once it can take focus again (the buy bar shows when the drawer closes)
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
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
        className={`fixed inset-0 z-40 bg-sf-overlay/40 transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        data-protected="cart"
        className={`fixed right-0 top-0 z-50 flex h-dvh w-full max-w-md flex-col bg-sf-surface shadow-xl transition-transform duration-300 motion-reduce:transition-none ${
          open ? "translate-x-0" : "invisible translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Shopping cart"
        aria-hidden={open ? undefined : true}
        inert={!open}
      >
        <header className="flex items-center justify-between border-b border-sf-border-soft px-5 py-4">
          <h2 className="text-lg font-bold">
            Your cart {count > 0 && <span className="text-sf-text-faint">({count})</span>}
          </h2>
          <button
            data-cart-close
            onClick={() => setOpen(false)}
            aria-label="Close cart"
            className="rounded-full p-1.5 text-sf-text-subtle hover:bg-sf-surface-sunken"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        {/* always in the page, so the first nudge is announced (a live region must exist before it changes) */}
        <OfferProgress progress={progress} />

        {items.length === 0 ? (
          pending ? (
            // First item lands here while the request is in flight — show a
            // skeleton instead of flashing "your cart is empty".
            <ul className="flex-1 space-y-4 px-5 py-4">
              {[0, 1].map((i) => (
                <li key={i} className="flex gap-3">
                  <div className="h-20 w-20 shrink-0 animate-pulse rounded-sf-small bg-sf-surface-sunken" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-4 w-3/4 animate-pulse rounded-sf-2xs bg-sf-surface-sunken" />
                    <div className="h-3 w-1/3 animate-pulse rounded-sf-2xs bg-sf-surface-sunken" />
                    <div className="h-7 w-24 animate-pulse rounded-sf-2xs bg-sf-surface-sunken" />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sf-text-subtle">
              <p className="font-medium text-sf-text-body">Your cart is empty</p>
              <p className="text-sm">Add something you like and it’ll show up here.</p>
            </div>
          )
        ) : (
          <ul className="flex-1 divide-y divide-sf-border-soft overflow-y-auto px-5">
            {items.map((it) => (
              <li key={it.variantId} className="flex gap-3 py-4">
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                  {it.image ? (
                    <Image src={it.image} alt={it.title} fill sizes="80px" className="object-cover" />
                  ) : null}
                </div>
                <div className="flex flex-1 flex-col">
                  <p className="line-clamp-2 text-sm font-medium text-sf-text">{it.title}</p>
                  {it.variantTitle && it.variantTitle !== "Default Title" && (
                    <p className="text-xs text-sf-text-subtle">{it.variantTitle}</p>
                  )}
                  {tierNudge?.variantId === it.variantId && (
                    <button
                      type="button"
                      data-nudge-add
                      onClick={() => setQty(it.variantId, it.quantity + tierNudge.add)}
                      disabled={pending}
                      className="sf-focus mt-1 inline-flex min-h-11 items-center self-start rounded-sf-small border border-sf-accent-border bg-sf-accent-subtle px-3 text-xs font-semibold text-sf-on-accent-soft disabled:opacity-50 sm:min-h-8"
                    >
                      Add {tierNudge.add} more
                    </button>
                  )}
                  <div className="mt-auto flex items-center justify-between pt-2">
                    <div className="inline-flex items-center rounded-sf-small border border-sf-border">
                      <button
                        onClick={() => setQty(it.variantId, it.quantity - 1)}
                        disabled={pending}
                        className="px-2.5 py-1 text-sf-text-muted hover:text-sf-text disabled:opacity-50"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="min-w-7 text-center text-sm">{it.quantity}</span>
                      <button
                        onClick={() => setQty(it.variantId, it.quantity + 1)}
                        disabled={pending}
                        className="px-2.5 py-1 text-sf-text-muted hover:text-sf-text disabled:opacity-50"
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
                  className="self-start text-sf-mark hover:text-sf-text-muted disabled:opacity-50"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}

            {gifts.map((g) => (
              <li key={`gift-${g.variantId}`} className="animate-offer-in flex gap-3 py-4">
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
                  {g.image ? (
                    <Image src={g.image} alt={g.title} fill sizes="80px" className="object-cover" />
                  ) : null}
                  <span className="absolute left-1 top-1 rounded-sf-2xs bg-sf-accent px-1.5 py-0.5 text-sf-3xs font-bold text-sf-on-accent">
                    FREE
                  </span>
                </div>
                <div className="flex flex-1 flex-col justify-center">
                  <p className="line-clamp-2 text-sm font-medium text-sf-text">{g.title}</p>
                  <p className="text-xs text-sf-text-subtle">Free gift 🎁</p>
                  <div className="mt-1 flex items-center gap-2 text-sm">
                    <span className="font-semibold text-sf-accent-text">FREE</span>
                    {g.value ? (
                      <span className="text-xs text-sf-text-faint line-through">
                        {formatMoney(g.value, currency)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* S32 (SF06): acknowledge catalog changes under the shopper's cart —
            totals already use current prices; this says what moved. */}
        {changes?.length > 0 && (
          <div className="mx-5 mb-2 rounded-sf-control border border-sf-warning-border bg-sf-warning-surface px-3 py-2.5 text-xs text-sf-warning-strong">
            {changes.map((c, i) => (
              <p key={`${c.variantId}-${c.kind}-${i}`}>
                {c.kind === "unavailable"
                  ? `“${c.title}” just went out of stock — remove it or check back later.`
                  : `“${c.title}” price changed since you added it: ${formatMoney(c.from, currency)} → ${formatMoney(c.to, currency)} (totals use the new price).`}
              </p>
            ))}
          </div>
        )}

        <UpsellSlot open={open} items={items} addItem={addItem} pending={pending} currency={currency} />

        {items.length > 0 && (
          <footer className="border-t border-sf-border-soft px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {/* Coupon — validated by the engine (try BEAST10, FLAT200, SOLO25) */}
            <div className="mb-4">
              {couponStatus?.valid ? (
                <div className="flex items-center justify-between rounded-sf-control border border-sf-accent-border bg-sf-accent-subtle px-3 py-2.5">
                  <span className="text-sm">
                    {/* P1-CONTRAST: muted, not subtle: subtle grey is 4.08:1 on a blue
                        accent's tint (white/#0a0a0b with #2563eb) */}
                    <span className="text-sf-text-muted">Coupon</span>{" "}
                    <span className="font-semibold text-sf-on-accent-soft">{couponStatus.code}</span>
                    {couponStatus.applied ? (
                      <span className="text-sf-accent-text"> · −{formatMoney(couponStatus.applied, currency)}</span>
                    ) : null}
                  </span>
                  <button
                    onClick={() => setCoupon(null)}
                    className="text-xs font-medium text-sf-text-muted hover:text-sf-text-soft"
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
                      className="min-w-0 flex-1 rounded-sf-control border border-sf-border px-3 py-2.5 text-sm uppercase outline-none placeholder:normal-case focus:border-sf-border-hover"
                    />
                    <button
                      type="submit"
                      disabled={!code.trim() || pending}
                      className="rounded-sf-control border border-sf-border-strong px-4 py-2.5 text-sm font-semibold text-sf-text-soft transition hover:bg-sf-surface-muted disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </form>
                  {couponStatus && !couponStatus.valid && (
                    <p className="mt-1.5 flex items-center justify-between gap-2 text-xs text-sf-danger">
                      <span>
                        “{couponStatus.code}” — {couponStatus.reason}
                      </span>
                      <button
                        onClick={() => setCoupon(null)}
                        className="shrink-0 font-medium text-sf-text-faint hover:text-sf-text-body"
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
                <span className="text-sf-text-subtle">Subtotal</span>
                <span className="text-sf-text-body">{formatMoney(subtotal, currency)}</span>
              </div>
              {appliedOffers.filter((o) => o.amount > 0).map((o) => (
                <div
                  key={o.id}
                  className="animate-offer-in flex items-start justify-between gap-3 text-sm text-sf-accent-text"
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
              {shipping && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-sf-text-subtle">Shipping</span>
                  {shipping.total === 0 ? (
                    <span className="font-semibold text-sf-accent-text">FREE</span>
                  ) : (
                    <span className="text-sf-text-body">{formatMoney(shipping.total, currency)}</span>
                  )}
                </div>
              )}
              {/* GEN-03: the free-shipping nudge is a promise in the store's name, so
                  it needs rates the store chose; it now lives in the progress block
                  at the top (lib/offers/progress.js gets the rates only then). */}
              <div className="flex items-center justify-between border-t border-sf-border-soft pt-2">
                <span className="font-semibold">Total</span>
                <span data-cart-total className="text-base font-bold">{formatMoney(grandTotal ?? total, currency)}</span>
              </div>
              {discountTotal > 0 && (
                <p
                  key={savePop}
                  className="animate-save-pop origin-right text-right text-xs font-semibold text-sf-accent-text"
                >
                  You save {formatMoney(discountTotal, currency)}
                </p>
              )}
            </div>
            <Link
              href="/checkout"
              onClick={() => setOpen(false)}
              className="block rounded-sf-control bg-sf-inverse px-5 py-3 text-center text-sm font-semibold text-sf-on-inverse transition hover:bg-sf-inverse-hover"
            >
              Checkout →
            </Link>
            <p className="mt-2 text-center text-sf-2xs text-sf-text-faint">
              Any cash on delivery fee is added at checkout
            </p>
          </footer>
        )}
      </aside>
    </>
  );
}
