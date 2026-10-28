"use client";

import { useRef, useState } from "react";

// Media library console (S38 / MC12). Uploads go through /api/admin/media as
// multipart; for raster images (not gif/svg) a THUMB derivative is generated
// here with a canvas (no native image library exists server-side) and rides
// the same request. Deletes are usage-guarded: a 409 lists what still
// references the file, and deleting anyway is a second, explicit step.

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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // {id, usage}
  const [copied, setCopied] = useState(null);
  const fileRef = useRef(null);

  async function refresh() {
    const res = await fetch("/api/admin/media");
    const json = await res.json().catch(() => ({}));
    if (json.ok) setMedia(json.media);
  }

  async function upload(files) {
    for (const file of files) {
      setBusy(true);
      setMsg({ ok: true, text: `Uploading ${file.name}…` });
      try {
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
          setMsg({ ok: false, text: (json.errors || [json.error || `Upload failed (${res.status})`]).join(" · ") });
          setBusy(false);
          return;
        }
        setMsg({ ok: true, text: json.media.deduped ? `${file.name} was already in the library — reused.` : `${file.name} uploaded.` });
      } catch (e) {
        setMsg({ ok: false, text: String(e?.message || e) });
      }
    }
    await refresh();
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function saveAlt(id, alt) {
    await fetch("/api/admin/media", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, alt }),
    });
    setMsg({ ok: true, text: "Alt text saved." });
  }

  async function del(id, force) {
    setBusy(true);
    const res = await fetch("/api/admin/media", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, force }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 409) {
      setConfirmDelete({ id, usage: json.usage || [] });
    } else if (json.ok) {
      setConfirmDelete(null);
      setMsg({ ok: true, text: "Deleted." });
      await refresh();
    } else {
      setMsg({ ok: false, text: json.error || "Delete failed" });
    }
    setBusy(false);
  }

  async function copyUrl(m) {
    try {
      await navigator.clipboard.writeText(m.url);
      setCopied(m.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setMsg({ ok: true, text: `URL: ${m.url}` });
    }
  }

  return (
    <div className="space-y-4">
      {!readOnly && (
        <div className="rounded-2xl border border-dashed border-zinc-300 p-5 text-center">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            multiple
            disabled={busy}
            onChange={(e) => e.target.files?.length && upload([...e.target.files])}
            className="mx-auto block text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-zinc-800"
          />
          <p className="mt-2 text-xs text-zinc-400">PNG, JPEG, WebP, GIF up to 1.5MB · SVG up to 300KB (sanitized). Duplicates are detected and reused.</p>
        </div>
      )}

      {msg && <div className={`rounded-xl px-4 py-3 text-sm ${msg.ok ? "bg-lime-50 text-lime-700" : "bg-red-50 text-red-600"}`}>{msg.text}</div>}

      {confirmDelete && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">This file is still referenced:</p>
          <ul className="mt-1 list-inside list-disc">
            {confirmDelete.usage.map((u) => (
              <li key={u.where} className="font-mono text-xs">{u.where}</li>
            ))}
          </ul>
          <p className="mt-2">Deleting it leaves broken images there (and in any older release you roll back to).</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => del(confirmDelete.id, true)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50">
              Delete anyway
            </button>
            <button type="button" onClick={() => setConfirmDelete(null)} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold hover:bg-amber-100">
              Keep it
            </button>
          </div>
        </div>
      )}

      {media.length === 0 ? (
        <p className="rounded-2xl border border-zinc-200 p-8 text-center text-sm text-zinc-400">No files yet — upload your first image above.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {media.map((m) => {
            const thumb = m.variants?.find((v) => v.variant === "thumb");
            return (
              <li key={m.id} className="overflow-hidden rounded-2xl border border-zinc-200">
                <div className="flex h-36 items-center justify-center bg-zinc-50">
                  {/* library files are same-origin; plain <img> keeps this simple */}
                  <img src={thumb ? `/api/media/${thumb.id}` : m.url} alt={m.alt || m.filename} className="max-h-36 max-w-full object-contain" loading="lazy" />
                </div>
                <div className="space-y-2 p-3">
                  <p className="truncate text-xs font-semibold text-zinc-700" title={m.filename}>
                    {m.filename}
                  </p>
                  <p className="text-[11px] text-zinc-400">
                    {m.mime.replace("image/", "")} · {fmtSize(m.size)}
                    {m.width ? ` · ${m.width}×${m.height}` : ""}
                    {thumb ? " · +thumb" : ""}
                  </p>
                  <input
                    defaultValue={m.alt}
                    placeholder="Alt text (describe the image)"
                    disabled={readOnly}
                    onBlur={(e) => !readOnly && e.target.value !== m.alt && saveAlt(m.id, e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 px-2 py-1 text-xs outline-none focus:border-zinc-400"
                  />
                  <div className="flex items-center justify-between">
                    <button type="button" onClick={() => copyUrl(m)} className="text-xs font-medium text-lime-700 hover:underline">
                      {copied === m.id ? "Copied ✓" : "Copy URL"}
                    </button>
                    {!readOnly && (
                      <button type="button" disabled={busy} onClick={() => del(m.id, false)} className="text-xs text-zinc-400 hover:text-red-600">
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
