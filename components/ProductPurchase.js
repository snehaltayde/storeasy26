"use client";

import { useMemo, useState } from "react";
import { useCart } from "@/components/cart/CartContext";
import { formatMoney, discountPercent } from "@/lib/format";

export default function ProductPurchase({ product }) {
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

  function choose(name, value) {
    setSelected((s) => ({ ...s, [name]: value }));
    setAdded(false);
  }

  function handleAdd() {
    if (!currentVariant || !available) return;
    // Server derives price/title/image from the catalog by variant GID.
    addItem(currentVariant.id, qty);
    setAdded(true);
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-bold text-zinc-900">{formatMoney(price, currency)}</span>
        {pct > 0 && (
          <>
            <span className="text-lg text-zinc-400 line-through">
              {formatMoney(compareAt, currency)}
            </span>
            <span className="rounded-md bg-lime-100 px-2 py-0.5 text-sm font-bold text-lime-800">
              Save {pct}%
            </span>
          </>
        )}
      </div>

      <p className={`mt-2 text-sm font-medium ${available ? "text-lime-700" : "text-zinc-400"}`}>
        {available ? "● In stock" : "● Sold out"}
      </p>

      {showOptions && (
        <div className="mt-6 space-y-5">
          {options.map((opt) => (
            <div key={opt.name}>
              <p className="mb-2 text-sm font-semibold text-zinc-700">
                {opt.name}
                {selected[opt.name] ? (
                  <span className="ml-2 font-normal text-zinc-400">{selected[opt.name]}</span>
                ) : null}
              </p>
              <div className="flex flex-wrap gap-2">
                {(opt.values || []).map((val) => {
                  const isSel = selected[opt.name] === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => choose(opt.name, val)}
                      className={`rounded-lg border px-3.5 py-2 text-sm font-medium transition ${
                        isSel
                          ? "border-zinc-900 bg-zinc-900 text-white"
                          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
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

      <div className="mt-6 flex items-center gap-3">
        <div className="inline-flex items-center rounded-xl border border-zinc-200">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            className="px-3.5 py-3 text-zinc-600 hover:text-zinc-900"
            aria-label="Decrease quantity"
          >
            −
          </button>
          <span className="min-w-8 text-center text-sm font-medium">{qty}</span>
          <button
            type="button"
            onClick={() => setQty((q) => q + 1)}
            className="px-3.5 py-3 text-zinc-600 hover:text-zinc-900"
            aria-label="Increase quantity"
          >
            +
          </button>
        </div>

        <button
          type="button"
          onClick={handleAdd}
          disabled={!available || !currentVariant}
          className="flex-1 rounded-xl bg-lime-400 px-6 py-3.5 text-sm font-bold text-zinc-950 transition enabled:hover:bg-lime-300 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
        >
          {available ? (currentVariant ? "Add to cart" : "Select options") : "Sold out"}
        </button>
      </div>

      {added && available && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 w-full rounded-xl border border-zinc-200 px-6 py-3 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400"
        >
          Added ✓ — View cart
        </button>
      )}
    </div>
  );
}
