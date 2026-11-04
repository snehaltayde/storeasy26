"use client";

import { useState } from "react";
import { Badge } from "@/components/console/Badge";
import { Button } from "@/components/console/Button";
import { WORDS, historyRowsOf, restoreOutcomeOf } from "./publishModel";

// P3-PUBLISHUI (PUB-04, DOC-08): Earlier versions of one document, from
// listHistory. Versions that Undo or a conflict kept for the founder show
// their own words ("Saved before Undo", "Kept from another tab"). Restore
// puts a version in the draft; it never goes live by itself. All props:
//   versions    listHistory's versions
//   onRestore(version)  the store's restoreVersion (a server-replace, plan
//                       A5); resolves to the documentsApi result
//   timeZone    for the times (optional)
//   message     a result to show from outside (optional)
export function EarlierVersionsView({ rows, busyId = null, message = null, onRestore }) {
  return (
    <section className="space-y-2" aria-label="Earlier versions" data-earlier-versions="">
      <p className="text-[13px] text-fg-muted">{WORDS.restoreNote}</p>
      {message && (
        <p className={message.ok ? "text-[13px] text-fg" : "text-[13px] text-danger"} role="status">
          {message.words}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-[13px] text-fg-muted">{WORDS.historyEmpty}</p>
      ) : (
        <ul className="divide-y divide-edge">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 py-2 text-[13px]">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                  {r.title}
                  {r.live && <Badge tone="success">Live now</Badge>}
                </p>
                <p className="text-fg-muted">{[r.when, r.by].filter(Boolean).join(" · ")}</p>
                {r.note && <p className="text-fg-muted">{r.note}</p>}
              </div>
              <Button size="sm" busy={busyId === r.id} disabled={busyId != null && busyId !== r.id} onClick={() => onRestore?.(r)}>
                {WORDS.restore}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function EarlierVersions({ versions, onRestore, timeZone, message: outside = null }) {
  const rows = historyRowsOf(versions, { timeZone });
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);
  const restore = async (row) => {
    if (!onRestore) return;
    setBusyId(row.id);
    setMessage(null);
    let r;
    try {
      r = await onRestore(versions.find((v) => v.id === row.id) || row);
    } catch {
      r = null;
    }
    setMessage(restoreOutcomeOf(r, row));
    setBusyId(null);
  };
  return <EarlierVersionsView rows={rows} busyId={busyId} message={message || outside} onRestore={restore} />;
}
