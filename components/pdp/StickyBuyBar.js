"use client";

import Image from "@/components/StoreImage";
import { formatMoney } from "@/lib/format";

// Phase 7 line 3 (docs/plans/phase-7.md decision 11): the phone buy bar.
// Storeasy's own part, like the buy box and the cart: data-protected, with no
// theme hook (data-part) and no plugin slot inside. It holds no state of its
// own: ProductPurchase owns the chosen variant and passes what to show.
// Below lg only. Always in the page so focus can come back to its button when
// the drawer closes; while hidden it is inert and out of the reading order.
// It sits under the drawer (z-40/50) and the consent banner (z-50).
//
// state: "add" | "adding" | "view" | "soldout" | "choose"
export const BUY_BAR_LABEL = {
  add: "Add to cart",
  adding: "Adding…",
  view: "View cart",
  soldout: "Sold out",
};

export default function StickyBuyBar({ visible, title, image, variantLabel, price, compareAt, currency = "INR", state, chooseLabel = "Choose options", onAdd, onView, onChoose }) {
  const label = state === "choose" ? chooseLabel : BUY_BAR_LABEL[state] || BUY_BAR_LABEL.add;
  const action = state === "view" ? onView : state === "choose" ? onChoose : state === "add" ? onAdd : undefined;
  const disabled = state === "soldout";
  const busy = state === "adding";
  return (
    <div
      data-protected="buy-bar"
      data-state={state}
      aria-hidden={visible ? undefined : true}
      inert={!visible}
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-sf-border bg-sf-surface/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-sf-bar backdrop-blur transition-transform duration-300 motion-reduce:transition-none lg:hidden ${
        visible ? "translate-y-0" : "invisible translate-y-full"
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3">
        <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-sf-small bg-sf-surface-sunken">
          {image ? <Image src={image} alt="" fill sizes="44px" className="object-cover" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-sf-text">{title}</p>
          <p className="flex items-baseline gap-2 text-sm">
            {variantLabel ? <span className="truncate text-sf-text-subtle">{variantLabel}</span> : null}
            <span className="font-bold text-sf-text">{formatMoney(price, currency)}</span>
            {compareAt && Number(compareAt) > Number(price) ? (
              <span className="text-xs text-sf-text-faint line-through">{formatMoney(compareAt, currency)}</span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          data-buy-bar-button
          onClick={action}
          disabled={disabled}
          aria-disabled={busy ? true : undefined}
          aria-busy={busy ? true : undefined}
          className="shrink-0 rounded-sf-control bg-sf-accent px-5 py-3 text-sm font-bold text-sf-on-accent transition enabled:hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:bg-sf-surface-strong disabled:text-sf-text-faint aria-busy:opacity-70"
        >
          {label}
        </button>
      </div>
    </div>
  );
}
