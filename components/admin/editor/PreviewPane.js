"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Monitor, RotateCw, Smartphone, Tablet } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/components/ui/utils";
import { Button } from "./fields/parts";
import { applyDesignToggle, createPreviewController, showDesignFor, WORDS } from "./editorModel";

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
//   fill         (Phase 6 studio) the pane takes its parent's full height
//                instead of 70vh
//   showDesign   (Phase 6 studio) true turns "Show design changes" on, once
//   onFrame(post) (Phase 6 studio) called once on mount with a poster bound
//                to this frame and this origin: post(msg) → true when it was
//                handed to the frame, false when there is no frame (or it is
//                navigating); called with null on unmount
// The frame is minted with startDocumentsPreview, re-minted when the bridge
// reports ok:false (the session ended, or "See the live store" left it on the
// live store) or when no ready arrives within 3 seconds of a load, and shows
// "Reconnecting…" meanwhile.
// Phase 2 line 6 (6c): the frame's bar, all reads (support has every one):
//   device       375 / 768 / 1280 (toggle-group): the frame's width; the
//                frame is still the store's own page, so its styles are the
//                storefront's (drill:sf-styles)
//   show design  the design draft's colours on every page of the preview
//                (setShowDesign on the session, a storefront.read POST); on
//                the design itself they are always on
//   reload       the frame again at its address; a session that has ended
//                (an expired preview) is opened again (the controller's retry)
//   open         the page in a new tab (the same preview cookie)
export const DEVICES = Object.freeze([
  { id: "phone", width: 375, words: "Phone", icon: Smartphone },
  { id: "tablet", width: 768, words: "Tablet", icon: Tablet },
  { id: "desktop", width: 1280, words: "Desktop", icon: Monitor },
]);

export default function PreviewPane({ api, documentId, path, ack = null, problem = null, select = null, adding = false, hidden = false, label = "", retry = 0, fill = false, showDesign = false, onPick, onView, onFrame }) {
  const frameRef = useRef(null);
  const ctlRef = useRef(null);
  const pathRef = useRef(path);
  const pickRef = useRef(onPick);
  const viewRef = useRef(onView);
  const openedRef = useRef(documentId);
  const [view, setView] = useState(null);
  const [device, setDevice] = useState("desktop");
  const [design, setDesign] = useState(false);
  const designRef = useRef(false);
  const stageRef = useRef(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setStageWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  pathRef.current = path;
  pickRef.current = onPick;
  viewRef.current = onView;
  const frameCbRef = useRef(onFrame);
  frameCbRef.current = onFrame;
  useEffect(() => {
    const origin = window.location.origin;
    const post = (msg) => {
      const w = frameRef.current?.contentWindow;
      if (!w) return false;
      try {
        w.postMessage(msg, origin);
        return true;
      } catch {
        return false; // the frame is navigating
      }
    };
    frameCbRef.current?.(post);
    return () => frameCbRef.current?.(null);
  }, []);

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
        // P4-EDITOR (P3-FIX5 review): no "Hide them" in the frame's bar while
        // the design is open (the frame is this store's own page)
        designOpen: (open) => {
          try {
            applyDesignToggle(frameRef.current?.contentDocument, open);
          } catch {
            /* the frame is navigating */
          }
        },
      };
      // the founder's "Show design changes" rides on every session the
      // controller opens or steers (it only knows the design's own rule)
      const steered = {
        ...api,
        startDocumentsPreview: (o = {}) => api.startDocumentsPreview({ ...o, showDesign: Boolean(o.showDesign) || designRef.current }),
        setShowDesign: (sid, on) => api.setShowDesign(sid, Boolean(on) || designRef.current),
      };
      ctl = createPreviewController({
        api: steered,
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

  const designDoc = showDesignFor(documentId);
  const failed = view?.phase === "failed";
  const toggleDesign = async (on) => {
    designRef.current = on;
    setDesign(on);
    const sid = ctlRef.current?.view().sid;
    if (sid) await api.setShowDesign(sid, on);
    ctlRef.current?.pathChanged();
  };
  // Phase 6 line 2: the studio turns "Show design changes" on once a token is
  // touched. No reload: the frame already draws the tokens (storeasy:tokens),
  // and the next reload brings the saved design draft.
  useEffect(() => {
    if (!showDesign || designRef.current) return;
    designRef.current = true;
    setDesign(true);
    const sid = ctlRef.current?.view().sid;
    if (sid) api.setShowDesign(sid, true);
  }, [showDesign]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => (failed ? ctlRef.current?.retry() : ctlRef.current?.pathChanged());
  const openHref = () => {
    try {
      const at = frameRef.current?.contentWindow?.location;
      if (at && at.origin === window.location.origin) return `${at.pathname}${at.search}`;
    } catch {
      /* the frame is navigating */
    }
    return path || "/";
  };
  const width = DEVICES.find((d) => d.id === device)?.width || 1280;
  // a phone or tablet wider than the pane is drawn at that width and scaled
  // down to fit, so the frame never scrolls sideways; the store still lays
  // itself out at the device's own width
  const scale = device !== "desktop" && stageWidth > 0 && stageWidth < width ? stageWidth / width : 1;

  return (
    <section
      aria-label={label ? `Preview of ${label}` : "Preview"}
      className={hidden ? "hidden" : fill ? "@container flex h-full min-h-0 min-w-0 flex-col gap-2" : "@container min-w-0 space-y-2"}
      data-preview-pane=""
      data-preview-label={view?.label || ""}
      data-preview-phase={view?.phase || ""}
      data-preview-design={view?.showDesign == null ? "" : String(view.showDesign)}
      data-preview-reconnecting={view?.reconnecting ? "" : undefined}
      data-adding={adding ? "" : undefined}
      data-preview-log={(ctlRef.current?.log || []).slice(-16).join(" ")}
      data-preview-device={device}
    >
      <div className="flex flex-wrap items-center gap-2" data-preview-bar="">
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={device} onValueChange={(v) => v && setDevice(v)} aria-label="Preview width" data-read-control="">
          {DEVICES.map((d) => (
            <ToggleGroupItem key={d.id} value={d.id} aria-label={`${d.words}, ${d.width} pixels wide`} title={`${d.words} (${d.width}px)`} data-device={d.id} data-read-control="">
              <d.icon aria-hidden />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {scale < 1 && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums" title={`Drawn ${width}px wide and shown at ${Math.round(scale * 100)}% to fit`} data-preview-scale="">
            {Math.round(scale * 100)}%
          </span>
        )}
        <div className="flex items-center gap-1.5">
          <Switch id="preview-show-design" size="sm" checked={designDoc || design} disabled={designDoc} onCheckedChange={toggleDesign} data-show-design="" data-read-control="" />
          <Label htmlFor="preview-show-design" className="text-xs font-normal text-muted-foreground" data-read-control="">
            {designDoc ? "Showing your design changes" : "Show design changes"}
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={reload} icon={<RotateCw aria-hidden />} data-preview-reload="" data-read-control="">
            {failed ? "Open the preview again" : "Reload"}
          </Button>
          <a
            href={path || "/"}
            target="_blank"
            rel="noopener"
            onClick={(e) => (e.currentTarget.href = openHref())}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
            data-preview-open=""
            data-read-control=""
          >
            <ExternalLink aria-hidden />
            <span className="sr-only @lg:not-sr-only">Open in a new tab</span>
          </a>
        </div>
      </div>
      {adding && (
        <p className="text-[13px] text-muted-foreground" role="status" data-adding-note="">
          {WORDS.adding}
        </p>
      )}
      <div ref={stageRef} className={cn("overflow-hidden rounded-lg border border-border bg-muted", fill ? "min-h-0 flex-1" : "h-[70vh]")} data-preview-stage="">
        <iframe
          ref={frameRef}
          title={label ? `Your store: ${label}` : "Your store"}
          className={cn("block bg-white", fill ? "h-full" : "h-[70vh]", device === "desktop" ? "w-full" : "mx-auto max-w-none shrink-0")}
          style={device === "desktop" ? undefined : scale < 1 ? { width: `${width}px`, height: `calc(${fill ? "100%" : "70vh"} / ${scale})`, transform: `scale(${scale})`, transformOrigin: "top left" } : { width: `${width}px` }}
          onLoad={() => ctlRef.current?.frameLoad()}
          data-preview-frame=""
        />
      </div>
    </section>
  );
}
