"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/console/Button";
import TakeOfflineConfirm from "./TakeOfflineConfirm";
import { WORDS, createUndoFlow } from "./publishModel";

// P3-PUBLISHUI (PUB-04, PUB-05): Undo, offered in the message after a
// publish and on each Recently published row. The dry run comes first, so
// the confirm says what will change (or, when Undo takes a page offline,
// which live pages link to it). All props; the flow is createUndoFlow().
//   target    { kind: "one", label, undo: {id, revision, logId} }
//             { kind: "set", setId, members, labels }
//             { kind: "offline", label, id, revision }
//   call      documentsApi.call or the editor store's wrapper
//   note      shown instead of Undo (a singleton's first publish)
//   onDocument, onUndone, onOpenEarlierVersions
//   flow      an existing createUndoFlow() (tests, or a host that shares one)

export function UndoNoticeView({ state, target, note = null, label, onStart, onConfirm, onCancel, onOpenEarlierVersions }) {
  if (note) return <p className="text-[13px] text-fg-muted">{note}</p>;
  if (!target) return null;
  const s = state || { phase: "idle" };
  const v = s.view;
  return (
    <div className="space-y-2" data-undo="">
      {(s.phase === "idle" || s.phase === "loading") && (
        <Button size="sm" busy={s.phase === "loading"} onClick={onStart}>
          {label || (target.kind === "set" ? WORDS.undoAll(target.members.length) : target.kind === "offline" ? WORDS.offlineConfirm : WORDS.undo)}
        </Button>
      )}
      {s.phase === "loading" && <p className="text-[13px] text-fg-muted">{WORDS.undoLoading}</p>}
      {s.phase === "confirm" && v && !v.willTakeOffline && (
        <div className="rounded-ctl border border-edge bg-surface-sunken p-3 text-[13px]">
          <p className="font-semibold text-fg">{v.title}</p>
          {v.changes.length ? (
            <>
              <p className="mt-1">{WORDS.undoWillChange}</p>
              <ul className="mt-1 list-disc pl-5">
                {v.changes.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-1">{WORDS.undoNoChanges}</p>
          )}
          {v.goesBackTo && <p className="mt-1">{v.goesBackTo}</p>}
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" busy={s.busy} onClick={onConfirm}>
              {WORDS.undoConfirm}
            </Button>
            <Button size="sm" onClick={onCancel} disabled={s.busy}>
              {WORDS.cancel}
            </Button>
          </div>
        </div>
      )}
      {s.phase === "confirm" && v && v.willTakeOffline && <TakeOfflineConfirm open view={v} busy={s.busy} onConfirm={onConfirm} onCancel={onCancel} />}
      {s.phase === "result" && s.outcome && (
        <div className="text-[13px]" role="status">
          <p className={s.outcome.phase === "error" ? "text-danger" : "text-fg"}>{s.outcome.words}</p>
          {(s.outcome.lines || []).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          {s.outcome.by && <p className="text-fg-muted">{WORDS.lastSavedBy(s.outcome.by)}</p>}
          {s.outcome.savedVersion && onOpenEarlierVersions && (
            <button type="button" className="mt-1 underline focus-ring" onClick={onOpenEarlierVersions}>
              {WORDS.earlierVersionsLink}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function UndoNotice({ target, call, note = null, label, onDocument, onUndone, onOpenEarlierVersions, flow: given }) {
  const flow = useMemo(() => given || createUndoFlow({ call, onDocument, onUndone }), [given]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return (
    <UndoNoticeView
      state={state}
      target={target}
      note={note}
      label={label}
      onStart={() => flow.start(target)}
      onConfirm={() => flow.confirm()}
      onCancel={() => flow.cancel()}
      onOpenEarlierVersions={onOpenEarlierVersions}
    />
  );
}
