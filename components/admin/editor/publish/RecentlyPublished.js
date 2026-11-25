"use client";

import { useMemo, useSyncExternalStore } from "react";
import { UndoNoticeView } from "./UndoNotice";
import { WORDS, createUndoFlow, recentGroupsOf } from "./publishModel";

// P3-PUBLISHUI (PUB-04, PUB-05): the Recently published list, from
// listRecentlyPublished. Each row: what happened, the page's name, who and
// when, the change summary, and Undo only when the row's canUndo is true. A
// row that took a page offline carries the server's note ("Publish it again
// from the editor to bring it back."). The rows of one publish are grouped,
// and a group with two or more rows that can be undone offers Undo of the
// whole set. P3-EDITOR mounts this on /admin/releases in documents mode.
// All props:
//   rows        listRecentlyPublished's rows
//   call        documentsApi.call or the store's wrapper (undo, undoSet)
//   editorHref(documentId)   the link to a row's page in the editor (optional)
//   onUndone(outcome, target), onDocument(doc), onOpenEarlierVersions
//   access      { canPublish, reason }: staff see Undo disabled with the
//               reason (P3-FIX3; the server refuses them too)
//   timeZone    for the times (optional)
//   flow        an existing createUndoFlow() (tests)

export function RecentlyPublishedView({ groups, state, access = null, onUndo, onConfirm, onCancel, editorHref = null, onOpenEarlierVersions }) {
  const active = state?.target || null;
  const undoBlock = (target) => <UndoNoticeView state={active === target ? state : { phase: "idle" }} target={target} access={access} onStart={() => onUndo(target)} onConfirm={onConfirm} onCancel={onCancel} onOpenEarlierVersions={onOpenEarlierVersions} />;
  if (!groups.length) return <p className="text-[13px] text-muted-foreground">{WORDS.recentEmpty}</p>;
  return (
    <ul className="space-y-3" aria-label="Recently published" data-recently-published="">
      {groups.map((g, gi) => (
        <li key={gi} className="rounded-md border border-border p-3" data-set={g.rows.length > 1 ? "" : undefined}>
          <ul className="divide-y divide-border">
            {g.rows.map((r) => (
              <li key={r.logId} className="space-y-1 py-2 text-[13px]" data-row="">
                <p className="text-foreground">
                  <span>{r.actionWords}</span> <span className="font-semibold">{r.label}</span>
                </p>
                <p className="text-muted-foreground">{[r.byName, r.when].filter(Boolean).join(" · ")}</p>
                {r.summary.length > 0 && (
                  <ul className="list-disc pl-5">
                    {r.summary.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {r.note && <p className="text-muted-foreground">{r.note}</p>}
                <div className="flex flex-wrap items-center gap-3">
                  {r.canUndo && r.target && undoBlock(r.target)}
                  {editorHref && (
                    <a href={editorHref(r.documentId)} data-read-control="" className="underline rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {WORDS.openInEditor}
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {g.undoSet && <div className="border-t border-border pt-2">{undoBlock(g.undoSet)}</div>}
        </li>
      ))}
    </ul>
  );
}

export default function RecentlyPublished({ rows, call, access = null, editorHref, onUndone, onDocument, onOpenEarlierVersions, timeZone, flow: given }) {
  const groups = useMemo(() => recentGroupsOf(rows, { timeZone }), [rows, timeZone]);
  const flow = useMemo(() => given || createUndoFlow({ call, onDocument, onUndone, access }), [given]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return (
    <RecentlyPublishedView
      groups={groups}
      state={state}
      access={access}
      onUndo={(t) => flow.start(t)}
      onConfirm={() => flow.confirm()}
      onCancel={() => flow.cancel()}
      editorHref={editorHref}
      onOpenEarlierVersions={onOpenEarlierVersions}
    />
  );
}
