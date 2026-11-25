"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CollectionProducts } from "./CollectionProducts";
import { CollectionsTable } from "./CollectionsTable";
import { ProductSheet } from "./ProductSheet";
import { ProductsTable } from "./ProductsTable";

// The Catalog page's two tabs (docs/plans/phase-2.md "Line 3"): Products (the
// first page comes from the server) and Collections (loaded when first
// opened), and the sheets their rows open. Tabs and sheets are reads. The
// list and panels are out of the Tab order (tabIndex -1: Radix makes them
// focusable); the triggers keep their roving focus.
export function CatalogTabs({ initial, currency, role }) {
  const [tab, setTab] = useState("products");
  const [seen, setSeen] = useState({ products: true });
  const [product, setProduct] = useState(null);
  const [collection, setCollection] = useState(null);
  const pick = (v) => {
    setTab(v);
    setSeen((s) => ({ ...s, [v]: true }));
  };
  return (
    <>
      <Tabs value={tab} onValueChange={pick}>
        <TabsList aria-label="Catalog" tabIndex={-1}>
          <TabsTrigger value="products" data-read-control>
            Products
          </TabsTrigger>
          <TabsTrigger value="collections" data-read-control>
            Collections
          </TabsTrigger>
        </TabsList>
        <TabsContent value="products" tabIndex={-1} className="mt-4">
          <ProductsTable initial={initial} currency={currency} onOpen={setProduct} />
        </TabsContent>
        <TabsContent value="collections" tabIndex={-1} className="mt-4">
          {seen.collections && <CollectionsTable onOpen={setCollection} />}
        </TabsContent>
      </Tabs>
      <ProductSheet product={product} onOpenChange={(o) => !o && setProduct(null)} role={role} currency={currency} />
      <CollectionProducts collection={collection} onOpenChange={(o) => !o && setCollection(null)} role={role} currency={currency} />
    </>
  );
}
