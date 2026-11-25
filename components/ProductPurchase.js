"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCart } from "@/components/cart/CartContext";
import { formatMoney, discountPercent } from "@/lib/format";
import { useMoney } from "@/components/MarketContext";
import StickyBuyBar from "@/components/pdp/StickyBuyBar";
import DeliveryCheck from "@/components/pdp/DeliveryCheck";

// Phase 4 line 2: underPrice and underAtc are server-rendered plugin slots
// (components/plugins/PluginSlot.js) passed in by the PDP layouts.
export default function ProductPurchase({ product, underPrice = null, underAtc = null }) {
  const { money, market } = useMoney(); // Phase 8 line 4: the same convertPrice the cart line uses
  const {
    options = [],
    variants = [],
    title,
    handle,
    featured_image,
    currency = "INR",
    available: productAvailable,
  } = product;

  const { addItem, setOpen, open: drawerOpen } = useCart();

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
  const [adding, setAdding] = useState(false);
  const optionsRef = useRef(null);

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

  // Phase 7 line 3: the bar's "Choose …" names the first option group without a
  // value that fits (none chosen, or one that doesn't exist with the others)
  const unchosen =
    showOptions && !currentVariant
      ? options.find((o) => !selected[o.name] || valueState[`${o.name}:${selected[o.name]}`] !== "ok") || options[0]
      : null;
  const variantLabel =
    currentVariant && showOptions ? (currentVariant.selectedOptions || []).map((o) => o.value).join(" · ") : "";

  function chooseFirstGroup() {
    const group = unchosen && optionsRef.current?.querySelector(`[data-option-group="${CSS.escape(unchosen.name)}"]`);
    if (!group) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    group.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    group.querySelector("button")?.focus({ preventScroll: true });
  }

  function choose(name, value) {
    setSelected((s) => ({ ...s, [name]: value }));
    setAdded(false);
  }

  // S38 (SF04): sticky mobile CTA — a bottom bar appears once the main add
  // button scrolls out of view (small screens only).
  const addRef = useRef(null);
  const [showSticky, setShowSticky] = useState(false);
  // Phase 7 line 3: only once the button has scrolled out above the screen
  // (not while it is still below the fold on first load).
  useEffect(() => {
    if (!addRef.current || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(([entry]) => setShowSticky(!entry.isIntersecting && entry.boundingClientRect.top < 0), { threshold: 0 });
    obs.observe(addRef.current);
    return () => obs.disconnect();
  }, []);

  // the page's spacer below lg: room at the end so the bar never covers the footer
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 1023.98px)");
    if (!mq) return;
    const body = document.body;
    const prev = body.style.paddingBottom;
    const apply = () => {
      body.style.paddingBottom = mq.matches ? "calc(5rem + env(safe-area-inset-bottom))" : prev;
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => {
      mq.removeEventListener?.("change", apply);
      body.style.paddingBottom = prev;
    };
  }, []);

  async function handleAdd() {
    if (!currentVariant || !available || adding) return; // no double tap
    setAdding(true);
    try {
      // Server derives price/title/image from the catalog by variant GID.
      await addItem(currentVariant.id, qty);
      setAdded(true);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-bold text-sf-text">{money(price, currency)}</span>
        {pct > 0 && (
          <>
            <span className="text-lg text-sf-text-faint line-through">
              {money(compareAt, currency)}
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
        <div ref={optionsRef} className="mt-6 space-y-5">
          {options.map((opt) => (
            <div key={opt.name} role="group" aria-label={opt.name} data-option-group={opt.name}>
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

      {/* Phase 8 line 1: PIN code → delivery estimate, cash on delivery, free shipping */}
      {/* Phase 8 line 4: PIN codes are the store's own country's; a market has no check */}
      {!market && <DeliveryCheck currency={currency} />}

      {/* S38 (SF04) → Phase 7 line 3: the phone buy bar (components/pdp/StickyBuyBar.js) */}
      <StickyBuyBar
        visible={showSticky && !drawerOpen}
        title={title}
        image={currentVariant?.image_url || featured_image}
        variantLabel={variantLabel}
        price={price}
        compareAt={compareAt}
        currency={currency}
        state={adding ? "adding" : added && available && currentVariant ? "view" : unchosen ? "choose" : !available ? "soldout" : "add"}
        chooseLabel={unchosen ? `Choose ${unchosen.name.toLowerCase()}` : undefined}
        onAdd={handleAdd}
        onView={() => setOpen(true)}
        onChoose={chooseFirstGroup}
      />
    </div>
  );
}
