"use client";

// P3-TREE (ED-02, AU-04): the add-section picker. Prop-driven, no store.
// Phase 2 line 6 (6a): on components/ui; storefront.write only (RoleGate,
// hidden for anyone without it).
//
//   <AddSection type sections index collections body? onChange onSelect afterLabel open? role />
// `body` (the whole draft, optional): a kind whose add would make it too big
// to save is shown refused (P3-FIX3).
//
// Lists every registered kind the document type takes (allowedKinds), with its
// label and its hint. A kind that can't be added (a second hero, …) is shown
// greyed out with the reason. Picking one calls treeModel.add, then
// onChange(sections, { op: "add", id, selectedId }) and onSelect(id), so the
// new section, whose id was minted here, is selected at once (ED-04).
// `open` only sets how it first renders (tests and hosts that want it open).
// Phase 6 (the studio's "Add a section here" insert points): `onClose()` is
// called when the picker closes (picked or closed), and `where` replaces the
// "Adds below …" words.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { add, addOptions } from "./treeModel";

export default function AddSection({ type, sections, index, collections = null, body = null, onChange, onSelect, afterLabel = "", open: openAtFirst = false, role = null, onClose, where: whereWords = null }) {
  const [open, setOpenState] = useState(!!openAtFirst);
  const setOpen = (v) => {
    setOpenState(v);
    if (!v) onClose?.();
  };
  const where = whereWords || (afterLabel ? `Adds below the ${afterLabel}` : "Adds at the end");
  if (!roleAllows(role, "storefront.write")) return null;
  const options = open ? addOptions(type, sections, index, { body }) : [];

  const pick = (kind) => {
    const r = add(sections, kind, index, { type, collections, body });
    if (!r.ok) return;
    setOpen(false);
    onChange?.(r.sections, { op: "add", id: r.id, selectedId: r.selectedId });
    onSelect?.(r.id);
  };

  if (!open) {
    return (
      <RoleGate role={role} action="storefront.write" mode="hide">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-tree-add="">
          <Plus aria-hidden />
          Add a section
        </Button>
      </RoleGate>
    );
  }
  return (
    <div role="group" aria-label="Add a section" className="rounded-md border border-border bg-card p-2" data-tree-picker="">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <p className="text-xs font-semibold text-foreground">Add a section</p>
        <p className="text-[11px] text-muted-foreground">{where}</p>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close the list" title="Close the list" onClick={() => setOpen(false)}>
          <X aria-hidden />
        </Button>
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
              className={cn(
                "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors",
                o.ok ? "hover:bg-muted" : "cursor-not-allowed opacity-60",
              )}
            >
              <span className="text-sm font-medium text-foreground">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.ok ? o.placeholder : o.reason}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
