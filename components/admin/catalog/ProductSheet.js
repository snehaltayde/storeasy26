"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Info, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyCell } from "@/components/kit/money-cell";
import { entityEditorHref } from "@/lib/admin/editor-entry";
import { roleAllows } from "@/lib/platform/authz";
import { ContentBadge, PriceRange, StockWords, Thumb, fetchCatalog } from "./ProductsTable";

// The product sheet (docs/plans/phase-2.md "Line 3" §1.2): what Shopify sends
// (variants with SKU, price and stock; collections; vendor), what is
// published (badge and modules), and the way to the editor: "Edit content"
// for a role that may write the storefront, "View content" for support. Every
// control is a read (data-read-control); the sheet writes nothing.
export const PRICE_NOTE = "Price and stock change in Shopify. The name, description, photos and modules shoppers see are set in the editor.";

export const editorLinkLabel = (role, kind = "product") => (roleAllows(role, "storefront.write") ? (kind === "collection" ? "Edit collection content" : "Edit content") : kind === "collection" ? "View collection content" : "View content");

export function SheetLinks({ editorHref, editorLabel, storeUrl, shopifyUrl }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link href={editorHref} data-read-control data-editor-link="" className={buttonVariants({ size: "sm" })}>
        {editorLabel}
      </Link>
      {storeUrl && (
        <a href={storeUrl} target="_blank" rel="noopener" data-read-control className={buttonVariants({ variant: "outline", size: "sm" })}>
          View on store
          <ExternalLink aria-hidden data-icon="inline-end" />
        </a>
      )}
      {shopifyUrl && (
        <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" data-read-control className={buttonVariants({ variant: "outline", size: "sm" })}>
          View in Shopify
          <ExternalLink aria-hidden data-icon="inline-end" />
        </a>
      )}
    </div>
  );
}

export function SheetCloseButton() {
  return (
    <SheetClose asChild>
      <Button type="button" variant="ghost" size="icon-sm" data-read-control aria-label="Close" className="absolute top-3 right-3">
        <X aria-hidden />
      </Button>
    </SheetClose>
  );
}

function Fact({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-foreground">{children}</dd>
    </div>
  );
}

function Body({ d, role, currency }) {
  const p = d.product;
  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-6">
      <SheetLinks editorHref={p.editorHref} editorLabel={editorLinkLabel(role)} storeUrl={p.storeUrl} shopifyUrl={p.shopifyUrl} />
      <div className="space-y-2">
        <p data-price-note="" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {PRICE_NOTE}
        </p>
        <dl className="divide-y divide-border">
        <Fact label="Price">
          <PriceRange min={p.priceMin} max={p.priceMax} currency={p.currency || currency} />
        </Fact>
        <Fact label="Stock">
          <StockWords available={p.available} inventory={p.totalInventory} />
        </Fact>
        <Fact label="Vendor">{p.vendor || "—"}</Fact>
        <Fact label="Shopify type">{p.productType || "—"}</Fact>
        </dl>
      </div>
      <section aria-labelledby="sheet-variants" className="space-y-2">
        <h3 id="sheet-variants" className="text-sm font-semibold text-foreground">
          Variants ({d.variants.length})
        </h3>
        <ul className="divide-y divide-border rounded-card border border-border">
          {d.variants.map((v) => (
            <li key={v.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate text-foreground">{v.title === "Default Title" ? "Default" : v.title}</span>
                <span className="block truncate font-mono text-xs whitespace-nowrap text-muted-foreground">{v.sku ? `SKU ${v.sku}` : "No SKU"}</span>
              </span>
              <span className="text-right text-xs">
                <StockWords available={v.available} />
              </span>
              <MoneyCell amount={v.price} currency={v.currency || currency} className="min-w-16" />
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="sheet-collections" className="space-y-2">
        <h3 id="sheet-collections" className="text-sm font-semibold text-foreground">
          Collections
        </h3>
        {d.collections.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {d.collections.map((c) => (
              <li key={c.id}>
                <Badge variant="outline">{c.title}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Not in any collection.</p>
        )}
      </section>
      <Separator />
      <section aria-labelledby="sheet-published" className="space-y-2">
        <h3 id="sheet-published" className="text-sm font-semibold text-foreground">
          Published on your store
        </h3>
        {d.published.state === "ok" ? (
          <dl className="divide-y divide-border">
            <Fact label="Badge">{d.published.badge || "None"}</Fact>
            <Fact label="Modules">{d.published.modules.length ? d.published.modules.join(", ") : "None"}</Fact>
          </dl>
        ) : (
          <p data-published-unavailable="" className="flex gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{d.published.note}</span>
          </p>
        )}
      </section>
    </div>
  );
}

export function ProductSheet({ product, onOpenChange, role, currency }) {
  const [state, setState] = useState({ id: null, data: null, error: null });
  const id = product?.productId || null;

  useEffect(() => {
    if (!id || product?.inShopify === false) return;
    let live = true;
    setState({ id, data: null, error: null });
    fetchCatalog({ view: "product", id })
      .then((data) => live && setState({ id, data, error: null }))
      .catch((e) => live && setState({ id, data: null, error: e.message }));
    return () => {
      live = false;
    };
  }, [id]);

  const d = state.id === id ? state.data : null;
  return (
    <Sheet open={Boolean(product)} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-catalog="product-sheet">
        <SheetCloseButton />
        <SheetHeader className="pr-12">
          <div className="flex items-start gap-3">
            <Thumb src={d?.product.image || product?.thumb} size="lg" />
            <div className="min-w-0 space-y-1">
              <SheetTitle className="truncate">{d?.product.title || product?.title || "Product"}</SheetTitle>
              <SheetDescription className="truncate">{(d?.product.shopifyTitle || product?.shopifyTitle) ? `Shopify: ${d?.product.shopifyTitle || product?.shopifyTitle}` : product?.handle || ""}</SheetDescription>
              <div className="pt-1">
                <ContentBadge state={d?.product.content || product?.content} />
              </div>
            </div>
          </div>
        </SheetHeader>
        {state.error && state.id === id ? (
          <p role="alert" className="px-4 text-sm text-destructive">
            {state.error}
          </p>
        ) : d ? (
          <Body d={d} role={role} currency={currency} />
        ) : product && !product.inShopify ? (
          <div className="space-y-3 px-4">
            <p className="rounded-md bg-destructive/5 px-3 py-2 text-sm text-foreground">This product is no longer in Shopify. Its content is kept, and shoppers can't reach it.</p>
            <SheetLinks editorHref={entityEditorHref({ product: product.productId })} editorLabel={editorLinkLabel(role)} />
          </div>
        ) : (
          <div aria-busy="true" className="space-y-3 px-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-12 w-full" />
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
            <Skeleton className="h-24 w-full rounded-card" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
