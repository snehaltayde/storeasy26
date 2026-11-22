"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, X } from "lucide-react";
import { Dialog } from "@/components/console/Dialog";
import { Button, IconButton } from "@/components/console/Button";
import { Input } from "@/components/console/fields";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { SkeletonText, EmptyState } from "@/components/console/bits";
import { cx } from "@/components/console/cx";

// THE catalog reference picker (S53 B2, on the B1 refs read model): every
// place a form takes a product/collection/variant opens this dialog instead
// of asking for a typed handle or GID. Mirrors MediaPicker's dialog pattern.
// It works in catalog IDs — callers map to whatever they persist (handles,
// GIDs) at the form boundary. Hydration via ids= keeps pre-selected entries
// visible IN ORDER, and ids the catalog lost render as explicit "missing"
// chips — never silently dropped.

const NOUN = { product: "product", collection: "collection", variant: "variant" };

const money = (v, cur) => {
  if (v == null) return null;
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(v));
  } catch {
    return `${v} ${cur || ""}`.trim();
  }
};

export async function fetchRefs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") sp.set(k, String(v));
  const res = await fetch(`/api/admin/refs?${sp}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Couldn't load the catalog (${res.status})`);
  return data;
}

// Human label for a hydrated item (used by selected chips and VariantPicker).
export function refLabel(item) {
  if (!item || item.missing) return item?.id || "";
  return item.title || item.handle || item.id;
}

const Thumb = ({ src, size = "size-9" }) =>
  src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" className={cx(size, "shrink-0 rounded-ctl border border-edge bg-surface-sunken object-cover")} />
  ) : (
    <span className={cx(size, "shrink-0 rounded-ctl border border-edge bg-surface-sunken")} aria-hidden />
  );

function RowMeta({ type, item }) {
  if (type === "collection")
    return (
      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-subtle">
        <span className="truncate font-mono">{item.handle}</span>
        {item.product_count != null && <span>· {item.product_count} product{item.product_count === 1 ? "" : "s"}</span>}
      </span>
    );
  if (type === "variant")
    return (
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
        {(item.options || [])
          .filter((o) => o?.value && o.value !== "Default Title")
          .map((o, i) => (
            <span key={i}>
              {o.name}: {o.value}
            </span>
          ))}
        {item.sku && <span className="font-mono">SKU {item.sku}</span>}
      </span>
    );
  return <span className="mt-0.5 block truncate font-mono text-xs text-fg-subtle">{item.handle}</span>;
}

// One searchable, paginated list over /api/admin/refs. Owns its load/error/
// empty states (house rules: no loading/error nulls). The refs API ignores
// q for variants (one product's variants come back complete), so variant
// lists filter locally instead.
function RefList({ active, type, collectionId, productId, selectedIds = [], addDisabled = false, onPick }) {
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState("loading"); // loading | error | ready
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [syncedAt, setSyncedAt] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const debounceRef = useRef(null);
  const reqSeq = useRef(0);

  const baseParams = useCallback(
    (query) => ({
      type,
      limit: 25,
      ...(type === "variant" ? { product: productId } : { q: query }),
      ...(type === "product" && collectionId ? { collection: collectionId } : {}),
    }),
    [type, collectionId, productId]
  );

  const load = useCallback(
    async (query) => {
      const seq = ++reqSeq.current;
      setPhase("loading");
      setError(null);
      try {
        const data = await fetchRefs(baseParams(query));
        if (seq !== reqSeq.current) return;
        setItems(data.items || []);
        setNextCursor(data.nextCursor || null);
        setSyncedAt(data.syncedAt || null);
        setPhase("ready");
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError(String(e?.message || e));
        setPhase("error");
      }
    },
    [baseParams]
  );

  // Reset + load whenever the list becomes the active step.
  useEffect(() => {
    if (!active) return;
    setQ("");
    load("");
    return () => clearTimeout(debounceRef.current);
  }, [active, load]);

  const onSearch = (value) => {
    setQ(value);
    if (type === "variant") return; // local filter — the API lists them all
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(value), 250);
  };

  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const data = await fetchRefs({ ...baseParams(q), cursor: nextCursor });
      setItems((cur) => [...cur, ...(data.items || [])]);
      setNextCursor(data.nextCursor || null);
      setSyncedAt(data.syncedAt || syncedAt);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoadingMore(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const visible =
    type === "variant" && needle
      ? items.filter((it) => `${it.title} ${it.sku || ""} ${(it.options || []).map((o) => o.value).join(" ")}`.toLowerCase().includes(needle))
      : items;

  return (
    <div className="space-y-3">
      <Input
        type="search"
        placeholder={type === "variant" ? "Filter variants by title, option or SKU…" : `Search ${NOUN[type]}s by title${type === "product" ? ", handle or SKU" : " or handle"}…`}
        value={q}
        onChange={(e) => onSearch(e.target.value)}
        aria-label={`Search ${NOUN[type]}s`}
      />
      {phase === "error" && (
        <Banner tone="danger" actions={<Button size="sm" onClick={() => load(q)}>Retry</Button>}>
          {error}
        </Banner>
      )}
      {phase === "loading" && <SkeletonText lines={4} />}
      {phase === "ready" && visible.length === 0 && (
        <EmptyState
          className="py-6"
          title={needle ? "No matches" : `No ${NOUN[type]}s synced yet`}
          body={needle ? "Try a different search." : "Sync the catalog to pick from it here."}
        />
      )}
      {phase === "ready" && visible.length > 0 && (
        <>
          <ul className="max-h-80 divide-y divide-edge overflow-y-auto rounded-ctl border border-edge" aria-label={`Synced ${NOUN[type]}s`}>
            {visible.map((item) => {
              const picked = selectedIds.includes(item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onPick(item)}
                    disabled={addDisabled && !picked}
                    aria-pressed={picked}
                    className={cx(
                      "flex w-full items-center gap-3 px-3 py-2 text-left text-sm focus-ring",
                      picked ? "bg-surface-sunken" : "hover:bg-surface-sunken",
                      addDisabled && !picked && "cursor-not-allowed opacity-50"
                    )}
                  >
                    <Thumb src={item.thumb} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium text-fg">{item.title}</span>
                        {item.status === "unavailable" && <Badge tone="warning">Unavailable</Badge>}
                      </span>
                      <RowMeta type={type} item={item} />
                    </span>
                    {money(type === "variant" ? item.price : item.price_min, item.currency) && (
                      <span className="shrink-0 text-xs tabular-nums text-fg-muted">{money(type === "variant" ? item.price : item.price_min, item.currency)}</span>
                    )}
                    {picked && <Check size={14} className="shrink-0 text-success" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
          {nextCursor && (
            <Button size="sm" busy={loadingMore} onClick={loadMore}>
              Load more
            </Button>
          )}
        </>
      )}
      {syncedAt && <p className="text-xs text-fg-subtle">Catalog synced {new Date(syncedAt).toLocaleString()}</p>}
    </div>
  );
}

// ---- the picker dialog --------------------------------------------------------

export function RefPicker({ open, onClose, type = "product", multi = false, selectedIds = [], onConfirm, title, collectionId, max }) {
  const [selected, setSelected] = useState([]); // hydrated items, in order
  const [hydration, setHydration] = useState("ready"); // ready | loading | error
  const [hydrationErr, setHydrationErr] = useState(null);

  const hydrate = useCallback(async () => {
    if (!multi || !selectedIds.length) {
      setSelected([]);
      setHydration("ready");
      return;
    }
    setHydration("loading");
    setHydrationErr(null);
    try {
      const data = await fetchRefs({ type, ids: selectedIds.join(",") });
      setSelected(data.items || []);
      setHydration("ready");
    } catch (e) {
      setHydrationErr(String(e?.message || e));
      setHydration("error");
    }
    // selectedIds as a join: the array prop is rebuilt by callers each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, type, selectedIds.join(",")]);

  useEffect(() => {
    if (open) hydrate();
  }, [open, hydrate]);

  const atMax = multi && max != null && selected.length >= max;

  function pick(item) {
    if (!multi) {
      onConfirm?.([item]);
      onClose?.();
      return;
    }
    setSelected((sel) => {
      const already = sel.some((s) => s.id === item.id); // duplicate prevention
      if (already) return sel.filter((s) => s.id !== item.id);
      if (max != null && sel.length >= max) return sel;
      return [...sel, item];
    });
  }

  const move = (i, dir) =>
    setSelected((sel) => {
      const j = i + dir;
      if (j < 0 || j >= sel.length) return sel;
      const next = [...sel];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const noun = NOUN[type];
  const dialogTitle = title || (multi ? `Choose ${noun}s` : `Choose a ${noun}`);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={dialogTitle}
      size="lg"
      footer={
        multi ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={hydration !== "ready"}
              onClick={() => {
                onConfirm?.(selected);
                onClose?.();
              }}
            >
              Confirm{selected.length ? ` (${selected.length}${max != null ? `/${max}` : ""})` : ""}
            </Button>
          </>
        ) : null
      }
    >
      <div className="space-y-3">
        {multi && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">
              Selected <span className="text-fg-subtle">({selected.length}{max != null ? `/${max}` : ""})</span>
              {max != null && atMax ? " — at the limit; remove one to add another" : ""}
            </p>
            {hydration === "loading" && <SkeletonText lines={1} />}
            {hydration === "error" && (
              <Banner tone="danger" actions={<Button size="sm" onClick={hydrate}>Retry</Button>}>
                Couldn&rsquo;t load your current selections — confirming is disabled so nothing gets dropped. {hydrationErr}
              </Banner>
            )}
            {hydration === "ready" && selected.length === 0 && <p className="text-xs text-fg-subtle">Nothing selected yet — pick from the list below.</p>}
            {hydration === "ready" && selected.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {selected.map((s, i) => (
                  <li
                    key={s.id}
                    className={cx(
                      "inline-flex items-center gap-1 rounded-ctl border px-2 py-1 text-[11px]",
                      s.missing ? "border-danger-edge bg-danger-bg text-danger" : "border-edge bg-surface-sunken text-fg"
                    )}
                  >
                    {s.missing ? (
                      <span className="font-mono" title={s.id}>
                        {s.id.length > 28 ? `…${s.id.slice(-24)}` : s.id} — missing from catalog
                      </span>
                    ) : (
                      <span className="max-w-48 truncate" title={refLabel(s)}>
                        {refLabel(s)}
                      </span>
                    )}
                    {!s.missing && (
                      <>
                        <IconButton label={`Move ${refLabel(s)} earlier`} icon={<ArrowUp size={12} aria-hidden />} disabled={i === 0} onClick={() => move(i, -1)} />
                        <IconButton
                          label={`Move ${refLabel(s)} later`}
                          icon={<ArrowDown size={12} aria-hidden />}
                          disabled={i === selected.length - 1}
                          onClick={() => move(i, 1)}
                        />
                      </>
                    )}
                    <IconButton label={`Remove ${s.missing ? s.id : refLabel(s)}`} icon={<X size={12} aria-hidden />} onClick={() => setSelected((sel) => sel.filter((x) => x.id !== s.id))} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <RefList active={open} type={type} collectionId={collectionId} selectedIds={selected.map((s) => s.id)} addDisabled={atMax} onPick={pick} />
      </div>
    </Dialog>
  );
}

// Preset convenience wrappers.
export const ProductPicker = (props) => <RefPicker type="product" {...props} />;
export const CollectionPicker = (props) => <RefPicker type="collection" {...props} />;

// ---- variant picker: product first, then its variants --------------------------

// Two-step dialog: search/paginate products, then list THAT product's variants
// (option values + SKU). Confirms one variant explicitly — it never auto-picks
// a first variant. onConfirm({ variantId, productId, productHandle, label,
// variant, product }).
export function VariantPicker({ open, onClose, onConfirm, title = "Choose a variant", selectedVariantId }) {
  const [product, setProduct] = useState(null); // step 2 when set
  const [current, setCurrent] = useState(null); // hydrated existing selection | null
  const [currentErr, setCurrentErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setProduct(null);
    setCurrent(null);
    setCurrentErr(null);
    if (!selectedVariantId) return;
    let stale = false;
    fetchRefs({ type: "variant", ids: selectedVariantId })
      .then((data) => {
        if (!stale) setCurrent(data.items?.[0] || null);
      })
      .catch((e) => {
        if (!stale) setCurrentErr(String(e?.message || e));
      });
    return () => {
      stale = true;
    };
  }, [open, selectedVariantId]);

  const confirmVariant = (v) => {
    const vt = v.title && v.title !== "Default" && v.title !== "Default Title" ? v.title : "";
    onConfirm?.({
      variantId: v.id,
      productId: product.id,
      productHandle: product.handle,
      label: vt ? `${product.title} — ${vt}` : product.title,
      variant: v,
      product,
    });
    onClose?.();
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-3">
        {!product && selectedVariantId && (
          <p className="text-xs text-fg-muted">
            Currently selected:{" "}
            {current ? (
              current.missing ? (
                <Badge tone="danger" title={selectedVariantId}>
                  missing from catalog
                </Badge>
              ) : (
                <span className="font-medium text-fg">
                  {refLabel(current)}
                  {current.sku ? ` · SKU ${current.sku}` : ""}
                </span>
              )
            ) : currentErr ? (
              <span className="text-warning">couldn&rsquo;t check it ({currentErr})</span>
            ) : (
              <span className="text-fg-subtle">checking…</span>
            )}
          </p>
        )}
        {!product ? (
          <>
            <p className="text-xs text-fg-muted">Step 1 of 2 — pick the product, then one of its variants.</p>
            <RefList active={open && !product} type="product" onPick={setProduct} />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <IconButton label="Back to products" icon={<ChevronLeft size={14} aria-hidden />} onClick={() => setProduct(null)} />
              <Thumb src={product.thumb} size="size-7" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{product.title}</span>
              <span className="shrink-0 font-mono text-xs text-fg-subtle">{product.handle}</span>
            </div>
            <RefList active={open && !!product} type="variant" productId={product.id} selectedIds={selectedVariantId ? [selectedVariantId] : []} onPick={confirmVariant} />
          </>
        )}
      </div>
    </Dialog>
  );
}
