"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Plus, Search, X } from "lucide-react";
import { Card, CardHeader, CardFooter } from "@/components/console/Card";
import { StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Field, Input, Textarea } from "@/components/console/fields";
import { EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";
import { CollectionPicker, ProductPicker } from "@/components/admin/cms/RefPicker";
import { PRODUCT_WORDS } from "@/components/admin/editor/editorModel";

// Catalog browser (S39 / MC05 + MC06, redesigned S50). Shopify-owned values
// are READ-ONLY here, labeled and linked to Shopify admin (P4-EDITOR: in the
// same plain words as the new editor's product form, PRODUCT_WORDS); what the console
// edits is per-tenant PRESENTATION: per-product PDP modules + badge, and
// per-collection pinned ordering. Overrides whose product vanished from the
// catalog are flagged ORPHANED (deleted-product guard), never hidden.
// S50 fixes: the debounced search shows a spinner (it used to give no
// feedback), saves toast, and errors land in a persistent Banner.

const TEMPLATE_LABELS = {
  classic: "Classic — two columns",
  editorial: "Editorial — story-led",
  standard: "Standard — filter bar",
  sidebar: "Sidebar — filter rail",
};

const money = (v, cur) => {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(v || 0));
  } catch {
    return `${v ?? "—"} ${cur || ""}`.trim();
  }
};

export default function CatalogAdmin({ initial }) {
  const [data, setData] = useState(initial);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(null); // {product, modules, badge}
  const [opening, setOpening] = useState(null); // product gid being fetched
  const [colHandle, setColHandle] = useState("");
  const [colId, setColId] = useState(null); // catalog id behind colHandle — known after a pick, resolved on demand otherwise (S53 B2)
  const [colPins, setColPins] = useState("");
  const [pinsPicker, setPinsPicker] = useState(null); // "collection" | "products" | null
  const [resolvingCol, setResolvingCol] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);
  const firstRun = useRef(true);
  const toast = useToast();

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false; // the server already rendered the unfiltered list
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/admin/catalog?q=${encodeURIComponent(q)}`);
        const json = await res.json().catch(() => ({}));
        if (json.ok) setData(json);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [q]);

  async function openProduct(gid) {
    setOpening(gid);
    setError(null);
    try {
      const res = await fetch(`/api/admin/catalog?product=${encodeURIComponent(gid)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Couldn't load the product (${res.status})`);
      setEditing({ product: json.product, modules: json.override.modules || [], badge: json.override.badge || "", surface: json.surface || null });
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setOpening(null);
    }
  }

  async function post(body, okText) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error((json.errors || [json.error || `Save failed (${res.status})`]).join(" · "));
      toast.success(okText);
      const r = await fetch(`/api/admin/catalog?q=${encodeURIComponent(q)}`).then((x) => x.json()).catch(() => ({}));
      if (r.ok) setData(r);
      return true;
    } catch (e) {
      setError(String(e?.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const mod = (i, patch) => setEditing((e) => ({ ...e, modules: e.modules.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  // S53 B2: the pins product picker filters to the chosen collection's MEMBERS
  // (the server rejects non-members). The refs API filters by collection id;
  // a picked collection carries its id, a typed handle resolves on demand.
  async function openPinsProducts() {
    if (colId) return setPinsPicker("products");
    setResolvingCol(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/refs?type=collection&q=${encodeURIComponent(colHandle.trim())}&limit=50`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Couldn't look up the collection (${res.status})`);
      const hit = (json.items || []).find((c) => c.handle === colHandle.trim());
      if (!hit) throw new Error(`“${colHandle.trim()}” isn't in the synced catalog — pick a collection with Choose…, or type product handles by hand.`);
      setColId(hit.id);
      setPinsPicker("products");
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setResolvingCol(false);
    }
  }

  // Picker items → the SAME one-handle-per-line textarea the form always
  // saved: current lines keep their order, picked handles append (deduped).
  const addPins = (items) =>
    setColPins((cur) => {
      const lines = cur.split("\n").map((s) => s.trim()).filter(Boolean);
      const added = items.map((it) => it.handle).filter((h) => h && !lines.includes(h));
      return [...lines, ...added].join("\n");
    });

  return (
    <div className="space-y-4">
      {error && <Banner tone="danger">{error}</Banner>}

      {editing ? (
        <Card>
          <CardHeader
            title={editing.product.title}
            description={`/products/${editing.product.handle}`}
            actions={
              editing.product.shopify_url && (
                <a
                  href={editing.product.shopify_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded text-xs font-medium text-fg-muted focus-ring hover:text-fg hover:underline"
                >
                  Open in Shopify admin <ExternalLink size={12} aria-hidden />
                </a>
              )
            }
          />

          {/* Shopify-owned values: labeled, read-only */}
          <div className="rounded-ctl bg-surface-sunken px-3.5 py-2.5 text-xs text-fg-muted">
            <p className="font-medium text-fg" data-shopify-owned="">{PRODUCT_WORDS.catalogShopify}</p>
            <p className="mt-0.5">
              Type: {editing.product.product_type || "—"} · Vendor: {editing.product.vendor || "—"} · Price: {editing.product.price_min}
              {editing.product.price_max !== editing.product.price_min ? `–${editing.product.price_max}` : ""} {editing.product.currency} ·{" "}
              {editing.product.available ? "In stock" : "Sold out"}
            </p>
          </div>

          {/* S57: explain the selected PDP template and WHY (audit: assignment
              reasons are visible where merchants edit the entity). */}
          {editing.surface && (
            <p className="mt-2 text-xs text-fg-muted">
              Page template: <span className="font-medium text-fg">{TEMPLATE_LABELS[editing.surface.template] || editing.surface.template}</span>
              {" — "}
              {editing.surface.source === "entity" ? "assigned to this product" : editing.surface.source === "family" ? "your store default" : "the platform default"}
              {" · "}
              <a href="/admin/theme#page-templates" className="font-medium text-fg underline-offset-2 hover:underline">
                Change on Theme
              </a>
            </p>
          )}

          <Field label="Badge" htmlFor="cat-badge" hint="Shown on the product card — blank = none." className="mt-4 max-w-xs">
            <Input id="cat-badge" placeholder='e.g. "Lab tested"' value={editing.badge} onChange={(e) => setEditing({ ...editing, badge: e.target.value })} />
          </Field>

          <p className="mt-5 text-xs font-medium text-fg-muted">Product-page modules (ingredients, usage, specs — accordions on this PDP)</p>
          {editing.modules.map((m, i) => (
            <div key={i} className="mt-2 rounded-ctl border border-edge p-3">
              <div className="flex items-start gap-2">
                <Input aria-label={`Module ${i + 1} title`} placeholder="Module title (e.g. Ingredients)" value={m.title} onChange={(e) => mod(i, { title: e.target.value })} />
                <IconButton
                  label={`Remove module ${i + 1}`}
                  icon={<X size={14} aria-hidden />}
                  onClick={() => setEditing((e) => ({ ...e, modules: e.modules.filter((_, j) => j !== i) }))}
                />
              </div>
              <Textarea mono aria-label={`Module ${i + 1} HTML`} className="mt-2" placeholder="<p>HTML — sanitized on save</p>" value={m.html} onChange={(e) => mod(i, { html: e.target.value })} />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} className="mt-2" onClick={() => setEditing((e) => ({ ...e, modules: [...e.modules, { title: "", html: "" }] }))}>
            Add module
          </Button>

          <CardFooter>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                const ok = await post({ product: { handle: editing.product.handle, modules: editing.modules, badge: editing.badge } }, "Saved as a draft — publish from Publishing");
                if (ok) setEditing(null);
              }}
            >
              Save presentation
            </Button>
            <Button disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader title="Products" />
            <div className="relative max-w-md">
              <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <Input
                type="search"
                aria-label="Search catalog"
                placeholder="Search by title, handle or type…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8 pr-8"
              />
              {searching && <Loader2 size={14} aria-hidden className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle motion-safe:animate-spin" />}
            </div>
            {data.products.length === 0 ? (
              <EmptyState title="No products match" body="Try a different title, handle or type." className="py-6" />
            ) : (
              <ul className="mt-2 divide-y divide-edge">
                {data.products.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                    {p.featured_image ? (
                      <img src={p.featured_image} alt="" loading="lazy" className="size-9 shrink-0 rounded-ctl border border-edge bg-surface-sunken object-cover" />
                    ) : (
                      <span className="size-9 shrink-0 rounded-ctl border border-edge bg-surface-sunken" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium text-fg">{p.title}</span>
                        <StatusBadge status={p.available ? "active" : "sold_out"} label={p.available ? "In stock" : "Sold out"} />
                        {p.customized && <StatusBadge status="customized" />}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                        <span className="font-mono">{p.handle}</span>
                        {p.product_type ? ` · ${p.product_type}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm tabular-nums text-fg-muted">{money(p.price_min, p.currency)}</span>
                    <Button size="sm" busy={opening === p.id} disabled={!!opening && opening !== p.id} onClick={() => openProduct(p.id)}>
                      Presentation
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {data.overrides.some((o) => o.orphaned) && (
            <Banner tone="warning" title="Orphaned overrides">
              These products were deleted from the catalog; their presentation rows do nothing. Remove them or restore the product in Shopify.
              <ul className="mt-1.5 space-y-0.5">
                {data.overrides.filter((o) => o.orphaned).map((o) => (
                  <li key={o.product_id} className="font-mono text-xs">
                    {o.product_id}
                  </li>
                ))}
              </ul>
            </Banner>
          )}

          <Card>
            <CardHeader
              title="Collection merchandising"
              description="Pin products to the top of a collection’s default (“Featured”) order — everything else keeps Shopify’s order. Pins must belong to the collection."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Collection handle" htmlFor="cat-col-handle">
                <div className="flex items-center gap-2">
                  <Input
                    id="cat-col-handle"
                    list="catalog-collections"
                    mono
                    className="flex-1"
                    value={colHandle}
                    onChange={(e) => {
                      setColHandle(e.target.value);
                      setColId(null); // typed handle — id unknown until resolved
                    }}
                    placeholder="protein"
                  />
                  <Button size="sm" onClick={() => setPinsPicker("collection")}>
                    Choose…
                  </Button>
                </div>
                <datalist id="catalog-collections">
                  {data.collections.map((c) => (
                    <option key={c.handle} value={c.handle}>
                      {c.title}
                      {c.pinned ? ` (${c.pinned} pinned)` : ""}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="Pinned product handles" htmlFor="cat-col-pins" hint="One per line, in display order · empty = back to Shopify’s order. Picked products append — edit the lines to reorder.">
                <Textarea id="cat-col-pins" mono value={colPins} onChange={(e) => setColPins(e.target.value)} placeholder={"whey-gold-1kg\ncreatine-250g"} />
                <Button size="sm" className="mt-2" busy={resolvingCol} disabled={!colHandle.trim()} onClick={openPinsProducts}>
                  Choose products…
                </Button>
              </Field>
            </div>
            <CardFooter>
              <Button
                variant="primary"
                busy={busy}
                disabled={!colHandle.trim()}
                onClick={() =>
                  post(
                    { collection: { handle: colHandle.trim(), pinnedHandles: colPins.split("\n").map((s) => s.trim()).filter(Boolean) } },
                    "Pinned order saved as a draft — publish from Publishing"
                  )
                }
              >
                Save pinned order
              </Button>
            </CardFooter>
          </Card>
        </>
      )}

      {/* S53 B2: catalog pickers for the pins form — the save still sends the
          collection handle + pinned product handles exactly as before. */}
      <CollectionPicker
        open={pinsPicker === "collection"}
        onClose={() => setPinsPicker(null)}
        title="Choose the collection"
        onConfirm={(items) => {
          if (items[0]) {
            setColHandle(items[0].handle);
            setColId(items[0].id);
          }
        }}
      />
      <ProductPicker
        open={pinsPicker === "products"}
        onClose={() => setPinsPicker(null)}
        title={`Pin products from “${colHandle.trim()}”`}
        multi
        collectionId={colId || undefined}
        onConfirm={addPins}
      />
    </div>
  );
}
