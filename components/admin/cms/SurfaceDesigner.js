"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { cx } from "@/components/console/cx";
import { PageHeader } from "@/components/console/PageHeader";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Card, CardHeader } from "@/components/console/Card";
import { EmptyState, Skeleton } from "@/components/console/bits";
import { Field, Input, Select, Textarea } from "@/components/console/fields";
import { useToast } from "@/components/console/Toast";
import { effectiveSurfaceTemplate, SURFACE_ENTITY_KEYS } from "@/lib/cms/defaults";
import { saveBlock, startPreview } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import DesignerTabs from "./DesignerTabs";
import { ProductPicker, CollectionPicker, refLabel } from "./RefPicker";

// S59 (audit slice 3, PDP + collection path): the SURFACE DESIGNER — pick a
// real product/collection as context, see the draft-preview page, and edit
// what that surface is governed by:
//   · its template (family default or an explicit per-entity assignment,
//     with the WHY stated — audit requirement)
//   · PDP: this product's modules & badge (the catalog presentation override)
//   · pointers to the editors that own the rest (accordions, pairs, pins)
// Preview is the SAVED draft via the same cookie-gated bridge as the home
// Designer; [data-sec] clicks in the page select the matching card here.
const SURFACE_META = {
  pdp: {
    title: "Designer — Product page",
    description: "Pick a product, preview its page, and set how it's presented. Everything saves as a draft — publish from Publishing.",
    entityNoun: "product",
    pathFor: (ctx) => `/products/${ctx.handle}`,
    options: [
      ["classic", "Classic — two columns"],
      ["editorial", "Editorial — story-led"],
    ],
  },
  collection: {
    title: "Designer — Collection page",
    description: "Pick a collection, preview its page, and set how it's presented. Everything saves as a draft — publish from Publishing.",
    entityNoun: "collection",
    pathFor: (ctx) => `/collections/${ctx.handle}`,
    options: [
      ["standard", "Standard — filter bar"],
      ["sidebar", "Sidebar — filter rail"],
    ],
  },
};

const DEVICES = [
  { key: "mobile", label: "Mobile", width: 375 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "desktop", label: "Desktop", width: "100%" },
];

const SOURCE_COPY = { entity: null, family: "your store default", platform: "the platform default" };

const ctxStorageKey = (surface) => `storeasy-designer-ctx-${surface}`;

export default function SurfaceDesigner({ surface, initial }) {
  const meta = SURFACE_META[surface];
  const entityKey = SURFACE_ENTITY_KEYS[surface];
  const toast = useToast();

  // -- context (the real product/collection being designed) --------------------
  const [ctx, setCtx] = useState(() => {
    try {
      const raw = sessionStorage.getItem(ctxStorageKey(surface));
      const v = raw ? JSON.parse(raw) : null;
      return v?.id && v?.handle ? v : null;
    } catch {
      return null;
    }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickCtx = (item) => {
    if (!item) return;
    const next = { id: item.id, handle: item.handle, title: refLabel(item) };
    setCtx(next);
    try {
      sessionStorage.setItem(ctxStorageKey(surface), JSON.stringify(next));
    } catch {
      /* per-tab convenience only */
    }
  };

  // -- template assignment (surface_templates block, CAS) ----------------------
  const [tplValue, setTplValue] = useState(initial.surfaceTemplates.value || null);
  const [tplRev, setTplRev] = useState(initial.surfaceTemplates.revision ?? null);
  const [tplBusy, setTplBusy] = useState(false);
  const [tplConflict, setTplConflict] = useState(false);
  const [tplErr, setTplErr] = useState(null);

  const assigned = ctx ? tplValue?.[entityKey]?.[ctx.id] || "" : "";
  const effective = ctx ? effectiveSurfaceTemplate(tplValue, surface, ctx.id) : null;
  const optionLabel = (v) => meta.options.find(([ov]) => ov === v)?.[1] || v;

  async function saveTemplate(nextPick, { force = false } = {}) {
    if (!ctx) return;
    setTplBusy(true);
    setTplErr(null);
    const map = { ...(tplValue?.[entityKey] || {}) };
    if (nextPick) map[ctx.id] = nextPick;
    else delete map[ctx.id];
    const next = { ...(tplValue || {}) };
    if (Object.keys(map).length) next[entityKey] = map;
    else delete next[entityKey];
    const value = Object.keys(next).length ? next : null;
    const res = await saveBlock("surface_templates", value, force ? undefined : tplRev, { force });
    setTplBusy(false);
    if (res.ok) {
      setTplConflict(false);
      setTplValue(res.blocks?.surface_templates ?? value);
      setTplRev(res.revisions?.surface_templates ?? null);
      toast.success("Saved as a draft — publish from Publishing");
      postRefresh(); // the template changes this very page
      return;
    }
    if (res.conflict) return setTplConflict(true);
    setTplErr(res.errors?.join(" · ") || res.error || "Save failed — try again.");
  }

  // -- PDP modules & badge (catalog presentation override) ---------------------
  const [mod, setMod] = useState({ phase: "idle", handle: null, modules: [], badge: "", error: null });
  const [modBusy, setModBusy] = useState(false);
  const modDirtyRef = useRef(false);
  useEffect(() => {
    if (surface !== "pdp" || !ctx) return;
    let gone = false;
    setMod({ phase: "loading", handle: null, modules: [], badge: "", error: null });
    modDirtyRef.current = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/catalog?product=${encodeURIComponent(ctx.id)}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.error || `Couldn't load the product (${res.status})`);
        if (gone) return;
        setMod({ phase: "ready", handle: json.product.handle, modules: json.override.modules || [], badge: json.override.badge || "", error: null });
      } catch (e) {
        if (!gone) setMod((m) => ({ ...m, phase: "error", error: String(e?.message || e) }));
      }
    })();
    return () => {
      gone = true;
    };
  }, [surface, ctx]);

  const patchModule = (i, patch) => {
    modDirtyRef.current = true;
    setMod((m) => ({ ...m, modules: m.modules.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  };

  async function saveModules() {
    setModBusy(true);
    try {
      const res = await fetch("/api/admin/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: { handle: mod.handle, modules: mod.modules, badge: mod.badge } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error((json.errors || [json.error || `Save failed (${res.status})`]).join(" · "));
      modDirtyRef.current = false;
      toast.success("Saved as a draft — publish from Publishing");
      postRefresh();
    } catch (e) {
      setMod((m) => ({ ...m, error: String(e?.message || e) }));
    } finally {
      setModBusy(false);
    }
  }

  // -- preview (saved draft, deep-linked at the context's page) ----------------
  const [device, setDevice] = useState("desktop");
  const [mint, setMint] = useState({ phase: "idle", error: null });
  const [mintTry, setMintTry] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [connected, setConnected] = useState(false);
  const iframeRef = useRef(null);
  const activatedRef = useRef(false);
  const cardRefs = useRef({});
  const [flash, setFlash] = useState(null);

  const previewPath = ctx ? meta.pathFor(ctx) : null;
  const post = (msg) => iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
  const postRefresh = () => {
    if (connected) post({ type: "storeasy:refresh" });
    else setNonce((n) => n + 1);
  };

  useEffect(() => {
    if (!previewPath) return;
    let gone = false;
    setMint({ phase: "minting", error: null });
    setConnected(false);
    (async () => {
      const r = await startPreview(previewPath);
      if (gone) return;
      if (!r.ok) setMint({ phase: "error", error: r.error || "Could not start the preview" });
      else {
        setMint({ phase: "up", error: null });
        setNonce((n) => n + 1);
      }
    })();
    return () => {
      gone = true;
    };
  }, [previewPath, mintTry]);

  const onFrameLoad = () => {
    setConnected(false);
    activatedRef.current = false;
    post("storeasy:designer:hello");
  };
  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "storeasy:ready") {
        setConnected(true);
        if (!activatedRef.current) {
          activatedRef.current = true;
          post("storeasy:designer:hello");
        }
      }
      if (msg.type === "storeasy:sec:click") {
        const key = { "pdp-modules": "modules", "pdp-pairs": "pairs", "collection-products": "pins" }[msg.id] || "template";
        const el = cardRefs.current[key];
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          setFlash(key);
          setTimeout(() => setFlash((f) => (f === key ? null : f)), 1600);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const width = DEVICES.find((d) => d.key === device)?.width ?? "100%";
  const cardCls = (key) => cx("rounded-card transition-shadow", flash === key && "ring-2 ring-[var(--c-accent)] shadow-card");
  const setCardRef = (key) => (el) => {
    cardRefs.current[key] = el;
  };

  // ------------------------------------------------------------------------------

  const Picker = surface === "pdp" ? ProductPicker : CollectionPicker;

  return (
    <>
      <PageHeader
        title={meta.title}
        description={meta.description}
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Designer" }]}
        actions={
          <Link
            href="/admin/releases"
            className="inline-flex items-center gap-1.5 rounded-ctl border border-edge bg-surface px-3 py-1.5 text-xs font-semibold text-fg focus-ring hover:bg-surface-sunken"
          >
            Publishing <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      <DesignerTabs />

      {!ctx ? (
        <Card>
          <EmptyState
            title={`Pick a ${meta.entityNoun} to design`}
            body={`The designer previews a real ${meta.entityNoun} page and edits what governs it.`}
            className="py-10"
            action={
              <Button variant="primary" icon={<Plus size={14} aria-hidden />} onClick={() => setPickerOpen(true)}>
                Choose a {meta.entityNoun}…
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
          {/* ---- preview ---- */}
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg">
                <span className="truncate">{ctx.title}</span>
                <span className="font-mono text-xs text-fg-subtle">/{ctx.handle}</span>
              </span>
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                Change…
              </Button>
              <span className="ml-auto flex items-center gap-1">
                {DEVICES.map((d) => (
                  <Button key={d.key} size="sm" variant={device === d.key ? "primary" : "ghost"} onClick={() => setDevice(d.key)}>
                    {d.label}
                  </Button>
                ))}
                <IconButton label="Refresh preview" icon={<RefreshCw size={14} aria-hidden />} onClick={postRefresh} disabled={mint.phase !== "up"} />
                <IconButton
                  label="Open preview in a new tab"
                  icon={<ExternalLink size={14} aria-hidden />}
                  onClick={() => window.open(previewPath, "_blank", "noopener")}
                  disabled={mint.phase !== "up"}
                />
              </span>
            </div>
            <p role="status" className="mb-2 text-xs text-fg-muted">
              {mint.phase === "minting" && (
                <span className="inline-flex items-center gap-1">
                  <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden /> Starting the draft preview…
                </span>
              )}
              {mint.phase === "up" && !connected && "Connecting the preview…"}
              {mint.phase === "up" && connected && "Preview shows your last save — click a tagged region to jump to its editor"}
            </p>
            {mint.phase === "error" && (
              <Banner
                tone="danger"
                title="Preview couldn't start"
                actions={
                  <Button size="sm" onClick={() => setMintTry((n) => n + 1)}>
                    Retry
                  </Button>
                }
              >
                {mint.error}
              </Banner>
            )}
            {mint.phase === "up" ? (
              <iframe
                key={nonce}
                ref={iframeRef}
                src={previewPath}
                title={`${meta.entityNoun} page preview (your last save)`}
                onLoad={onFrameLoad}
                style={{ width: typeof width === "number" ? `${width}px` : width }}
                className="mx-auto block min-h-[70vh] rounded-card border border-edge bg-surface shadow-card"
              />
            ) : (
              mint.phase !== "error" && <Skeleton className="min-h-[70vh] w-full rounded-card" />
            )}
          </div>

          {/* ---- inspector ---- */}
          <div className="space-y-4">
            <div ref={setCardRef("template")} className={cardCls("template")}>
              <Card>
                <CardHeader
                  title="Template"
                  badge={<Badge tone={assigned ? "accent" : "neutral"}>{assigned ? "Assigned" : "Default"}</Badge>}
                  description={
                    effective
                      ? `Renders ${optionLabel(effective.template)} — ${
                          effective.source === "entity" ? `assigned to this ${meta.entityNoun}` : SOURCE_COPY[effective.source]
                        }.`
                      : ""
                  }
                />
                {tplConflict && (
                  <ConflictBanner
                    what="the page templates"
                    busy={tplBusy}
                    onTakeTheirs={() => window.location.reload()}
                    onOverwrite={() => saveTemplate(assigned || null, { force: true })}
                  />
                )}
                {tplErr && (
                  <Banner tone="danger" className="mb-3">
                    {tplErr}
                  </Banner>
                )}
                <Field label={`Template for this ${meta.entityNoun}`} htmlFor={`sd-tpl-${surface}`} hint="Saved immediately as a draft. “Follow store default” removes the assignment.">
                  <Select
                    id={`sd-tpl-${surface}`}
                    value={assigned}
                    disabled={tplBusy}
                    onChange={(e) => saveTemplate(e.target.value || null)}
                  >
                    <option value="">Follow store default ({optionLabel(effectiveSurfaceTemplate(tplValue, surface, null).template)})</option>
                    {meta.options.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="mt-2 text-xs text-fg-subtle">
                  Store defaults live on <Link href="/admin/theme#page-templates" className="font-medium text-fg hover:underline">Theme → Page templates</Link>.
                </p>
              </Card>
            </div>

            {surface === "pdp" && (
              <div ref={setCardRef("modules")} className={cardCls("modules")}>
                <Card>
                  <CardHeader
                    title="Modules & badge"
                    description="This product's accordions and card badge (the catalog presentation override). Drafts — shoppers see them after you publish."
                    actions={
                      mod.phase === "ready" && (
                        <Button variant="primary" size="sm" busy={modBusy} onClick={saveModules}>
                          Save
                        </Button>
                      )
                    }
                  />
                  {mod.phase === "loading" && <Skeleton className="h-24 w-full rounded-ctl" />}
                  {mod.error && (
                    <Banner tone="danger" className="mb-3">
                      {mod.error}
                    </Banner>
                  )}
                  {mod.phase === "ready" && (
                    <>
                      <Field label="Badge" htmlFor="sd-badge" hint="Shown on the product card — blank = none." className="max-w-xs">
                        <Input
                          id="sd-badge"
                          placeholder='e.g. "Lab tested"'
                          value={mod.badge}
                          onChange={(e) => {
                            modDirtyRef.current = true;
                            setMod((m) => ({ ...m, badge: e.target.value }));
                          }}
                        />
                      </Field>
                      <p className="mt-4 text-xs font-medium text-fg-muted">Product-page modules (accordions on this PDP)</p>
                      {mod.modules.map((m, i) => (
                        <div key={i} className="mt-2 rounded-ctl border border-edge p-3">
                          <div className="flex items-start gap-2">
                            <Input aria-label={`Module ${i + 1} title`} placeholder="Module title (e.g. Ingredients)" value={m.title} onChange={(e) => patchModule(i, { title: e.target.value })} />
                            <IconButton
                              label={`Remove module ${i + 1}`}
                              icon={<X size={14} aria-hidden />}
                              onClick={() => {
                                modDirtyRef.current = true;
                                setMod((mm) => ({ ...mm, modules: mm.modules.filter((_, j) => j !== i) }));
                              }}
                            />
                          </div>
                          <Textarea mono aria-label={`Module ${i + 1} HTML`} className="mt-2" placeholder="<p>HTML — sanitized on save</p>" value={m.html} onChange={(e) => patchModule(i, { html: e.target.value })} />
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Plus size={13} aria-hidden />}
                        className="mt-2"
                        onClick={() => {
                          modDirtyRef.current = true;
                          setMod((m) => ({ ...m, modules: [...m.modules, { title: "", html: "" }] }));
                        }}
                      >
                        Add module
                      </Button>
                    </>
                  )}
                </Card>
              </div>
            )}

            {surface === "pdp" && (
              <div ref={setCardRef("pairs")} className={cardCls("pairs")}>
                <Card>
                  <CardHeader title="Also on this page" />
                  <ul className="space-y-2 text-sm">
                    <li>
                      <Link href="/admin/storefront/product-pages" className="font-medium text-fg hover:underline">
                        Accordions on every product page →
                      </Link>
                      <p className="text-xs text-fg-subtle">The store-wide PDP accordions (shipping, returns…).</p>
                    </li>
                    <li>
                      <Link href="/admin/upsells" className="font-medium text-fg hover:underline">
                        “Pairs well with” →
                      </Link>
                      <p className="text-xs text-fg-subtle">Manual pairings override the same-collection automatic picks.</p>
                    </li>
                  </ul>
                </Card>
              </div>
            )}

            {surface === "collection" && (
              <div ref={setCardRef("pins")} className={cardCls("pins")}>
                <Card>
                  <CardHeader title="Also on this page" />
                  <ul className="space-y-2 text-sm">
                    <li>
                      <Link href="/admin/catalog" className="font-medium text-fg hover:underline">
                        Pinned product order →
                      </Link>
                      <p className="text-xs text-fg-subtle">Pin products to the top of this collection's “Featured” order (Catalog → Collection merchandising).</p>
                    </li>
                    <li>
                      <Link href="/admin/storefront/home#collections" className="font-medium text-fg hover:underline">
                        Collections page curation →
                      </Link>
                      <p className="text-xs text-fg-subtle">Which collections are featured, ordered and hidden on /collections.</p>
                    </li>
                  </ul>
                </Card>
              </div>
            )}
          </div>
        </div>
      )}

      <Picker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={`Design which ${meta.entityNoun}?`}
        onConfirm={(items) => {
          if (items?.[0]) pickCtx(items[0]);
        }}
      />
    </>
  );
}
