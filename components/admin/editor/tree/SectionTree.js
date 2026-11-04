"use client";

// P3-TREE (ED-02, AU-04, ED-04): the section tree of one document. Prop-driven:
// no store import (plan, FORMS split); the logic is in ./treeModel.js.
//
//   <SectionTree
//     type             the document type (home, page, product_layout, …)
//     sections         the draft's sections
//     selectedId       the selected section's id, or null
//     onChange(next, { op, id?, selectedId })   a new section list
//     onSelect(id)     a row was picked (or the selection moved after a delete)
//     issuesBySection  { [sectionId]: issues } (treeModel.groupIssues)
//     collections      for a new product rail (starterSection)
//   />
//
// Each row shows the kind's label and the section's own title, and is marked:
//   selected     aria-current="true", a bar and a sunken background
//   Unfinished   the section has an "incomplete" issue (DOC-05, PV-02)
//   Needs a fix  the section has an "error" issue
//   Hidden       enabled:false, or hidden on both screens (TREE-05)
// Its buttons (move up, move down, hide or show, copy, delete) are disabled,
// with the reason as their title, whenever the registry's composition rules
// would refuse the result. Delete asks once, in the row.
import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Trash2 } from "lucide-react";
import { cx } from "@/components/console/cx";
import { Badge } from "@/components/console/Badge";
import { Button, IconButton } from "@/components/console/Button";
import AddSection from "./AddSection";
import { moveUp, moveDown, hide, show, duplicate, remove, rowActions, rowState } from "./treeModel";

const OPS = { moveUp, moveDown, hide, show, duplicate, remove };

export default function SectionTree({ type, sections, selectedId = null, onChange, onSelect, issuesBySection = {}, collections = null }) {
  const [confirmId, setConfirmId] = useState(null);
  const list = Array.isArray(sections) ? sections : [];

  const run = (op, id) => {
    const r = OPS[op](list, id, { type });
    if (!r.ok) return;
    setConfirmId(null);
    onChange?.(r.sections, { op, id: r.id ?? id, selectedId: r.selectedId });
    if (r.selectedId !== selectedId) onSelect?.(r.selectedId);
  };

  const selectedIndex = list.findIndex((s) => s && s.id === selectedId);
  const selectedRow = selectedIndex >= 0 ? rowState(list[selectedIndex]) : null;

  return (
    <div className="space-y-3" data-section-tree="">
      {list.length === 0 ? (
        <p className="rounded-ctl border border-dashed border-edge px-3 py-4 text-center text-xs text-fg-muted">No sections yet. Add one to start.</p>
      ) : (
        <ol aria-label="Sections" className="space-y-1">
          {list.map((s, i) => {
            const id = s && typeof s.id === "string" ? s.id : null;
            const row = rowState(s, id ? issuesBySection?.[id] : []);
            const selected = id != null && id === selectedId;
            const can = id ? rowActions(list, id, type) : null;
            const name = row.title ? `${row.label}: ${row.title}` : row.label;
            return (
              <li
                key={id ?? `at-${i}`}
                data-section-row={id ?? ""}
                data-selected={selected ? "" : undefined}
                data-unfinished={row.unfinished ? "" : undefined}
                className={cx(
                  "group relative rounded-ctl border px-2 py-1.5",
                  selected ? "border-edge-strong bg-surface-sunken" : "border-edge bg-surface",
                  row.hidden && "opacity-70",
                )}
              >
                {selected && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    disabled={!id}
                    onClick={() => id && onSelect?.(id)}
                    className="flex min-w-0 flex-1 flex-col items-start rounded-ctl px-1 text-left focus-ring"
                  >
                    <span className={cx("max-w-full truncate text-sm", selected ? "font-semibold text-fg" : "font-medium text-fg")}>{row.label}</span>
                    {row.title && <span className="max-w-full truncate text-xs text-fg-muted">{row.title}</span>}
                  </button>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.unfinished && <Badge tone="warning" title="Some of it still needs filling in. It shows as unfinished in your preview and can't be published yet.">Unfinished</Badge>}
                    {row.problem && <Badge tone="danger" title="Something here needs fixing before it can be published.">Needs a fix</Badge>}
                    {row.hidden && <Badge tone="neutral" title="Shoppers don't see this section.">Hidden</Badge>}
                  </span>
                </div>
                {can && confirmId !== id && (
                  <div className="mt-1 flex items-center gap-0.5" role="group" aria-label={`Change ${name}`}>
                    <IconButton label={`Move ${row.label} up`} title={can.moveUp.reason || undefined} icon={<ArrowUp size={14} aria-hidden />} disabled={!can.moveUp.ok} onClick={() => run("moveUp", id)} />
                    <IconButton label={`Move ${row.label} down`} title={can.moveDown.reason || undefined} icon={<ArrowDown size={14} aria-hidden />} disabled={!can.moveDown.ok} onClick={() => run("moveDown", id)} />
                    {row.hidden ? (
                      <IconButton label={`Show ${row.label}`} title={can.show.reason || undefined} icon={<Eye size={14} aria-hidden />} disabled={!can.show.ok} onClick={() => run("show", id)} />
                    ) : (
                      <IconButton label={`Hide ${row.label}`} title={can.hide.reason || undefined} icon={<EyeOff size={14} aria-hidden />} disabled={!can.hide.ok} onClick={() => run("hide", id)} />
                    )}
                    <IconButton label={`Copy ${row.label}`} title={can.duplicate.reason || undefined} icon={<Copy size={14} aria-hidden />} disabled={!can.duplicate.ok} onClick={() => run("duplicate", id)} />
                    <IconButton label={`Delete ${row.label}`} title={can.remove.reason || undefined} icon={<Trash2 size={14} aria-hidden />} disabled={!can.remove.ok} onClick={() => setConfirmId(id)} />
                  </div>
                )}
                {can && confirmId === id && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5" role="group" aria-label={`Delete ${name}?`}>
                    <p className="text-xs text-fg">Delete this section?</p>
                    <Button size="sm" variant="danger" onClick={() => run("remove", id)}>
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                      Keep it
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <AddSection
        type={type}
        sections={list}
        index={selectedIndex >= 0 ? selectedIndex + 1 : list.length}
        afterLabel={selectedRow ? selectedRow.label.toLowerCase() : ""}
        collections={collections}
        onChange={onChange}
        onSelect={onSelect}
      />
    </div>
  );
}
