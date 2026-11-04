"use client";

// P3-TREE (ED-02, AU-04): the add-section picker. Prop-driven, no store.
//
//   <AddSection type sections index collections body? onChange onSelect afterLabel open? />
// `body` (the whole draft, optional): a kind whose add would make it too big
// to save is shown refused (P3-FIX3).
//
// Lists every registered kind the document type takes (allowedKinds), with its
// label and its hint. A kind that can't be added (a second hero, …) is shown
// greyed out with the reason. Picking one calls treeModel.add, then
// onChange(sections, { op: "add", id, selectedId }) and onSelect(id), so the
// new section, whose id was minted here, is selected at once (ED-04).
// `open` only sets how it first renders (tests and hosts that want it open).
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cx } from "@/components/console/cx";
import { Button, IconButton } from "@/components/console/Button";
import { add, addOptions } from "./treeModel";

export default function AddSection({ type, sections, index, collections = null, body = null, onChange, onSelect, afterLabel = "", open: openAtFirst = false }) {
  const [open, setOpen] = useState(!!openAtFirst);
  const options = open ? addOptions(type, sections, index, { body }) : [];
  const where = afterLabel ? `Adds below the ${afterLabel}` : "Adds at the end";

  const pick = (kind) => {
    const r = add(sections, kind, index, { type, collections, body });
    if (!r.ok) return;
    setOpen(false);
    onChange?.(r.sections, { op: "add", id: r.id, selectedId: r.selectedId });
    onSelect?.(r.id);
  };

  if (!open) {
    return (
      <Button size="sm" variant="secondary" icon={<Plus size={13} aria-hidden />} onClick={() => setOpen(true)} data-tree-add="">
        Add a section
      </Button>
    );
  }
  return (
    <div role="group" aria-label="Add a section" className="rounded-ctl border border-edge bg-surface p-2" data-tree-picker="">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <p className="text-xs font-semibold text-fg">Add a section</p>
        <p className="text-[11px] text-fg-subtle">{where}</p>
        <IconButton className="ml-auto" label="Close the list" icon={<X size={13} aria-hidden />} onClick={() => setOpen(false)} />
      </div>
      <ul className="space-y-0.5">
        {options.map((o) => (
          <li key={o.kind}>
            <button
              type="button"
              disabled={!o.ok}
              title={o.reason || undefined}
              onClick={() => pick(o.kind)}
              data-kind={o.kind}
              className={cx(
                "flex w-full flex-col items-start rounded-ctl px-2 py-1.5 text-left focus-ring motion-safe:transition-colors",
                o.ok ? "hover:bg-surface-sunken" : "cursor-not-allowed opacity-60",
              )}
            >
              <span className="text-sm font-medium text-fg">{o.label}</span>
              <span className="text-xs text-fg-muted">{o.ok ? o.placeholder : o.reason}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
