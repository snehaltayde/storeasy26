"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Trash2 } from "lucide-react";
import { Card } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { IconButton } from "@/components/console/Button";
import { ConfirmDialog } from "@/components/console/Dialog";
import { CopyButton } from "@/components/console/Copy";
import { Input } from "@/components/console/fields";
import { EmptyState, PermissionNote } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Media library console (S38 / MC12, redesigned S50). Uploads go through
// /api/admin/media as multipart; for raster images (not gif/svg) a THUMB
// derivative is generated here with a canvas (no native image library exists
// server-side) and rides the same request. Deletes are usage-guarded: every
// delete confirms in a dialog first, and a 409 lists what still references
// the file in a second "delete anyway" dialog (same force semantics as
// before). S50 fixes: blur-saving alt text now toasts (it was silent), and
// read-only support actors see an honest PermissionNote instead of nothing.

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

// Resize to ≤480px wide (keeping aspect) → webp blob. Returns null when the
// browser can't (svg/gif/tiny files skip — the original serves everywhere).
async function makeThumb(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return null;
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width <= 480) return null;
    const scale = 480 / bitmap.width;
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    return blob ? { blob, width: canvas.width, height: canvas.height } : null;
  } catch {
    return null;
  }
}

async function imageDims(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height };
  } catch {
    return { width: null, height: null };
  }
}

export default function MediaAdmin({ initial, readOnly = false }) {
  const [media, setMedia] = useState(initial);
  const [uploading, setUploading] = useState(null); // filename in flight
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null); // media row
  const [usageGuard, setUsageGuard] = useState(null); // {media, usage}
  const fileRef = useRef(null);
  const toast = useToast();

  async function refresh() {
    const res = await fetch("/api/admin/media");
    const json = await res.json().catch(() => ({}));
    if (json.ok) setMedia(json.media);
  }

  async function upload(files) {
    setError(null);
    try {
      for (const file of files) {
        setUploading(file.name);
        const form = new FormData();
        form.set("file", file);
        const dims = await imageDims(file);
        if (dims.width) {
          form.set("width", String(dims.width));
          form.set("height", String(dims.height));
        }
        const thumb = await makeThumb(file);
        if (thumb) {
          form.set("thumb", thumb.blob, `thumb.webp`);
          form.set("thumbWidth", String(thumb.width));
          form.set("thumbHeight", String(thumb.height));
        }
        const res = await fetch("/api/admin/media", { method: "POST", body: form });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setError((json.errors || [json.error || `Upload failed (${res.status})`]).join(" · "));
          return;
        }
        toast.success(json.media.deduped ? `${file.name} was already in the library — reused` : `${file.name} uploaded`);
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setUploading(null);
      await refresh();
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveAlt(id, alt) {
    const res = await fetch("/api/admin/media", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, alt }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      toast.error(json.error || "Couldn't save alt text");
      return;
    }
    setMedia((list) => list.map((m) => (m.id === id ? { ...m, alt } : m)));
    toast.success("Alt text saved");
  }

  // One DELETE helper, same API semantics as before: force=false may come
  // back 409 with a usage list; force=true removes regardless.
  async function requestDelete(id, force) {
    const res = await fetch("/api/admin/media", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, force }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 409) return { usage: json.usage || [] };
    if (!res.ok || !json.ok) throw new Error(json.error || "Delete failed");
    return { ok: true };
  }

  return (
    <div className="space-y-4">
      {readOnly ? (
        <PermissionNote role="support" need="upload or change media" />
      ) : (
        <Card className="border-dashed text-center">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            multiple
            disabled={!!uploading}
            onChange={(e) => e.target.files?.length && upload([...e.target.files])}
            className="mx-auto block rounded text-sm text-fg-muted focus-ring file:mr-3 file:rounded-ctl file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-fg hover:file:bg-primary-hover disabled:opacity-50"
          />
          <p className="mt-2 text-xs text-fg-subtle">PNG, JPEG, WebP, GIF up to 1.5MB · SVG up to 300KB (sanitized). Duplicates are detected and reused.</p>
        </Card>
      )}

      {uploading && (
        <Banner tone="info">
          <span className="inline-flex items-center gap-2">
            <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden />
            Uploading {uploading}…
          </span>
        </Banner>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      {media.length === 0 ? (
        <Card>
          <EmptyState icon={<ImageIcon size={20} aria-hidden />} title="No files yet" body={readOnly ? "Uploads appear here." : "Upload your first image above."} />
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {media.map((m) => {
            const thumb = m.variants?.find((v) => v.variant === "thumb");
            return (
              <Card key={m.id} as="li" padded={false} className="overflow-hidden">
                <div className="flex h-36 items-center justify-center bg-surface-sunken">
                  {/* library files are same-origin; plain <img> keeps this simple */}
                  <img src={thumb ? `/api/media/${thumb.id}` : m.url} alt={m.alt || m.filename} className="max-h-36 max-w-full object-contain" loading="lazy" />
                </div>
                <div className="space-y-2 p-3">
                  <p className="truncate text-xs font-medium text-fg" title={m.filename}>
                    {m.filename}
                  </p>
                  <p className="text-[11px] text-fg-subtle">
                    {m.mime.replace("image/", "")} · {fmtSize(m.size)}
                    {m.width ? ` · ${m.width}×${m.height}` : ""}
                    {thumb ? " · +thumb" : ""}
                  </p>
                  <Input
                    defaultValue={m.alt}
                    placeholder="Alt text (describe the image)"
                    aria-label={`Alt text for ${m.filename}`}
                    disabled={readOnly}
                    onBlur={(e) => !readOnly && e.target.value !== (m.alt || "") && saveAlt(m.id, e.target.value)}
                    className="px-2 py-1 text-xs"
                  />
                  <div className="flex items-center justify-between">
                    <CopyButton value={m.url} label={`Copy URL for ${m.filename}`} />
                    {!readOnly && (
                      <IconButton
                        label={`Delete ${m.filename}`}
                        icon={<Trash2 size={14} aria-hidden />}
                        onClick={() => setDeleting(m)}
                        className="text-fg-muted hover:bg-danger-bg hover:text-danger"
                      />
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete file"
        tone="danger"
        confirmLabel="Delete"
        body={
          deleting && (
            <>
              Deletes <strong>{deleting.filename}</strong> from the library permanently. If anything still references it, you&rsquo;ll be shown where before it goes.
            </>
          )
        }
        onConfirm={async () => {
          const r = await requestDelete(deleting.id, false);
          if (r.usage) {
            setUsageGuard({ media: deleting, usage: r.usage });
          } else {
            toast.success("Deleted");
            await refresh();
          }
        }}
      />

      <ConfirmDialog
        open={!!usageGuard}
        onClose={() => setUsageGuard(null)}
        title="Still referenced — delete anyway?"
        tone="danger"
        confirmLabel="Delete anyway"
        body={
          usageGuard && (
            <>
              <Banner tone="warning" title="This file is still referenced:">
                <ul className="list-inside list-disc">
                  {usageGuard.usage.map((u) => (
                    <li key={u.where} className="font-mono text-xs">
                      {u.where}
                    </li>
                  ))}
                </ul>
              </Banner>
              <p className="mt-2">Deleting it leaves broken images there (and in any older release you roll back to).</p>
            </>
          )
        }
        onConfirm={async () => {
          const r = await requestDelete(usageGuard.media.id, true);
          if (r.usage) throw new Error("Still referenced — the server refused the forced delete");
          toast.success("Deleted");
          await refresh();
        }}
      />
    </div>
  );
}
