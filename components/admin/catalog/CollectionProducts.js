"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { ContentBadge, PriceRange, Thumb, fetchCatalog } from "./ProductsTable";
import { SheetCloseButton, SheetLinks, editorLinkLabel } from "./ProductSheet";

// One collection, opened from the Collections tab (docs/plans/phase-2.md
// "Line 3" §1.3): its products in Shopify's order, 50 at a time ("Load
// more"), and "Edit collection content" (support: "View collection
// content"). Reads only.
export function CollectionProducts({ collection, onOpenChange, role, currency }) {
  const [state, setState] = useState({ id: null, data: null, items: [], error: null, more: false, moreError: null });
  const id = collection?.id || null;

  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ id, data: null, items: [], error: null, more: false, moreError: null });
    fetchCatalog({ view: "collection", id })
      .then((data) => live && setState({ id, data, items: data.items, error: null, more: false, moreError: null }))
      .catch((e) => live && setState({ id, data: null, items: [], error: e.message, more: false, moreError: null }));
    return () => {
      live = false;
    };
  }, [id]);

  async function loadMore() {
    if (!state.data?.nextCursor) return;
    setState((s) => ({ ...s, more: true, moreError: null }));
    try {
      const next = await fetchCatalog({ view: "collection", id, cursor: state.data.nextCursor });
      setState((s) => (s.id === id ? { ...s, data: next, items: [...s.items, ...next.items], more: false } : s));
    } catch (e) {
      // the rows already loaded stay; the error shows under them
      setState((s) => (s.id === id ? { ...s, more: false, moreError: e.message } : s));
    }
  }

  const mine = state.id === id;
  const d = mine ? state.data : null;
  const columns = [
    { key: "position", header: "#", className: "w-10 font-mono text-xs text-muted-foreground tabular-nums", cell: (r) => r.position + 1 },
    { key: "thumb", header: <span className="sr-only">Image</span>, className: "w-12", cell: (r) => <Thumb src={r.thumb} /> },
    { key: "title", header: "Product", truncate: true },
    { key: "price", header: "Price", align: "right", className: "w-px whitespace-nowrap pl-4", cell: (r) => <PriceRange min={r.priceMin} max={r.priceMax} currency={r.currency || currency} /> },
    { key: "content", header: "Content", className: "hidden w-px pl-4 sm:table-cell", cell: (r) => <ContentBadge state={r.content} /> },
  ];
  return (
    <Sheet open={Boolean(collection)} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-full data-[side=right]:w-full data-[side=right]:sm:max-w-xl" data-catalog="collection-sheet">
        <SheetCloseButton />
        <SheetHeader className="pr-12">
          <SheetTitle className="truncate">{d?.collection.title || collection?.title || "Collection"}</SheetTitle>
          <SheetDescription>
            {(d?.collection.products ?? collection?.products ?? 0) === 1 ? "1 product" : `${d?.collection.products ?? collection?.products ?? 0} products`}, in the order Shopify sorts them.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-6">
          {d && <SheetLinks editorHref={d.collection.editorHref} editorLabel={editorLinkLabel(role, "collection")} storeUrl={d.collection.storeUrl} shopifyUrl={d.collection.shopifyUrl} />}
          {mine && state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : (
            <DataTable
              label="Products in this collection"
              columns={columns}
              rows={mine ? state.items : []}
              rowKey={(r) => r.productId}
              loading={!d}
              empty={<EmptyState title="No products in this collection" description="Add products to it in Shopify, then sync." />}
              // "Load more" only while the server has a next page
              footer={d ? { offset: 0, total: d.nextCursor ? Math.max(d.total, state.items.length + 1) : state.items.length, onLoadMore: loadMore, loadingMore: state.more } : null}
            />
          )}
          {mine && state.moreError && (
            <p role="alert" data-catalog="load-more-error" className="text-sm text-destructive">
              {state.moreError}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
