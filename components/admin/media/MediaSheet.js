"use client";

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Copy, ExternalLink, ListTree, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge } from "@/components/kit/status-badge";
import { useToast } from "@/components/console/Toast";
import { roleAllows } from "@/lib/platform/authz";
import { DeleteMediaDialog } from "@/components/admin/media/DeleteMediaDialog";
import { fmtDate, fmtDims, fmtSize, MEDIA_WORDS, TYPE_WORDS, usageLines } from "@/components/admin/media/media-words";

const WRITE = "storefront.write";
const send = async (method, body) => {
  const res = await fetch("/api/admin/media", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.ok === true, json };
};

// One file's details (Phase 2 line 5 §3-§5): preview, name, type, size,
// dimensions, uploaded date, Copy URL; alt text (writers edit it, everyone
// else reads it, with a note when it is empty); "Where it's used" (PUT, a
// read: storefront.read); archive or bring back and delete for writers
// (RoleGate, hidden from support). The sheet's own close and every read in
// it carry data-read-control (support's stray-control rule).
//   item, role; onUpdated(item): the file changed; onRemoved(): it was deleted
export function MediaDetails({ item, role, onUpdated, onRemoved }) {
  const toast = useToast();
  const [alt, setAlt] = useState(item.alt || "");
  const [saving, setSaving] = useState(false);
  const [usage, setUsage] = useState(null); // { status: "loading" | "ready" | "failed", lines }
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setAlt(item.alt || "");
    setUsage(null);
  }, [item.id, item.alt]);

  async function loadUsage() {
    setUsage({ status: "loading", lines: [] });
    try {
      const r = await send("PUT", { id: item.id });
      setUsage(r.ok ? { status: "ready", lines: usageLines(r.json.usage) } : { status: "failed", lines: [] });
    } catch {
      setUsage({ status: "failed", lines: [] });
    }
  }

  async function saveAlt() {
    setSaving(true);
    try {
      const r = await send("PATCH", { id: item.id, alt });
      if (!r.ok) return toast.error(MEDIA_WORDS.altFailed);
      toast.success(MEDIA_WORDS.altSaved);
      onUpdated?.({ ...item, alt: alt.slice(0, 300) });
    } catch {
      toast.error(MEDIA_WORDS.altFailed);
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(archived) {
    setBusy(true);
    try {
      const r = await send("PATCH", { id: item.id, archived });
      if (!r.ok) return toast.error(r.json.code === "MEDIA_ARCHIVE_UNAVAILABLE" || r.json.code === "MEDIA_NOT_FOUND" ? r.json.error : MEDIA_WORDS.failed);
      toast.success(archived ? MEDIA_WORDS.archived(item.filename) : MEDIA_WORDS.unarchived(item.filename));
      onUpdated?.({ ...item, archived_at: r.json.archived_at ?? null });
    } catch {
      toast.error(MEDIA_WORDS.failed);
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(new URL(item.url, window.location.origin).href);
      toast.success(MEDIA_WORDS.copied);
    } catch {
      toast.error(MEDIA_WORDS.copyFailed);
    }
  }

  const archived = item.archived_at != null;
  const facts = [
    ["Type", TYPE_WORDS[item.mime] || item.mime],
    ["Size", fmtSize(item.size)],
    ["Dimensions", fmtDims(item)],
    ["Uploaded", fmtDate(item.created_at)],
  ];

  return (
    <div data-media="details" data-media-id={item.id} className="flex flex-col gap-5">
      {/* the grid's frame, larger: a fixed stage so a tall image never
          pushes the facts off a phone, and a small one is not blown up */}
      <div className="flex h-56 items-center justify-center overflow-hidden rounded-card border border-border bg-muted p-2 sm:h-64">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.url} alt={item.alt || ""} className="max-h-full max-w-full object-contain" />
      </div>
      {archived && (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <StatusBadge kind="media" status="archived" />
          <span>{MEDIA_WORDS.archivedNote}</span>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" data-read-control onClick={copyUrl}>
          <Copy aria-hidden /> Copy URL
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={item.url} target="_blank" rel="noreferrer" data-read-control>
            <ExternalLink aria-hidden /> Open full size
          </a>
        </Button>
      </div>

      <section aria-labelledby="media-alt" className="space-y-2">
        <Label id="media-alt" htmlFor={roleAllows(role, WRITE) ? "media-alt-input" : undefined}>
          Alt text
        </Label>
        {roleAllows(role, WRITE) && !(alt || "").trim() && <p className="text-xs text-muted-foreground">{MEDIA_WORDS.altEmpty}</p>}
        <AltField role={role} alt={alt} setAlt={setAlt} saving={saving} onSave={saveAlt} changed={alt !== (item.alt || "")} />
      </section>

      <section aria-label="Where it's used" className="space-y-2">
        <Button type="button" variant="outline" size="sm" data-read-control onClick={loadUsage} disabled={usage?.status === "loading"}>
          <ListTree aria-hidden /> Where it&apos;s used
        </Button>
        {usage?.status === "ready" && (
          <div data-media="usage" className="text-sm">
            {usage.lines.length ? (
              <ul className="list-disc space-y-1 pl-5">
                {usage.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{MEDIA_WORDS.notUsed}</p>
            )}
          </div>
        )}
        {usage?.status === "failed" && <p className="text-sm text-danger">{MEDIA_WORDS.usageFailed}</p>}
      </section>

      {roleAllows(role, WRITE) && (
        <div data-media="writes" className="flex flex-wrap gap-2 border-t border-border pt-4">
          <RoleGate role={role} action={WRITE} mode="hide">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setArchived(!archived)}>
              {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              {archived ? "Bring back" : "Archive"}
            </Button>
          </RoleGate>
          <RoleGate role={role} action={WRITE} mode="hide">
            <Button type="button" variant="outline" size="sm" className="text-danger" onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden /> Delete
            </Button>
          </RoleGate>
          <p className="w-full text-xs text-muted-foreground">{MEDIA_WORDS.archiveHelp}</p>
        </div>
      )}
      <DeleteMediaDialog
        item={item}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          toast.success(MEDIA_WORDS.deleted(item.filename));
          onRemoved?.();
        }}
        onArchive={() => setArchived(true)}
      />
    </div>
  );
}

// Alt text: a field and Save for writers; the text itself for everyone else.
function AltField({ role, alt, setAlt, saving, onSave, changed }) {
  return (
    <>
      {roleAllows(role, WRITE) && (
        <div className="space-y-2">
          <Textarea id="media-alt-input" value={alt} maxLength={300} rows={2} onChange={(e) => setAlt(e.target.value)} />
          <RoleGate role={role} action={WRITE} mode="hide">
            <Button type="button" size="sm" disabled={!changed || saving} onClick={onSave}>
              {saving ? "Saving…" : "Save alt text"}
            </Button>
          </RoleGate>
        </div>
      )}
      {!roleAllows(role, WRITE) && (
        <p data-media="alt-read" className={alt ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>
          {alt || MEDIA_WORDS.altNone}
        </p>
      )}
    </>
  );
}

export function MediaSheet({ item, role, onClose, onUpdated, onRemoved }) {
  return (
    <Sheet open={item != null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" showCloseButton={false} // the kit's sheet is 3/4 wide; this one is the whole phone (docs/UI.md
        // "Details sheet"), square-edged there, and 448px from 640px up
        className="overflow-y-auto p-4 data-[side=right]:w-full data-[side=right]:max-sm:rounded-none sm:p-6 data-[side=right]:sm:max-w-md" data-media="sheet">
        {item && (
          <>
            <SheetHeader className="flex-row items-start justify-between gap-2 p-0">
              <div className="min-w-0">
                <SheetTitle className="truncate" title={item.filename}>
                  {item.filename}
                </SheetTitle>
                <SheetDescription className="sr-only">Details of this file</SheetDescription>
              </div>
              <SheetClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" data-read-control aria-label="Close">
                  <X aria-hidden />
                </Button>
              </SheetClose>
            </SheetHeader>
            <MediaDetails item={item} role={role} onUpdated={onUpdated} onRemoved={onRemoved} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
