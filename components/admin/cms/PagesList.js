"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { Tabs } from "@/components/console/Tabs";
import { Table } from "@/components/console/Table";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Input } from "@/components/console/fields";
import { IconButton } from "@/components/console/Button";
import { DangerDialog } from "@/components/console/Dialog";
import { EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";
import { cx } from "@/components/console/cx";
import { deletePage, startPreview } from "./api";
import { pageUrl, FAMILY_LABELS } from "./labels";

// The Pages list (S52): every content page across the three families, with
// family tabs, client-side search (the list is small), status derived from
// visibility windows, and row actions (edit / preview / duplicate / delete).
// Server-rendered data in; mutations call the API and router.refresh().

const FAMILY_TONES = { page: "neutral", campaign: "info", journal: "accent" };

// Visible / Hidden, plus window-derived Scheduled / Expired for campaign and
// journal pages (windows are UTC instants; "now" decides).
export function pageStatus(p, now = Date.now()) {
  if (!p.enabled) return { label: "Hidden", tone: "warning" };
  if (p.family === "campaign" || p.family === "journal") {
    if (p.window_start && now < new Date(p.window_start).getTime()) return { label: "Scheduled", tone: "info" };
    if (p.window_end && now >= new Date(p.window_end).getTime()) return { label: "Expired", tone: "neutral" };
  }
  return { label: "Visible", tone: "success" };
}

const when = (s) =>
  s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// Clickable column-sort header (Title and Last edited).
function SortHeader({ label, col, sort, onSort }) {
  const active = sort.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      aria-label={`Sort by ${label}`}
      className={cx("inline-flex items-center gap-1 rounded focus-ring hover:text-fg", active && "text-fg")}
    >
      {label}
      {active && (sort.dir === "asc" ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />)}
    </button>
  );
}

export function PagesList({ pages, pageRevisions = {} }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "updated_at", dir: "desc" }); // default: newest edits first
  const [previewBusy, setPreviewBusy] = useState(null); // slug with a preview in flight
  const [actionError, setActionError] = useState(null); // persistent (Banner), e.g. preview mint failed
  const [toDelete, setToDelete] = useState(null); // page pending the DangerDialog

  const counts = useMemo(() => {
    const c = { all: pages.length, page: 0, campaign: 0, journal: 0 };
    for (const p of pages) c[p.family] = (c[p.family] || 0) + 1;
    return c;
  }, [pages]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = pages.filter(
      (p) =>
        (tab === "all" || p.family === tab) &&
        (!needle || `${p.title || ""} ${p.slug}`.toLowerCase().includes(needle))
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "title") return dir * String(a.title || a.slug).localeCompare(String(b.title || b.slug));
      // updated_at: null (built-in standard copy, never edited) always sinks
      if (!a.updated_at && !b.updated_at) return a.slug.localeCompare(b.slug);
      if (!a.updated_at) return 1;
      if (!b.updated_at) return -1;
      return dir * String(a.updated_at).localeCompare(String(b.updated_at));
    });
  }, [pages, tab, q, sort]);

  async function preview(p) {
    setPreviewBusy(p.slug);
    setActionError(null);
    const url = pageUrl(p);
    const r = await startPreview(url);
    setPreviewBusy(null);
    if (!r.ok) {
      setActionError(r.error || "Couldn't start a preview session.");
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  if (pages.length === 0) {
    return (
      <EmptyState
        title="No pages yet"
        body="Policies, FAQs, campaign landings and journal posts all start here."
        action={
          <Link
            href="/admin/storefront/pages/new"
            className="inline-flex items-center rounded-ctl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg focus-ring hover:bg-primary-hover"
          >
            Create your first page
          </Link>
        }
      />
    );
  }

  const isRevert = toDelete?.source === "default";

  return (
    <div className="space-y-3">
      <Tabs
        label="Filter pages by family"
        active={tab}
        onChange={setTab}
        items={[
          { id: "all", label: "All", count: counts.all },
          { id: "page", label: "Pages", count: counts.page },
          { id: "campaign", label: "Campaigns", count: counts.campaign },
          { id: "journal", label: "Journal", count: counts.journal },
        ]}
      />

      <Input
        type="search"
        aria-label="Search pages"
        placeholder="Search by title or slug…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-sm"
      />

      {actionError && (
        <Banner tone="danger" title="Preview failed">
          {actionError}
        </Banner>
      )}

      <Table
        columns={[
          {
            key: "title",
            header: (
              <SortHeader label="Title" col="title" sort={sort} onSort={(k) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc" }))} />
            ),
          },
          { key: "url", header: "URL" },
          { key: "family", header: "Family" },
          { key: "status", header: "Status" },
          { key: "source", header: "Source" },
          {
            key: "updated_at",
            header: (
              <SortHeader
                label="Last edited"
                col="updated_at"
                sort={sort}
                onSort={(k) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }))}
              />
            ),
          },
          { key: "actions", header: <span className="sr-only">Actions</span>, align: "right" },
        ]}
        rows={rows}
        rowKey={(r) => r.slug}
        empty={<EmptyState title="No matches" body="Try a different search or family tab." />}
        renderCell={(p, col) => {
          if (col.key === "title")
            return (
              <Link href={`/admin/storefront/pages/${p.slug}`} className="font-medium text-fg focus-ring hover:underline">
                {p.title || p.slug}
              </Link>
            );
          if (col.key === "url") return <span className="font-mono text-[11px] text-fg-subtle">{pageUrl(p)}</span>;
          if (col.key === "family") return <Badge tone={FAMILY_TONES[p.family] || "neutral"}>{FAMILY_LABELS[p.family] || p.family}</Badge>;
          if (col.key === "status") {
            const s = pageStatus(p);
            return <Badge tone={s.tone}>{s.label}</Badge>;
          }
          if (col.key === "source")
            return p.source === "custom" ? (
              <Badge tone="neutral">Customized</Badge>
            ) : (
              <Badge tone="neutral" title="Built-in standard copy, available only on BeastLife stores. Editing it creates your own version.">
                Standard copy
              </Badge>
            );
          if (col.key === "updated_at") return <span className="whitespace-nowrap text-xs text-fg-muted">{when(p.updated_at)}</span>;
          // actions
          return (
            <span className="flex items-center justify-end gap-0.5">
              <Link
                href={`/admin/storefront/pages/${p.slug}`}
                aria-label={`Edit ${p.title || p.slug}`}
                title="Edit"
                className="inline-flex items-center justify-center rounded-ctl p-1.5 text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg motion-safe:transition-colors"
              >
                <Pencil size={14} aria-hidden />
              </Link>
              <IconButton
                label={`Preview ${p.title || p.slug}`}
                title="Preview"
                icon={<ExternalLink size={14} aria-hidden />}
                busy={previewBusy === p.slug}
                onClick={() => preview(p)}
              />
              <Link
                href={`/admin/storefront/pages/new?from=${encodeURIComponent(p.slug)}`}
                aria-label={`Duplicate ${p.title || p.slug}`}
                title="Duplicate"
                className="inline-flex items-center justify-center rounded-ctl p-1.5 text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg motion-safe:transition-colors"
              >
                <Copy size={14} aria-hidden />
              </Link>
              <IconButton
                label={p.source === "default" ? `Revert ${p.title || p.slug} to standard copy` : `Delete ${p.title || p.slug}`}
                title={p.source === "default" ? "Revert to standard copy" : "Delete"}
                icon={<Trash2 size={14} aria-hidden />}
                className="text-danger hover:bg-danger-bg hover:text-danger"
                onClick={() => setToDelete(p)}
              />
            </span>
          );
        }}
      />

      {rows.length > 50 && (
        <p className="text-xs text-fg-subtle">Showing all {rows.length} pages — this list isn&rsquo;t paginated.</p>
      )}

      <DangerDialog
        open={toDelete != null}
        onClose={() => setToDelete(null)}
        title={isRevert ? "Revert to standard copy" : "Delete page"}
        confirmLabel={isRevert ? "Revert" : "Delete"}
        typedConfirmation={toDelete?.slug}
        body={
          isRevert ? (
            <>
              This removes any customizations of <strong>{toDelete?.title || toDelete?.slug}</strong> and the built-in standard copy serves
              again at <code className="font-mono text-[11px]">{toDelete ? pageUrl(toDelete) : ""}</code>. The standard copy itself can&rsquo;t
              be deleted.
            </>
          ) : (
            <>
              This deletes <strong>{toDelete?.title || toDelete?.slug}</strong> from your drafts. Shoppers stop seeing{" "}
              <code className="font-mono text-[11px]">{toDelete ? pageUrl(toDelete) : ""}</code> after your next publish.
            </>
          )
        }
        onConfirm={async () => {
          // S53: the revision we listed rides along — a delete racing a
          // colleague's edit conflicts instead of discarding their work
          const r = await deletePage(toDelete.slug, pageRevisions[toDelete.slug] ?? undefined);
          if (!r.ok) throw new Error(r.error || "Delete failed — try again.");
          toast.success(isRevert ? "Reverted to the standard copy" : `Deleted “${toDelete.title || toDelete.slug}”`);
          router.refresh();
        }}
      />
    </div>
  );
}
