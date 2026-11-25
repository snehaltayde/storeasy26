"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { fetchCatalog } from "./ProductsTable";

// The Collections tab (docs/plans/phase-2.md "Line 3" §1.3): title, handle,
// product count and pinned count. Loaded the first time the tab opens; a
// row's title opens the collection's products (CollectionProducts). Reads only.
const num = (n) => (n == null ? <span className="text-muted-foreground">—</span> : <span className="font-mono tabular-nums">{n}</span>);

export function CollectionsTable({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    fetchCatalog({ view: "collections" })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [attempt]);

  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <span>{error}</span>
        <Button type="button" variant="outline" size="sm" data-read-control onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  const columns = [
    {
      key: "title",
      header: "Collection",
      className: "max-w-0 w-full",
      cell: (c) => (
        <button type="button" data-read-control onClick={() => onOpen(c)} title={c.title} className="block max-w-full truncate text-left font-medium text-foreground hover:underline focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {c.title}
        </button>
      ),
    },
    { key: "handle", header: "Handle", className: "hidden w-px whitespace-nowrap pl-6 font-mono text-xs text-muted-foreground sm:table-cell" },
    { key: "products", header: "Products", align: "right", className: "w-px whitespace-nowrap pl-6", cell: (c) => num(c.products) },
    { key: "pinned", header: "Pinned", align: "right", className: "w-px whitespace-nowrap pl-6", cell: (c) => num(c.pinned) },
  ];
  return (
    <div data-catalog="collections" className="space-y-3">
      {data?.published === "unavailable" && (
        <p data-published-unavailable="" className="flex gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{data.note}</span>
        </p>
      )}
      <DataTable
        label="Collections"
        columns={columns}
        rows={data?.items || []}
        loading={!data}
        empty={<EmptyState title="No collections yet" description="Collections come in from Shopify with your products. Make one in Shopify, then sync." />}
        footer={data ? { offset: 0, total: data.items.length } : null}
      />
    </div>
  );
}
