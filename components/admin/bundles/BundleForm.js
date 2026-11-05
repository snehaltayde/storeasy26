"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Field, Input, Textarea } from "@/components/console/fields";
import { VariantPicker } from "@/components/admin/cms/RefPicker";
import { formatMoney } from "@/lib/format";
import { reasonSentence } from "@/lib/commerce/bundle-words";

// P5-PANEL (COM-02): THE bundle form. The console's Catalog > Bundles panel
// uses it in full mode; the editor's inline "new bundle" Dialog (P5-EDITOR)
// uses it in compact mode.
//
//   <BundleForm currency initial onSaved(bundle) compact onCancel />
//
// - Products are picked (VariantPicker), never typed. Picking a product that
//   is already in the list adds to its quantity instead of a second row (the
//   server merges duplicates too).
// - The slug is never typed: a new bundle gets one derived from its name
//   (POST { create }); an edit keeps it. The link is shown read-only.
// - A live check (POST { check }) runs on every change. Its structured
//   reasons become words through lib/commerce/bundle-words.js: per product
//   row ('Sold out', 'No longer available', …) and under the price (the
//   saving, or 'Price must be lower than <sum>'). Money goes through
//   formatMoney with the store's currency. The legacy problem strings are
//   never shown.
// - Full mode, new bundle: 'Save as draft' (saved turned off) and 'Save and
//   show to shoppers' (turned on; only when the check passes, and the server
//   saves nothing if it fails: mustPass). Edit: one 'Save changes' that sends
//   neither slug nor on/off, so a live bundle stays live (P5-BUNDLEREAD).
// - Compact mode: Name, Products, Price and one 'Create bundle', enabled
//   only when the check passes; it creates the bundle turned on (OQ-C).
//   onTitleChange(title) lets the editor's Dialog say the page the name
//   gives (P5-EDITOR).
// P5-EDITOR (the P5-PANEL review):
// - the saving keeps the currency's cents ($4.48, never $4); when the cart
//   takes off a rounded amount (the offer engine rounds to a whole amount),
//   the form says so;
// - a quantity can be cleared while typing (no keystroke turns '' into 1;
//   nothing is checked or saved while one is empty), and a typed 1.5 is
//   sent as it is, so the check's bad_quantity reason shows on its row;
// - a row stored by a product's web name (before products were picked) is
//   named: that row says to pick the product again, and nothing is checked
//   until it is (the server would refuse the whole check).

const API = "/api/admin/bundles";

async function postJson(body) {
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || "Request failed"), { body: json });
  return json;
}

// A whole quantity of 1 or more, as the offer engine takes it (used when two
// rows merge).
const wholeQuantity = (v) => Math.max(1, Math.round(Number(v)) || 1);
// The quantity box's text -> the row's quantity: '' stays '' while typing, a
// number stays as typed (1.5 is shown, and the check says why it can't be).
export const quantityFrom = (text) => {
  const t = String(text ?? "").trim();
  if (t === "") return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
};
// P5-FIX2 (the P5-EDITOR review): a quantity under 1 (0 or negative) counts
// as empty too. The check and the save would clamp it to 1, so the box would
// say 0 while the bundle stores 1; instead the row asks for a quantity and
// nothing is checked or saved until it is 1 or more.
export const emptyQuantity = (q) => q === "" || q == null || (typeof q === "string" && !Number.isFinite(Number(q))) || (typeof q === "number" && q < 1);
// A picked product (a variant id from the catalog), as the bundle route
// takes it. Anything else was stored by a web name and must be picked again.
const PICKED = /^gid:\/\/[^/]+\/ProductVariant\/\S+$/;
export const isPickedVariant = (v) => PICKED.test(String(v ?? ""));
// "Pick product 2 again." / "Pick products 2 and 3 again."
export function pickAgainWords(indexes) {
  const n = (indexes || []).map((i) => i + 1);
  if (!n.length) return "";
  if (n.length === 1) return `Pick product ${n[0]} again: it was saved by its web name, not picked from your catalog.`;
  return `Pick products ${n.slice(0, -1).join(", ")} and ${n.at(-1)} again: they were saved by their web names, not picked from your catalog.`;
}
// The saving the founder reads: to the cent, as the products and the price
// give it; `cart` is what the offer engine takes off (a whole amount).
export function savingOf(componentsSum, price) {
  const sum = Number(componentsSum);
  const p = Number(price);
  if (!(sum > 0) || !(p > 0)) return { exact: 0, cart: 0 };
  const diff = Math.max(0, sum - p);
  return { exact: Math.round(diff * 100) / 100, cart: Math.round(diff) };
}

const variantLabel = (c) => {
  if (!c?.title) return null;
  const vt = c.variant_title && !/^default( title)?$/i.test(c.variant_title) ? c.variant_title : "";
  return vt ? `${c.title} — ${vt}` : c.title;
};

// A reason as words: bundle-words first; a reason it has no sentence for
// may carry the server's own plain words (lib/bundles.js bad_quantity).
export const reasonWords = (r, currency) => reasonSentence(r, { currency: currency ?? undefined }) || (typeof r?.words === "string" ? r.words : "");

const ROW_REASONS = new Set(["sold_out", "missing", "duplicate", "bad_quantity"]);
const PRODUCT_REASONS = new Set(["too_few", "mixed_currency"]);
const PRICE_REASONS = new Set(["no_saving", "bad_price"]);

const rowsFrom = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((c) => c && typeof c.variantId === "string" && c.variantId)
    .map((c) => ({ variantId: c.variantId, quantity: c.quantity == null || c.quantity === "" ? 1 : Number(c.quantity) || 1, label: c.label || null }));

// Put a picked variant into the rows. at: a row index (that row changes) or
// "new" (a row is added). A variant already in another row adds to that
// row's quantity instead.
export function applyPick(rows, at, pick) {
  const other = rows.findIndex((r, i) => r.variantId === pick.variantId && i !== at);
  if (other >= 0) {
    const add = at === "new" ? 1 : rows[at].quantity;
    const next = rows.map((r, i) => (i === other ? { ...r, quantity: wholeQuantity(r.quantity) + wholeQuantity(add) } : r));
    return at === "new" ? next : next.filter((_, i) => i !== at);
  }
  const row = { variantId: pick.variantId, quantity: 1, label: pick.label || null };
  if (at === "new") return [...rows, row];
  return rows.map((r, i) => (i === at ? { ...row, quantity: r.quantity } : r));
}

export function BundleForm({ currency, initial = null, onSaved, compact = false, onCancel, onTitleChange }) {
  const [id, setId] = useState(initial?.id || null);
  const [slug, setSlug] = useState(initial?.slug || null);
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [price, setPrice] = useState(initial?.bundle_price != null ? String(initial.bundle_price) : "");
  const [rows, setRows] = useState(() => rowsFrom(initial?.items));
  const [check, setCheck] = useState(null); // { key, compat, currency }
  const [checkErr, setCheckErr] = useState(null);
  const [saving, setSaving] = useState(null); // "draft" | "show" | "edit" | "create"
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const [pickerAt, setPickerAt] = useState(null); // row index | "new" | null
  const seq = useRef(0);

  const key = JSON.stringify([rows.map((r) => [r.variantId, r.quantity]), price]);
  const money = (n) => formatMoney(n, (currency ?? check?.currency) || undefined);

  // the live check, on every change; a stale answer is dropped. Nothing is
  // checked while a quantity is empty or a row needs picking again.
  useEffect(() => {
    const n = ++seq.current;
    if (!rows.length || rows.some((r) => emptyQuantity(r.quantity) || !isPickedVariant(r.variantId))) {
      setCheck(null);
      setCheckErr(null);
      return;
    }
    const items = rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity }));
    postJson({ check: { items, bundle_price: price === "" ? null : Number(price) } }).then(
      (r) => {
        if (n !== seq.current) return;
        setCheck({ key, compat: r.compat || null, currency: r.currency || null });
        setCheckErr(null);
      },
      (e) => {
        if (n !== seq.current) return;
        setCheck(null);
        setCheckErr(String(e?.message || e));
      },
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = check && check.key === key ? check.compat : null;
  const reasons = current?.reasons || [];
  const passes = !!current && current.state === "available";
  const words = (r) => reasonWords(r, currency ?? check?.currency);
  const rowWords = (i) => reasons.filter((r) => ROW_REASONS.has(r.kind) && r.index === i).map(words).filter(Boolean);
  const productWords = reasons.filter((r) => PRODUCT_REASONS.has(r.kind)).map(words).filter(Boolean);
  const priceWords = reasons.filter((r) => PRICE_REASONS.has(r.kind)).map(words).filter(Boolean);
  const labelOf = (r, i) => r.label || variantLabel(current?.components?.[i]) || null;
  const saving_ = current && passes ? savingOf(current.componentsSum, price) : { exact: 0, cart: 0 };
  const unpicked = rows.map((r, i) => (isPickedVariant(r.variantId) ? -1 : i)).filter((i) => i >= 0);
  const blank = rows.some((r) => emptyQuantity(r.quantity));

  const items = () => rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity }));
  const isEdit = !!id;

  async function save(kind) {
    setSaving(kind);
    setErr(null);
    try {
      const base = { title, items: items(), bundle_price: Number(price) };
      let body;
      if (kind === "edit") body = { bundle: { id, ...base, ...(compact ? {} : { description }) } };
      else if (kind === "create") body = { create: { ...base, enable: true, mustPass: true } };
      else body = { create: { ...base, description, enable: kind === "show", mustPass: kind === "show" } };
      const r = await postJson(body);
      const b = r.bundle || {};
      setId(b.id || id);
      setSlug(b.slug || slug);
      setSaved(true);
      await onSaved?.(b);
    } catch (e) {
      const body = e?.body || {};
      if (Array.isArray(body.reasons) && body.reasons.length) setCheck({ key, compat: { state: body.state, reasons: body.reasons, components: current?.components }, currency: check?.currency || null });
      setErr(String(e?.message || e));
    } finally {
      setSaving(null);
    }
  }

  const busy = !!saving;
  const nameId = compact ? "bundle-name-compact" : "bundle-name";

  return (
    <div className={compact ? "space-y-3" : "rounded-ctl border border-edge bg-surface-sunken p-4"} data-bundle-form={compact ? "compact" : "full"}>
      <div className={compact ? "space-y-3" : "grid gap-3 sm:grid-cols-2"}>
        <Field label="Name" htmlFor={nameId} className={compact ? "" : "sm:col-span-2"}>
          <Input
            id={nameId}
            placeholder="Starter stack"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              onTitleChange?.(e.target.value);
            }}
          />
        </Field>
      </div>

      <div className="mt-4" data-bundle-products="">
        <p className="text-xs font-medium text-fg-muted">Products</p>
        {rows.length === 0 && <p className="mt-1 text-xs text-fg-subtle">Pick at least two products.</p>}
        <ul className="mt-1 space-y-2">
          {rows.map((r, i) => {
            const picked = isPickedVariant(r.variantId);
            const label = labelOf(r, i) || (picked ? null : `“${r.variantId}”`);
            const said = [
              ...(picked ? [] : ["Pick this product again with Change: it was saved by its web name."]),
              ...(emptyQuantity(r.quantity) ? ["Enter how many of this product, 1 or more."] : []),
              ...rowWords(i),
            ];
            const whole = Number.isInteger(Number(r.quantity));
            return (
              <li key={r.variantId} className="rounded-ctl border border-edge bg-surface p-2" data-bundle-row={i}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{label || (current || blank || unpicked.length ? "—" : "Checking…")}</span>
                  <Button size="sm" onClick={() => setPickerAt(i)} disabled={busy}>
                    Change
                  </Button>
                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      invalid={!whole}
                      aria-label={`Quantity of ${label || `product ${i + 1}`}`}
                      value={r.quantity}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: quantityFrom(e.target.value) } : x)))}
                    />
                  </div>
                  <IconButton label={`Remove ${label || `product ${i + 1}`}`} icon={<X size={14} aria-hidden />} disabled={busy} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
                </div>
                {said.length > 0 && (
                  <p className="mt-1 text-xs text-warning" data-bundle-row-reason="">
                    {said.join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} className="mt-2" disabled={busy} onClick={() => setPickerAt("new")}>
          Add product
        </Button>
        {productWords.length > 0 && (
          <p className="mt-1 text-xs text-warning" data-bundle-products-reason="">
            {productWords.join(" · ")}
          </p>
        )}
      </div>

      <div className={compact ? "mt-4" : "mt-4 grid gap-3 sm:grid-cols-2"}>
        <Field label="Price" htmlFor={compact ? "bundle-price-compact" : "bundle-price"}>
          <Input id={compact ? "bundle-price-compact" : "bundle-price"} type="number" min="1" value={price} onChange={(e) => setPrice(e.target.value)} />
          {priceWords.length > 0 ? (
            <p className="mt-1 text-xs text-warning" data-bundle-price-reason="">
              {priceWords.join(" · ")}
            </p>
          ) : passes ? (
            <p className="mt-1 text-xs text-fg-muted" data-bundle-saving="">
              {`The products add up to ${money(current.componentsSum)}. Shoppers save ${money(saving_.exact)}.`}
              {saving_.cart !== saving_.exact ? ` The cart takes off ${money(saving_.cart)}, as it rounds to a whole amount.` : ""}
            </p>
          ) : null}
        </Field>
      </div>

      {!compact && (
        <div className="mt-3">
          <Field label="Description" htmlFor="bundle-desc" hint="Shown on the bundle page.">
            <Textarea id="bundle-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      )}

      {slug && !compact && (
        <p className="mt-3 text-xs text-fg-muted" data-bundle-link="">
          Shoppers&apos; link: <span className="font-mono text-fg">/bundles/{slug}</span>
        </p>
      )}

      {unpicked.length > 0 && (
        <Banner tone="warning" className="mt-3">
          <span data-bundle-pick-again="">{pickAgainWords(unpicked)}</span>
        </Banner>
      )}
      {checkErr && <Banner tone="warning" className="mt-3">{checkErr}</Banner>}
      {err && <Banner tone="danger" className="mt-3">{err}</Banner>}
      {saved && !err && (
        <Banner tone="success" className="mt-3">
          Saved.{compact && slug ? ` Shoppers' link: /bundles/${slug}` : ""}
        </Banner>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {compact ? (
          <Button variant="primary" busy={saving === "create"} disabled={busy || !passes || blank || !title.trim() || saved} onClick={() => save("create")}>
            Create bundle
          </Button>
        ) : isEdit ? (
          <Button variant="primary" busy={saving === "edit"} disabled={busy || rows.length === 0 || blank || unpicked.length > 0} onClick={() => save("edit")}>
            Save changes
          </Button>
        ) : (
          <>
            <Button busy={saving === "draft"} disabled={busy || rows.length === 0 || blank || unpicked.length > 0} onClick={() => save("draft")}>
              Save as draft
            </Button>
            <Button variant="primary" busy={saving === "show"} disabled={busy || !passes || blank || !title.trim()} onClick={() => save("show")}>
              Save and show to shoppers
            </Button>
          </>
        )}
        {onCancel && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {saved ? "Done" : "Cancel"}
          </Button>
        )}
      </div>

      <VariantPicker
        open={pickerAt != null}
        onClose={() => setPickerAt(null)}
        title={pickerAt === "new" || pickerAt == null ? "Add a product" : "Change the product"}
        selectedVariantId={typeof pickerAt === "number" ? rows[pickerAt]?.variantId : undefined}
        onConfirm={(pick) => {
          if (pickerAt != null && pick?.variantId) setRows(applyPick(rows, pickerAt, pick));
        }}
      />
    </div>
  );
}

export default BundleForm;
