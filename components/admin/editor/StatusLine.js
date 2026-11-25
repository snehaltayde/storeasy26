"use client";

import { CloudOff } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { WORDS } from "./editorModel";

// P3-EDITOR (ED-03, PV-01, PV-02, PUB-06): one line that says, in plain words,
// whether the founder's changes are saved and whether the preview shows them,
// plus the choices the store asks for. All props, no store import:
//   save        the store's state (status, statusWords, conflict, backupOffer,
//               notice, busy, unsavedWarning, error)
//   preview     the preview controller's view (label, words, field, note,
//               reconnecting)
//   closed      the store has never published (PUB-06)
//   blocked     { message, to } a link that waited for a save that failed
//   readOnly    this person only reads (support): no save line, no choices
//               that write
//   role        the actor's role (RoleGate on the choices that write)
//   on          { useNewer, keepMine, acceptBackup, dismissBackup, retry,
//                 previewRetry, leaveAnyway, focus(field) }
// Labels: the store's "Saving" / "Saved" / "Could not save: …", "Offline"
// when the save could not reach Storeasy, and the preview's "Up to date" /
// "Updating" / "Could not update" (PV-01).
// Phase 2 line 6 (6a): on components/ui. The conflict banner offers "Load
// theirs" (useNewer: yours is kept as an earlier version) and "Keep mine"
// (keepMine: theirs is kept as an earlier version).

const SAVE_TONE = { saved: "text-success", saving: "text-muted-foreground", pending: "text-muted-foreground", busy: "text-muted-foreground", error: "text-destructive", conflict: "text-warning-text", offline: "text-warning-text" };
const PREVIEW_TONE = { "Up to date": "text-success", Updating: "text-muted-foreground", "Could not update": "text-destructive" };
const TONES = {
  info: "border-info/30 bg-info/5",
  warning: "border-warning/40 bg-warning/10",
  danger: "border-destructive/30 bg-destructive/5",
};

// A message box in the editor (the kit has no alert yet): a title, words and
// the choices under it. tone: info | warning | danger.
export function Notice({ tone = "info", title = null, children = null, className, ...rest }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-md border px-3 py-2 text-[13px] text-foreground", TONES[tone] || TONES.info, className)} {...rest}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={title ? "mt-1 text-muted-foreground" : undefined}>{children}</div>}
    </div>
  );
}

export const isOffline = (s) => s?.status === "error" && s?.error?.code === "NETWORK_ERROR";

export default function StatusLine({ save = null, preview = null, closed = false, blocked = null, previewHidden = false, readOnly = false, role = null, on = {} }) {
  const s = save || { status: "saving", statusWords: "Saving" };
  const p = preview || null;
  const offline = isOffline(s);
  const status = offline ? "offline" : s.status;
  return (
    <div className="space-y-2" data-status-line="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        {!readOnly && (
          <p role="status" aria-live="polite" data-save-status={status} className="flex items-center gap-1">
            <span className="text-muted-foreground">Changes: </span>
            {offline && <CloudOff aria-hidden className="size-3.5 text-warning-text" />}
            <span className={SAVE_TONE[status] || "text-foreground"}>{offline ? `Offline. ${s.error?.message || ""}`.trim() : s.statusWords}</span>
          </p>
        )}
        {readOnly && (
          <p className="text-muted-foreground" data-save-status="read-only">
            You can look at this page but not change it.
          </p>
        )}
        {p && !previewHidden && (
          <p role="status" aria-live="polite" data-preview-status={p.label}>
            <span className="text-muted-foreground">Preview: </span>
            <span className={PREVIEW_TONE[p.label] || "text-foreground"}>{p.label}</span>
            {p.words && <span className="text-muted-foreground">{` · ${p.words}`}</span>}
          </p>
        )}
        {!readOnly && s.status === "error" && (
          <Button size="xs" variant="outline" onClick={on.retry}>
            Try again
          </Button>
        )}
        {p && !previewHidden && p.label === "Could not update" && (
          <Button size="xs" variant="outline" onClick={on.previewRetry} data-preview-retry="" data-read-control="">
            Try the preview again
          </Button>
        )}
      </div>
      {p && !previewHidden && p.note && <p className="text-[13px] text-muted-foreground">{p.note.words}</p>}
      {closed && (
        <Notice tone="info" title="Opening soon">
          <span data-closed-store="">{WORDS.closedStore}</span>
        </Notice>
      )}
      {!readOnly && s.conflict && (
        <Notice tone="warning" title={s.conflict.words} data-conflict-banner="">
          <p>Your text is still here. Choose which version to keep. The other one is kept in Earlier versions.</p>
          <div className="mt-2 flex flex-wrap gap-2" data-conflict="">
            <RoleGate role={role} action="storefront.write" mode="hide">
              <Button size="xs" onClick={on.useNewer}>
                Load theirs
              </Button>
            </RoleGate>
            <RoleGate role={role} action="storefront.write" mode="hide">
              <Button size="xs" variant="outline" onClick={on.keepMine}>
                Keep mine
              </Button>
            </RoleGate>
          </div>
        </Notice>
      )}
      {!readOnly && s.backupOffer && (
        <Notice tone="info" title={s.backupOffer.words}>
          <div className="mt-1 flex flex-wrap gap-2" data-backup-offer="">
            <RoleGate role={role} action="storefront.write" mode="hide">
              <Button size="xs" onClick={on.acceptBackup}>
                Keep them as an earlier draft
              </Button>
            </RoleGate>
            <Button size="xs" variant="outline" onClick={on.dismissBackup}>
              No, throw them away
            </Button>
          </div>
        </Notice>
      )}
      {blocked && (
        <Notice tone="warning" title={blocked.message}>
          <div className="mt-1 flex gap-2">
            <Button size="xs" variant="outline" onClick={on.leaveAnyway}>
              {WORDS.leaveAnyway}
            </Button>
          </div>
        </Notice>
      )}
      {s.notice && (
        <p className="text-[13px] text-muted-foreground" role="status" data-store-notice="">
          {s.notice}
        </p>
      )}
    </div>
  );
}
