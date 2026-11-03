"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Upload } from "lucide-react";
import { Dialog } from "@/components/console/Dialog";
import { Button } from "@/components/console/Button";
import { Input } from "@/components/console/fields";
import { Banner } from "@/components/console/Banner";
import { SkeletonText, EmptyState } from "@/components/console/bits";
import { cx } from "@/components/console/cx";
import { useToast } from "@/components/console/Toast";
import { MediaUploadStatus } from "@/components/admin/MediaUploadStatus";
import { uploadImage } from "@/lib/media-upload";
import { UPLOAD_ACCEPT } from "@/lib/media-upload-plan";

// THE media picker (S52): every place content takes an image opens this
// dialog instead of asking for a pasted URL. Lists the library with search,
// uploads in place, and hands back { url, alt } on selection.
export function MediaPicker({ open, onClose, onSelect }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState(null); // progress of the file in flight
  const [uploadErr, setUploadErr] = useState(null);
  const fileRef = useRef(null);
  const toast = useToast();

  async function load() {
    setErr(null);
    try {
      const res = await fetch("/api/admin/media");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Couldn't load the library (${res.status})`);
      setItems((data.media || []).filter((m) => !m.variant)); // originals only
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }
  useEffect(() => {
    if (open) {
      setQ("");
      setItems(null);
      load();
    }
  }, [open]);

  async function upload(file) {
    if (!file) return;
    setUploadErr(null);
    const r = await uploadImage(file, { onProgress: setUploading });
    if (fileRef.current) fileRef.current.value = "";
    if (r.ok) {
      await load();
      if (r.notice) toast.info(r.notice); // a toast, because picking closes this dialog
      if (r.media?.url) onSelect?.({ url: r.media.url, alt: r.media.alt || "", id: r.media.id });
    } else {
      setUploadErr(r.message);
    }
    setUploading(null);
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items || [];
    return (items || []).filter((m) => `${m.filename} ${m.alt || ""}`.toLowerCase().includes(needle));
  }, [items, q]);

  const thumbOf = (m) => {
    const t = (m.variants || []).find((v) => v.variant === "thumb");
    return t ? `/api/media/${t.id}` : m.url; // listed variants carry an id, not a url
  };

  return (
    <Dialog open={open} onClose={onClose} title="Choose an image" size="lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search by filename or alt text…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-48 flex-1"
            aria-label="Search media"
          />
          <input
            ref={fileRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <Button size="sm" icon={<Upload size={13} aria-hidden />} busy={!!uploading} onClick={() => fileRef.current?.click()}>
            Upload
          </Button>
        </div>
        <MediaUploadStatus progress={uploading} />
        {uploadErr && <Banner tone="danger">{uploadErr}</Banner>}
        {err && (
          <Banner tone="danger" actions={<Button size="sm" onClick={load}>Retry</Button>}>
            {err}
          </Banner>
        )}
        {items === null && !err && <SkeletonText lines={4} />}
        {items !== null && filtered.length === 0 && (
          <EmptyState
            title={q ? "No matches" : "No images yet"}
            body={q ? "Try a different search." : "Upload your first image, or manage the library under Storefront → Media."}
          />
        )}
        {filtered.length > 0 && (
          <ul className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4" role="listbox" aria-label="Media library">
            {filtered.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={cx(
                    "group w-full overflow-hidden rounded-ctl border border-edge bg-surface text-left focus-ring",
                    "hover:border-edge-strong hover:shadow-card"
                  )}
                  onClick={() => onSelect?.({ url: m.url, alt: m.alt || "", id: m.id })}
                  title={m.alt ? `${m.filename} — ${m.alt}` : m.filename}
                >
                  <span className="flex h-20 items-center justify-center overflow-hidden bg-surface-sunken">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumbOf(m)} alt={m.alt || m.filename} className="h-full w-full object-cover" loading="lazy" />
                  </span>
                  <span className="block truncate px-1.5 py-1 text-[11px] text-fg-muted group-hover:text-fg">{m.filename}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-fg-subtle">
          <ImagePlus size={12} aria-hidden className="mr-1 inline" />
          Picking fills the image URL and its library alt text — you can still adjust the alt for this spot.
        </p>
      </div>
    </Dialog>
  );
}
