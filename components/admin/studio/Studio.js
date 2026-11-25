"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import * as documentsApi from "../editor/documentsApi";
import { createDocumentStore } from "../editor/store";
import PreviewPane from "../editor/PreviewPane";
import StatusLine, { Notice } from "../editor/StatusLine";
import SettingsForm from "../editor/fields/SettingsForm";
import { applyTreeOps, createTabStorage, framePathFor, inspectorPath, readOnlyApi, selectionAfterTree, treeChangeOps } from "../editor/editorModel";
import { createStudioModel, orderMessage, restoreOps } from "./studioModel";
import StudioTopBar from "./StudioTopBar";
import SectionsRail from "./SectionsRail";
import DesignRail, { designStoreFor } from "./DesignRail";

// Phase 6 step 0 (docs/plans/phase-6.md): the studio's shell. A full-screen
// frame over the console: top bar, a left rail with two tabs (Sections,
// Design), the store's real preview in the centre, the existing inspector on
// the right. Lines 1 and 2 fill the slots: line 1 owns SectionsRail.js and
// StudioTopBar.js (drag, publish dialog, undo keys), line 2 owns DesignRail.js
// (the tokens). Each slot gets one prop, `studio` (see studioContext below).
//
// Roles: can = { write, publish } from the page (storefront.write,
// storefront.publish). Without write the api is readOnlyApi and the store is
// read-only, so no documents write ever leaves the browser (support,
// operator support); without publish (staff) there is no Publish control.
export const STUDIO_TABS = Object.freeze([
  { id: "sections", words: "Sections" },
  { id: "design", words: "Design" },
]);
// below 1024px the rails become tabs (Phase 6 line 1 feature 1)
export const STUDIO_PANES = Object.freeze([
  { id: "sections", words: "Sections" },
  { id: "edit", words: "Edit" },
  { id: "design", words: "Design" },
  { id: "preview", words: "Preview" },
]);
export const STUDIO_WORDS = Object.freeze({
  readOnly: "You can look at your store here but not change it.",
  loading: "Opening the studio…",
  failed: "This page couldn't be opened. Nothing was changed.",
  missing: "This page isn't there any more.",
});

export const DESIGN_DOC = "doc_design";
// the store openDocument reuses for id, or null (make one): doc_design is
// the Design tab's store when it has one (never a second store), any other
// document the one this session kept
export function storeToOpen(id, { kept = new Map(), design = null } = {}) {
  if (id === DESIGN_DOC) return design && design.getState?.().id === DESIGN_DOC ? design : null;
  return kept.get(id) || null;
}

// what an undo or redo step does: null (doc_design: the Design tab's
// applier wrote it; or a document no longer held), else the store to write,
// the setField ops (restoreOps toward the step's side) and switchTo, the
// document to switch to when the step isn't on the open one
export function undoPlan(step, { kept = new Map(), open = null, handles = () => false, dir = step?.dir } = {}) {
  if (!step || handles(step.docId)) return null;
  const store = kept.get(step.docId);
  if (!store) return null;
  const ops = restoreOps(store.getState().body, (dir ?? "undo") === "undo" ? step.before : step.after);
  return { store, ops, switchTo: store === open ? null : step.docId };
}

// the preview never says "Up to date" while the open document holds edits
// the server hasn't acknowledged (an instant reorder or token draw is drawn
// before its save): it says "Updating" until the save's reload
export function previewWhileSaving(view, save) {
  if (!view || view.label !== "Up to date" || !save?.unacknowledged) return view;
  return { ...view, label: "Updating", words: null };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const noSub = () => () => {};
const noState = () => null;

// The layout, all props (rendered on its own in test-studio).
export function StudioView({ topBar = null, note = null, readOnly = false, tab = "sections", onTab, pane = "preview", onPane, sections = null, design = null, preview = null, inspector = null }) {
  // small screens show one pane at a time; from lg all three columns show
  const shown = (id) => (pane === id ? "flex" : "hidden");
  const railPane = pane === "sections" || pane === "design";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground" data-studio="" data-studio-readonly={readOnly ? "" : undefined}>
      {topBar}
      {note && (
        <Notice className="mx-3 mt-2" data-studio-note="">
          {note}
        </Notice>
      )}
      <div role="tablist" aria-label="Studio panes" className="flex gap-1 border-b border-border p-2 lg:hidden" data-studio-panes="">
        {STUDIO_PANES.map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant={pane === p.id ? "secondary" : "ghost"}
            role="tab"
            aria-selected={pane === p.id}
            onClick={() => {
              onPane?.(p.id);
              if (p.id === "sections" || p.id === "design") onTab?.(p.id);
            }}
            data-studio-pane={p.id}
            data-read-control=""
          >
            {p.words}
          </Button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <aside aria-label="Studio tools" className={`${railPane ? "flex" : "hidden"} min-h-0 flex-col border-r border-border lg:flex`} data-studio-rail="">
          <div role="tablist" aria-label="Studio tools" className="hidden gap-1 border-b border-border p-2 lg:flex">
            {STUDIO_TABS.map((t) => (
              <Button key={t.id} type="button" size="sm" variant={tab === t.id ? "secondary" : "ghost"} role="tab" aria-selected={tab === t.id} onClick={() => onTab?.(t.id)} data-studio-tab={t.id} data-read-control="">
                {t.words}
              </Button>
            ))}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3" data-studio-panel={tab}>
            {tab === "design" ? design : sections}
          </div>
        </aside>
        <main className={`${shown("preview")} min-h-0 min-w-0 flex-col p-3 lg:flex`} data-studio-preview="">
          {preview}
        </main>
        <aside aria-label="Inspector" className={`${pane === "edit" ? "block" : "hidden"} min-h-0 overflow-y-auto border-l border-border p-3 lg:block`} data-studio-inspector="">
          {inspector}
        </aside>
      </div>
    </div>
  );
}

export default function Studio({ document: entry, note = null, can = {}, role = null, startingBrand = null, api: givenApi = documentsApi }) {
  const canWrite = can?.write === true;
  const canPublish = canWrite && can?.publish === true;
  const api = useMemo(() => (canWrite ? givenApi : readOnlyApi(givenApi)), [givenApi, canWrite]);
  const model = useMemo(() => createStudioModel(), []);
  const history = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [docs, setDocs] = useState(null);
  const [store, setStore] = useState(null);
  const [load, setLoad] = useState({ status: "loading" });
  const [selection, setSelection] = useState(null);
  const [tab, setTab] = useState("sections");
  const [pane, setPane] = useState("preview");
  const [previewView, setPreviewView] = useState(null);
  const [published, setPublished] = useState(null);
  const storeRef = useRef(null);
  // Phase 6 line 1: one store per document opened this session, kept open
  // (still autosaving) when the founder switches, so undo can reach any of
  // them and Publish flushes them all. Line 2's design store joins with
  // registerStore(store) → unregister.
  const storesRef = useRef(new Map());
  // doc_design has one store: the Design tab's (designStoreFor) when it has
  // one; else the studio makes it, the tab shares it, and on leaving it the
  // studio flushes and disposes it (the tab then opens its own)
  const ownDesign = useRef(null);
  const postRef = useRef(null);
  const openSeq = useRef(0);
  const tabStorage = useMemo(() => {
    if (typeof window === "undefined") return null;
    let ls = null;
    try {
      ls = window.localStorage;
    } catch {
      ls = null;
    }
    return createTabStorage(ls, `studio_${Math.random().toString(36).slice(2, 10)}`);
  }, []);
  storeRef.current = store;
  const state = useSyncExternalStore(store ? store.subscribe : noSub, store ? store.getState : noState, noState);

  const openDocument = useCallback(
    async (id) => {
      const mine = ++openSeq.current;
      setLoad({ status: "loading" });
      setSelection(null);
      const prev = storeRef.current;
      if (prev && prev === ownDesign.current && id !== DESIGN_DOC) {
        // saved before the studio moves on, so the Design tab's own store
        // (opened when it sees the studio leave) reads the fresh revision
        // a save that fails (a 409, offline) keeps the studio on the design
        // with its store open: the save line shows the conflict or the error
        const f = prev.readOnly ? { ok: true } : await prev.beforeNavigate().catch(() => null);
        if (!f?.ok) {
          if (mine === openSeq.current) setLoad({ status: "ready" });
          return;
        }
        ownDesign.current = null;
        prev.dispose();
        if (mine !== openSeq.current) return;
      }
      const kept = storeToOpen(id, { kept: storesRef.current, design: designStoreFor({ model }) });
      if (kept) {
        storeRef.current = kept;
        setStore(kept);
        setLoad({ status: "ready" });
        return;
      }
      const r = await api.call("getDocument", id);
      if (mine !== openSeq.current) return;
      if (r?.ok && isObj(r.data?.document)) {
        const s = createDocumentStore({ api, document: r.data.document, tenant: typeof window !== "undefined" ? window.location.host : "", storage: tabStorage, readOnly: !canWrite });
        if (s.getState().id === DESIGN_DOC) ownDesign.current = s;
        else storesRef.current.set(s.getState().id, s);
        storeRef.current = s;
        setStore(s);
        await s.open();
        if (mine === openSeq.current) setLoad({ status: "ready" });
        return;
      }
      storeRef.current = null;
      setStore(null);
      setLoad(r?.code === "NOT_FOUND" ? { status: "missing" } : { status: "failed", message: r?.message });
    },
    [api, tabStorage, canWrite, model],
  );

  useEffect(() => {
    api.call("listDocuments", true).then((r) => r?.ok && Array.isArray(r.data?.documents) && setDocs(r.data.documents));
    openDocument(entry?.id || "doc_home");
    const all = storesRef.current;
    return () => {
      for (const s of all.values()) s.dispose();
      all.clear();
      ownDesign.current?.dispose();
      ownDesign.current = null;
      model.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const registerStore = useCallback((s) => {
    const id = s?.getState?.().id;
    if (!id) return () => {};
    storesRef.current.set(id, s);
    return () => storesRef.current.get(id) === s && storesRef.current.delete(id);
  }, []);
  const refreshDocs = useCallback(() => api.call("listDocuments", true).then((r) => r?.ok && Array.isArray(r.data?.documents) && setDocs(r.data.documents)), [api]);

  // ---- writes (each one an undo step; the store saves it as a draft) ----
  const post = useCallback((msg) => (postRef.current ? postRef.current(msg) : false), []);
  const change = (fn) => {
    const s = storeRef.current;
    if (!s || !canWrite) return;
    const { id, body: before } = s.getState();
    fn(s);
    const after = s.getState().body;
    model.record({ docId: id, before, after });
  };
  const edit = ({ sectionId, path, value }) => change((s) => s.setField(inspectorPath({ sectionId, path }), value));
  const treeChange = (next, meta) => {
    change((s) => applyTreeOps(s, treeChangeOps(s.getState().body?.sections || [], next, meta), next));
    setSelection((sel) => selectionAfterTree({ selectedId: sel, op: meta?.op, proposed: meta?.selectedId ?? null, after: next }));
    const s = storeRef.current;
    if (s && ["moveUp", "moveDown", "move", "hide", "show"].includes(meta?.op)) post(orderMessage(s.getState().id, s.getState().body));
  };
  // an undo or redo is a normal draft save on that step's document's own
  // store (any document this session opened); never a publish. Undoing a
  // step on a document that isn't open switches the studio to it.
  const step = (dir) => {
    if (!canWrite) return;
    const peek = dir === "undo" ? model.canUndo() : model.canRedo();
    if (!peek) return;
    const st = dir === "undo" ? model.undo() : model.redo();
    if (!st) return;
    if (model.handles(st.docId)) return; // doc_design: the Design tab's applier wrote it (never a whole-body snapshot here)
    const plan = undoPlan(st, { dir, kept: storesRef.current, open: storeRef.current, handles: model.handles });
    if (!plan) return;
    for (const o of plan.ops) plan.store.setField(o.path, o.value);
    if (plan.switchTo) {
      openDocument(plan.switchTo);
      return;
    }
    const s = plan.store;
    post(orderMessage(s.getState().id, s.getState().body));
    setSelection((sel) => (sel && (s.getState().body?.sections || []).some((x) => isObj(x) && x.id === sel) ? sel : null));
  };
  // StudioPublishDialog sent the publishSet; this keeps its answer
  const publish = (result) => {
    if (!canPublish) return;
    setPublished(result);
    refreshDocs();
  };

  // ---- what the slots get ----
  const body = state?.body;
  const sections = isObj(body) && Array.isArray(body.sections) ? body.sections : null;
  const lockedWords = canWrite ? null : STUDIO_WORDS.readOnly;
  const studio = {
    api,
    can: { write: canWrite, publish: canPublish },
    role,
    readOnly: !canWrite,
    docs,
    state,
    store,
    stores: () => [...storesRef.current.values(), ...(ownDesign.current ? [ownDesign.current] : [])],
    registerStore,
    model,
    history,
    selection,
    select: (id) => setSelection(id || null),
    openDocument,
    edit,
    treeChange,
    undo: () => step("undo"),
    redo: () => step("redo"),
    post,
    startingBrand: isObj(startingBrand) ? startingBrand : null,
  };
  const context = {
    readOnlyReason: lockedWords,
    collections: [],
    products: [],
    pages: (docs || []).filter((d) => d.slug && ["page", "campaign", "journal"].includes(d.type)).map((d) => ({ slug: d.slug, family: d.type, document: d.id, title: d.label })),
    startingBrand: studio.startingBrand,
  };
  const selected = sections && selection ? sections.find((x) => isObj(x) && x.id === selection) : null;
  const issues = state?.pending?.issues || state?.issues || [];
  const inspector =
    load.status !== "ready" || !state ? (
      <p className="text-sm text-muted-foreground" data-studio-load={load.status}>
        {load.status === "loading" ? STUDIO_WORDS.loading : load.status === "missing" ? STUDIO_WORDS.missing : load.message || STUDIO_WORDS.failed}
      </p>
    ) : selected ? (
      <SettingsForm key={selected.id} readOnlyReason={lockedWords} kind={selected.kind} sectionId={selected.id} value={selected.settings} issues={issues} context={context} onChange={(_n, m) => edit({ sectionId: selected.id, path: m.path, value: m.value })} />
    ) : (
      <SettingsForm key={`doc-${state.id}`} readOnlyReason={lockedWords} type={state.type} value={body} issues={issues} context={context} onChange={(_n, m) => edit({ sectionId: null, path: m.path, value: m.value })} />
    );
  const ack = useMemo(() => (state ? { ackCount: state.ackCount, draftHash: state.draftHash, issues: state.issues } : null), [state?.ackCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = useMemo(() => {
    if (!state) return null;
    if (state.pending) return { kind: "pending", message: state.pending.message, issues: state.pending.issues };
    if (state.error) return { kind: "failed", message: state.error.message };
    return null;
  }, [state?.pending, state?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = state?.document?.label || entry?.label || "Home page";
  const s = storeRef.current;
  const statusLine = (
    <StatusLine
      save={state}
      preview={previewWhileSaving(previewView, state)}
      readOnly={!canWrite}
      role={role}
      on={{ useNewer: () => s?.useNewer(), keepMine: () => s?.keepMine(), acceptBackup: () => s?.acceptBackup(), dismissBackup: () => s?.dismissBackup(), retry: () => s?.retry() }}
    />
  );

  return (
    <StudioView
      readOnly={!canWrite}
      note={note}
      tab={tab}
      onTab={setTab}
      pane={pane}
      onPane={setPane}
      topBar={<StudioTopBar studio={studio} label={label} statusLine={statusLine} onPublish={publish} published={published} />}
      sections={<SectionsRail studio={studio} />}
      design={<DesignRail studio={studio} />}
      inspector={inspector}
      preview={
        <PreviewPane
          fill
          showDesign={history.touched.includes("doc_design")}
          api={api}
          documentId={state?.id || entry?.id}
          path={framePathFor(state ? { type: state.type, body: state.body, slug: state.document?.slug } : entry)}
          ack={ack}
          problem={problem}
          select={selection}
          label={label}
          onPick={(p) => p?.sectionId && setSelection(p.sectionId)}
          onView={setPreviewView}
          onFrame={(p) => (postRef.current = p)}
        />
      }
    />
  );
}
