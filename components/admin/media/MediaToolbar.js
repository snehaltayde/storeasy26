"use client";

import { LayoutGrid, List, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/components/ui/utils";
import { SORT_WORDS, TYPE_FILTERS } from "@/components/admin/media/media-words";

// The library's reads (Phase 2 line 5 §1): Active / Archived tabs with
// counts, search by file name or alt text, the type filter, the sort and the
// grid / list toggle. All of them only ask the server for another page, so
// each carries data-read-control (scripts/support/read-controls.js). None
// sits in a form, so Enter in the search submits nothing. The type and sort
// filters are native selects: no portal and no focus guards, and the phone's
// own picker. The tab list is marked too: Radix makes it focusable (Tab
// lands on it and moves on to the current tab), and it does nothing else.
const SELECT = "h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none";

export function MediaToolbar({ tab, counts, q, type, sort, view, onTab, onQ, onType, onSort, onView }) {
  return (
    <div data-media="toolbar" className="mb-4 flex flex-col gap-3">
      {/* Row 1: which files, and how they are shown. Row 2: narrowing them;
          on phones the two selects share a line so the files start sooner. */}
      <div className="flex items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={onTab}>
          <TabsList aria-label="Which files" data-read-control>
            <TabsTrigger value="active" data-read-control>
              Active <span className="font-mono tabular-nums text-muted-foreground">{counts?.active ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger value="archived" data-read-control>
              Archived <span className="font-mono tabular-nums text-muted-foreground">{counts?.archived ?? 0}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div role="group" aria-label="Show as" className="flex shrink-0 gap-1">
          {[
            ["grid", "Grid", LayoutGrid],
            ["list", "List", List],
          ].map(([v, label, Icon]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              aria-label={`Show as ${label.toLowerCase()}`}
              data-read-control
              onClick={() => onView(v)}
              className={cn(
                "inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
                view === v && "border-input bg-muted text-foreground",
              )}
            >
              <Icon aria-hidden className="size-4" />
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={q} onChange={(e) => onQ(e.target.value)} placeholder="Search by name or alt text" aria-label="Search files" maxLength={200} className="pl-8" data-read-control />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <select value={type} onChange={(e) => onType(e.target.value)} aria-label="File type" className={cn(SELECT, "w-full sm:w-36")} data-read-control>
            <option value="">All types</option>
            {TYPE_FILTERS.map(([v, w]) => (
              <option key={v} value={v}>
                {w}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => onSort(e.target.value)} aria-label="Sort" className={cn(SELECT, "w-full sm:w-40")} data-read-control>
            {SORT_WORDS.map(([v, w]) => (
              <option key={v} value={v}>
                {w}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
