"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Trash2 } from "lucide-react";
import { Card } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { IconButton } from "@/components/console/Button";
import { ConfirmDialog } from "@/components/console/Dialog";
import { CopyButton } from "@/components/console/Copy";
import { Input } from "@/components/console/fields";
import { EmptyState, PermissionNote } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";
import { MediaUploadStatus } from "@/components/admin/MediaUploadStatus";
import { uploadImage } from "@/lib/media-upload";
import { UPLOAD_ACCEPT } from "@/lib/media-upload-plan";

// Media library console (S38 / MC12, redesigned S50). Uploads go through
// lib/media-upload.js, the one path shared with MediaPicker (MED-01): resize,
// dimensions and the THUMB derivative all happen there. Deletes are
// usage-guarded: every delete confirms in a dialog first, and a 409 lists what
// still references the file in a second "delete anyway" dialog (same force
// semantics as before). S50 fixes: blur-saving alt text now toasts (it was
// silent), and read-only support actors see an honest PermissionNote instead
// of nothing.

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export default function MediaAdmin({ initial, readOnly = false }) {
  const [media, setMedia] = useState(initial);
  const [uploading, setUploading] = useState(null); // progress of the file in flight
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
        const r = await uploadImage(file, { onProgress: setUploading });
        if (!r.ok) {
          setError(r.message);
          return;
        }
        if (r.media.deduped) toast.success(`${file.name} was already in the library — reused`);
        else toast.success(r.notice || `${file.name} uploaded`);
      }
    } finally {
      setUploading(null);
      // Reset first. If the connection is down the refresh fails too, and a file
      // left in the input means picking it again does nothing.
      if (fileRef.current) fileRef.current.value = "";
      await refresh().catch(() => {});
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
            accept={UPLOAD_ACCEPT}
            multiple
            disabled={!!uploading}
            onChange={(e) => e.target.files?.length && upload([...e.target.files])}
            className="mx-auto block rounded text-sm text-fg-muted focus-ring file:mr-3 file:rounded-ctl file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-fg hover:file:bg-primary-hover disabled:opacity-50"
          />
          <p className="mt-2 text-xs text-fg-subtle">Photos are made smaller for you before they upload. GIFs and animated images can be up to 1.5MB and SVGs up to 300KB. Duplicates are detected and reused.</p>
        </Card>
      )}

      <MediaUploadStatus progress={uploading} />

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
