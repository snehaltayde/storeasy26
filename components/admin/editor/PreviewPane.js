"use client";

import { useEffect, useRef, useState } from "react";
import { createPreviewController, WORDS } from "./editorModel";

// P3-EDITOR (PV-01, PUB-11, ED-04): the preview frame. The logic is
// editorModel.createPreviewController (pure, unit-tested); this file only
// gives it the frame and the window's messages.
//   api          documentsApi ({ startDocumentsPreview, setShowDesign })
//   documentId   the open document (showDesign is on only for doc_design)
//   path         the address the frame shows for it
//   ack          { ackCount, draftHash, issues } the store's last acknowledged save
//   problem      { kind: "failed" | "pending", message, issues, field } or null
//   select       a section id to outline in the frame
//   adding       a newly added section isn't in the frame yet
//   hidden       the writing view keeps the frame (and its session) but hides it
//   onPick(pick), onView(view)
// The frame is minted with startDocumentsPreview, re-minted when the bridge
// reports ok:false (the session ended, or "See the live store" left it on the
// live store) or when no ready arrives within 3 seconds of a load, and shows
// "Reconnecting…" meanwhile.

export default function PreviewPane({ api, documentId, path, ack = null, problem = null, select = null, adding = false, hidden = false, label = "", retry = 0, onPick, onView }) {
  const frameRef = useRef(null);
  const ctlRef = useRef(null);
  const pathRef = useRef(path);
  const pickRef = useRef(onPick);
  const viewRef = useRef(onView);
  const openedRef = useRef(documentId);
  const [view, setView] = useState(null);
  pathRef.current = path;
  pickRef.current = onPick;
  viewRef.current = onView;

  useEffect(() => {
    const origin = window.location.origin;
    // P3-FIX5 (finding D1): one controller per mount. React strict mode (next
    // dev) runs this effect, its cleanup, then the effect again on the same
    // mount: the controller is kept in the ref and start() is idempotent, so
    // the mount mints one preview session, not two.
    let ctl = ctlRef.current;
    if (!ctl) {
      const frame = {
        setSrc: (p) => {
          if (frameRef.current) frameRef.current.src = p;
        },
        post: (msg) => {
          try {
            frameRef.current?.contentWindow?.postMessage(msg, origin);
          } catch {
            /* the frame is navigating */
          }
        },
        currentPath: () => frameRef.current?.contentWindow?.location?.pathname ?? null,
      };
      ctl = createPreviewController({
        api,
        frame,
        documentId: openedRef.current,
        pathFor: () => pathRef.current || "/",
        onChange: (v) => {
          setView(v);
          viewRef.current?.(v);
        },
        onPick: (p) => pickRef.current?.(p),
      });
      ctlRef.current = ctl;
    }
    const onMessage = (e) => {
      if (e.origin !== origin || e.source !== frameRef.current?.contentWindow) return;
      ctl.message(e.data);
    };
    window.addEventListener("message", onMessage);
    ctl.start();
    return () => {
      window.removeEventListener("message", onMessage);
      ctl.dispose(); // parks what arrives meanwhile; a strict-mode re-run starts it again
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pathSeen = useRef(path);
  useEffect(() => {
    if (pathSeen.current === path) return;
    pathSeen.current = path;
    if (openedRef.current === documentId) ctlRef.current?.pathChanged();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!documentId || openedRef.current === documentId) return;
    openedRef.current = documentId;
    ctlRef.current?.openDocument(documentId);
  }, [documentId]);

  useEffect(() => {
    if (ack && Number.isFinite(ack.ackCount) && ack.ackCount > 0) ctlRef.current?.saveAck(ack);
  }, [ack?.ackCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!problem) return;
    if (problem.kind === "pending") ctlRef.current?.savePending(problem);
    else ctlRef.current?.saveFailed(problem);
  }, [problem]);

  useEffect(() => {
    if (retry > 0) ctlRef.current?.retry();
  }, [retry]);

  useEffect(() => {
    ctlRef.current?.select(select);
  }, [select, view?.phase]);

  return (
    <section
      aria-label={label ? `Preview of ${label}` : "Preview"}
      className={hidden ? "hidden" : "min-w-0 space-y-1.5"}
      data-preview-pane=""
      data-preview-label={view?.label || ""}
      data-preview-phase={view?.phase || ""}
      data-preview-design={view?.showDesign == null ? "" : String(view.showDesign)}
      data-preview-reconnecting={view?.reconnecting ? "" : undefined}
      data-adding={adding ? "" : undefined}
      data-preview-log={(ctlRef.current?.log || []).slice(-16).join(" ")}
    >
      {adding && (
        <p className="text-[13px] text-fg-muted" role="status" data-adding-note="">
          {WORDS.adding}
        </p>
      )}
      <div className="overflow-hidden rounded-card border border-edge bg-surface-sunken">
        <iframe ref={frameRef} title={label ? `Your store: ${label}` : "Your store"} className="block h-[70vh] w-full bg-white" onLoad={() => ctlRef.current?.frameLoad()} data-preview-frame="" />
      </div>
    </section>
  );
}
