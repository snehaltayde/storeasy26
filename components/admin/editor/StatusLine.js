"use client";

import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { WORDS } from "./editorModel";

// P3-EDITOR (ED-03, PV-01, PV-02, PUB-06): one line that says, in plain words,
// whether the founder's changes are saved and whether the preview shows them,
// plus the choices the store asks for. All props, no store import:
//   save        the store's state (status, statusWords, conflict, backupOffer,
//               notice, busy, unsavedWarning)
//   preview     the preview controller's view (label, words, field, note,
//               reconnecting)
//   closed      the store has never published (PUB-06)
//   blocked     { message, to } a link that waited for a save that failed
//   on          { useNewer, keepMine, acceptBackup, dismissBackup, retry,
//                 previewRetry, leaveAnyway, focus(field) }
// Labels: the store's "Saving" / "Saved" / "Could not save: …" and the
// preview's "Up to date" / "Updating" / "Could not update" (PV-01).

const SAVE_TONE = { saved: "text-success", saving: "text-fg-muted", pending: "text-fg-muted", busy: "text-fg-muted", error: "text-danger", conflict: "text-warning" };
const PREVIEW_TONE = { "Up to date": "text-success", Updating: "text-fg-muted", "Could not update": "text-danger" };

export default function StatusLine({ save = null, preview = null, closed = false, blocked = null, previewHidden = false, on = {} }) {
  const s = save || { status: "saving", statusWords: "Saving" };
  const p = preview || null;
  return (
    <div className="space-y-2" data-status-line="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <p role="status" aria-live="polite" data-save-status={s.status}>
          <span className="text-fg-muted">Changes: </span>
          <span className={SAVE_TONE[s.status] || "text-fg"}>{s.statusWords}</span>
        </p>
        {p && !previewHidden && (
          <p role="status" aria-live="polite" data-preview-status={p.label}>
            <span className="text-fg-muted">Preview: </span>
            <span className={PREVIEW_TONE[p.label] || "text-fg"}>{p.label}</span>
            {p.words && <span className="text-fg-muted">{` · ${p.words}`}</span>}
          </p>
        )}
        {s.status === "error" && (
          <Button size="sm" onClick={on.retry}>
            Try again
          </Button>
        )}
        {p && !previewHidden && p.label === "Could not update" && (
          <Button size="sm" onClick={on.previewRetry} data-preview-retry="">
            Try the preview again
          </Button>
        )}
      </div>
      {p && !previewHidden && p.note && <p className="text-[13px] text-fg-muted">{p.note.words}</p>}
      {closed && (
        <Banner tone="info" title="Opening soon">
          <span data-closed-store="">{WORDS.closedStore}</span>
        </Banner>
      )}
      {s.conflict && (
        <Banner tone="warning" title={s.conflict.words} actions={null}>
          <p>Your text is still here. Choose which version to keep. The other one is kept in Earlier versions.</p>
          <div className="mt-2 flex flex-wrap gap-2" data-conflict="">
            <Button size="sm" variant="primary" onClick={on.useNewer}>
              Use the newer version
            </Button>
            <Button size="sm" onClick={on.keepMine}>
              Keep mine
            </Button>
          </div>
        </Banner>
      )}
      {s.backupOffer && (
        <Banner tone="info" title={s.backupOffer.words}>
          <div className="mt-1 flex flex-wrap gap-2" data-backup-offer="">
            <Button size="sm" variant="primary" onClick={on.acceptBackup}>
              Keep them as an earlier draft
            </Button>
            <Button size="sm" onClick={on.dismissBackup}>
              No, throw them away
            </Button>
          </div>
        </Banner>
      )}
      {blocked && (
        <Banner tone="warning" title={blocked.message}>
          <div className="mt-1 flex gap-2">
            <Button size="sm" onClick={on.leaveAnyway}>
              {WORDS.leaveAnyway}
            </Button>
          </div>
        </Banner>
      )}
      {s.notice && (
        <p className="text-[13px] text-fg-muted" role="status" data-store-notice="">
          {s.notice}
        </p>
      )}
    </div>
  );
}
