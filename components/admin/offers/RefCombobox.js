"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";
import { formatMoney } from "@/lib/format";

// The console's one product / variant / value picker (Phase 2 line 4): a
// Popover holding a search box and a listbox (Command and cmdk stay deferred,
// docs/UI.md). Keyboard: the search box keeps focus; ArrowDown/ArrowUp move,
// Home/End jump, Enter picks, Esc closes (focus back on the trigger), and
// Backspace in an empty box goes back from a product's sizes to the products.
//   load(q, parent) -> Promise<[{ id, label, sub?, drill? }]>: the options for
//     the search text; an option with drill opens its own list (a product's
//     sizes), and a drill with one child picks that child straight away
//   onPick(option, parent)
//   buttonText: the trigger's words; disabled: a read-only form's trigger
export function RefCombobox({ buttonText, label, load, onPick, selectedId = null, disabled = false, emptyText = "Nothing matches that search.", placeholder = "Search…", id }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [parent, setParent] = useState(null);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(0);
  // the list on screen is for an earlier search (the debounce is running or
  // the answer hasn't come): Enter waits for the fresh list
  const [stale, setStale] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const preloaded = useRef(false); // choose() already loaded this stage
  const listRef = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return undefined;
    if (preloaded.current) {
      preloaded.current = false;
      return undefined;
    }
    const n = ++seq.current;
    setStale(true);
    const h = setTimeout(
      () =>
        load(q.trim(), parent).then(
          (r) => {
            if (n !== seq.current) return;
            setItems(r);
            setError(null);
            setActive(0);
            setStale(false);
          },
          (e) => {
            if (n !== seq.current) return;
            setItems([]);
            setError(String(e?.message || e));
            setStale(false);
          },
        ),
      q ? 200 : 0,
    );
    return () => clearTimeout(h);
    // load is the caller's; the list follows the search, the stage, opening and Try again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, parent, attempt]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const reset = () => {
    seq.current++;
    preloaded.current = false;
    setQ("");
    setParent(null);
    setItems(null);
    setError(null);
    setStale(true);
  };
  const setOpenState = (v) => {
    setOpen(v);
    if (!v) reset();
  };
  const toStage = (p, list, err = null) => {
    seq.current++;
    preloaded.current = true;
    setParent(p);
    setQ("");
    setItems(list);
    setError(err);
    setActive(0);
    setStale(false);
  };
  const retry = () => {
    setError(null);
    setItems(null);
    setAttempt((x) => x + 1);
  };

  async function choose(item) {
    if (!item) return undefined;
    if (item.drill) {
      setStale(true);
      let kids;
      try {
        kids = await load("", item);
      } catch (e) {
        // the sizes didn't load: say so on this product's stage, with Try again
        return toStage(item, [], String(e?.message || e));
      }
      if (kids.length === 1) {
        onPick(kids[0], item);
        return setOpenState(false);
      }
      return toStage(item, kids);
    }
    onPick(item, parent);
    return setOpenState(false);
  }

  function onKeyDown(e) {
    const r = comboKey(e.key, { n: items?.length || 0, active, stale, q, hasParent: Boolean(parent) });
    if (r.prevent) e.preventDefault();
    if (r.active !== undefined) setActive(r.active);
    if (r.pick) choose(items?.[active]);
    if (r.back) {
      seq.current++;
      setParent(null);
      setItems(null);
    }
  }

  const optionId = (i) => `${listId}-o${i}`;
  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" id={id} disabled={disabled} aria-label={label ? `${label}: ${buttonText}` : undefined} className="w-full justify-between font-normal sm:w-80" data-ref-combobox="trigger">
          <span className="truncate">{buttonText}</span>
          <ChevronsUpDown aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-2" data-ref-combobox="popover">
        {parent && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => {
              seq.current++;
              setParent(null);
              setItems(null);
            }}
            className="mb-1 inline-flex items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft aria-hidden className="size-3.5" /> All products
          </button>
        )}
        <Input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items?.length ? optionId(active) : undefined}
          aria-label={parent ? `Search the sizes of ${parent.label}` : label || "Search"}
          placeholder={parent ? `Sizes of ${parent.label}` : placeholder}
          value={q}
          onChange={(e) => {
            setStale(true);
            setQ(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <ul ref={listRef} id={listId} role="listbox" aria-busy={stale || undefined} data-stale={stale ? "true" : undefined} aria-label={label || "Options"} className="mt-2 max-h-72 overflow-y-auto" data-ref-combobox="list">
          {items === null && <li className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</li>}
          {error && (
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm text-destructive" data-ref-combobox="error">
              <span>{error}</span>
              <Button type="button" size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            </li>
          )}
          {items && !error && items.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">{emptyText}</li>}
          {(items || []).map((o, i) => (
            <li
              key={o.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm pointer-coarse:min-h-10", i === active && "bg-muted")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.label}</span>
                {o.sub && <span className="block truncate text-xs text-muted-foreground">{o.sub}</span>}
              </span>
              {o.id === selectedId && <Check aria-label="Chosen now" className="size-4 shrink-0" />}
              {o.drill && <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// The picker's keys, as data (scripts/test-offers-console.js runs it):
//   n options, the active index, stale (the list is for an earlier search),
//   q (the search text), hasParent (on a product's sizes)
// -> { prevent, active?, pick?, back? }. Enter on a stale list does nothing.
export function comboKey(key, { n = 0, active = 0, stale = false, q = "", hasParent = false } = {}) {
  if (key === "ArrowDown") return { prevent: true, active: n ? (active + 1) % n : 0 };
  if (key === "ArrowUp") return { prevent: true, active: n ? (active - 1 + n) % n : 0 };
  if (key === "Home") return { prevent: true, active: 0 };
  if (key === "End") return { prevent: true, active: Math.max(0, n - 1) };
  if (key === "Enter") return { prevent: true, pick: !stale && n > 0 && active < n };
  if (key === "Backspace" && !q && hasParent) return { prevent: true, back: true };
  return { prevent: false };
}

// ---- loaders on GET /api/admin/refs (lib/admin/refs.js) ----

async function refs(params) {
  const res = await fetch(`/api/admin/refs?${new URLSearchParams(params)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error("Your products couldn't load. Close this and try again.");
  return data.items || [];
}

const isDefault = (t) => !t || /^default( title)?$/i.test(t);
export const variantLabel = (productTitle, variantTitle) => (isDefault(variantTitle) ? productTitle : `${productTitle} — ${variantTitle}`);
const priceText = (amount, currency) => (amount != null && currency ? formatMoney(Number(amount), currency) : null);

// products: { id, label, sub, product }
export const loadProducts = async (q) =>
  (await refs({ type: "product", q, limit: "25" })).map((p) => ({ id: p.id, label: p.title, sub: [p.shopify_title && `In Shopify: ${p.shopify_title}`, priceText(p.price_min, p.currency)].filter(Boolean).join(" · ") || null, product: p }));

// a product, then its sizes: { id (the variant gid), label, sub, variant, product }
export async function loadVariants(q, parent) {
  if (!parent) return (await loadProducts(q)).map((p) => ({ ...p, drill: true }));
  const needle = q.toLowerCase();
  return (await refs({ type: "variant", product: parent.id }))
    .filter((v) => !needle || String(v.title).toLowerCase().includes(needle) || String(v.sku || "").toLowerCase().includes(needle))
    .map((v) => ({
      id: v.id,
      label: variantLabel(parent.label, v.title),
      sub: [v.sku, priceText(v.price, v.currency), v.status === "available" ? null : "Sold out"].filter(Boolean).join(" · ") || null,
      variant: v,
      product: parent.product,
    }));
}

// a fixed list ({ value, count }), searched here: tags and product types
// options [{ value, count, label? }]: a collection (Phase 8 line 5) shows and
// searches by its title (label), and picks its handle (value)
export const valueLoader = (options) => async (q) => {
  const needle = q.toLowerCase();
  const name = (o) => o.label || o.value;
  return (options || []).filter((o) => !needle || name(o).toLowerCase().includes(needle)).map((o) => ({ id: o.value, label: name(o), sub: `${o.count} product${o.count === 1 ? "" : "s"}` }));
};
