"use client";

import { useRef } from "react";
import { cx } from "./cx";

// Console tabs (S50): role=tablist with arrow-key navigation. Used for
// list filters (orders statuses) and view switches. Counts render as small
// numeric suffixes, not chips.
export function Tabs({ items, active, onChange, label, className = "" }) {
  const refs = useRef([]);
  const move = (from, delta) => {
    const next = (from + delta + items.length) % items.length;
    refs.current[next]?.focus();
    onChange(items[next].id);
  };
  return (
    <div role="tablist" aria-label={label} className={cx("flex flex-wrap items-center gap-1 border-b border-edge", className)}>
      {items.map((it, i) => {
        const selected = it.id === active;
        return (
          <button
            key={it.id}
            ref={(el) => (refs.current[i] = el)}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(it.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(i, 1);
              if (e.key === "ArrowLeft") move(i, -1);
            }}
            className={cx(
              "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-ring motion-safe:transition-colors",
              selected ? "border-primary font-medium text-fg" : "border-transparent text-fg-muted hover:border-edge-strong hover:text-fg"
            )}
          >
            {it.label}
            {it.count != null && <span className={cx("text-xs tabular-nums", selected ? "text-fg-muted" : "text-fg-subtle")}>{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
