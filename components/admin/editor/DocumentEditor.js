"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/console/PageHeader";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import * as documentsApi from "./documentsApi";
import { createDocumentStore } from "./store";
import SectionTree from "./tree/SectionTree";
import { groupIssues } from "./tree/treeModel";
import SettingsForm from "./fields/SettingsForm";
import { createLibraryPicker } from "./fields/index.js";
import ProductForm from "./ProductForm";
import CollectionForm from "./CollectionForm";
import { MediaPicker } from "../cms/MediaPicker";
import { fetchRefs } from "../cms/RefPicker";
import { PublishPanelView } from "./publish/PublishPanel";
import UndoNotice from "./publish/UndoNotice";
import EarlierVersions from "./publish/EarlierVersions";
import RecentlyPublished from "./publish/RecentlyPublished";
import { createPublishFlow } from "./publish/publishModel";
import { SwitcherView, ProductCounts } from "./Switcher";
import PreviewPane from "./PreviewPane";
import StatusLine from "./StatusLine";
import {
  WORDS,
  ENTITY_TYPES,
  applyTreeOps,
  productListArgs,
  createNavGuard,
  createStoreCall,
  createTabStorage,
  framePathFor,
  inspectorPath,
  isStoreClosed,
  isWritingDocument,
  pendingAfterShown,
  pickPlan,
  selectionAfterTree,
  treeChangeOps,
} from "./editorModel";
import { editorHref } from "@/lib/admin/editor-entry";
import { documentType, sectionType } from "@/lib/registry/index.js";

// P3-EDITOR (ED-02, ED-03, ED-04, PV-01, PV-02, PUB-02, PUB-04, PUB-06,
// PUB-11): the new editor. It replaces P3-ROUTES' placeholder and wires the
// batch 3 parts together:
//   the store (store.js)          one per open document; saving, conflicts,
//                                 server-replace operations, the local backup
//   the preview (PreviewPane)     editorModel.createPreviewController
//   the tree and the inspector    SectionTree, SettingsForm (edits become
//                                 store operations: editorModel)
//   publishing                    PublishPanel's view with a flow whose call
//                                 is the store's (editorModel.createStoreCall),
//                                 UndoNotice, take offline, Earlier versions
//   the switcher                  every document, products listed
// The interaction rules are in editorModel.js (pure, unit-tested). This file
// only holds React state and browser events.
//
// P4-PICKER (MED-03, OVL-04, ED-12): the inspector's context carries
//   pickImage({ path })    opens the media library (MediaPicker); resolves
//                          with { media: "/api/media/<id>", alt } or null
//                          (fields/index.js createLibraryPicker, mediaPick).
//                          ImageControl and GalleryControl use it. Archived
//                          files are not listed: the library read leaves them
//                          out (GET /api/admin/media, P4-MEDIA)
//   lookupProducts(ids)    the catalog picker's names for product ids
//                          (/api/admin/refs ids=), for the pairs and pinned
//                          product lists
//   shopify                what Shopify sends now for an open product or
//                          collection (openEntityContent), for the gallery's
//                          read-only Shopify side
//
// P4-EDITOR (OVL-04, OVL-01, OVL-06, ED-12, ED-02):
//   - a product's content opens in ProductForm and a collection's in
//     CollectionForm (beside the preview of that product's or collection's
//     own page), in place of the section tree and the settings form
//   - what Shopify sends now comes from the page (the `entity` prop, read on
//     the server: lib/admin/entity-entry.js). The editor never calls
//     openEntityContent itself, so a read-only person never triggers a write
//     and never waits on a line that can't load
//   - the switcher lists products ONLY through listProductContent (search,
//     filters, counts, pages) and collections through the catalog picker's
//     read; the 30-row /api/admin/catalog route is not used any more. The
//     pickers' first products and collections come from the same refs read
//   - "Keep mine", "Use Shopify's" and "Discard edits" go through the store's
//     call (editorModel.createStoreCall), so the draft is saved first
//
// Props (from app/(console)/admin/(authed)/editor/page.js):
//   document { id, type, label, slug }  the document to open (editor-entry)
//   note                                 a note from the address, or null
//   entity                               for product or collection content:
//                                        what Shopify sends now (or null)
//   readOnly                             plain words when this person can
//                                        look but not change (or null)
//   api                                  documentsApi (tests pass a stub)

const RICH = "rich_text";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const noSub = () => () => {};
const noState = () => null;
const ROUTE_FAMILY = { page: "page", campaign: "campaign", journal: "journal" };

function makeTabId() {
  try {
    return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

// ---- the view (rendered tests call this with plain props) ---------------------------

export function EditorView({
  entry,
  note = null,
  switchNote = null,
  load = { status: "loading" },
  state = null,
  docs = null,
  catalog = { products: [], collections: [] },
  selection = null,
  focusRequest = null,
  showSwitcher = false,
  previewOpen = false,
  preview = null,
  previewView = null,
  publish = null,
  blocked = null,
  goBack = null,
  versions = null,
  busyOpen = null,
  call = null,
  pickImage = null,
  lookupProducts = null,
  entity = null,
  readOnly = null,
  products = null,
  productsState = { status: "ready", more: false },
  productFilter = "all",
  entityBusy = false,
  on = {},
}) {
  // P4-FIX3: while the store still holds the document opened before (see
  // staleEntity below), the heading names the one being opened
  const switching = Boolean(state) && Boolean(entry?.id) && state.id !== entry.id && (ENTITY_TYPES.includes(state.type) || ENTITY_TYPES.includes(entry?.type));
  const label = (switching ? entry?.label : state?.document?.label) || entry?.label || "Home page";
  const doc = state ? { ...(state.document || {}), type: state.type, body: state.body } : null;
  const type = state?.type || entry?.type || "home";
  const body = state?.body;
  const writing = Boolean(state) && isWritingDocument(type, body);
  const sections = isObj(body) && Array.isArray(body.sections) ? body.sections : null;
  const access = state?.document?.access || null;
  const staff = access && access.canPublish === false;
  const issues = state?.pending?.issues || state?.issues || [];
  const closed = Array.isArray(docs) && isStoreClosed(docs);
  const selected = sections && selection ? sections.find((s) => isObj(s) && s.id === selection) : null;
  const live = Boolean(state?.document?.publishedVersionId);
  const changed = live && state?.document?.publishedHash && state.draftHash && state.document.publishedHash !== state.draftHash;
  const route = documentType(type)?.route === true;
  const context = {
    collections: catalog.collections || [],
    products: catalog.products || [],
    pages: (Array.isArray(docs) ? docs : []).filter((d) => ROUTE_FAMILY[d.type] && d.slug).map((d) => ({ slug: d.slug, family: ROUTE_FAMILY[d.type], document: d.id, title: d.label })),
    ...(typeof pickImage === "function" ? { pickImage } : {}),
    ...(typeof lookupProducts === "function" ? { lookupProducts } : {}),
    shopify: isObj(entity) && isObj(entity.shopify) ? entity.shopify : null,
    shopifyMissing: isObj(entity) && entity.inShopify === false,
  };
  const entityDoc = ENTITY_TYPES.includes(type);
  const entityId = state?.document?.entityId || null;
  // P4-FIX3 (P4-EDITOR review): switching from one product (or collection) to
  // another changes the page's entry and entity at once, while the store still
  // holds the earlier document until getDocument answers. Until the store
  // holds the entry's own document, the product and collection forms are held
  // back, so one product's draft is never shown against another's Shopify
  // values. Each form is also keyed on its document AND the entry it belongs
  // to, so it never carries one product's form state into the next.
  const staleEntity = switching;
  const formKey = `${state?.id || ""}:${entry?.id || ""}`;

  const inspector = () => {
    if (!state) return null;
    // P4-EDITOR: a product's and a collection's own forms
    if (type === "product_content") {
      return (
        <ProductForm
          key={`product-${formKey}`}
          body={body}
          entity={entity}
          access={access}
          readOnly={readOnly}
          issues={issues}
          context={context}
          focusRequest={focusRequest}
          selection={selection}
          busy={entityBusy}
          on={{
            edit: (m) => on.edit?.({ sectionId: null, path: m.path, value: m.value }),
            sectionEdit: (m) => on.edit?.({ sectionId: m.sectionId, path: m.path, value: m.value }),
            treeChange: on.treeChange,
            resolve: on.resolve,
            discard: on.discard,
          }}
        />
      );
    }
    if (type === "collection_content") {
      return <CollectionForm key={`collection-${formKey}`} body={body} entity={entity} readOnly={readOnly} issues={issues} context={context} on={{ edit: (m) => on.edit?.({ sectionId: null, path: m.path, value: m.value }) }} />;
    }
    if (selected) {
      return (
        <SettingsForm
          key={selected.id}
          kind={selected.kind}
          sectionId={selected.id}
          value={selected.settings}
          issues={issues}
          focusRequest={focusRequest}
          context={context}
          onChange={(_next, m) => on.edit?.({ sectionId: selected.id, path: m.path, value: m.value })}
        />
      );
    }
    return <SettingsForm key={`doc-${state.id}`} type={type} value={body} issues={issues} focusRequest={focusRequest} context={context} onChange={(_next, m) => on.edit?.({ sectionId: null, path: m.path, value: m.value })} />;
  };

  const actions = state && (
    <div className="flex flex-wrap items-start gap-3" data-editor-actions="">
      {publish && <PublishPanelView state={publish.state} canConfirm={publish.canConfirm} access={access} call={call} on={publish.on} />}
      {changed && !goBack?.confirming && (
        <Button size="md" onClick={on.goBack} disabled={Boolean(state.busy)} data-go-back="">
          {WORDS.goBackToLive}
        </Button>
      )}
      {goBack?.confirming && (
        <div className="space-y-2 rounded-ctl border border-edge bg-surface-sunken p-3 text-[13px]" data-go-back-confirm="">
          <p>{WORDS.goBackConfirm}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={on.goBackConfirm} busy={goBack.busy}>
              {WORDS.goBackToLive}
            </Button>
            <Button size="sm" onClick={on.goBackCancel} disabled={goBack.busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {route && live && !staff && (
        <UndoNotice target={{ kind: "offline", label, id: state.id, revision: state.revision }} label="Take this page offline" call={call} access={access} onUndone={on.afterUndo} />
      )}
      {route && live && staff && (
        <div className="space-y-1">
          <Button size="md" disabled>
            Take this page offline
          </Button>
          <p className="text-[13px] text-fg-muted">{access.reason}</p>
        </div>
      )}
      <Button size="md" variant="ghost" onClick={on.toggleVersions} data-versions-toggle="">
        {versions ? "Hide earlier versions" : "Earlier versions"}
      </Button>
    </div>
  );

  return (
    <div data-document-editor="" data-doc={entry?.id || ""} data-writing={writing ? "" : undefined} className="space-y-4">
      <PageHeader title="Editor" description="Edit your store's pages, menus and look here. Changes save as drafts and go live when you publish." />
      {note && (
        <Banner tone="info" className="mb-1">
          {note}
        </Banner>
      )}
      {switchNote && (
        <Banner tone="info" className="mb-1">
          <span data-switch-note="">{switchNote}</span>
        </Banner>
      )}
      <section aria-label="Open document" className="rounded-card border border-edge bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Editing</p>
            <h2 data-document-label="" className="mt-1 text-lg font-semibold text-fg">
              {label}
            </h2>
          </div>
          <Button size="sm" onClick={on.toggleSwitcher} aria-expanded={showSwitcher} data-switcher-toggle="">
            {showSwitcher ? "Close the page list" : "All pages"}
          </Button>
        </div>
        <div className="mt-1">
          <ProductCounts counts={products?.counts || null} />
        </div>
        {showSwitcher && (
          <div className="mt-3">
            <SwitcherView
              documents={docs || []}
              products={products?.items || []}
              counts={products?.counts || null}
              productsState={productsState}
              collections={catalog.collections || []}
              openId={entry?.id}
              openEntityId={entityId}
              query={on.query ?? ""}
              onQuery={on.setQuery}
              filter={productFilter}
              onFilter={on.setFilter}
              onMore={on.moreProducts}
              onOpen={on.open}
              onOpenHref={on.openHref}
              busyId={busyOpen}
            />
          </div>
        )}
        <div className="mt-3">
          <StatusLine save={state} preview={previewView} closed={closed} blocked={blocked} previewHidden={writing && !previewOpen} on={on.status || {}} />
        </div>
      </section>

      {load.status === "loading" && <p className="text-sm text-fg-muted" role="status">{WORDS.loading(label)}</p>}
      {load.status === "failed" && (
        <Banner tone="danger" title={load.message || WORDS.loadFailed} />
      )}
      {load.status === "missing" && entityDoc && readOnly && (
        <div className="space-y-3 rounded-card border border-edge bg-surface p-4" data-entity-untouched="">
          <p className="text-[13px] text-fg-muted">{type === "product_content" ? "Nothing has been changed on this product yet. It shows what Shopify sends." : "Nothing has been changed on this collection yet."}</p>
          {type === "product_content" ? (
            <ProductForm body={null} entity={entity} access={{ canPublish: false }} readOnly={readOnly} context={context} />
          ) : (
            <CollectionForm body={null} entity={entity} readOnly={readOnly} context={context} />
          )}
        </div>
      )}
      {load.status === "missing" && !(entityDoc && readOnly) && (
        <Banner tone="info" title={WORDS.notFoundSingleton(label)}>
          <div className="mt-2">
            <Button size="sm" variant="primary" onClick={on.startMissing} data-start-missing="">
              {WORDS.start}
            </Button>
          </div>
        </Banner>
      )}

      {state && !staleEntity && actions}
      {state && !staleEntity && versions && (
        <section aria-label="Earlier versions" className="rounded-card border border-edge bg-surface p-4" data-earlier-versions-panel="">
          {versions.status === "loading" ? <p className="text-[13px] text-fg-muted">Loading earlier versions…</p> : <EarlierVersions versions={versions.rows} onRestore={on.restore} message={versions.message} />}
        </section>
      )}

      {state && !staleEntity && writing && (
        <div className="space-y-4" data-writing-view="">
          <p className="text-[13px] text-fg-muted">{WORDS.writingView}</p>
          <div className="space-y-6 rounded-card border border-edge bg-surface p-4">
            <SettingsForm key={`doc-${state.id}`} type={type} value={body} issues={issues} focusRequest={selection ? null : focusRequest} context={context} onChange={(_n, m) => on.edit?.({ sectionId: null, path: m.path, value: m.value })} />
            {sections
              .filter((s) => s.kind === RICH)
              .map((s) => (
                <SettingsForm key={s.id} kind={s.kind} sectionId={s.id} value={s.settings} issues={issues} focusRequest={selection === s.id ? focusRequest : null} context={context} onChange={(_n, m) => on.edit?.({ sectionId: s.id, path: m.path, value: m.value })} />
              ))}
          </div>
          <Button size="sm" onClick={on.togglePreview} aria-expanded={previewOpen} data-preview-toggle="">
            {previewOpen ? WORDS.hidePreview : WORDS.showPreview}
          </Button>
          {preview}
        </div>
      )}

      {staleEntity && load.status !== "loading" && (
        <p className="text-sm text-fg-muted" role="status" data-entity-switching="">
          {WORDS.loading(label)}
        </p>
      )}

      {state && !staleEntity && !writing && entityDoc && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]" data-editor-layout="" data-entity-layout="">
          <section aria-label="Settings" className="min-w-0 rounded-card border border-edge bg-surface p-4" data-inspector="">
            {inspector()}
          </section>
          <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">{preview}</div>
        </div>
      )}

      {state && !staleEntity && !writing && !entityDoc && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]" data-editor-layout="">
          <div className="min-w-0 space-y-4">
            {sections && (
              <section aria-label="Sections" className="max-h-[45vh] overflow-y-auto rounded-card border border-edge bg-surface p-3 lg:max-h-[40vh]">
                <SectionTree type={type} sections={sections} selectedId={selection} issuesBySection={groupIssues(issues)} collections={catalog.collections} onChange={on.treeChange} onSelect={on.treeSelect} />
                {selection && (
                  <button type="button" className="mt-2 text-[13px] underline focus-ring" onClick={() => on.treeSelect?.(null, { force: true })}>
                    {route ? "Edit the page's details" : "Edit the settings of the whole page"}
                  </button>
                )}
              </section>
            )}
            <section aria-label="Settings" className="rounded-card border border-edge bg-surface p-4" data-inspector="">
              {inspector()}
            </section>
          </div>
          <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">{preview}</div>
        </div>
      )}
    </div>
  );
}

// ---- the editor ---------------------------------------------------------------------

export default function DocumentEditor({ document: entry, note = null, entity: entityProp = null, readOnly = null, api = documentsApi }) {
  const router = useRouter();
  const [docs, setDocs] = useState(null);
  const [catalog, setCatalog] = useState({ products: [], collections: [] });
  const [load, setLoad] = useState({ status: "loading" });
  const [store, setStore] = useState(null);
  const [selection, setSelection] = useState(null);
  const [focusRequest, setFocusRequest] = useState(null);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [query, setQuery] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewView, setPreviewView] = useState(null);
  const [pending, setPending] = useState({});
  const [blocked, setBlocked] = useState(null);
  const [switchNote, setSwitchNote] = useState(null);
  const [goBack, setGoBack] = useState(null);
  const [versions, setVersions] = useState(null);
  const [busyOpen, setBusyOpen] = useState(null);
  const [mounted, setMounted] = useState(false);
  const [previewRetries, setPreviewRetries] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [productList, setProductList] = useState(null); // { items, counts, nextCursor }
  const [productsState, setProductsState] = useState({ status: "loading", more: false });
  const [productFilter, setProductFilter] = useState("all");
  const [entityBusy, setEntityBusy] = useState(false);
  const productSeq = useRef(0);
  // P4-FIX5: only the latest openEntry may adopt its answer (A to B to C with
  // B answering last must never leave the store on B while the page is on C)
  const openSeq = useRef(0);
  const picker = useMemo(() => createLibraryPicker(setPickerOpen), []);
  const lookupProducts = useCallback(async (ids) => (await fetchRefs({ type: "product", ids: ids.join(","), limit: ids.length })).items || [], []);
  const storeRef = useRef(null);
  const flowRef = useRef(null);
  const pickRef = useRef(null); // a pick that opened another document: select there
  const treeOpRef = useRef(false);
  const tabStorage = useMemo(() => {
    if (typeof window === "undefined") return null;
    let ls = null;
    try {
      ls = window.localStorage;
    } catch {
      ls = null;
    }
    return createTabStorage(ls, makeTabId());
  }, []);
  storeRef.current = store;

  const state = useSyncExternalStore(store ? store.subscribe : noSub, store ? store.getState : noState, noState);

  // ---- loading ----
  const refreshDocs = useCallback(async () => {
    const r = await api.call("listDocuments", true);
    if (r?.ok && Array.isArray(r.data?.documents)) setDocs(r.data.documents);
  }, [api]);

  // P4-EDITOR: the switcher's products, read only through listProductContent
  // (search, filter, pages); every answer carries the shell's counts
  const loadProducts = useCallback(
    async ({ q = "", filter = "all", cursor = null } = {}) => {
      const mine = ++productSeq.current;
      setProductsState((p) => ({ ...p, status: "loading" }));
      const r = await api.call("listProductContent", productListArgs({ query: q, filter, cursor }));
      if (mine !== productSeq.current) return;
      if (!r?.ok) return setProductsState({ status: "failed", more: false, message: r?.message });
      const d = r.data || {};
      setProductList((prev) => ({ items: cursor && prev ? [...prev.items, ...(d.items || [])] : d.items || [], counts: d.counts || prev?.counts || null, nextCursor: d.nextCursor || null }));
      setProductsState({ status: "ready", more: Boolean(d.nextCursor) });
    },
    [api],
  );

  useEffect(() => {
    setMounted(true);
    refreshDocs();
    loadProducts();
    // the pickers' first products and collections: the catalog picker's read
    // (/api/admin/refs), never the 30-row catalog route
    Promise.all([fetchRefs({ type: "product", limit: 50 }).catch(() => null), fetchRefs({ type: "collection", limit: 50 }).catch(() => null)]).then(([p, c]) =>
      setCatalog({
        products: (p?.items || []).map((x) => ({ handle: x.handle, id: x.id, title: x.title, available_count: x.status === "available" ? 1 : 0 })),
        collections: (c?.items || []).map((x) => ({ handle: x.handle, id: x.id, title: x.title, available_count: x.product_count ?? 0 })),
      }),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a new search or filter reads the list again (a short pause while typing)
  const firstList = useRef(true);
  useEffect(() => {
    if (firstList.current) {
      firstList.current = false;
      return undefined;
    }
    const h = setTimeout(() => loadProducts({ q: query, filter: productFilter }), 250);
    return () => clearTimeout(h);
  }, [query, productFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const adopt = useCallback(
    async (document) => {
      storeRef.current?.dispose();
      const s = createDocumentStore({ api, document, tenant: typeof window !== "undefined" ? window.location.host : "", storage: tabStorage });
      storeRef.current = s;
      setStore(s);
      await s.open();
      return s;
    },
    [api, tabStorage],
  );

  const openEntry = useCallback(
    async (id) => {
      const mine = ++openSeq.current;
      setLoad({ status: "loading" });
      setVersions(null);
      setGoBack(null);
      setPending({});
      const r = await api.call("getDocument", id);
      // a later openEntry started while this one waited: its answer wins
      if (mine !== openSeq.current) return;
      if (r?.ok && isObj(r.data?.document)) {
        await adopt(r.data.document);
        if (mine !== openSeq.current) return;
        setLoad({ status: "ready" });
        const p = pickRef.current;
        pickRef.current = null;
        if (p && p.documentId === id) {
          setSelection(p.sectionId || null);
          setFocusRequest(p.focusRequest ? { ...p.focusRequest } : null);
          setSwitchNote(p.note);
        } else {
          setSelection(null);
          setFocusRequest(null);
          setSwitchNote(null);
        }
        return;
      }
      storeRef.current?.dispose();
      storeRef.current = null;
      setStore(null);
      setLoad(r?.code === "NOT_FOUND" ? { status: "missing" } : { status: "failed", message: r?.message });
    },
    [api, adopt],
  );

  useEffect(() => {
    if (entry?.id) openEntry(entry.id);
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => storeRef.current?.dispose(), []);

  // P4-EDITOR: what Shopify sends now for the open product or collection is
  // the page's (read on the server); this editor never asks for it.
  const entity = entityProp;

  // ---- leaving (ED-03) ----
  const guard = useMemo(
    () =>
      createNavGuard({
        getStore: () => storeRef.current,
        origin: typeof window !== "undefined" ? window.location.origin : "",
        here: () => (typeof window !== "undefined" ? window.location.pathname + window.location.search : ""),
        navigate: (to) => {
          setBlocked(null);
          router.push(to);
        },
        onBlocked: (b) => setBlocked(b),
      }),
    [router],
  );
  useEffect(() => {
    const onClick = (e) => {
      guard.onClickCapture(e);
    };
    const onBefore = (e) => {
      const s = storeRef.current;
      if (s && s.beforeUnload()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onStorage = (e) => tabStorage?.onStorage?.(e);
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBefore);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBefore);
      window.removeEventListener("storage", onStorage);
    };
  }, [guard, tabStorage]);

  const openDocument = useCallback(
    async (id) => {
      if (!id) return;
      if (id === entry?.id && storeRef.current) {
        setShowSwitcher(false);
        return;
      }
      setBusyOpen(id);
      const moved = await guard.go(editorHref(id));
      setBusyOpen(null);
      if (moved) setShowSwitcher(false);
    },
    [guard, entry?.id],
  );

  // ---- the store's call, the publish flow ----
  const call = useMemo(
    () =>
      createStoreCall({
        api,
        getStore: () => storeRef.current,
        getPinned: (id) => flowRef.current?.getState().items.find((it) => it.id === id)?.draftHash ?? null,
        onReplaced: (doc) => adopt(doc),
      }),
    [api, adopt],
  );
  const focusField = useCallback(
    (f) => {
      if (!f) return;
      if (f.documentId && f.documentId !== storeRef.current?.getState().id) {
        pickRef.current = { documentId: f.documentId, sectionId: f.sectionId || null, focusRequest: f.field ? { path: f.field, offset: null } : null, note: null };
        openDocument(f.documentId);
        return;
      }
      setSelection(f.sectionId || null);
      setFocusRequest(f.field ? { path: f.field, offset: null } : null);
      if (!f.field && f.anchor && typeof document !== "undefined") setTimeout(() => document.getElementById(f.anchor)?.focus?.(), 0);
    },
    [openDocument],
  );
  const flow = useMemo(() => {
    // P4-EDITOR: a lost publish answer is checked against the server's
    // document (readDocument), never the store's copy
    const f = createPublishFlow({ call, readDocument: (id) => api.call("getDocument", id), onFocus: focusField, onPublished: () => refreshDocs() });
    flowRef.current = f;
    return f;
  }, [call, focusField, refreshDocs]);
  const publishState = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  // P4-EDITOR: a lost answer that turned out live: take the server's document
  // (its published version) into the store, unless typing is waiting
  useEffect(() => {
    if (publishState.phase !== "checked" || publishState.outcome?.live !== true) return;
    refreshDocs();
    const s = storeRef.current;
    if (!s || s.getState().unacknowledged) return;
    api.call("getDocument", s.getState().id).then((g) => {
      const cur = storeRef.current;
      if (g?.ok && isObj(g.data?.document) && cur && !cur.getState().unacknowledged && cur.getState().id === g.data.document.id) adopt(g.data.document);
    });
  }, [publishState.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const homeExists = Array.isArray(docs) && docs.some((d) => d.id === "doc_home" || d.type === "home");

  const publish = {
    state: publishState,
    canConfirm: flow.canConfirm(),
    on: {
      open: async () => {
        const s = storeRef.current;
        if (!s) return;
        const f = await s.beforeNavigate(); // what the review shows is what is saved
        if (!f.ok) return setBlocked({ message: f.message || WORDS.notSavedYet, to: null });
        const st = s.getState();
        flow.open([{ id: st.id, label: st.document?.label, type: st.type, revision: st.revision, draftHash: st.draftHash }], { access: st.document?.access });
      },
      confirm: () => flow.confirm(),
      close: () => flow.close(),
      act: (a, issue) => flow.act(a, issue),
      keepLive: (id, sectionId) => flow.keepLive(id, sectionId),
      retry: () => flow.retry(),
      focus: focusField,
      document: () => {},
      openDocument: (id) => openDocument(id),
      conflict: null,
      // "Make your home page" only when there is no home page yet; when there is
      // one, the same button opens it (the words are PublishPanel's)
      createHome: async () => {
        if (homeExists) return openDocument("doc_home");
        const r = await api.call("createDocument", { type: "home", meta: null, body: null, entityId: null });
        await refreshDocs();
        openDocument(r?.ok ? r.data?.document?.id || "doc_home" : "doc_home");
      },
      openEarlierVersions: () => toggleVersions(true),
    },
  };

  // ---- earlier versions, go back to live ----
  async function toggleVersions(force) {
    if (versions && force !== true) return setVersions(null);
    const s = storeRef.current;
    if (!s) return;
    setVersions({ status: "loading" });
    const r = await api.call("listHistory", s.getState().id);
    setVersions({ status: "ready", rows: r?.ok ? r.data.versions : [], message: r?.ok ? null : r?.message });
  }
  async function restore(row) {
    const s = storeRef.current;
    if (!s) return null;
    const r = await s.restoreVersion(row.id);
    return r;
  }

  // ---- edits ----
  const edit = ({ sectionId, path, value }) => storeRef.current?.setField(inspectorPath({ sectionId, path }), value);
  const treeChange = (next, meta) => {
    const s = storeRef.current;
    if (!s) return;
    const before = s.getState().body?.sections || [];
    applyTreeOps(s, treeChangeOps(before, next, meta), next);
    const sel = selectionAfterTree({ selectedId: selection, op: meta?.op, proposed: meta?.selectedId ?? null, after: next });
    setSelection(sel);
    setFocusRequest(null);
    if ((meta?.op === "add" || meta?.op === "duplicate") && meta.id) setPending((p) => ({ ...p, [meta.id]: s.getState().ackCount }));
    treeOpRef.current = true;
    queueMicrotask(() => {
      treeOpRef.current = false;
    });
  };
  const treeSelect = (id, opts) => {
    if (treeOpRef.current && !opts?.force) return; // the tree's own follow-up after a change: selectionAfterTree decided
    setSelection(id || null);
    setFocusRequest(null);
  };

  // ---- the preview ----
  const onPick = (pick) => {
    const s = storeRef.current?.getState();
    const layout = s && (s.type === "product_layout" || s.type === "collection_layout") ? (s.body?.sections || []).find((x) => sectionType(x?.kind)?.protected)?.id || null : null;
    const plan = pickPlan(pick, { openId: s?.id || entry?.id, openLabel: s?.document?.label || entry?.label, labelOf: (id) => docs?.find((d) => d.id === id)?.label || null, fallbackSectionId: layout });
    if (plan.kind === "select") {
      if (plan.sectionId) setSelection(plan.sectionId);
      else if (plan.focusRequest) setSelection(null);
      setFocusRequest(plan.focusRequest ? { ...plan.focusRequest } : null);
      setSwitchNote(null);
    } else if (plan.kind === "switch") {
      pickRef.current = plan;
      openDocument(plan.documentId);
    }
  };
  const onView = (v) => {
    setPreviewView(v);
    if (v.phase === "shown") setPending((p) => (Object.keys(p).length ? pendingAfterShown(p, v.shownAck).pending : p));
  };
  const problem = useMemo(() => {
    if (!state) return null;
    if (state.pending) return { kind: "pending", message: state.pending.message, issues: state.pending.issues };
    if (state.error) return { kind: "failed", message: state.error.message };
    return null;
  }, [state?.pending, state?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const ack = useMemo(() => (state ? { ackCount: state.ackCount, draftHash: state.draftHash, issues: state.issues } : null), [state?.ackCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const productHandle = (catalog.products || []).find((p) => p.available_count > 0)?.handle || catalog.products?.[0]?.handle || null;
  const collectionHandle = catalog.collections?.[0]?.handle || null;
  const entityHandle = isObj(entity?.shopify) && typeof entity.shopify.handle === "string" ? entity.shopify.handle : null;
  const path = framePathFor(state ? { type: state.type, body: state.body, slug: state.document?.slug } : entry, { productHandle, collectionHandle, entityHandle });
  const writing = Boolean(state) && isWritingDocument(state.type, state.body);
  const adding = Boolean(selection && Object.hasOwn(pending, selection)) || Object.keys(pending).length > 0;
  const previewEl =
    !mounted ? null : (
      <PreviewPane
        retry={previewRetries}
        api={api}
        documentId={state?.id || entry?.id}
        path={path}
        ack={ack}
        problem={problem}
        select={selection && !Object.hasOwn(pending, selection) ? selection : null}
        adding={adding}
        hidden={writing && !previewOpen}
        label={state?.document?.label || entry?.label}
        onPick={onPick}
        onView={onView}
      />
    );

  return (
    <>
    <EditorView
      entry={entry}
      note={note}
      switchNote={switchNote}
      load={load}
      state={state}
      docs={docs}
      catalog={catalog}
      selection={selection}
      focusRequest={focusRequest}
      showSwitcher={showSwitcher}
      previewOpen={previewOpen}
      preview={previewEl}
      previewView={previewView}
      publish={publish}
      blocked={blocked}
      goBack={goBack}
      versions={versions}
      busyOpen={busyOpen}
      call={call}
      pickImage={picker.pick}
      lookupProducts={lookupProducts}
      entity={entity}
      readOnly={readOnly}
      products={productList}
      productsState={productsState}
      productFilter={productFilter}
      entityBusy={entityBusy}
      on={{
        edit,
        treeChange,
        treeSelect,
        open: openDocument,
        openHref: async (href) => {
          if (!href) return;
          setBusyOpen(href);
          const moved = await guard.go(href);
          setBusyOpen(null);
          if (moved) setShowSwitcher(false);
        },
        query,
        setQuery,
        setFilter: (f) => setProductFilter(f),
        moreProducts: () => productList?.nextCursor && loadProducts({ q: query, filter: productFilter, cursor: productList.nextCursor }),
        resolve: async (field, choice) => {
          const s = storeRef.current;
          if (!s) return;
          setEntityBusy(true);
          const r = await call("resolveShopifyChange", { id: s.getState().id, field, choice });
          setEntityBusy(false);
          if (r && !r.ok) setBlocked({ message: r.message, to: null });
          else loadProducts({ q: query, filter: productFilter });
        },
        discard: async () => {
          const s = storeRef.current;
          if (!s) return;
          setEntityBusy(true);
          const r = await call("discardOrphanEdits", { id: s.getState().id });
          setEntityBusy(false);
          if (r && !r.ok) setBlocked({ message: r.message, to: null });
          else {
            refreshDocs();
            loadProducts({ q: query, filter: productFilter });
          }
        },
        restore,
        toggleSwitcher: () => setShowSwitcher((v) => !v),
        togglePreview: () => setPreviewOpen((v) => !v),
        toggleVersions: () => toggleVersions(),
        afterUndo: () => refreshDocs(),
        goBack: () => setGoBack({ confirming: true, busy: false }),
        goBackCancel: () => setGoBack(null),
        goBackConfirm: async () => {
          setGoBack({ confirming: true, busy: true });
          const r = await storeRef.current?.discardDraft();
          setGoBack(null);
          if (r && !r.ok) setBlocked({ message: r.message, to: null });
        },
        startMissing: async () => {
          const r = await api.call("createDocument", { type: entry?.type, meta: null, body: null, entityId: null });
          if (r?.ok) {
            await refreshDocs();
            openEntry(entry.id);
          } else setLoad({ status: "failed", message: r?.message });
        },
        status: {
          useNewer: () => storeRef.current?.useNewer(),
          keepMine: () => storeRef.current?.keepMine(),
          acceptBackup: () => storeRef.current?.acceptBackup(),
          dismissBackup: () => storeRef.current?.dismissBackup(),
          retry: () => storeRef.current?.retry(),
          previewRetry: () => setPreviewRetries((n) => n + 1),
          leaveAnyway: () => {
            const to = blocked?.to;
            setBlocked(null);
            if (to) router.push(to);
          },
        },
      }}
    />
    {pickerOpen && <MediaPicker open={pickerOpen} onClose={picker.close} onSelect={picker.select} />}
    </>
  );
}

// ---- /admin/releases in documents mode (PUB-04) ---------------------------------------

// Recently published, with Undo through documentsApi. `access` is passed on
// (P3-FIX3 adds the prop to RecentlyPublished and UndoNotice): staff see
// Undo disabled with the reason (PUB-02).
// The rows are read from the documents API (listRecentlyPublished), again
// after each Undo. initialRows: rows already in hand (tests).
export function PublishingHistory({ initialRows = null, access = null, api = documentsApi }) {
  const [list, setList] = useState(initialRows ? { status: "ready", rows: initialRows } : { status: "loading", rows: [] });
  const load = useCallback(async () => {
    const r = await api.call("listRecentlyPublished", { limit: 20 });
    setList(r?.ok ? { status: "ready", rows: Array.isArray(r.data?.rows) ? r.data.rows : [] } : { status: "failed", rows: [], message: r?.message });
  }, [api]);
  useEffect(() => {
    if (!initialRows) load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (list.status === "loading") return <p className="text-sm text-fg-muted" role="status">Loading what was published…</p>;
  if (list.status === "failed") return <Banner tone="warning" title={list.message || "We couldn't load what was published. Reload the page."} />;
  return <RecentlyPublished rows={list.rows} call={api.call} access={access} editorHref={(id) => editorHref(id)} onUndone={() => load()} />;
}
