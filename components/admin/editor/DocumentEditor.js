"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/components/ui/utils";
import { RoleGate } from "@/components/kit/role-gate";
import * as documentsApi from "./documentsApi";
import { createDocumentStore } from "./store";
import SectionTree from "./tree/SectionTree";
import { groupIssues } from "./tree/treeModel";
import SettingsForm from "./fields/SettingsForm";
import { createLibraryPicker } from "./fields/index.js";
import ProductForm from "./ProductForm";
import CollectionForm from "./CollectionForm";
import { MediaPicker } from "../shared/MediaPicker";
import { fetchRefs } from "../shared/RefPicker";
import { PublishPanelView } from "./publish/PublishPanel";
import UndoNotice from "./publish/UndoNotice";
import EarlierVersions from "./publish/EarlierVersions";
import { createPublishFlow, WORDS as PUBLISH_WORDS } from "./publish/publishModel";
import { SwitcherView, ProductCounts } from "./Switcher";
import PreviewPane from "./PreviewPane";
import StatusLine, { Notice } from "./StatusLine";
import {
  WORDS,
  ENTITY_TYPES,
  applyTreeOps,
  productListArgs,
  createNavGuard,
  createStoreCall,
  readOnlyApi,
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
import { pickedBundleIds, bundlesWithPending } from "./fields/inspectorModel.js";

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
//   can                                  { offersWrite } (P5-EDITOR, OQ-A):
//                                        the inline "Create a bundle"
//   currency                             the store's currency, for that form
//   startingBrand                        P6-NAV (OQ-P6-8): the store's
//                                        starting palette brand, handed to
//                                        the design form in the context (its
//                                        Reset goes back to it), or null
//   api                                  documentsApi (tests pass a stub)
//
// P5-EDITOR (COM-02, COM-01): the bundle picker's rows. Read once at mount
// beside products and collections (GET /api/admin/refs?type=bundle, first 50),
// plus ids= for picked bundles not in that page; again on window focus and
// after an inline create, so the inspector's chips match the preview. A
// failed or 403 read is { status: "failed" }: the picker then says "You
// can't see bundles here." A search goes to q=.
// P5-FIX2 (the P5-EDITOR review): the list also keeps `answered`, the ids an
// ids= read answered, and the view gets `pending` (inspectorModel
// bundlesWithPending): a picked id that is neither in the list nor answered
// yet reads "Checking this bundle…", never "deleted".

const RICH = "rich_text";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const noSub = () => () => {};
const noState = () => null;
const ROUTE_FAMILY = { page: "page", campaign: "campaign", journal: "journal" };
// Phase 2 line 6 (6a): the phone tabs (below 768px)
const PANES = ["sections", "edit", "preview"];
const READ_ONLY_WORDS = "You can look at this page but not change it.";
const PANE_WORDS = { sections: "Sections", edit: "Edit", preview: "Preview" };

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
  bundles = null,
  can = {},
  currency = undefined,
  startingBrand = null,
  products = null,
  productsState = { status: "ready", more: false },
  productFilter = "all",
  entityBusy = false,
  role = null,
  paneTab = "edit",
  tabletPreview = false,
  showArchived = false,
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
  const lockedWords = can?.write === true ? null : readOnly || READ_ONLY_WORDS;
  const context = {
    readOnlyReason: lockedWords,
    collections: catalog.collections || [],
    products: catalog.products || [],
    pages: (Array.isArray(docs) ? docs : []).filter((d) => ROUTE_FAMILY[d.type] && d.slug).map((d) => ({ slug: d.slug, family: ROUTE_FAMILY[d.type], document: d.id, title: d.label })),
    ...(typeof pickImage === "function" ? { pickImage } : {}),
    ...(typeof lookupProducts === "function" ? { lookupProducts } : {}),
    shopify: isObj(entity) && isObj(entity.shopify) ? entity.shopify : null,
    shopifyMissing: isObj(entity) && entity.inShopify === false,
    // P5-EDITOR: the bundle picker (fields/BundleControl.js)
    bundles: bundles || { status: "loading", items: [] },
    ...(typeof on.searchBundles === "function" ? { searchBundles: on.searchBundles } : {}),
    ...(typeof on.refreshBundles === "function" ? { refreshBundles: on.refreshBundles } : {}),
    canCreateBundles: can?.offersWrite === true,
    currency,
    // P6-NAV: the design form's Reset (fields/DesignForm.js)
    startingBrand: isObj(startingBrand) ? startingBrand : null,
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
          readOnly={lockedWords}
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
      return <CollectionForm key={`collection-${formKey}`} body={body} entity={entity} readOnly={lockedWords} issues={issues} context={context} on={{ edit: (m) => on.edit?.({ sectionId: null, path: m.path, value: m.value }) }} />;
    }
    if (selected) {
      return (
        <SettingsForm readOnlyReason={lockedWords}
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
    return <SettingsForm readOnlyReason={lockedWords} key={`doc-${state.id}`} type={type} value={body} issues={issues} focusRequest={focusRequest} context={context} onChange={(_next, m) => on.edit?.({ sectionId: null, path: m.path, value: m.value })} />;
  };

  const canWrite = can?.write === true;
  // Phase 2 line 6 (6b): support's inspector is read-only, every field and
  // picker disabled, with these words above it
  const canPublish = can?.publish === true;
  // Phase 2 line 6 (6c): without storefront.publish (staff, support) the bar
  // shows the reason where Publish would be, and no Publish, Take offline or
  // Undo button; the page's can.publish wins over a document read before it
  const publishAccess = can?.publish !== false ? access : { canPublish: false, reason: access?.reason || PUBLISH_WORDS.staffReason };
  const tab = PANES.includes(paneTab) ? paneTab : "edit";
  const ready = Boolean(state) && !staleEntity;
  const loading = load.status === "loading" || (!state && load.status === "ready");

  const actions = state && (
    <div className="relative flex flex-wrap items-start gap-2" data-editor-actions="">
      {publish && <PublishPanelView floating state={publish.state} canConfirm={publish.canConfirm} access={publishAccess} call={call} on={publish.on} />}
      {changed && !goBack?.confirming && (
        <RoleGate role={role} action="storefront.write" mode="hide">
          <Button size="sm" variant="outline" onClick={on.goBack} disabled={Boolean(state.busy)} data-go-back="">
            {WORDS.goBackToLive}
          </Button>
        </RoleGate>
      )}
      {goBack?.confirming && (
        <Notice tone="warning" data-go-back-confirm="">
          <p>{WORDS.goBackConfirm}</p>
          <div className="mt-2 flex gap-2">
            <RoleGate role={role} action="storefront.write" mode="hide">
              <Button size="xs" onClick={on.goBackConfirm} disabled={goBack.busy}>
                {WORDS.goBackToLive}
              </Button>
            </RoleGate>
            <Button size="xs" variant="outline" onClick={on.goBackCancel} disabled={goBack.busy}>
              Cancel
            </Button>
          </div>
        </Notice>
      )}
      {route && live && !staff && canPublish && (
        <UndoNotice target={{ kind: "offline", label, id: state.id, revision: state.revision }} label="Take this page offline" call={call} access={access} onUndone={on.afterUndo} />
      )}

      <Button size="sm" variant="ghost" onClick={on.toggleVersions} data-versions-toggle="" data-read-control="">
        {versions ? "Hide earlier versions" : "Earlier versions"}
      </Button>
    </div>
  );

  const paneSkeleton = (rows) => (
    <div className="space-y-2 p-3" data-pane-skeleton="" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );

  const pageList = showSwitcher && (
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
      showArchived={showArchived}
      onShowArchived={on.setShowArchived}
      role={role}
      onCreate={on.createPage}
      onArchive={on.archive}
    />
  );

  // the left pane: the page list (when open) or the open document's sections
  const sectionsPane = (
    <div className="flex min-h-0 flex-col" data-pane-body="sections">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">{showSwitcher ? "All pages" : "Sections"}</p>
        <Button size="xs" variant="ghost" onClick={on.toggleSwitcher} aria-expanded={showSwitcher} data-switcher-toggle="" data-read-control="">
          {showSwitcher ? "Close the page list" : "All pages"}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {pageList}
          {!showSwitcher && loading && paneSkeleton(5)}
          {!showSwitcher && ready && sections && !writing && !entityDoc && (
            <>
              <SectionTree type={type} sections={sections} selectedId={selection} issuesBySection={groupIssues(issues)} collections={catalog.collections} onChange={on.treeChange} onSelect={on.treeSelect} body={body} role={role} />
              {selection && (
                <Button size="xs" variant="link" className="mt-2 px-0" onClick={() => on.treeSelect?.(null, { force: true })} data-read-control="">
                  {route ? "Edit the page's details" : "Edit the settings of the whole page"}
                </Button>
              )}
            </>
          )}
          {!showSwitcher && ready && (writing || entityDoc || !sections) && <p className="text-[13px] text-muted-foreground">{entityDoc ? "This content has no sections. Its fields are in Edit." : writing ? WORDS.writingView : "This page has no sections. Its settings are in Edit."}</p>}
        </div>
      </ScrollArea>
    </div>
  );

  const editPane = (
    <div className="min-w-0 space-y-4 p-4" data-pane-body="edit">
      {loading && paneSkeleton(6)}
      {load.status === "failed" && (
        <Notice tone="danger" title={load.message || WORDS.loadFailed} data-load-failed="">
          <Button size="xs" variant="outline" className="mt-2" onClick={on.retryLoad} data-load-retry="" data-read-control="">
            Try again
          </Button>
        </Notice>
      )}
      {load.status === "missing" && entityDoc && readOnly && (
        <div className="space-y-3" data-entity-untouched="">
          <p className="text-[13px] text-muted-foreground">{type === "product_content" ? "Nothing has been changed on this product yet. It shows what Shopify sends." : "Nothing has been changed on this collection yet."}</p>
          {type === "product_content" ? <ProductForm body={null} entity={entity} access={{ canPublish: false }} readOnly={readOnly} context={context} /> : <CollectionForm body={null} entity={entity} readOnly={readOnly} context={context} />}
        </div>
      )}
      {load.status === "missing" && !(entityDoc && readOnly) && (
        <Notice tone="info" title={WORDS.notFoundSingleton(label)}>
          <RoleGate role={role} action="storefront.write" mode="hide">
            <Button size="xs" className="mt-2" onClick={on.startMissing} data-start-missing="">
              {WORDS.start}
            </Button>
          </RoleGate>
        </Notice>
      )}
      {staleEntity && load.status !== "loading" && (
        <p className="text-sm text-muted-foreground" role="status" data-entity-switching="">
          {WORDS.loading(label)}
        </p>
      )}
      {ready && writing && (
        <div className="space-y-4" data-writing-view="">
          <p className="text-[13px] text-muted-foreground">{WORDS.writingView}</p>
          <div className="space-y-6" data-inspector="">
            <SettingsForm readOnlyReason={lockedWords} key={`doc-${state.id}`} type={type} value={body} issues={issues} focusRequest={selection ? null : focusRequest} context={context} onChange={(_n, m) => on.edit?.({ sectionId: null, path: m.path, value: m.value })} />
            {sections
              .filter((s) => s.kind === RICH)
              .map((s) => (
                <SettingsForm readOnlyReason={lockedWords} key={s.id} kind={s.kind} sectionId={s.id} value={s.settings} issues={issues} focusRequest={selection === s.id ? focusRequest : null} context={context} onChange={(_n, m) => on.edit?.({ sectionId: s.id, path: m.path, value: m.value })} />
              ))}
          </div>
          <Button size="sm" variant="outline" className="hidden md:inline-flex" onClick={on.togglePreview} aria-expanded={previewOpen} data-preview-toggle="" data-read-control="">
            {previewOpen ? WORDS.hidePreview : WORDS.showPreview}
          </Button>
        </div>
      )}
      {ready && !writing && (
        <section aria-label="Settings" className="min-w-0" data-inspector="">
          {inspector()}
        </section>
      )}
    </div>
  );

  // phone (below 768px): one pane at a time, chosen by the tabs; tablet
  // (768-1023px): the sections beside the settings, the preview by a toggle
  // in their place; from 1024px all three side by side. The preview is
  // mounted once and only shown or hidden, so its frame never reloads.
  // A writing document (rich text only) keeps its preview behind its own
  // toggle from 768px; on a phone the Preview tab shows it.
  const paneClass = {
    sections: cn(tab === "sections" ? "flex" : "hidden", "min-h-0 flex-col border-border md:flex md:border-r"),
    edit: writing
      ? cn(tab === "edit" ? "block" : "hidden", "min-h-0 min-w-0 overflow-y-auto md:block", !previewOpen && "lg:col-span-2")
      : cn(tab === "edit" ? "block" : "hidden", tabletPreview ? "md:hidden" : "md:block", "min-h-0 min-w-0 overflow-y-auto lg:block"),
    preview: cn(
      tab === "preview" ? "block" : "hidden",
      "min-h-0 min-w-0 overflow-y-auto border-border bg-muted/40 p-3 lg:border-l",
      writing ? (previewOpen ? "md:block md:col-span-2 lg:col-span-1" : "md:hidden") : cn(tabletPreview ? "md:block" : "md:hidden", "lg:block"),
    ),
  };

  return (
    <div data-document-editor="" data-doc={entry?.id || ""} data-writing={writing ? "" : undefined} className="flex min-h-[calc(100svh-3.5rem)] flex-col lg:h-[calc(100svh-3.5rem)]">
      <header className="space-y-2 border-b border-border bg-background px-4 py-3" data-editor-bar="">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Editing</p>
            <h2 data-document-label="" className="truncate text-lg font-semibold text-foreground">
              {label}
            </h2>
            <ProductCounts counts={products?.counts || null} />
          </div>
          {ready && actions}
        </div>
        <StatusLine save={state} preview={previewView} closed={closed} blocked={blocked} previewHidden={writing && !previewOpen} readOnly={!canWrite} role={role} on={on.status || {}} />
        {note && (
          <Notice tone="info" data-entry-note="">
            {note}
          </Notice>
        )}
        {switchNote && (
          <Notice tone="info">
            <span data-switch-note="">{switchNote}</span>
          </Notice>
        )}
        {ready && versions && (
          <section aria-label="Earlier versions" className="max-h-72 overflow-y-auto rounded-lg border border-border bg-card p-3" data-earlier-versions-panel="">
            {versions.status === "loading" ? <p className="text-[13px] text-muted-foreground">Loading earlier versions…</p> : <EarlierVersions versions={versions.rows} onRestore={canWrite ? on.restore : undefined} message={versions.message} />}
          </section>
        )}
        <div className="flex items-center gap-2 md:hidden">
          <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={tab} onValueChange={(v) => v && on.setPane?.(v)} aria-label="Show" className="w-full" data-editor-tabs="" data-read-control="">
            {PANES.map((p) => (
              <ToggleGroupItem key={p} value={p} className="flex-1" data-pane-tab={p} data-read-control="">
                {PANE_WORDS[p]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {!writing && (
          <div className="hidden md:flex lg:hidden">
            <Button size="xs" variant="outline" onClick={on.toggleTabletPreview} aria-pressed={tabletPreview} data-tablet-preview="" data-read-control="">
              {tabletPreview ? "Show the settings" : "Show the preview"}
            </Button>
          </div>
        )}
      </header>

      <div
        className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[13rem_minmax(17rem,21rem)_minmax(0,1fr)] 2xl:grid-cols-[15rem_minmax(20rem,24rem)_minmax(0,1fr)]"
        data-editor-frame=""
        data-editor-layout={!writing && ready ? "" : undefined}
        data-entity-layout={entityDoc && ready && !writing ? "" : undefined}
      >
        <aside aria-label="Sections and pages" className={paneClass.sections} data-pane="sections">
          {sectionsPane}
        </aside>
        <div className={paneClass.edit} data-pane="edit">
          {editPane}
        </div>
        <section aria-label="Preview" className={paneClass.preview} data-pane="preview">
          {loading && !preview ? paneSkeleton(1) : preview}
        </section>
      </div>
    </div>
  );
}

// ---- the editor ---------------------------------------------------------------------

// Phase 2 line 6 (6a) props, besides the ones above:
//   can            { write, publish, offersWrite } from the page (roleAllows).
//                  can.write false: the store is read-only (no saveDraft is
//                  ever sent, not even the keepalive on pagehide)
//   role           the actor's role, for RoleGate
export default function DocumentEditor({ document: entry, note = null, entity: entityProp = null, readOnly = null, can = {}, role = null, currency = undefined, startingBrand = null, api: givenApi = documentsApi }) {
  // Phase 2 line 6 review: one read-only guard for every direct call below
  // (createDocument, archive, the missing singleton's start, …): without
  // storefront.write only the document reads leave the browser
  const api = useMemo(() => (can?.write === true ? givenApi : readOnlyApi(givenApi)), [givenApi, can?.write]);
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
  const [paneTab, setPaneTab] = useState("edit");
  const [tabletPreview, setTabletPreview] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [bundles, setBundles] = useState({ status: "loading", items: [], answered: [] });
  const bundleSeq = useRef(0);
  const bundleAsked = useRef(new Set()); // ids already asked for by ids=
  // P6-NAV (carried from the P5-FIX2 review): the ids= answers of the picks
  // effect that arrived while a full read (loadBundles) was still out. That
  // read's answer is merged with them, never put in their place, so a bundle
  // picked during a focus re-read keeps its row (and never reads "Checking
  // this bundle…" for good). id -> its row, or null when the answer left it out.
  const bundleLate = useRef(new Map());
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
  // Phase 2 line 6: with "Show archived pages" on, archived pages are read too
  const archivedRef = useRef(false);
  const refreshDocs = useCallback(async () => {
    const r = await api.call("listDocuments", archivedRef.current ? { includeArchived: true } : true);
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

  // P5-EDITOR: the bundles (first 50, then ids= for picked ones not in them).
  // Only the latest read may set the list.
  const loadBundles = useCallback(async () => {
    const mine = ++bundleSeq.current;
    bundleLate.current = new Map();
    try {
      const first = await fetchRefs({ type: "bundle", limit: 50 });
      let items = Array.isArray(first?.items) ? first.items : [];
      const want = pickedBundleIds(storeRef.current?.getState()?.body).filter((id) => !items.some((b) => b?.id === id));
      if (want.length) {
        const more = await fetchRefs({ type: "bundle", ids: want.join(","), limit: want.length });
        items = [...items, ...(Array.isArray(more?.items) ? more.items : [])];
      }
      if (mine !== bundleSeq.current) return;
      // merge the picks effect's answers that came in meanwhile
      const late = [...bundleLate.current].filter(([id]) => !items.some((b) => b?.id === id) && !want.includes(id));
      items = [...items, ...late.map(([, r]) => r).filter(Boolean)];
      const answered = [...want, ...late.map(([id]) => id)];
      bundleAsked.current = new Set([...items.map((b) => b?.id), ...answered]);
      setBundles({ status: "ready", items, answered });
    } catch {
      if (mine === bundleSeq.current) setBundles({ status: "failed", items: [], answered: [] });
    }
  }, []);
  // a search (q=): its rows join the list, so a bundle picked from them has
  // its chip at once
  const searchBundles = useCallback(async (q) => {
    const r = await fetchRefs({ type: "bundle", q, limit: 50 });
    const rows = Array.isArray(r?.items) ? r.items : [];
    setBundles((b) => (b.status === "ready" ? { ...b, items: [...b.items.filter((x) => !rows.some((y) => y?.id === x?.id)), ...rows] } : b));
    return rows;
  }, []);

  useEffect(() => {
    setMounted(true);
    refreshDocs();
    loadProducts();
    loadBundles();
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
      const s = createDocumentStore({ api, document, tenant: typeof window !== "undefined" ? window.location.host : "", storage: tabStorage, readOnly: can?.write !== true });
      storeRef.current = s;
      setStore(s);
      await s.open();
      return s;
    },
    [api, tabStorage, can?.write],
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


  // P5-EDITOR: read the bundles again when the founder comes back to this
  // tab (a bundle changed on the Bundles page changes the live blocks at
  // once), and read by ids= any picked bundle the list doesn't hold yet (a
  // document opened after the first read, or a bundle past the first 50).
  useEffect(() => {
    const onFocus = () => loadBundles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadBundles]);
  const pickedKey = pickedBundleIds(state?.body).join(",");
  useEffect(() => {
    if (bundles.status !== "ready" || !pickedKey) return;
    const want = pickedKey.split(",").filter((id) => !bundles.items.some((b) => b?.id === id) && !bundleAsked.current.has(id));
    if (!want.length) return;
    want.forEach((id) => bundleAsked.current.add(id));
    const mine = bundleSeq.current;
    fetchRefs({ type: "bundle", ids: want.join(","), limit: want.length }).then(
      (r) => {
        if (mine !== bundleSeq.current) return;
        const rows = Array.isArray(r?.items) ? r.items : [];
        for (const id of want) bundleLate.current.set(id, rows.find((x) => x?.id === id) || null);
        setBundles((b) => (b.status === "ready" ? { ...b, items: [...b.items.filter((x) => !rows.some((y) => y?.id === x?.id)), ...rows], answered: [...(b.answered || []), ...want] } : b));
      },
      () => {
        if (mine === bundleSeq.current) setBundles({ status: "failed", items: [], answered: [] });
      },
    );
  }, [pickedKey, bundles.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const bundlesShown = useMemo(() => bundlesWithPending(bundles, pickedKey ? pickedKey.split(",") : []), [bundles, pickedKey]);

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
        hidden={writing && !previewOpen && paneTab !== "preview"}
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
      bundles={bundlesShown}
      can={can}
      currency={currency}
      startingBrand={startingBrand}
      products={productList}
      productsState={productsState}
      productFilter={productFilter}
      entityBusy={entityBusy}
      role={role}
      paneTab={paneTab}
      tabletPreview={tabletPreview}
      showArchived={showArchived}
      on={{
        setPane: (p) => setPaneTab(p),
        toggleTabletPreview: () => setTabletPreview((v) => !v),
        retryLoad: () => entry?.id && openEntry(entry.id),
        setShowArchived: (v) => {
          archivedRef.current = v;
          setShowArchived(v);
          refreshDocs();
        },
        // New page (storefront.write; the server checks it again)
        createPage: async ({ title, slug }) => {
          const r = await api.call("createDocument", { type: "page", meta: { title, slug }, body: null, entityId: null });
          if (!r?.ok) return { ok: false, message: r?.issues?.[0]?.message || r?.message || "The page wasn't made. Try again." };
          await refreshDocs();
          const id = r.data?.document?.id;
          if (id) openDocument(id);
          return { ok: true };
        },
        // Archive (storefront.write): only a page that is not live
        archive: async (row) => {
          const r = await api.call("archive", row.id, { revision: row.revision });
          if (!r?.ok) return { ok: false, message: r?.message || "The page wasn't archived. Try again." };
          await refreshDocs();
          if (row.id === entry?.id) guard.go(editorHref("doc_home"));
          return { ok: true };
        },
        edit,
        searchBundles,
        refreshBundles: loadBundles,
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

// /admin/releases (PUB-04) moved to components/admin/releases/ (Phase 2 line 6).
