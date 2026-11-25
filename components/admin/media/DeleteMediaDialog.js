"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { MEDIA_WORDS, refusalWords, usageLines } from "@/components/admin/media/media-words";

// Delete (Phase 2 line 5 §5). An AlertDialog confirms first; an unused file
// is deleted. A file in use comes back 409 MEDIA_IN_USE: the dialog then says
// so in fixed words, lists the places by page name and offers "Archive it
// instead". There is no force: lib/media.js never deletes a used file, and
// this dialog has no way to ask it to.
//   item: the file; open / onOpenChange; onDeleted(); onArchive(): archive it
export function DeleteMediaDialog({ item, open, onOpenChange, onDeleted, onArchive }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null); // { message, lines, offerArchive }

  const change = (v) => {
    if (!v) setRefusal(null);
    onOpenChange(v);
  };

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/media", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        change(false);
        onDeleted?.();
        return;
      }
      const inUse = json.code === "MEDIA_IN_USE";
      setRefusal({ message: refusalWords(json.code, json.error), lines: inUse ? usageLines(json.usage) : [], offerArchive: inUse && item.archived_at == null });
    } catch {
      setRefusal({ message: MEDIA_WORDS.failed, lines: [], offerArchive: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent data-media="delete-dialog" data-state-kind={refusal ? "refused" : "confirm"}>
        {refusal ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{MEDIA_WORDS.inUseTitle}</AlertDialogTitle>
              <AlertDialogDescription>{refusal.message}</AlertDialogDescription>
            </AlertDialogHeader>
            {refusal.lines.length > 0 && (
              <ul data-media="refusal-usage" className="list-disc space-y-1 pl-5 text-sm text-foreground">
                {refusal.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
            {refusal.offerArchive && <p className="text-sm text-muted-foreground">{MEDIA_WORDS.inUseHelp}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel>Close</AlertDialogCancel>
              {refusal.offerArchive && (
                <Button
                  type="button"
                  onClick={() => {
                    change(false);
                    onArchive?.();
                  }}
                >
                  Archive it instead
                </Button>
              )}
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="[overflow-wrap:anywhere]">{MEDIA_WORDS.deleteTitle(item?.filename || "this file")}</AlertDialogTitle>
              <AlertDialogDescription>{MEDIA_WORDS.deleteHelp}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
              <Button type="button" variant="destructive" disabled={busy} onClick={remove}>
                {busy ? "Deleting…" : "Delete file"}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
