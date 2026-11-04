"use client";

import { Dialog } from "@/components/console/Dialog";
import { Button } from "@/components/console/Button";
import { WORDS } from "./publishModel";

// P3-PUBLISHUI (PUB-04): the confirm before a page goes offline, from
// "Take this page offline" or from an Undo whose dry run says it takes the
// page offline. All props: `view` is dryRunView() of the dry run (the
// pages that link to it, and the change words).
//   open, view { title, changes, linkers }, busy, onConfirm, onCancel
export function TakeOfflineBody({ view }) {
  const linkers = view?.linkers || [];
  const changes = view?.changes || [];
  return (
    <div className="space-y-3" data-take-offline="">
      <p>{WORDS.offlineWhat}</p>
      {linkers.length ? (
        <div>
          <p className="font-medium text-fg">{WORDS.offlineLinkers}</p>
          <ul className="mt-1 list-disc pl-5">
            {linkers.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>{WORDS.offlineNoLinkers}</p>
      )}
      {changes.length > 0 && (
        <div>
          <p className="font-medium text-fg">{WORDS.undoWillChange}</p>
          <ul className="mt-1 list-disc pl-5">
            {changes.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function TakeOfflineConfirm({ open = true, view, busy = false, onConfirm, onCancel }) {
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      title={view?.title || WORDS.offlineConfirm}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {WORDS.cancel}
          </Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            {WORDS.offlineConfirm}
          </Button>
        </>
      }
    >
      <TakeOfflineBody view={view} />
    </Dialog>
  );
}
