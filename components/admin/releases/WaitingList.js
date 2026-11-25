"use client";

import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { switcherRows } from "@/components/admin/editor/editorModel";
import PublishPanel from "@/components/admin/editor/publish/PublishPanel";
import { Badge, EmptyState } from "@/components/admin/editor/fields/parts";
import { editorHref } from "@/lib/admin/editor-entry";

// /admin/releases "Waiting to publish" (Phase 2 line 6): the pages with a
// draft that isn't live (never published, or changed since), from
// listDocuments. Someone who may publish ticks pages and presses Publish
// selected: the same PublishPanel and checks as the editor's Publish, sent as
// publishSet when two or more are ticked. Staff and support see the list and
// the reason, with no boxes and no button. Each row links into the editor.
//   documents   listDocuments' rows
//   access      { canPublish, reason }
//   call        documentsApi.call
//   onPublished(outcome)   after a publish (the page reads both lists again)
export const waitingRows = (documents) => switcherRows({ documents }).documents.filter((r) => r.state !== "Live");

export function WaitingListView({ rows, access = null, selected = [], onToggle, panel = null }) {
  const canPublish = access?.canPublish === true;
  if (!rows.length) return <EmptyState title="Nothing is waiting to publish" body="Every page's draft is live. Changes you make in the editor show up here until they are published." />;
  return (
    <div className="space-y-3" data-waiting-list="">
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Waiting to publish">
        {rows.map((r) => {
          const id = `waiting-${r.id}`;
          return (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-sm" data-waiting-row={r.id}>
              {canPublish && <Checkbox id={id} checked={selected.includes(r.id)} onCheckedChange={() => onToggle?.(r.id)} aria-label={`Select ${r.label}`} data-waiting-select="" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">{r.label}</p>
                {r.typeLabel && <p className="text-xs text-muted-foreground">{r.typeLabel}</p>}
              </div>
              <Badge tone={r.state === "Not published yet" ? "neutral" : "warning"}>{r.state}</Badge>
              <a href={editorHref(r.id)} className="shrink-0 rounded-sm text-sm underline outline-none focus-visible:ring-2 focus-visible:ring-ring" data-read-control="">
                Open in the editor
              </a>
            </li>
          );
        })}
      </ul>
      {panel}
    </div>
  );
}

export default function WaitingList({ documents = [], access = null, call, onPublished }) {
  const rows = useMemo(() => waitingRows(documents), [documents]);
  const [selected, setSelected] = useState([]);
  const picked = rows.filter((r) => selected.includes(r.id));
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const panel = (
    <PublishPanel
      documents={picked.map((r) => ({ id: r.id, label: r.label, type: r.type }))}
      mode={picked.length > 1 ? "all" : "one"}
      label={picked.length ? `Publish selected (${picked.length})` : "Publish selected"}
      disabled={picked.length === 0}
      access={access}
      call={call}
      onPublished={(o) => {
        setSelected([]);
        onPublished?.(o);
      }}
    />
  );
  return <WaitingListView rows={rows} access={access} selected={selected} onToggle={toggle} panel={panel} />;
}
