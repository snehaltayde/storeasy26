"use client";

// P4-PICKER (ED-12, OVL-04): an ordered list of products, picked through the
// catalog picker (/api/admin/refs, components/admin/cms/RefPicker.js).
//
//   ProductPicks        the shared list: each product by the name the store
//                       shows (the effective title), with "Shopify title: X"
//                       under it when Shopify calls it something else;
//                       Move up, Move down and Remove on each row (buttons,
//                       so the keyboard reaches them); "Choose products"
//                       opens the picker
//   ProductListControl  collection_content.pinned (setting kind product_ids):
//                       a list of Shopify product ids, in order
//
// Props are the inspector's (controls.js): field, value, onChange, issues
// (placed: [{ anchor, issue }]), owner, context, readOnly. From context:
//   lookupProducts(ids) -> Promise<[{ id, title, shopify_title?, handle,
//                       missing? }]> in the order asked (the refs read's ids=
//                       hydration). Without it the refs read is called here.
// The stored value is ids only; names are looked up, never stored.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ListPlus, Trash2 } from "lucide-react";
import { Button, IconButton } from "../../../console/Button.js";
import { ProductPicker, fetchRefs } from "../../shared/RefPicker.js";
import { Notes } from "./controls.js";
import { idOf, notesId, notesAt, moveIn, removeAt } from "./inspectorModel.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const described = (anchor, notes) => (notes.length ? notesId(anchor) : undefined);

// What one row says: the name shoppers see first, Shopify's name second when
// it differs. A product the catalog no longer has says so in plain words.
export function productLine(item) {
  if (!isObj(item)) return { primary: "Loading…", secondary: null, missing: false, loading: true };
  if (item.missing) return { primary: "No longer in your Shopify catalog", secondary: null, missing: true, loading: false };
  const primary = String(item.title || item.handle || "Untitled product");
  const shop = typeof item.shopify_title === "string" && item.shopify_title.trim() ? item.shopify_title : null;
  return { primary, secondary: shop && shop !== primary ? `Shopify title: ${shop}` : null, missing: false, loading: false };
}

// The products in `ids` that `known` doesn't hold yet.
export const unknownIds = (ids, known) => (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && !Object.hasOwn(known || {}, id));

const defaultLookup = async (ids) => (await fetchRefs({ type: "product", ids: ids.join(","), limit: ids.length })).items || [];

// The anchors a ProductPicks list renders at `path` for `ids`.
export const picksPaths = (path, ids) => [path, ...(Array.isArray(ids) ? ids : []).map((_, j) => `${path}.${j}`)];

export function ProductPicks({ id, owner, path, label, ids, onChange, issues, context = {}, readOnly = false, max = null, hint = null, children = null }) {
  const list = Array.isArray(ids) ? ids : [];
  const [known, setKnown] = useState({});
  const [picking, setPicking] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const missing = unknownIds(list, known);
  const key = missing.join(",");

  useEffect(() => {
    if (!missing.length) return undefined;
    let stale = false;
    const lookup = typeof context.lookupProducts === "function" ? context.lookupProducts : defaultLookup;
    Promise.resolve()
      .then(() => lookup(missing))
      .then((items) => {
        if (stale) return;
        const got = {};
        for (const it of Array.isArray(items) ? items : []) if (isObj(it) && typeof it.id === "string") got[it.id] = it;
        for (const m of missing) if (!got[m]) got[m] = { id: m, missing: true };
        setKnown((k) => ({ ...k, ...got }));
        setLookupError(null);
      })
      .catch(() => {
        if (!stale) setLookupError("We couldn't load the product names. Reload the page to see them.");
      });
    return () => {
      stale = true;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const notes = notesAt(issues, id);
  const full = max != null && list.length >= max;
  const nameOf = (pid, j) => {
    const l = productLine(known[pid]);
    return l.loading || l.missing ? `product ${j + 1}` : l.primary;
  };
  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 rounded-ctl border border-edge p-3 focus-ring" data-product-picks="">
      <p id={`${id}--label`} className="mb-2 text-xs font-medium text-fg-muted">
        {label}
      </p>
      <div className="space-y-3">
        {children}
        {list.length === 0 && <p className="text-xs text-fg-subtle">No products yet.</p>}
        {list.length > 0 && (
          <ol className="divide-y divide-edge rounded-ctl border border-edge" aria-label={label}>
            {list.map((pid, j) => {
              const rid = idOf(owner, `${path}.${j}`);
              const rnotes = notesAt(issues, rid);
              const line = productLine(known[pid]);
              const name = nameOf(pid, j);
              return (
                <li key={`${pid}-${j}`} className="px-2.5 py-1.5" data-pick={pid}>
                  <div className="flex items-start gap-1.5">
                    <span id={rid} tabIndex={-1} aria-describedby={described(rid, rnotes)} className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${line.missing ? "text-warning" : "text-fg"}`} data-pick-title="">
                        {`${j + 1}. ${line.primary}`}
                      </span>
                      {line.secondary && (
                        <span className="block truncate text-xs text-fg-muted" data-pick-shopify="">
                          {line.secondary}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center">
                      <IconButton label={`Move ${name} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={readOnly || j === 0} onClick={() => onChange(moveIn(list, j, -1))} />
                      <IconButton label={`Move ${name} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={readOnly || j === list.length - 1} onClick={() => onChange(moveIn(list, j, 1))} />
                      <IconButton label={`Remove ${name}`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={() => onChange(removeAt(list, j))} />
                    </span>
                  </div>
                  <Notes anchor={rid} notes={rnotes} />
                </li>
              );
            })}
          </ol>
        )}
        {lookupError && <p className="text-xs text-warning">{lookupError}</p>}
        <Button size="sm" icon={<ListPlus size={13} aria-hidden />} disabled={readOnly} onClick={() => setPicking(true)}>
          {list.length ? "Change the products" : "Choose products"}
        </Button>
      </div>
      {(hint || max != null) && <p className="mt-1 text-xs text-fg-subtle">{[hint, max != null ? `${list.length} of ${max} products${full ? ". The list is full." : ""}` : null].filter(Boolean).join(" ")}</p>}
      <Notes anchor={id} notes={notes} />
      {picking && (
        <ProductPicker
          open={picking}
          multi
          max={max ?? undefined}
          selectedIds={list}
          title={`Choose products: ${label}`}
          onClose={() => setPicking(false)}
          onConfirm={(items) => {
            const picked = (Array.isArray(items) ? items : []).filter((it) => isObj(it) && typeof it.id === "string");
            const got = {};
            for (const it of picked) got[it.id] = it;
            setKnown((k) => ({ ...k, ...got }));
            onChange(picked.map((it) => it.id));
          }}
        />
      )}
    </div>
  );
}

// collection_content.pinned: the products shown first on the collection page,
// in this order. An empty list stores null (no pins).
export default function ProductListControl({ field, value, onChange, issues, owner = null, context = {}, readOnly = false }) {
  const id = idOf(owner, field.path);
  return (
    <ProductPicks
      id={id}
      owner={owner}
      path={field.path}
      label={field.label}
      ids={Array.isArray(value) ? value : []}
      onChange={(ids) => onChange(ids.length ? ids : null)}
      issues={issues}
      context={context}
      readOnly={readOnly}
      max={field.setting?.max ?? null}
      hint="Shown first on the collection page, in this order."
    />
  );
}
ProductListControl.paths = (field, value) => picksPaths(field.path, value);
