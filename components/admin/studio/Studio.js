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
import DesignRail from "./DesignRail";

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
export const STUDIO_WORDS = Object.freeze({
  readOnly: "You can look at your store here but not change it.",
  loading: "Opening the studio…",
  failed: "This page couldn't be opened. Nothing was changed.",
  missing: "This page isn't there any more.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const noSub = () => () => {};
const noState = () => null;

// The layout, all props (rendered on its own in test-studio).
export function StudioView({ topBar = null, note = null, readOnly = false, tab = "sections", onTab, sections = null, design = null, preview = null, inspector = null }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground" data-studio="" data-studio-readonly={readOnly ? "" : undefined}>
      {topBar}
      {note && (
        <Notice className="mx-3 mt-2" data-studio-note="">
          {note}
        </Notice>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)_22rem]">
        <aside aria-label="Studio tools" className="flex min-h-0 flex-col border-r border-border" data-studio-rail="">
          <div role="tablist" aria-label="Studio tools" className="flex gap-1 border-b border-border p-2">
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
        <main className="flex min-h-0 min-w-0 flex-col p-3" data-studio-preview="">
          {preview}
        </main>
        <aside aria-label="Inspector" className="min-h-0 overflow-y-auto border-l border-border p-3" data-studio-inspector="">
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
  const [previewView, setPreviewView] = useState(null);
  const [published, setPublished] = useState(null);
  const storeRef = useRef(null);
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
      const r = await api.call("getDocument", id);
      if (mine !== openSeq.current) return;
      storeRef.current?.dispose();
      if (r?.ok && isObj(r.data?.document)) {
        const s = createDocumentStore({ api, document: r.data.document, tenant: typeof window !== "undefined" ? window.location.host : "", storage: tabStorage, readOnly: !canWrite });
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
    [api, tabStorage, canWrite],
  );

  useEffect(() => {
    api.call("listDocuments", true).then((r) => r?.ok && Array.isArray(r.data?.documents) && setDocs(r.data.documents));
    openDocument(entry?.id || "doc_home");
    return () => {
      storeRef.current?.dispose();
      model.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const step = (dir) => {
    const s = storeRef.current;
    if (!s || !canWrite) return;
    const st = dir === "undo" ? model.undo() : model.redo();
    if (!st) return;
    if (st.docId !== s.getState().id) return; // another document's step: line 1 keeps a store per document
    if (model.handles(st.docId)) return; // doc_design: the Design tab's applier wrote it (never a whole-body snapshot here)
    for (const o of restoreOps(s.getState().body, dir === "undo" ? st.before : st.after)) s.setField(o.path, o.value);
    post(orderMessage(s.getState().id, s.getState().body));
  };
  const publish = async () => {
    const s = storeRef.current;
    if (!s || !canPublish) return;
    setPublished(await s.publish());
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
      preview={previewView}
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
