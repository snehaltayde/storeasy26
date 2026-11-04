"use client";

import { useRef, useState } from "react";
import { Archive, ArchiveRestore, Image as ImageIcon, ListTree, Trash2 } from "lucide-react";
import { Card } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Badge } from "@/components/console/Badge";
import { Button, IconButton } from "@/components/console/Button";
import { ConfirmDialog, Dialog } from "@/components/console/Dialog";
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
// usage-guarded: every delete confirms in a dialog first. S50 fixes:
// blur-saving alt text now toasts (it was silent), and read-only support
// actors see an honest PermissionNote instead of nothing.
//
// P4-PICKER (MED-03): archive instead of delete.
//   - Archive and Unarchive on each file (PATCH {id, archived}); an archived
//     file is hidden from the image picker and still shows wherever it is used
//   - "Show archived files" lists them too (GET ?archived=include), marked
//   - "Where it's used" on each file reads the usage (PUT {id}) and lists it
//     in plain words (usageLine: a page's name and state, never an id)
//   - a delete the server refuses because the file is used shows the
//     server's plain reason and where it is used, with "Archive it instead"
//     and no way round it. On a store still on the current editors (its usage
//     has no page, release or settings marks) the old "delete anyway" choice
//     stays, as the server still allows it there
//   - any other refusal (the store is being moved) shows its plain words

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const STATE_WORDS = { live: "live", draft: "draft", "older version": "an earlier version" };
const prefix = (w, p) => typeof w === "string" && w.startsWith(p);

// One usage row in plain words: what it is, never an id or a table name.
export function usageLine(u) {
  if (!isObj(u)) return "Another part of your store";
  if (u.document) return `${u.name || "A page"} (${STATE_WORDS[u.label] || u.label || "used"})`;
  const w = typeof u.where === "string" ? u.where : "";
  if (u.config) return `Your ${w || "store settings"}`;
  if (prefix(w, "live release:")) return "What your store shows now";
  if (prefix(w, "scheduled release:")) return "A scheduled update of your store";
  if (u.release || prefix(w, "retained release:")) return "An earlier published version of your store";
  if (prefix(w, "block:")) return "A section of your home page";
  if (prefix(w, "page:")) return `Your page “${w.slice(5)}”`;
  if (prefix(w, "product modules:")) return "A product's extra content";
  return "Another part of your store";
}
export const usageLines = (uses) => [...new Set((Array.isArray(uses) ? uses : []).map(usageLine))];

// The usage of a store on the new editor: every row names a page, an old
// published version or the store's settings. There, a used file is never
// deleted, forced or not (lib/media.js deleteMedia).
export const documentsUsage = (uses) => Array.isArray(uses) && uses.length > 0 && uses.every((u) => isObj(u) && (u.document || u.release || u.config));

// P4-FIX2: "Delete anyway" is offered only when it can work: lib/media.js
// deleteMedia refuses a forced delete whenever any usage row is a page
// document (and always on a documents store), so a legacy store whose file is
// used by an old section AND a page draft gets the refusal, not the choice.
export const canForceDelete = (uses) => Array.isArray(uses) && uses.length > 0 && !documentsUsage(uses) && !uses.some((u) => isObj(u) && u.document);

// P4-FIX2: what a refused delete says. The server's words for a used file are
// never shown (on a legacy store they hold codes such as "block:promo"): the
// console says it in fixed words and lists the places by usageLines. The
// moving-store and changed-file refusals are fixed plain sentences on the
// server (lib/media.js); anything else is the plain "failed" line.
const SERVER_WORDS_SHOWN = new Set(["STORE_MIGRATING", "MEDIA_CHANGED"]);
export function refusalWords(code, message) {
  if (code === "MEDIA_IN_USE") return MEDIA_WORDS.inUse;
  if (SERVER_WORDS_SHOWN.has(code) && typeof message === "string" && message) return message;
  return MEDIA_WORDS.failed;
}

export const MEDIA_WORDS = Object.freeze({
  inUse: "This file is still used, so it wasn't deleted. Remove it from the places below first.",
  backFromArchive: (name) => `${name} was archived. It's back in your library now.`,
  archived: (name) => `${name} is archived. It's hidden from the image picker, and pages that use it still show it.`,
  unarchived: (name) => `${name} is back in your library.`,
  archivedNote: "Archived: hidden from the image picker. Pages that use it still show it.",
  notUsed: "Not used anywhere.",
  refusedTitle: "This file can't be deleted",
  refusedHelp: "Archive it instead to hide it from the image picker. Pages that use it keep showing it.",
  failed: "Something went wrong on our side, so nothing changed. Try again.",
});

// The refusal dialog's state for one refused delete.
const refusalOf = (media, code, message, usage) => ({
  media,
  message: refusalWords(code, message),
  lines: code === "MEDIA_IN_USE" ? usageLines(usage) : [],
  offerArchive: code === "MEDIA_IN_USE" && media.archived_at == null,
});

export default function MediaAdmin({ initial, readOnly = false }) {
  const [media, setMedia] = useState(initial);
  const [uploading, setUploading] = useState(null); // progress of the file in flight
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null); // media row
  const [usageGuard, setUsageGuard] = useState(null); // {media, lines}: old editors only, "delete anyway"
  const [refusal, setRefusal] = useState(null); // {media, message, lines, offerArchive}
  const [showArchived, setShowArchived] = useState(false);
  const [usedBy, setUsedBy] = useState({}); // id -> { status: "loading" | "ready" | "failed", lines, message }
  const [busy, setBusy] = useState(null); // id of a file being archived or brought back
  const fileRef = useRef(null);
  const showArchivedRef = useRef(false); // what refresh() lists, set with the box
  const toast = useToast();

  async function refresh() {
    // "Show archived files" (P4-PICKER). test-media-upload runs this body on
    // its own, where the ref isn't defined: then it lists as before.
    const withArchived = typeof showArchivedRef !== "undefined" && showArchivedRef.current === true;
    const res = await fetch(withArchived ? "/api/admin/media?archived=include" : "/api/admin/media");
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
        // P4-FIX2: bytes that match an archived file bring it back on purpose
        // (lib/media.js saveMedia), and the founder is told
        if (r.media.deduped && r.media.unarchived) toast.success(MEDIA_WORDS.backFromArchive(file.name));
        else if (r.media.deduped) toast.success(`${file.name} was already in the library — reused`);
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

  // Archive (true) or bring back (false). The server's refusals are in plain
  // words (archiving not available yet, the file is gone).
  async function setArchived(m, archived) {
    setBusy(m.id);
    try {
      const res = await fetch("/api/admin/media", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: m.id, archived }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        toast.error(json.error || MEDIA_WORDS.failed);
        return false;
      }
      const at = json.archived_at ?? null;
      setMedia((list) => (archived && !showArchivedRef.current ? list.filter((x) => x.id !== m.id) : list.map((x) => (x.id === m.id ? { ...x, archived_at: at } : x))));
      toast.success(archived ? MEDIA_WORDS.archived(m.filename) : MEDIA_WORDS.unarchived(m.filename));
      return true;
    } catch {
      toast.error(MEDIA_WORDS.failed);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function toggleArchived(on) {
    showArchivedRef.current = on;
    setShowArchived(on);
    await refresh().catch(() => {});
  }

  // "Where it's used": the usage read, in plain words. A second press hides it.
  async function showUsage(m) {
    if (usedBy[m.id] && usedBy[m.id].status !== "loading") {
      setUsedBy((u) => {
        const next = { ...u };
        delete next[m.id];
        return next;
      });
      return;
    }
    setUsedBy((u) => ({ ...u, [m.id]: { status: "loading", lines: [] } }));
    try {
      const res = await fetch("/api/admin/media", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: m.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || MEDIA_WORDS.failed);
      setUsedBy((u) => ({ ...u, [m.id]: { status: "ready", lines: usageLines(json.usage) } }));
    } catch (e) {
      setUsedBy((u) => ({ ...u, [m.id]: { status: "failed", lines: [], message: String(e?.message || MEDIA_WORDS.failed) } }));
    }
  }

  // One DELETE helper: { ok } when deleted, { refused: { code, message,
  // usage } } on a 409, and a throw (plain words) on anything else.
  async function requestDelete(id, force) {
    const res = await fetch("/api/admin/media", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, force }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 409) return { refused: { code: json.code || null, message: json.error || MEDIA_WORDS.failed, usage: Array.isArray(json.usage) ? json.usage : [] } };
    if (!res.ok || !json.ok) throw new Error(json.error || "Delete failed");
    return { ok: true };
  }

  const list = Array.isArray(media) ? media : [];

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

      <div className="flex items-center gap-2 text-sm text-fg">
        <input id="media-show-archived" type="checkbox" className="size-4 focus-ring" checked={showArchived} onChange={(e) => toggleArchived(e.target.checked)} data-show-archived="" />
        <label htmlFor="media-show-archived">Show archived files</label>
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState icon={<ImageIcon size={20} aria-hidden />} title="No files yet" body={readOnly ? "Uploads appear here." : "Upload your first image above."} />
        </Card>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.map((m) => {
            const thumb = m.variants?.find((v) => v.variant === "thumb");
            const archived = m.archived_at != null;
            const used = usedBy[m.id];
            return (
              <Card key={m.id} as="li" padded={false} className="overflow-hidden">
                <div className="flex h-36 items-center justify-center bg-surface-sunken" data-media-file={m.id} data-archived={archived ? "" : undefined}>
                  {/* library files are same-origin; plain <img> keeps this simple */}
                  <img src={thumb ? `/api/media/${thumb.id}` : m.url} alt={m.alt || m.filename} className={`max-h-36 max-w-full object-contain ${archived ? "opacity-60" : ""}`} loading="lazy" />
                </div>
                <div className="space-y-2 p-3">
                  <p className="flex items-center gap-1.5 truncate text-xs font-medium text-fg" title={m.filename}>
                    <span className="truncate">{m.filename}</span>
                    {archived && <Badge tone="warning">Archived</Badge>}
                  </p>
                  <p className="text-[11px] text-fg-subtle">
                    {m.mime.replace("image/", "")} · {fmtSize(m.size)}
                    {m.width ? ` · ${m.width}×${m.height}` : ""}
                    {thumb ? " · +thumb" : ""}
                  </p>
                  {archived && <p className="text-[11px] text-fg-muted">{MEDIA_WORDS.archivedNote}</p>}
                  <Input
                    defaultValue={m.alt}
                    placeholder="Alt text (describe the image)"
                    aria-label={`Alt text for ${m.filename}`}
                    disabled={readOnly}
                    onBlur={(e) => !readOnly && e.target.value !== (m.alt || "") && saveAlt(m.id, e.target.value)}
                    className="px-2 py-1 text-xs"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="sm" variant="ghost" icon={<ListTree size={13} aria-hidden />} aria-expanded={!!used && used.status !== "loading"} busy={used?.status === "loading"} onClick={() => showUsage(m)} data-media-usage={m.id}>
                      Where it&rsquo;s used
                    </Button>
                    {!readOnly &&
                      (archived ? (
                        <Button size="sm" icon={<ArchiveRestore size={13} aria-hidden />} busy={busy === m.id} onClick={() => setArchived(m, false)} data-media-unarchive={m.id}>
                          Unarchive
                        </Button>
                      ) : (
                        <Button size="sm" icon={<Archive size={13} aria-hidden />} busy={busy === m.id} onClick={() => setArchived(m, true)} data-media-archive={m.id}>
                          Archive
                        </Button>
                      ))}
                  </div>
                  {used && used.status !== "loading" && (
                    <div className="rounded-ctl bg-surface-sunken px-2 py-1.5 text-[11px] text-fg" data-media-used-by={m.id} role="status">
                      {used.status === "failed" ? (
                        <p className="text-danger">{used.message}</p>
                      ) : used.lines.length === 0 ? (
                        <p>{MEDIA_WORDS.notUsed}</p>
                      ) : (
                        <>
                          <p className="font-medium">Used by:</p>
                          <ul className="list-inside list-disc">
                            {used.lines.map((l) => (
                              <li key={l}>{l}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
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
              Deletes <strong>{deleting.filename}</strong> from the library permanently. If anything still uses it, you&rsquo;ll be shown where, and it won&rsquo;t be deleted.
            </>
          )
        }
        onConfirm={async () => {
          const m = deleting;
          const r = await requestDelete(m.id, false);
          if (r.refused) {
            const { code, message, usage } = r.refused;
            if (code === "MEDIA_IN_USE" && canForceDelete(usage)) setUsageGuard({ media: m, lines: usageLines(usage) });
            else setRefusal(refusalOf(m, code, message, usage));
          } else {
            toast.success("Deleted");
            await refresh();
          }
        }}
      />

      <Dialog
        open={!!refusal}
        onClose={() => setRefusal(null)}
        title={MEDIA_WORDS.refusedTitle}
        size="sm"
        footer={
          refusal && (
            <>
              <Button onClick={() => setRefusal(null)}>Close</Button>
              {refusal.offerArchive && !readOnly && (
                <Button
                  variant="primary"
                  icon={<Archive size={13} aria-hidden />}
                  busy={busy === refusal.media.id}
                  onClick={async () => {
                    if (await setArchived(refusal.media, true)) setRefusal(null);
                  }}
                  data-archive-instead=""
                >
                  Archive it instead
                </Button>
              )}
            </>
          )
        }
      >
        {refusal && (
          <div className="space-y-2" data-delete-refused="">
            <p className="text-fg">{refusal.message}</p>
            {refusal.lines.length > 0 && (
              <>
                <p className="font-medium text-fg">Used by:</p>
                <ul className="list-inside list-disc">
                  {refusal.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </>
            )}
            {refusal.offerArchive && <p>{MEDIA_WORDS.refusedHelp}</p>}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!usageGuard}
        onClose={() => setUsageGuard(null)}
        title="Still used — delete anyway?"
        tone="danger"
        confirmLabel="Delete anyway"
        body={
          usageGuard && (
            <>
              <Banner tone="warning" title="This file is still used by:">
                <ul className="list-inside list-disc">
                  {usageGuard.lines.map((l) => (
                    <li key={l} className="text-xs">
                      {l}
                    </li>
                  ))}
                </ul>
              </Banner>
              <p className="mt-2">Deleting it leaves broken images there (and in any older release you roll back to).</p>
            </>
          )
        }
        onConfirm={async () => {
          const m = usageGuard.media;
          const r = await requestDelete(m.id, true);
          if (r.refused) {
            // the usage changed since (a page now uses it, or the store is
            // being moved): the refusal in fixed words, never the server's text
            setUsageGuard(null);
            setRefusal(refusalOf(m, r.refused.code, r.refused.message, r.refused.usage));
            return;
          }
          toast.success("Deleted");
          await refresh();
        }}
      />
    </div>
  );
}
