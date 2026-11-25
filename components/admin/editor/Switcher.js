"use client";

import { useState } from "react";
import { Archive, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RoleGate } from "@/components/kit/role-gate";
import { cn } from "@/components/ui/utils";
import { documentType } from "@/lib/registry/index.js";
import { SLUG_RE } from "@/lib/registry/settings.js";
import { switcherRows, collectionRows, productCounts, PRODUCT_FILTERS, WORDS } from "./editorModel";

// P3-EDITOR (ED-02): every document by its label, with a name search.
// P4-EDITOR (OVL-04, ED-12): products (read ONLY through listProductContent:
// paged, searched there by the published name, Shopify's name or the web
// address; filters "Changed in Shopify" and "No longer in Shopify" with their
// counts; a row opens /admin/editor?product=<gid>) and collections (the
// catalog picker's read; a row opens /admin/editor?collection=<gid>).
// Phase 2 line 6 (6a), the page list: on components/ui, grouped (pageGroups)
// as Home, Pages, Header and footer, Design, Policies, Product content and
// Collection content; each page with a Live or Draft badge and a dot for
// unpublished changes; "Show archived" lists archived pages too (the page
// list's own listDocuments read with includeArchived). "New page" (a title
// and a web address) and Archive are storefront.write (RoleGate, hidden for
// anyone without it). An archived page can't be opened or brought back here.
// Props only:
//   documents       listDocuments' rows (archived ones when showArchived)
//   products        listProductContent's items for the current search,
//                   filter and pages; counts its counts
//   productsState   { status: "loading" | "ready" | "failed", message?, more }
//   collections     the refs read's collections ({ id, handle, title })
//   openId, openEntityId   the open document, and its product or collection
//   onOpen(id)      open another document (the editor saves first)
//   onOpenHref(href) open a product's or collection's content (saves first)
//   query, onQuery, filter, onFilter, onMore   the search, the filter, the next page
//   showArchived, onShowArchived   the archived switch
//   role            the actor's role (RoleGate)
//   onCreate({ title, slug }) -> { ok } | { ok: false, message }   New page
//   onArchive(row) -> { ok } | { ok: false, message }               Archive

// A policy page: a page whose address is a privacy, terms, refund or returns
// page (the rule of lib/documents/policy-pages.js kindOfSlug, which reads the
// database and so can't load in the browser; test:editor-ui keeps them equal).
export const isPolicyPage = (d) => d?.type === "page" && /privacy|terms|refund|return/.test(String(d?.slug ?? ""));

export const PAGE_GROUPS = Object.freeze([
  { key: "home", label: "Home" },
  { key: "pages", label: "Pages" },
  { key: "chrome", label: "Header and footer" },
  { key: "design", label: "Design" },
  { key: "policies", label: "Policies" },
]);
const CHROME = new Set(["header", "footer", "announcement"]);
export function groupOf(d) {
  if (d.type === "home") return "home";
  if (CHROME.has(d.type)) return "chrome";
  if (d.type === "design") return "design";
  if (isPolicyPage(d)) return "policies";
  return "pages";
}
const ROUTE = (type) => documentType(type)?.route === true;

// The documents as the page list shows them: [{ key, label, rows }], groups
// with no row left out. A row: switcherRows' row plus live, changed (live
// with unpublished changes), archived, slug, revision and canArchive (a route
// page that is not live and not archived).
export function pageGroups({ documents = [], query = "", openId = null, showArchived = false } = {}) {
  const docs = Array.isArray(documents) ? documents : [];
  const term = String(query ?? "").trim().toLowerCase();
  const byId = new Map(docs.filter((d) => d && typeof d.id === "string").map((d) => [d.id, d]));
  const shown = switcherRows({ documents: docs, query, openId }).documents.map((r) => ({ ...r, archived: false }));
  const archived = showArchived
    ? docs
        .filter((d) => d && d.archivedAt && ROUTE(d.type))
        .filter((d) => !term || [d.label, d.slug].some((w) => typeof w === "string" && w.toLowerCase().includes(term)))
        .map((d) => ({ kind: "document", id: d.id, label: d.label || "Untitled", type: d.type, open: false, state: "Archived", archived: true }))
    : [];
  const rows = [...shown, ...archived].map((r) => {
    const d = byId.get(r.id) || {};
    const live = d.live === true;
    return { ...r, live, changed: live && d.unpublishedChanges === true, slug: d.slug ?? null, revision: d.revision ?? null, canArchive: !r.archived && !live && ROUTE(d.type) };
  });
  return PAGE_GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => groupOf({ type: r.type, slug: r.slug }) === g.key) })).filter((g) => g.rows.length > 0);
}

const slugFrom = (title) =>
  String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

// "New page": a title and a web address (made from the title until edited)
export function NewPageDialog({ open, onOpenChange, onCreate }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [state, setState] = useState({ busy: false, message: null });
  const address = edited ? slug : slugFrom(title);
  const bad = address && !SLUG_RE.test(address) ? "Use lowercase letters, numbers and dashes, starting with a letter or number." : null;
  async function submit(e) {
    e.preventDefault();
    if (!title.trim() || !address || bad) return setState({ busy: false, message: "Give the page a title and a web address." });
    setState({ busy: true, message: null });
    const r = await onCreate?.({ title: title.trim(), slug: address });
    if (r && r.ok === false) setState({ busy: false, message: r.message });
    else setState({ busy: false, message: null });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-new-page="">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New page</DialogTitle>
            <DialogDescription>It starts as a draft. Nothing is live until you publish it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-page-title">Title</Label>
            <Input id="new-page-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-page-slug">Web address</Label>
            <div>
              <Input
                id="new-page-slug"
                value={address}
                maxLength={81}
                aria-invalid={bad ? true : undefined}
                aria-describedby={bad ? "new-page-slug-why" : undefined}
                onChange={(e) => {
                  setEdited(true);
                  setSlug(e.target.value);
                }}
                autoComplete="off"
              />
            </div>
            {bad && (
              <p id="new-page-slug-why" className="text-xs text-destructive">
                {bad}
              </p>
            )}
          </div>
          {state.message && (
            <p role="alert" className="text-[13px] text-destructive">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={state.busy}>
              {state.busy ? "Making the page…" : "Make the page"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PageRow({ r, busy, role, onOpen, onArchive }) {
  const [state, setState] = useState({ confirming: false, busy: false, message: null });
  const archive = async () => {
    setState({ confirming: true, busy: true, message: null });
    const res = await onArchive?.(r);
    setState(res && res.ok === false ? { confirming: false, busy: false, message: res.message } : { confirming: false, busy: false, message: null });
  };
  return (
    <li data-page-row={r.id} data-archived={r.archived ? "" : undefined}>
      <div className={cn("flex items-center gap-1 rounded-md", r.open && "bg-muted")}>
        <button
          type="button"
          onClick={() => onOpen?.(r.id)}
          aria-current={r.open ? "page" : undefined}
          disabled={busy || r.archived}
          className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent", r.open && "font-semibold")}
          data-switcher-doc={r.id}
          data-read-control=""
        >
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.label}</span>
          {r.changed && (
            <span className="flex items-center" data-unpublished="" title="Changes not published">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              <span className="sr-only">Unpublished changes</span>
            </span>
          )}
          <Badge variant={r.archived ? "muted" : r.live ? "success" : "outline"} data-doc-state={r.archived ? "archived" : r.live ? "live" : "draft"}>
            {r.archived ? "Archived" : r.live ? "Live" : "Draft"}
          </Badge>
        </button>
        {r.canArchive && !state.confirming && (
          <RoleGate role={role} action="storefront.write" mode="hide">
            <Button variant="ghost" size="icon-xs" aria-label={`Archive ${r.label}`} title={`Archive ${r.label}`} onClick={() => setState({ confirming: true, busy: false, message: null })} data-archive={r.id}>
              <Archive aria-hidden />
            </Button>
          </RoleGate>
        )}
      </div>
      {state.confirming && (
        <div role="group" aria-label={`Archive ${r.label}?`} className="mt-1 flex flex-wrap items-center gap-1.5 px-2 pb-1">
          <p className="text-xs text-foreground">Archive this page? It leaves the list and can't be opened.</p>
          <RoleGate role={role} action="storefront.write" mode="hide">
            <Button size="xs" variant="destructive" disabled={state.busy} onClick={archive}>
              Archive
            </Button>
          </RoleGate>
          <Button size="xs" variant="ghost" disabled={state.busy} onClick={() => setState({ confirming: false, busy: false, message: null })}>
            Keep it
          </Button>
        </div>
      )}
      {state.message && (
        <p role="alert" className="px-2 pb-1 text-xs text-destructive">
          {state.message}
        </p>
      )}
    </li>
  );
}

const GroupHeading = ({ children }) => <p className="px-2 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;

export function SwitcherView({
  documents = [],
  products = [],
  counts = null,
  productsState = { status: "ready", more: false },
  collections = [],
  openId = null,
  openEntityId = null,
  query = "",
  onQuery,
  filter = "all",
  onFilter,
  onMore,
  onOpen,
  onOpenHref,
  busyId = null,
  showArchived = false,
  onShowArchived,
  role = null,
  onCreate,
  onArchive,
}) {
  const [creating, setCreating] = useState(false);
  const groups = pageGroups({ documents, query, openId, showArchived });
  const rows = switcherRows({ documents, products, query, openId, openEntityId });
  const term = String(query ?? "").trim().toLowerCase();
  const cols = collectionRows(collections, { openEntityId }).filter((c) => !term || c.label.toLowerCase().includes(term));
  const tally = productCounts(counts);
  const countOf = (key) => tally.find((t) => t.key === key)?.count ?? 0;
  const busy = busyId != null;
  const nothing = groups.length === 0 && rows.products.length === 0 && cols.length === 0 && productsState.status === "ready";
  return (
    <nav aria-label="Pages in this store" className="space-y-2" data-switcher="">
      <div className="flex items-center gap-2">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Find a page, product or collection by name</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(e) => onQuery?.(e.target.value)} placeholder="Find a page, product or collection" className="pl-8" data-switcher-search="" data-read-control="" />
        </label>
        <RoleGate role={role} action="storefront.write" mode="hide">
          <Button size="sm" variant="outline" onClick={() => setCreating(true)} data-new-page-open="">
            <Plus aria-hidden />
            New page
          </Button>
        </RoleGate>
      </div>
      <div className="flex items-center gap-2 px-1">
        <Switch id="switcher-archived" checked={showArchived} onCheckedChange={(v) => onShowArchived?.(v === true)} data-switcher-archived="" data-read-control="" />
        <Label htmlFor="switcher-archived" className="text-xs font-normal text-muted-foreground">
          Show archived pages
        </Label>
      </div>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} data-page-group={g.key}>
          <GroupHeading>{g.label}</GroupHeading>
          <ul className="space-y-0.5">
            {g.rows.map((r) => (
              <PageRow key={r.id} r={r} busy={busy} role={role} onOpen={onOpen} onArchive={onArchive} />
            ))}
          </ul>
        </section>
      ))}

      <section aria-label="Product content" data-switcher-products="" data-page-group="products">
        <GroupHeading>{`Product content (${countOf("all")})`}</GroupHeading>
        <div className="flex flex-wrap gap-1 px-1 py-1" role="group" aria-label="Show products">
          {PRODUCT_FILTERS.map((f) => (
            <Button key={f.key} size="xs" variant={filter === f.key ? "secondary" : "ghost"} aria-pressed={filter === f.key} onClick={() => onFilter?.(f.key)} data-product-filter={f.key} data-read-control="">
              {`${f.label} (${countOf(f.key)})`}
            </Button>
          ))}
        </div>
        {productsState.status === "failed" && <p className="px-2 text-[13px] text-muted-foreground">{productsState.message || "We couldn't load your products. Reload the page."}</p>}
        {productsState.status !== "failed" && rows.products.length === 0 && productsState.status !== "loading" && (
          <p className="px-2 text-[13px] text-muted-foreground">{term ? "No product has that name." : filter === "all" ? "No products yet." : "None right now."}</p>
        )}
        {rows.products.length > 0 && (
          <ul className="space-y-0.5" aria-label="Product list">
            {rows.products.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpenHref?.(r.href, r.id)}
                  aria-current={r.open ? "page" : undefined}
                  disabled={busy}
                  className={cn("flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", r.open && "bg-muted font-semibold")}
                  data-switcher-product={r.id}
                  data-read-control=""
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-foreground">{r.label}</span>
                    {r.secondary && <span className="block truncate text-[11px] text-muted-foreground">{r.secondary}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{r.state}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {productsState.status === "loading" && (
          <p className="px-2 text-[13px] text-muted-foreground" role="status">
            Loading products…
          </p>
        )}
        {productsState.more && productsState.status !== "loading" && (
          <div className="px-2 pt-1">
            <Button size="xs" variant="ghost" onClick={onMore} data-products-more="" data-read-control="">
              Show more products
            </Button>
          </div>
        )}
        <p className="px-2 text-[11px] text-muted-foreground">{WORDS.productNote}</p>
      </section>

      {cols.length > 0 && (
        <section aria-label="Collection content" data-switcher-collections="" data-page-group="collections">
          <GroupHeading>Collection content</GroupHeading>
          <ul className="space-y-0.5" aria-label="Collection list">
            {cols.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenHref?.(c.href, c.id)}
                  aria-current={c.open ? "page" : undefined}
                  disabled={busy}
                  className={cn("flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", c.open && "bg-muted font-semibold")}
                  data-switcher-collection={c.id}
                  data-read-control=""
                >
                  <span className="min-w-0 truncate text-sm text-foreground">{c.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {nothing && <p className="px-1 text-[13px] text-muted-foreground">Nothing here has that name.</p>}
      {creating && <NewPageDialog open={creating} onOpenChange={setCreating} onCreate={async (v) => {
        const r = await onCreate?.(v);
        if (!r || r.ok !== false) setCreating(false);
        return r;
      }} />}
    </nav>
  );
}

// The shell's counts line (OVL-04): products, changed in Shopify, no longer in Shopify.
export function ProductCounts({ counts }) {
  if (!counts) return null;
  return (
    <p className="text-xs text-muted-foreground" data-product-counts="">
      {productCounts(counts)
        .map((c) => `${c.label} ${c.count}`)
        .join(" · ")}
    </p>
  );
}

export default function Switcher(props) {
  const [query, setQuery] = useState("");
  return <SwitcherView {...props} query={props.query ?? query} onQuery={props.onQuery ?? setQuery} />;
}
