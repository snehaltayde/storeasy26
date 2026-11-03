"use client";

import { useCart } from "./CartContext";

export default function CartButton() {
  const { count, setOpen } = useCart();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-header-fg transition hover:bg-header-fg/10"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-sf-accent px-1 text-sf-2xs font-bold text-sf-on-accent">
          {count}
        </span>
      )}
    </button>
  );
}
