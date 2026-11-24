"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/components/ui/utils";

// The console's list table (docs/UI.md "Components" and "States"), on
// components/ui/table. No client-side sorting, filtering or paging: the page
// asks the server and passes the result in (no TanStack).
//
//   columns: [{ key, header, cell?(row), align?: "right", truncate?: true,
//              sortable?: true, className? }]
//            cell defaults to row[key]; truncate cuts the text to the column
//            and shows the whole of it in a tooltip (cell must be a string)
//   rows, rowKey(row) (default row.id)
//   rowHref(row): the row's page; the first column's text becomes the link
//   rowActions(row): the row's own controls (role-gated by the page), last column
//   loading: skeleton rows in place of the body; skeletonRows (default 5)
//   empty: what an empty, loaded table shows (an <EmptyState/>)
//   sort { key, dir: "asc"|"desc" } and onSort(key): sortable headers
//   footer: { offset, total, onPrevious, onNext } shows "1–50 of N" with
//           Previous/Next; { total, onLoadMore, loadingMore } shows "Load more"
//   label: the table's accessible name
//
// Rows are 40px (48px on a touch screen); the header sticks to the top of a
// scroll box capped below the viewport height, so header and footer stay in
// view on a 50-row page. Sort buttons, row links and the footer are reads, so
// they carry data-read-control (support's stray-control rule on a new-UI route).
const ROW = "h-10 pointer-coarse:h-12";

function SortButton({ column, sort, onSort }) {
  const dir = sort?.key === column.key ? sort.dir : null;
  const Icon = dir === "asc" ? ArrowUp : dir === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <button
      type="button"
      data-read-control
      onClick={() => onSort?.(column.key)}
      className={cn("-mx-1 inline-flex items-center gap-1 rounded-md px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", column.align === "right" && "flex-row-reverse")}
    >
      {column.header}
      <Icon aria-hidden className={cn("size-3.5", !dir && "opacity-50")} />
    </button>
  );
}

function CellText({ column, row }) {
  const value = column.cell ? column.cell(row) : row[column.key];
  if (!column.truncate || typeof value !== "string") return value ?? null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-full truncate">{value}</span>
      </TooltipTrigger>
      <TooltipContent>{value}</TooltipContent>
    </Tooltip>
  );
}

function Footer({ footer, count }) {
  if (!footer || !count) return null;
  const { offset = 0, total = count, onPrevious, onNext, onLoadMore, loadingMore = false } = footer;
  const range = `${offset + 1}–${offset + count} of ${total}`;
  return (
    <div data-kit="data-table-footer" className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <span className="font-mono tabular-nums">{range}</span>
      {onLoadMore ? (
        offset + count < total && (
          <Button type="button" variant="outline" size="sm" data-read-control onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )
      ) : (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" data-read-control onClick={onPrevious} disabled={!onPrevious || offset <= 0}>
            Previous
          </Button>
          <Button type="button" variant="outline" size="sm" data-read-control onClick={onNext} disabled={!onNext || offset + count >= total}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export function DataTable({ columns, rows = [], rowKey = (r) => r.id, rowHref = null, rowActions = null, loading = false, skeletonRows = 5, empty = null, sort = null, onSort = null, footer = null, label, className }) {
  if (!loading && rows.length === 0 && empty) return empty;
  const span = columns.length + (rowActions ? 1 : 0);
  return (
    <div data-kit="data-table" className={cn("overflow-hidden rounded-card border border-border bg-card", className)}>
      <Table aria-label={label} aria-busy={loading || undefined} containerClassName="max-h-[calc(100dvh-14rem)] overflow-auto">
        <TableHeader className="sticky top-0 z-10">
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => (
              <TableHead key={c.key} scope="col" aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={cn(c.align === "right" && "text-right", c.className)}>
                {c.sortable && onSort ? <SortButton column={c} sort={sort} onSort={onSort} /> : c.header}
              </TableHead>
            ))}
            {rowActions && (
              <TableHead scope="col" className="w-px text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <TableRow key={`sk-${i}`} data-kit="skeleton-row" className={ROW}>
                  <TableCell colSpan={span}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            : rows.map((row) => {
                const href = rowHref?.(row) || null;
                return (
                  <TableRow key={rowKey(row)} className={ROW}>
                    {columns.map((c, i) => (
                      <TableCell key={c.key} className={cn(c.align === "right" && "text-right", c.truncate && "max-w-0 w-full", c.className)}>
                        {href && i === 0 ? (
                          <Link href={href} data-read-control className="block truncate font-medium text-foreground hover:underline focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                            <CellText column={c} row={row} />
                          </Link>
                        ) : (
                          <CellText column={c} row={row} />
                        )}
                      </TableCell>
                    ))}
                    {rowActions && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">{rowActions(row)}</div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
        </TableBody>
      </Table>
      {!loading && <Footer footer={footer} count={rows.length} />}
    </div>
  );
}
