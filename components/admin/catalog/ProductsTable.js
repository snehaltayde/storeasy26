"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ImageIcon, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { cn } from "@/components/ui/utils";
import { shopifyImage } from "@/lib/format";

// The Products tab (docs/plans/phase-2.md "Line 3" §1.1): search, the
// content filters with the store's counts, the stock filter, 50 a page by
// cursor. Every control here is a read (data-read-control): the page holds no
// write. A row's name opens the product sheet (CatalogTabs).

export const PAGE_SIZE = 50;

// GET /api/admin/catalog?view=… -> the JSON, or throws with plain words
export async function fetchCatalog(params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  let res;
  try {
    res = await fetch(`/api/admin/catalog?${qs}`, { cache: "no-store" });
  } catch {
    throw new Error("We couldn't reach your store. Check your connection and try again.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(res.status === 404 ? "That's no longer in your catalog." : "We couldn't load your catalog. Try again.");
  return body;
}

export const CONTENT_WORDS = Object.freeze({
  published: ["Published", "success"],
  draft: ["Draft changes", "warning"],
  shopify_only: ["Shopify only", "muted"],
  gone: ["No longer in Shopify", "danger"],
});

export function ContentBadge({ state }) {
  const [label, tone] = CONTENT_WORDS[state] || CONTENT_WORDS.shopify_only;
  return (
    <Badge variant={tone} data-content-state={state}>
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />
      {label}
    </Badge>
  );
}

export function PriceRange({ min, max, currency }) {
  if (min == null) return <MoneyCell amount={null} currency={currency} />;
  if (max == null || max === min) return <MoneyCell amount={min} currency={currency} />;
  return (
    <span className="flex items-center justify-end gap-1">
      <MoneyCell amount={min} currency={currency} className="inline" />
      <span aria-hidden className="text-muted-foreground">–</span>
      <span className="sr-only">to</span>
      <MoneyCell amount={max} currency={currency} className="inline" />
    </span>
  );
}

// A product photo, or a quiet placeholder when there is none or it fails to load.
export function Thumb({ src, size = "sm" }) {
  const [broken, setBroken] = useState(false);
  const box = size === "lg" ? "size-12" : "size-8";
  if (!src || broken) return <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground", box)}><ImageIcon className={size === "lg" ? "size-5" : "size-3.5"} /></span>;
  return <img src={shopifyImage(src, size === "lg" ? 160 : 80)} alt="" loading="lazy" onError={() => setBroken(true)} className={cn("shrink-0 rounded-md border border-border bg-muted object-cover", box)} />;
}

export function StockWords({ available, inventory }) {
  if (available == null) return <span className="text-muted-foreground">—</span>;
  if (!available) return <span className="whitespace-nowrap text-destructive">Sold out</span>;
  if (inventory == null) return <span className="whitespace-nowrap text-foreground">In stock</span>;
  return (
    <span className="whitespace-nowrap text-foreground">
      <span className="font-mono tabular-nums">{inventory}</span> in stock
    </span>
  );
}

const FILTERS = [
  { key: "all", label: "All", count: "all" },
  { key: "edited", label: "Edited", count: "edited" },
  { key: "changed_in_shopify", label: "Changed in Shopify", count: "changedInShopify" },
  { key: "orphaned", label: "No longer in Shopify", count: "orphaned" },
];
const STOCK = [
  { key: "any", label: "Any stock" },
  { key: "in_stock", label: "In stock" },
  { key: "sold_out", label: "Sold out" },
];

function Segmented({ label, options, value, onChange, counts }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          data-read-control
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset pointer-coarse:h-9",
            value === o.key && "bg-card text-foreground shadow-card",
          )}
        >
          {o.label}
          {counts && o.count && <span className="font-mono text-xs tabular-nums text-muted-foreground">{counts[o.count] ?? 0}</span>}
        </button>
      ))}
    </div>
  );
}

export function ProductsTable({ initial, currency, onOpen }) {
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState({ q: "", filter: "all", stock: "any" });
  const [cursors, setCursors] = useState([]); // the cursors of the pages before this one
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const typed = useRef(null);
  const seq = useRef(0);

  async function load(next, at = null, before = []) {
    const mine = ++seq.current;
    setQuery(next);
    setLoading(true);
    setError(null);
    try {
      const body = await fetchCatalog({ view: "products", q: next.q, filter: next.filter, stock: next.stock, cursor: at });
      if (mine !== seq.current) return;
      setData(body);
      setCursor(at);
      setCursors(before);
    } catch (e) {
      if (mine === seq.current) setError(e.message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  const onType = (q) => {
    clearTimeout(typed.current);
    typed.current = setTimeout(() => load({ ...query, q: q.trim() }), 250);
  };
  const clear = () => {
    const box = document.getElementById("catalog-search");
    if (box) box.value = "";
    load({ q: "", filter: "all", stock: "any" });
  };

  const counts = data?.counts || { all: 0, edited: 0, changedInShopify: 0, orphaned: 0 };
  const filtered = query.q || query.filter !== "all" || query.stock !== "any";
  const columns = [
    { key: "thumb", header: <span className="sr-only">Image</span>, className: "w-12", cell: (r) => <Thumb src={r.thumb} /> },
    {
      key: "title",
      header: "Name",
      className: "max-w-0 w-full",
      cell: (r) => (
        <>
          <button type="button" data-read-control onClick={() => onOpen(r)} title={r.title} className="block max-w-full text-left focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span className="block truncate font-medium text-foreground hover:underline">{r.title}</span>
            {r.shopifyTitle && <span className="block truncate text-xs text-muted-foreground">Shopify: {r.shopifyTitle}</span>}
          </button>
          <div className="mt-1 sm:hidden">
            <ContentBadge state={r.content} />
          </div>
        </>
      ),
    },
    { key: "productType", header: "Type", className: "hidden w-px whitespace-nowrap text-muted-foreground lg:table-cell", cell: (r) => r.productType || "—" },
    { key: "price", header: "Price", align: "right", className: "w-px whitespace-nowrap pl-6", cell: (r) => <PriceRange min={r.priceMin} max={r.priceMax} currency={r.currency || currency} /> },
    { key: "stock", header: "Stock", align: "right", className: "hidden w-px whitespace-nowrap pl-6 sm:table-cell", cell: (r) => <StockWords available={r.available} inventory={r.totalInventory} /> },
    { key: "content", header: "Content", className: "hidden w-px pl-6 sm:table-cell", cell: (r) => <ContentBadge state={r.content} /> },
  ];

  const empty =
    counts.all === 0 && counts.orphaned === 0 && !filtered ? (
      <EmptyState
        title="Your catalog is empty"
        description="Products come in from Shopify. Connect Shopify in onboarding to bring them in."
        action={
          <Link href="/admin/onboarding" data-read-control className={buttonVariants({ size: "sm" })}>
            Connect Shopify in onboarding
          </Link>
        }
      />
    ) : (
      <EmptyState
        icon={Search}
        title="No products match"
        description={query.q ? `Nothing matches "${query.q}" with these filters.` : "No products match these filters."}
        action={
          <Button type="button" variant="outline" size="sm" data-read-control onClick={clear}>
            Clear search and filters
          </Button>
        }
      />
    );

  return (
    <div data-catalog="products" className="space-y-3">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <form method="get" role="search" onSubmit={(e) => e.preventDefault()} className="relative w-full md:max-w-sm xl:max-w-60">
          <label htmlFor="catalog-search" className="sr-only">
            Search products
          </label>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="catalog-search" name="q" type="search" data-read-control placeholder="Search by name or handle" autoComplete="off" onChange={(e) => onType(e.target.value)} className="pl-8" />
        </form>
        <div className="flex min-w-0 flex-wrap gap-2 xl:flex-nowrap">
          <Segmented label="Content" options={FILTERS} value={query.filter} counts={counts} onChange={(filter) => load({ ...query, filter })} />
          <Segmented label="Stock" options={STOCK} value={query.stock} onChange={(stock) => load({ ...query, stock })} />
        </div>
      </div>
      {error ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <span>{error}</span>
          <Button type="button" variant="outline" size="sm" data-read-control onClick={() => load(query, cursor, cursors)}>
            Try again
          </Button>
        </div>
      ) : (
        <DataTable
          label="Products"
          columns={columns}
          rows={data?.items || []}
          rowKey={(r) => r.productId}
          loading={loading}
          skeletonRows={8}
          empty={empty}
          footer={{
            offset: cursors.length * PAGE_SIZE,
            total: data?.total ?? (data?.items || []).length,
            onPrevious: cursors.length ? () => load(query, cursors[cursors.length - 1], cursors.slice(0, -1)) : null,
            onNext: data?.nextCursor ? () => load(query, data.nextCursor, [...cursors, cursor]) : null,
          }}
        />
      )}
    </div>
  );
}
