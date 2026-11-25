"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/kit/data-table";
import { StatusBadge } from "@/components/kit/status-badge";
import { fmtDate, fmtDims, fmtSize, TYPE_WORDS } from "@/components/admin/media/media-words";

// The library's files (Phase 2 line 5 §1): a grid of thumbnails, or a list
// (the kit's DataTable). Opening a file is a read (it opens the details
// sheet), so the card and the list's name button carry data-read-control.
// Thumbnails are the file's thumb variant, else the file, both through
// /api/media/<id> (mediaUrl), never a blob or a storage address.
//   items, view: "grid" | "list", loading, onOpen(item)
// 12px across and 16px down on phones, 16 / 24 from 640px: the caption
// belongs to the thumbnail above it, so rows sit further apart than columns.
const GRID = "grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-6 lg:grid-cols-4 xl:grid-cols-5";
const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none";

export function MediaGridSkeleton({ count = 10 }) {
  return (
    <ul aria-hidden data-media="skeleton" className={GRID}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex flex-col gap-2">
          <Skeleton className="aspect-square w-full rounded-card" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

export function MediaGrid({ items, view, loading, onOpen, footer = null, empty = null }) {
  if (view === "list") {
    const columns = [
      {
        key: "filename",
        header: "Name",
        cell: (m) => (
          <button type="button" data-read-control onClick={() => onOpen(m)} title={m.filename} className={`flex max-w-[16rem] items-center gap-2 rounded-md text-left hover:underline ${FOCUS}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.thumbUrl} alt="" loading="lazy" className="size-8 shrink-0 rounded-md border border-border bg-muted object-contain" />
            <span className="truncate">{m.filename}</span>
            {m.archived_at && <StatusBadge kind="media" status="archived" />}
          </button>
        ),
      },
      { key: "mime", header: "Type", cell: (m) => TYPE_WORDS[m.mime] || m.mime },
      { key: "size", header: "Size", align: "right", cell: (m) => <span className="font-mono tabular-nums">{fmtSize(m.size)}</span> },
      { key: "dims", header: "Dimensions", cell: (m) => fmtDims(m) },
      { key: "created_at", header: "Uploaded", cell: (m) => fmtDate(m.created_at) },
    ];
    return <DataTable label="Files" columns={columns} rows={items} loading={loading} empty={empty} footer={footer} />;
  }
  if (loading) return <MediaGridSkeleton />;
  if (!items.length) return empty;
  return (
    <ul data-media="grid" className={GRID}>
      {items.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            data-read-control
            data-media-id={m.id}
            onClick={() => onOpen(m)}
            className={`group flex w-full flex-col gap-2 rounded-card text-left ${FOCUS}`}
          >
            {/* Square, the muted fill around the image, 8px inside the edge;
                a small image stays its own size instead of blurring up. */}
            <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-card border border-border bg-muted p-2 transition-colors group-hover:border-muted-foreground/40 motion-reduce:transition-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.thumbUrl} alt={m.alt || ""} loading="lazy" className="max-h-full max-w-full object-contain" />
              {m.archived_at && <StatusBadge kind="media" status="archived" className="absolute top-2 left-2" />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground" title={m.filename}>
                {m.filename}
              </span>
              <span className="text-xs text-muted-foreground">
              {TYPE_WORDS[m.mime] || m.mime} · <span className="font-mono tabular-nums">{fmtSize(m.size)}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
