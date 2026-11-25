"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCart } from "@/components/cart/CartContext";
import { formatMoney, discountPercent } from "@/lib/format";

// Phase 4 line 2: underPrice and underAtc are server-rendered plugin slots
// (components/plugins/PluginSlot.js) passed in by the PDP layouts.
export default function ProductPurchase({ product, underPrice = null, underAtc = null }) {
  const {
    options = [],
    variants = [],
    title,
    handle,
    featured_image,
    currency = "INR",
    available: productAvailable,
  } = product;

  const { addItem, setOpen } = useCart();

  const defaultVariant = variants.find((v) => v.available) || variants[0] || null;
  const [selected, setSelected] = useState(() => {
    const init = {};
    (defaultVariant?.selectedOptions || []).forEach((o) => {
      init[o.name] = o.value;
    });
    return init;
  });
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  const currentVariant = useMemo(() => {
    if (!variants.length) return null;
    return (
      variants.find((v) =>
        (v.selectedOptions || []).every((o) => selected[o.name] === o.value),
      ) || null
    );
  }, [variants, selected]);

  const price = currentVariant?.price ?? product.price_min;
  const compareAt = currentVariant?.compare_at_price ?? product.compare_at_min;
  const available = currentVariant ? currentVariant.available : productAvailable;
  const pct = compareAt ? discountPercent(price, compareAt) : 0;

  // Only surface option pickers for real multi-variant products.
  const showOptions =
    options.length > 0 && !(options.length === 1 && (options[0].values || []).length <= 1);

  // S38 (SF04): invalid-variant feedback. For each option value, does ANY
  // variant exist (and is any of them in stock) with that value plus the
  // OTHER current selections? Non-existent combinations get struck through.
  const valueState = useMemo(() => {
    const state = {};
    for (const opt of options) {
      for (const val of opt.values || []) {
        const want = { ...selected, [opt.name]: val };
        const matches = variants.filter((v) => (v.selectedOptions || []).every((o) => want[o.name] === o.value));
        state[`${opt.name}:${val}`] = matches.length === 0 ? "missing" : matches.some((v) => v.available) ? "ok" : "soldout";
      }
    }
    return state;
  }, [options, variants, selected]);

  function choose(name, value) {
    setSelected((s) => ({ ...s, [name]: value }));
    setAdded(false);
  }

  // S38 (SF04): sticky mobile CTA — a bottom bar appears once the main add
  // button scrolls out of view (small screens only).
  const addRef = useRef(null);
  const [showSticky, setShowSticky] = useState(false);
  useEffect(() => {
    if (!addRef.current || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(([entry]) => setShowSticky(!entry.isIntersecting), { threshold: 0 });
    obs.observe(addRef.current);
    return () => obs.disconnect();
  }, []);

  function handleAdd() {
    if (!currentVariant || !available) return;
    // Server derives price/title/image from the catalog by variant GID.
    addItem(currentVariant.id, qty);
    setAdded(true);
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-bold text-sf-text">{formatMoney(price, currency)}</span>
        {pct > 0 && (
          <>
            <span className="text-lg text-sf-text-faint line-through">
              {formatMoney(compareAt, currency)}
            </span>
            <span className="rounded-sf-xs bg-sf-sale-soft px-2 py-0.5 text-sm font-bold text-sf-on-sale-soft">
              Save {pct}%
            </span>
          </>
        )}
      </div>

      <p className={`mt-2 text-sm font-medium ${available ? "text-sf-accent-text" : "text-sf-text-faint"}`}>
        {available ? "● In stock" : "● Sold out"}
      </p>

      {underPrice}

      {showOptions && (
        <div className="mt-6 space-y-5">
          {options.map((opt) => (
            <div key={opt.name}>
              <p className="mb-2 text-sm font-semibold text-sf-text-body">
                {opt.name}
                {selected[opt.name] ? (
                  <span className="ml-2 font-normal text-sf-text-faint">{selected[opt.name]}</span>
                ) : null}
              </p>
              <div className="flex flex-wrap gap-2">
                {(opt.values || []).map((val) => {
                  const isSel = selected[opt.name] === val;
                  const state = valueState[`${opt.name}:${val}`] || "ok";
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => choose(opt.name, val)}
                      aria-pressed={isSel}
                      title={state === "missing" ? "Not available with the current selection" : state === "soldout" ? "Sold out" : undefined}
                      className={`rounded-sf-small border px-3.5 py-2 text-sm font-medium transition ${
                        isSel
                          ? "border-sf-inverse bg-sf-inverse text-sf-on-inverse"
                          : state === "missing"
                            ? "border-dashed border-sf-border bg-sf-surface text-sf-mark line-through hover:border-sf-border-strong"
                            : state === "soldout"
                              ? "border-sf-border bg-sf-surface text-sf-text-faint line-through hover:border-sf-border-hover"
                              : "border-sf-border bg-sf-surface text-sf-text-body hover:border-sf-border-hover"
                      }`}
                    >
                      {val}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {showOptions && !currentVariant && (
        <p className="mt-4 rounded-sf-control bg-sf-warning-surface px-4 py-3 text-sm text-sf-warning-strong">
          This combination isn&rsquo;t available — struck-through values don&rsquo;t exist together. Pick a different option.
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <div className="inline-flex items-center rounded-sf-control border border-sf-border">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            className="px-3.5 py-3 text-sf-text-muted hover:text-sf-text"
            aria-label="Decrease quantity"
          >
            −
          </button>
          <span className="min-w-8 text-center text-sm font-medium">{qty}</span>
          <button
            type="button"
            onClick={() => setQty((q) => q + 1)}
            className="px-3.5 py-3 text-sf-text-muted hover:text-sf-text"
            aria-label="Increase quantity"
          >
            +
          </button>
        </div>

        <button
          ref={addRef}
          type="button"
          onClick={handleAdd}
          disabled={!available || !currentVariant}
          className="flex-1 rounded-sf-control bg-sf-accent px-6 py-3.5 text-sm font-bold text-sf-on-accent transition enabled:hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:bg-sf-surface-strong disabled:text-sf-text-faint"
        >
          {available ? (currentVariant ? "Add to cart" : "Select options") : "Sold out"}
        </button>
      </div>

      {underAtc}

      {added && available && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 w-full rounded-sf-control border border-sf-border px-6 py-3 text-sm font-semibold text-sf-text-body transition hover:border-sf-border-hover"
        >
          Added ✓ — View cart
        </button>
      )}

      {/* S38 (SF04): sticky mobile CTA — shows once the main button scrolls away */}
      {showSticky && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-sf-border bg-sf-surface/95 px-4 py-3 shadow-sf-bar backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-7xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-sf-text">{title}</p>
              <p className="text-sm font-bold text-sf-text">{formatMoney(price, currency)}</p>
            </div>
            <button
              type="button"
              onClick={added ? () => setOpen(true) : handleAdd}
              disabled={!added && (!available || !currentVariant)}
              className="rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent transition enabled:hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:bg-sf-surface-strong disabled:text-sf-text-faint"
            >
              {added ? "View cart" : available ? (currentVariant ? "Add to cart" : "Select options") : "Sold out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
