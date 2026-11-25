"use client";

import { Button } from "../fields/parts";
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
          <p className="font-medium text-foreground">{WORDS.offlineLinkers}</p>
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
          <p className="font-medium text-foreground">{WORDS.undoWillChange}</p>
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

// Phase 2 line 6 (6c): the confirm is a panel in place (as Undo's own
// confirm is), not a modal: it sits where the founder pressed the button, and
// names the pages that link here before anything goes offline.
export function TakeOfflineFooter({ busy = false, onConfirm, onCancel }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="danger" busy={busy} onClick={onConfirm}>
        {WORDS.offlineConfirm}
      </Button>
      <Button size="sm" onClick={onCancel} disabled={busy}>
        {WORDS.cancel}
      </Button>
    </div>
  );
}

export default function TakeOfflineConfirm({ open = true, view, busy = false, onConfirm, onCancel }) {
  if (!open) return null;
  const title = view?.title || WORDS.offlineConfirm;
  return (
    <section role="group" aria-label={title} className="max-w-md space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[13px]" data-take-offline-confirm="">
      <p className="font-semibold text-foreground">{title}</p>
      <TakeOfflineBody view={view} />
      <TakeOfflineFooter busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
    </section>
  );
}
