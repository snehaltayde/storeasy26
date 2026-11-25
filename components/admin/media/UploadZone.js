"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, ImageUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/components/ui/utils";
import { RoleGate } from "@/components/kit/role-gate";
import { uploadImage } from "@/lib/media-upload";
import { progressLabel, UPLOAD_ACCEPT } from "@/lib/media-upload-plan";
import { limitsLine, MEDIA_WORDS, uploadResultWords } from "@/components/admin/media/media-words";

// Upload (Phase 2 line 5 §2): the button and drag-and-drop, several files at
// once, one row per file with its own progress bar. Every file goes through
// lib/media-upload.js uploadImage (the one upload path, shared with the
// editor's picker: resize, dimensions, the thumb), one at a time so a
// duplicate in the same batch dedupes. Refusals are uploadImage's own words.
// Writers only: the page renders it only for storefront.write, and its
// button goes through RoleGate as well.
//   role, limits: { mime: bytes } from the server; onDone(): after a batch
//   pickRef: set to a function that opens the file chooser (the header's button)
export function UploadZone({ role, limits, onDone, pickRef }) {
  const input = useRef(null);
  const [rows, setRows] = useState([]); // { key, name, stage, percent, result }
  const [over, setOver] = useState(false);
  const busy = rows.some((r) => !r.result);

  useEffect(() => {
    if (pickRef) pickRef.current = () => input.current?.click();
  }, [pickRef]);

  const patch = (key, p) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  async function upload(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    const stamp = Date.now();
    const batch = files.map((f, i) => ({ key: `${stamp}-${i}`, name: f.name, stage: "waiting", percent: 0, result: null }));
    setRows((rs) => [...rs.filter((r) => !r.result), ...batch]);
    try {
      for (const [i, file] of files.entries()) {
        const key = batch[i].key;
        const r = await uploadImage(file, { onProgress: (p) => patch(key, { stage: p.stage, percent: p.percent ?? 0 }) });
        patch(key, { result: uploadResultWords(file, r) });
      }
    } finally {
      if (input.current) input.current.value = "";
      onDone?.();
    }
  }

  return (
    <section aria-label="Upload images" data-media="upload-zone" className="mb-6">
      <div
        data-media="drop"
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          // leaving for a child (the button, the words) is still over the zone
          if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer?.files);
        }}
        data-over={over || undefined}
        className={cn(
          "flex flex-wrap items-center gap-3 rounded-card border border-dashed border-border bg-card p-4 transition-colors motion-reduce:transition-none sm:flex-nowrap sm:gap-4 sm:px-6",
          // over: a solid 2px accent edge (border + inset ring, so nothing moves)
          over && "border-solid border-primary bg-primary/5 ring-1 ring-primary ring-inset",
        )}
      >
        <span aria-hidden className={cn("flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", over && "bg-primary text-primary-foreground")}>
          <ImageUp className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium text-foreground">{over ? (
              "Drop to upload"
            ) : (
              <>
                {/* a phone has nothing to drag from */}
                <span className="pointer-coarse:hidden">Drop images here, or choose them</span>
                <span className="hidden pointer-coarse:inline">Add images from this device</span>
              </>
            )}</p>
          <p className="text-xs text-muted-foreground">{limitsLine(limits)}</p>
        </div>
        <RoleGate role={role} action="storefront.write" mode="hide">
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            Choose images
          </Button>
        </RoleGate>
        <input ref={input} type="file" multiple accept={UPLOAD_ACCEPT} data-media="file-input" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => upload(e.target.files)} />
      </div>
      {rows.length > 0 && (
        <ul aria-label="Uploads" aria-live="polite" className="mt-2 max-h-60 divide-y divide-border overflow-y-auto overscroll-contain rounded-card border border-border bg-card">
          {rows.map((r) => {
            const Icon = r.result?.tone === "danger" ? CircleAlert : CircleCheck;
            return (
              <li key={r.key} data-media="upload-row" data-state={r.result ? r.result.tone : "working"} className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm">
                {r.result ? (
                  <>
                    <Icon aria-hidden className={cn("size-4 shrink-0", r.result.tone === "danger" ? "text-danger" : "text-success")} />
                    <p className={cn("min-w-0", r.result.tone === "danger" ? "text-danger" : "text-foreground")}>{r.result.text}</p>
                  </>
                ) : (
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="truncate text-muted-foreground">{r.stage === "waiting" ? `${MEDIA_WORDS.waiting}: ${r.name}` : progressLabel(r)}</p>
                    <Progress value={r.stage === "uploading" ? r.percent : null} aria-label={`Upload of ${r.name}`} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && !busy && (
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setRows([])}>
          Clear the list
        </Button>
      )}
    </section>
  );
}
