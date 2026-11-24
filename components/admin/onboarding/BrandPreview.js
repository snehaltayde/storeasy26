"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { createPreviewController } from "@/components/admin/editor/editorModel";
import { startDocumentsPreview, setShowDesign } from "@/components/admin/editor/documentsApi";
import { PREVIEW_WORDS } from "./brandModel";

// The Brand step's live preview (Phase 1 line 6): this store's home page (/)
// with its drafts and the design draft, in a frame. The frame is the editor's
// (createPreviewController, startDocumentsPreview with showDesign on, the
// same "Showing your latest changes…", "Reconnecting…" and re-mint logic); it
// says the look hello ({…, look: true}, components/preview/bridge-core.js), so
// the frame posts no picks and hides its own bar. The founder's unsaved
// choices are a message to the frame (`message`, brandModel overlayMessage),
// never a write: sent on every change and again after every ready (any frame
// reload). `saved` counts saves and skips: each one reloads the frame so it
// shows the saved draft. A read-only role (`canEdit` false) gets the frame as
// saved and never sends a message.
//   width  "phone" | "computer": Computer renders at 1280px, scaled to fit.
export const LOOK_HELLO = Object.freeze({ type: "storeasy:editor:hello", v: 2, look: true });
export const COMPUTER_PX = 1280;
const COMPUTER_HEIGHT = 640; // what the scaled page shows of itself, in console pixels
const api = { startDocumentsPreview, setShowDesign };

export default function BrandPreview({ message = null, canEdit = false, saved = 0, className = "" }) {
  const frameRef = useRef(null);
  const boxRef = useRef(null);
  const ctlRef = useRef(null);
  const msgRef = useRef(message);
  const [view, setView] = useState(null);
  const [width, setWidth] = useState("phone");
  const [scale, setScale] = useState(1);
  msgRef.current = message;

  const send = () => {
    if (!canEdit || !msgRef.current) return;
    try {
      frameRef.current?.contentWindow?.postMessage(msgRef.current, window.location.origin);
    } catch {
      /* the frame is navigating; the next ready sends it again */
    }
  };

  useEffect(() => {
    const origin = window.location.origin;
    // one controller per mount (start() is idempotent: strict mode's second
    // effect mints nothing new)
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
      ctl = createPreviewController({ api, frame, documentId: "doc_design", pathFor: () => "/", hello: LOOK_HELLO, onChange: setView });
      ctlRef.current = ctl;
    }
    const onMessage = (e) => {
      if (e.origin !== origin || e.source !== frameRef.current?.contentWindow) return;
      ctl.message(e.data);
      // a working frame (a first load or any reload): draw the unsaved choices again
      if (e.data?.type === "storeasy:ready" && e.data.v === 2 && e.data.ok === true) send();
    };
    window.addEventListener("message", onMessage);
    ctl.start();
    return () => {
      window.removeEventListener("message", onMessage);
      ctl.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const key = JSON.stringify(message);
  useEffect(() => {
    if (view?.phase === "shown") send();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (saved > 0) ctlRef.current?.saveAck({ draftHash: null, issues: [], ackCount: saved });
  }, [saved]);

  // Computer: a 1280px page scaled to the box's width
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver !== "function") return undefined;
    const fit = () => setScale(Math.min(1, (box.clientWidth || COMPUTER_PX) / COMPUTER_PX));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const computer = width === "computer";
  const failed = view?.phase === "failed";
  return (
    <section aria-label={PREVIEW_WORDS.title} className={cn("min-w-0 space-y-3", className)} data-brand-preview="" data-preview-phase={view?.phase || ""} data-preview-width={width} data-preview-reconnecting={view?.reconnecting ? "" : undefined} data-preview-log={(ctlRef.current?.log || []).slice(-16).join(" ")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label={PREVIEW_WORDS.width} className="inline-flex rounded-md border border-border bg-muted p-0.5">
          {["phone", "computer"].map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={width === w}
              data-preview-toggle={w}
              onClick={() => setWidth(w)}
              className={cn("h-8 rounded-[4px] px-3 text-[0.8125rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", width === w ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground")}
            >
              {PREVIEW_WORDS[w]}
            </button>
          ))}
        </div>
        {view?.words && (
          <p role="status" className={cn("text-[0.8125rem]", failed ? "text-danger" : "text-muted-foreground")} data-preview-words="">
            {view.words}
          </p>
        )}
      </div>
      {failed && (
        <Button variant="outline" size="sm" onClick={() => ctlRef.current?.retry()} data-preview-retry="">
          <RotateCcw aria-hidden />
          Try again
        </Button>
      )}
      {!canEdit && <p className="text-xs text-muted-foreground">{PREVIEW_WORDS.readOnly}</p>}
      <div ref={boxRef} className="overflow-hidden rounded-card border border-border bg-muted">
        <div className={cn("relative mx-auto", !computer && "max-w-[390px]")} style={computer ? { height: COMPUTER_HEIGHT } : undefined}>
          <div className={computer ? "absolute top-0 left-0 origin-top-left" : undefined} style={computer ? { width: COMPUTER_PX, height: Math.round(COMPUTER_HEIGHT / scale), transform: `scale(${scale})` } : undefined}>
            <iframe ref={frameRef} title={PREVIEW_WORDS.frameTitle} className={cn("block w-full bg-background", computer ? "h-full" : "h-[70vh] max-h-[760px]")} onLoad={() => ctlRef.current?.frameLoad()} data-preview-frame="" />
          </div>
        </div>
      </div>
    </section>
  );
}
