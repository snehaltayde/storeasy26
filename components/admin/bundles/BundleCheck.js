"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { cn } from "@/components/ui/utils";
import { reasonSentence } from "@/lib/commerce/bundle-words";

// A bundle's compatibility check in words (Phase 2 line 4): the products'
// sum against the bundle price and the saving, or the reasons it can't be
// sold. Every sentence comes from lib/commerce/bundle-words.js, built from the
// structured `reasons` (never the legacy problem strings). The pure helpers
// below are the form's rules (the same as the editor's BundleForm, which line
// 6 replaces; it stays untouched here).

const PICKED = /^gid:\/\/[^/]+\/ProductVariant\/\S+$/;
export const isPickedVariant = (v) => PICKED.test(String(v ?? ""));
// a quantity box that is empty, not a number or under 1: the row asks for
// one and nothing is checked or saved until it is 1 or more
export const emptyQuantity = (q) => q === "" || q == null || !Number.isFinite(Number(q)) || Number(q) < 1;
export const quantityFrom = (text) => {
  const t = String(text ?? "").trim();
  if (t === "") return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
};
const whole = (v) => Math.max(1, Math.round(Number(v)) || 1);

// Put a picked variant into the rows: at a row index (that row changes) or
// "new". A variant already in another row adds to that row's quantity.
export function applyPick(rows, at, pick) {
  const other = rows.findIndex((r, i) => r.variantId === pick.variantId && i !== at);
  if (other >= 0) {
    const add = at === "new" ? 1 : rows[at].quantity;
    const next = rows.map((r, i) => (i === other ? { ...r, quantity: whole(r.quantity) + whole(add) } : r));
    return at === "new" ? next : next.filter((_, i) => i !== at);
  }
  const row = { variantId: pick.variantId, quantity: 1, label: pick.label || null };
  if (at === "new") return [...rows, row];
  return rows.map((r, i) => (i === at ? { ...row, quantity: r.quantity } : r));
}

// the saving to the cent; `cart` is what the offer engine takes off (whole)
export function savingOf(componentsSum, price) {
  const sum = Number(componentsSum);
  const p = Number(price);
  if (!(sum > 0) || !(p > 0)) return { exact: 0, cart: 0 };
  const diff = Math.max(0, sum - p);
  return { exact: Math.round(diff * 100) / 100, cart: Math.round(diff) };
}

export const reasonWords = (r, currency) => reasonSentence(r, { currency: currency ?? undefined }) || (typeof r?.words === "string" ? r.words : "");
const ROW = new Set(["sold_out", "missing", "duplicate", "bad_quantity"]);
const PRICE = new Set(["no_saving", "bad_price"]);
export const rowWords = (reasons, i, currency) => (reasons || []).filter((r) => ROW.has(r.kind) && r.index === i).map((r) => reasonWords(r, currency)).filter(Boolean);
export const priceWords = (reasons, currency) => (reasons || []).filter((r) => PRICE.has(r.kind)).map((r) => reasonWords(r, currency)).filter(Boolean);
export const otherWords = (reasons, currency) => (reasons || []).filter((r) => !ROW.has(r.kind) && !PRICE.has(r.kind)).map((r) => reasonWords(r, currency)).filter(Boolean);
// every reason, with the product it is about: "Serum: Sold out"
export const allWords = (reasons, currency) => (reasons || []).map((r) => [r.title, reasonWords(r, currency)].filter(Boolean).join(": ")).filter(Boolean);

export const componentLabel = (c) => {
  if (!c?.title) return null;
  const vt = c.variant_title && !/^default( title)?$/i.test(c.variant_title) ? c.variant_title : "";
  return vt ? `${c.title} — ${vt}` : c.title;
};

// check: { state, reasons, componentsSum } (POST {check} or the page's first)
export function BundleCheck({ check, price, currency, checking = false, error = null }) {
  const money = (n) => formatMoney(Number(n) || 0, currency ?? undefined);
  if (error) return <p className="text-sm text-warning-text" data-bundle-check="error">{error}</p>;
  if (!check) return <p className="text-sm text-muted-foreground" data-bundle-check="none">{checking ? "Checking…" : "Pick at least two products and a price to see the saving."}</p>;
  const passes = check.state === "available";
  const saving = passes ? savingOf(check.componentsSum, price) : null;
  // [words, isPrice]: a price reason carries data-bundle-price-reason (the p5 drill reads it)
  const said = [...priceWords(check.reasons, currency).map((w) => [w, true]), ...otherWords(check.reasons, currency).map((w) => [w, false])];
  const sum = Number(check.componentsSum) || 0;
  const cheaper = sum > 0 && Number(price) > 0 && Number(price) < sum;
  return (
    <div className="space-y-3 text-sm" aria-live="polite" data-bundle-check={passes ? "passes" : "fails"}>
      {sum > 0 && (
        <dl className="grid grid-cols-3 overflow-hidden rounded-md border border-border bg-muted" data-bundle-figures>
          <div className="px-3 py-2">
            <dt className="text-xs text-muted-foreground">Products add up to</dt>
            <dd className={cn("mt-0.5 font-mono text-sm tabular-nums text-muted-foreground", cheaper && "line-through decoration-muted-foreground/70")}>{money(sum)}</dd>
          </div>
          <div className="border-l border-border px-3 py-2">
            <dt className="text-xs text-muted-foreground">Bundle price</dt>
            <dd className="mt-0.5 font-mono text-sm font-medium tabular-nums text-foreground">{money(price)}</dd>
          </div>
          <div className={cn("border-l border-border px-3 py-2", passes && "bg-success/10")}>
            <dt className="text-xs text-muted-foreground">Shoppers save</dt>
            <dd className={cn("mt-0.5 font-mono text-sm font-medium tabular-nums", passes ? "text-success" : "text-muted-foreground")}>{passes ? money(saving.exact) : "Nothing yet"}</dd>
          </div>
        </dl>
      )}
      {passes ? (
        <p className="flex items-start gap-2 text-success" data-bundle-saving>
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Shoppers save {money(saving.exact)}.{saving.cart !== saving.exact ? ` The cart takes off ${money(saving.cart)}, as it rounds to a whole amount.` : ""} It can be shown to shoppers.
          </span>
        </p>
      ) : (
        <ul className="space-y-1 text-warning-text" data-bundle-reasons>
          {(said.length ? said : [["Fix the products listed above before shoppers can see it.", false]]).map(([w, isPrice], i) => (
            <li key={i} className="flex items-start gap-2" data-bundle-price-reason={isPrice ? "" : undefined}>
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
