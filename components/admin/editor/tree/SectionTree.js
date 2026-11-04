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
//     body             the whole draft (optional): a copy or an add that would
//                      make it too big to save is refused (DRAFT_TOO_LARGE)
//     confirmingId     the row whose delete confirm shows first (tests, hosts)
//   />
//
// Each row shows the kind's label and the section's own title, and is marked:
//   selected     aria-current="true", a bar and a sunken background
//   Unfinished   the section has an "incomplete" issue (DOC-05, PV-02)
//   Needs a fix  the section has an "error" issue
//   Hidden       enabled:false, or hidden on both screens (TREE-05)
// Its buttons (move up, move down, hide or show, copy, delete) are disabled
// whenever the registry's composition rules would refuse the result. Every
// button's title is its reason when disabled, else its label (P3-FIX3: an
// enabled icon keeps its tooltip). A disabled button can't take focus, so its
// reason is also text under the row, named by the button's aria-describedby;
// "already at the top / bottom" is only for screen readers (the greyed arrow
// says it). Delete asks once, in the row.
import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Trash2 } from "lucide-react";
import { cx } from "@/components/console/cx";
import { Badge } from "@/components/console/Badge";
import { Button, IconButton } from "@/components/console/Button";
import AddSection from "./AddSection";
import { moveUp, moveDown, hide, show, duplicate, remove, rowActions, rowState } from "./treeModel";

const OPS = { moveUp, moveDown, hide, show, duplicate, remove };

// a reason that the button's place already says
const OBVIOUS = new Set(["AT_TOP", "AT_BOTTOM"]);

export default function SectionTree({ type, sections, selectedId = null, onChange, onSelect, issuesBySection = {}, collections = null, body = null, confirmingId = null }) {
  const [confirmId, setConfirmId] = useState(confirmingId);
  const list = Array.isArray(sections) ? sections : [];

  const run = (op, id) => {
    const r = OPS[op](list, id, { type, body });
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
            const can = id ? rowActions(list, id, type, { body }) : null;
            const name = row.title ? `${row.label}: ${row.title}` : row.label;
            const buttons = can
              ? [
                  { op: "moveUp", label: `Move ${row.label} up`, icon: <ArrowUp size={14} aria-hidden />, onClick: () => run("moveUp", id) },
                  { op: "moveDown", label: `Move ${row.label} down`, icon: <ArrowDown size={14} aria-hidden />, onClick: () => run("moveDown", id) },
                  row.hidden
                    ? { op: "show", label: `Show ${row.label}`, icon: <Eye size={14} aria-hidden />, onClick: () => run("show", id) }
                    : { op: "hide", label: `Hide ${row.label}`, icon: <EyeOff size={14} aria-hidden />, onClick: () => run("hide", id) },
                  { op: "duplicate", label: `Copy ${row.label}`, icon: <Copy size={14} aria-hidden />, onClick: () => run("duplicate", id) },
                  { op: "remove", label: `Delete ${row.label}`, icon: <Trash2 size={14} aria-hidden />, onClick: () => setConfirmId(id) },
                ].map((b) => ({ ...b, ...can[b.op], whyId: !can[b.op].ok && can[b.op].reason ? `${id}--why-${b.op}` : undefined }))
              : [];
            const why = buttons.filter((b) => b.whyId);
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
                  <>
                    <div className="mt-1 flex items-center gap-0.5" role="group" aria-label={`Change ${name}`}>
                      {buttons.map((b) => (
                        <IconButton key={b.op} label={b.label} title={b.reason || b.label} icon={b.icon} disabled={!b.ok} aria-describedby={b.whyId} onClick={b.onClick} data-op={b.op} />
                      ))}
                    </div>
                    {why.length > 0 && (
                      <ul className="mt-0.5 space-y-0.5 px-1 text-[11px] text-fg-subtle" data-why="">
                        {why.map((b) => (
                          <li key={b.op} id={b.whyId} className={OBVIOUS.has(b.code) ? "sr-only" : undefined}>
                            {b.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
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
        body={body}
        onChange={onChange}
        onSelect={onSelect}
      />
    </div>
  );
}
