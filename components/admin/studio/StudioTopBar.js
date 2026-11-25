"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Maximize2, Minimize2, Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createNavGuard } from "../editor/editorModel";
import StudioPublishDialog, { createPublishRun, publishRows } from "./StudioPublishDialog";
import { designStoreFor } from "./DesignRail";

// Phase 6 line 1 (docs/plans/phase-6.md feature 1): the studio's top bar.
//   Exit studio     a link; while any open document holds unsaved edits it
//                   saves them first (createNavGuard), and stays with words
//                   when the save fails; leaving the tab warns the same way
//   the switcher    pages, home, layouts, header, footer and design (a read)
//   statusLine      the save and preview line (StatusLine)
//   Undo, Redo      ⌘Z / ⇧⌘Z (Ctrl on other systems) outside a text field;
//                   storefront.write only
//   Full screen     requestFullscreen (a read)
//   Publish         StudioPublishDialog (storefront.publish only; staff read
//                   "Ask an admin to publish."; support and operator support
//                   get no write control at all)
// The device widths are the preview's own bar (PreviewPane DEVICES).
// Props: studio (Studio.js's context), label, statusLine, onPublish(result)
// (after a publish that went through), published (the last one, or null).
export const TOP_WORDS = Object.freeze({
  exit: "Exit studio",
  askAdmin: "Ask an admin to publish.",
  publish: "Publish",
  published: "Published.",
  switcher: "Open a page",
  fullScreen: "Full screen",
  leaveFullScreen: "Leave full screen",
  preparing: "Saving your last changes…",
});

export const SWITCHER_TYPES = Object.freeze(["home", "page", "campaign", "journal", "product_layout", "collection_layout", "header", "footer", "design"]);
export const switcherDocs = (docs) => (Array.isArray(docs) ? docs : []).filter((d) => d && SWITCHER_TYPES.includes(d.type) && !d.archivedAt);

const editable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""));
// ⌘Z → "undo", ⇧⌘Z (or Ctrl+Y) → "redo", else null
export function undoKey(e) {
  if (!e || editable(e.target)) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = String(e.key || "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && e.ctrlKey && !e.metaKey) return "redo";
  return null;
}

// the stores Publish flushes and Exit waits for: the studio's own (one per
// document opened) and DesignRail's doc_design store (designStoreFor)
export function studioStores(studio) {
  const list = [...(typeof studio?.stores === "function" ? studio.stores() : studio?.store ? [studio.store] : []), designStoreFor(studio)];
  const seen = new Map();
  for (const s of list) {
    const id = s?.getState?.().id;
    if (id && !seen.has(id)) seen.set(id, s);
  }
  return [...seen.values()];
}

// every open document as one store for the nav guard
export function allStores(list) {
  const stores = () => (typeof list === "function" ? list() : list || []).filter(Boolean);
  return {
    getState: () => ({ unacknowledged: stores().some((s) => s.getState().unacknowledged) }),
    async beforeNavigate() {
      for (const s of stores()) {
        const r = await s.beforeNavigate();
        if (!r || !r.ok) return r || { ok: false };
      }
      return { ok: true };
    },
    beforeUnload: () => stores().reduce((warn, s) => s.beforeUnload() || warn, false),
  };
}

export default function StudioTopBar({ studio, label = "", statusLine = null, onPublish, published = null }) {
  const router = useRouter();
  const can = studio?.can || {};
  const h = studio?.history || { undo: 0, redo: 0 };
  const [blocked, setBlocked] = useState(null);
  const [full, setFull] = useState(false);
  const [dialog, setDialog] = useState(null); // { rows, key }
  const [preparing, setPreparing] = useState(null);
  // every open document's store, line 2's design store included (one per id)
  const stores = () => studioStores(studio);
  const run = useMemo(() => createPublishRun({ api: studio?.api, stores, current: () => studio?.store || null }), [studio?.api, studio?.store]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs = switcherDocs(studio?.docs);
  const openId = studio?.state?.id || "";

  // leaving: in-app links wait for the saves; the tab warns
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const all = allStores(stores);
    const guard = createNavGuard({
      getStore: () => all,
      origin: window.location.origin,
      here: () => window.location.pathname + window.location.search,
      navigate: (to) => {
        setBlocked(null);
        router.push(to);
      },
      onBlocked: (b) => setBlocked(b.message),
    });
    const onClick = (e) => guard.onClickCapture(e);
    const onBefore = (e) => {
      if (all.beforeUnload()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onKey = (e) => {
      if (!can.write) return;
      const k = undoKey(e);
      if (!k) return;
      e.preventDefault();
      k === "undo" ? studio.undo() : studio.redo();
    };
    const onFull = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBefore);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFull);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBefore);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFull);
    };
  }); // every render: the handlers see this render's studio

  const toggleFull = () => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  const switchTo = (id) => {
    if (!id || id === openId) return;
    studio.openDocument(id);
    try {
      window.history.replaceState(window.history.state, "", `/admin/studio?doc=${encodeURIComponent(id)}`);
    } catch {
      /* the address stays */
    }
  };
  const startPublish = async () => {
    setPreparing(TOP_WORDS.preparing);
    const p = await run.prepare();
    setPreparing(null);
    if (!p.ok) return setBlocked(p.message);
    setBlocked(null);
    setDialog({ rows: publishRows(p.documents, { touched: studio.model?.touched?.() || [] }), key: Date.now() });
  };

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2" data-studio-top="">
      <Link href="/admin/dashboard" className="text-sm font-medium underline-offset-4 hover:underline" data-studio-exit="" data-read-control="">
        {TOP_WORDS.exit}
      </Link>
      <h1 className="sr-only" data-studio-label="">
        {label}
      </h1>
      <Select value={openId || undefined} onValueChange={switchTo}>
        <SelectTrigger size="sm" className="max-w-56" aria-label={TOP_WORDS.switcher} data-studio-switcher="" data-read-control="">
          <SelectValue placeholder={label}>{label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {docs.map((d) => (
            <SelectItem key={d.id} value={d.id} data-studio-switch={d.id}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="min-w-0 flex-1">{statusLine}</div>
      {can.write && (
        <>
          <Button type="button" size="sm" variant="ghost" disabled={!h.undo} onClick={() => studio.undo()} aria-label="Undo" title="Undo (⌘Z)" data-studio-undo="">
            <Undo2 aria-hidden />
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!h.redo} onClick={() => studio.redo()} aria-label="Redo" title="Redo (⇧⌘Z)" data-studio-redo="">
            <Redo2 aria-hidden />
          </Button>
        </>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={toggleFull} aria-label={full ? TOP_WORDS.leaveFullScreen : TOP_WORDS.fullScreen} title={full ? TOP_WORDS.leaveFullScreen : TOP_WORDS.fullScreen} data-studio-fullscreen="" data-read-control="">
        {full ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
      </Button>
      {can.publish ? (
        <Button type="button" size="sm" disabled={!!preparing} aria-busy={!!preparing} onClick={startPublish} data-studio-publish="">
          {TOP_WORDS.publish}
        </Button>
      ) : can.write ? (
        <p className="text-sm text-muted-foreground" data-studio-ask-admin="">
          {TOP_WORDS.askAdmin}
        </p>
      ) : null}
      {(preparing || blocked) && (
        <p role="alert" className="w-full text-sm text-muted-foreground" data-studio-blocked="">
          {preparing || blocked}
        </p>
      )}
      {published && (
        <p role="status" className="text-sm text-muted-foreground" data-studio-published="">
          {published.ok ? TOP_WORDS.published : published.message || "Couldn't publish."}
        </p>
      )}
      {can.publish && dialog && (
        <StudioPublishDialog
          key={dialog.key}
          open
          rows={dialog.rows}
          run={run}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            onPublish?.(r.result);
          }}
          onFix={async (f) => {
            setDialog(null);
            if (f.id !== openId) await studio.openDocument(f.id);
            if (f.sectionId) studio.select(f.sectionId);
          }}
        />
      )}
    </header>
  );
}
