"use client";

// P3-TREE (ED-02, AU-04, ED-04): the section tree of one document. Prop-driven:
// no store import (plan, FORMS split); the logic is in ./treeModel.js.
// Phase 2 line 6 (6a): on components/ui and components/kit.
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
//     role             the actor's role: move, hide, copy, delete and add are
//                      storefront.write (RoleGate, hidden for anyone without
//                      it, so support only selects and reads)
//   />
//
// Each row shows the kind's label and the section's own title, and is marked:
//   selected     aria-current="true", a bar and a muted background
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
// A section's blocks (TREE-02; none of today's kinds take any) are rows nested
// under it in a collapsible list.
// Keyboard: ArrowUp / ArrowDown (Home / End) move focus between the rows;
// Enter or Space selects the focused row (it is a button).
import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Copy, Eye, EyeOff, Trash2 } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RoleGate } from "@/components/kit/role-gate";
import AddSection from "./AddSection";
import { moveUp, moveDown, hide, show, duplicate, remove, rowActions, rowState } from "./treeModel";

const OPS = { moveUp, moveDown, hide, show, duplicate, remove };
const WRITE = "storefront.write";

// a reason that the button's place already says
const OBVIOUS = new Set(["AT_TOP", "AT_BOTTOM"]);

// ArrowUp/ArrowDown/Home/End move focus between the rows' select buttons
export function moveRowFocus(e) {
  const keys = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
  if (!(e.key in keys)) return;
  const rows = [...(e.currentTarget?.querySelectorAll?.("[data-tree-select]") || [])];
  const at = rows.indexOf(e.target);
  if (at < 0) return;
  const k = keys[e.key];
  const next = k === "first" ? 0 : k === "last" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + k));
  e.preventDefault();
  rows[next]?.focus();
}

function BlockRows({ blocks, label }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 pl-2" data-tree-blocks="">
      <CollapsibleTrigger data-read-control="" className="flex items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        {`${blocks.length} block${blocks.length === 1 ? "" : "s"} in ${label}`}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 space-y-0.5 border-l border-border pl-2">
          {blocks.map((bl, i) => (
            <li key={bl?.id ?? i} data-block-row={bl?.id ?? ""} className="truncate text-xs text-foreground">
              {(typeof bl?.kind === "string" && bl.kind.replace(/_/g, " ")) || "Block"}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function SectionTree({ type, sections, selectedId = null, onChange, onSelect, issuesBySection = {}, collections = null, body = null, confirmingId = null, role = null }) {
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
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No sections yet. Add one to start.</p>
      ) : (
        <ol aria-label="Sections" className="space-y-0.5" onKeyDown={moveRowFocus}>
          {list.map((s, i) => {
            const id = s && typeof s.id === "string" ? s.id : null;
            const row = rowState(s, id ? issuesBySection?.[id] : []);
            const selected = id != null && id === selectedId;
            const can = id ? rowActions(list, id, type, { body }) : null;
            const name = row.title ? `${row.label}: ${row.title}` : row.label;
            const buttons = can
              ? [
                  { op: "moveUp", label: `Move ${row.label} up`, icon: <ArrowUp aria-hidden />, onClick: () => run("moveUp", id) },
                  { op: "moveDown", label: `Move ${row.label} down`, icon: <ArrowDown aria-hidden />, onClick: () => run("moveDown", id) },
                  row.hidden
                    ? { op: "show", label: `Show ${row.label}`, icon: <Eye aria-hidden />, onClick: () => run("show", id) }
                    : { op: "hide", label: `Hide ${row.label}`, icon: <EyeOff aria-hidden />, onClick: () => run("hide", id) },
                  { op: "duplicate", label: `Copy ${row.label}`, icon: <Copy aria-hidden />, onClick: () => run("duplicate", id) },
                  { op: "remove", label: `Delete ${row.label}`, icon: <Trash2 aria-hidden />, onClick: () => setConfirmId(id) },
                ].map((b) => ({ ...b, ...can[b.op], whyId: !can[b.op].ok && can[b.op].reason ? `${id}--why-${b.op}` : undefined }))
              : [];
            const why = buttons.filter((b) => b.whyId);
            const blocks = Array.isArray(s?.blocks) ? s.blocks : [];
            return (
              <li
                key={id ?? `at-${i}`}
                data-section-row={id ?? ""}
                data-selected={selected ? "" : undefined}
                data-unfinished={row.unfinished ? "" : undefined}
                className={cn("group relative rounded-md px-2 py-1.5 transition-colors motion-reduce:transition-none", selected ? "bg-muted" : "hover:bg-muted/60", row.hidden && "text-muted-foreground")}
              >
                {selected && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    disabled={!id}
                    onClick={() => id && onSelect?.(id)}
                    data-tree-select=""
                    data-read-control=""
                    className="flex min-w-0 flex-1 flex-col items-start rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className={cn("max-w-full truncate text-sm", row.hidden ? "text-muted-foreground" : "text-foreground", selected ? "font-semibold" : "font-medium")}>{row.label}</span>
                    {row.title && <span className="max-w-full truncate text-xs text-muted-foreground">{row.title}</span>}
                  </button>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.unfinished && (
                      <Badge variant="warning" title="Some of it still needs filling in. It shows as unfinished in your preview and can't be published yet.">
                        Unfinished
                      </Badge>
                    )}
                    {row.problem && (
                      <Badge variant="danger" title="Something here needs fixing before it can be published.">
                        Needs a fix
                      </Badge>
                    )}
                    {row.hidden && (
                      <Badge variant="muted" title="Shoppers don't see this section.">
                        Hidden
                      </Badge>
                    )}
                  </span>
                </div>
                {blocks.length > 0 && <BlockRows blocks={blocks} label={row.label} />}
                {can && confirmId !== id && (
                  <>
                    <div className={cn("mt-1 flex items-center gap-0.5", !selected && "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100")} role="group" aria-label={`Change ${name}`}>
                      {buttons.map((b) => (
                        <RoleGate key={b.op} role={role} action={WRITE} mode="hide">
                          <Button variant="ghost" size="icon-xs" aria-label={b.label} title={b.reason || b.label} disabled={!b.ok} aria-describedby={b.whyId} onClick={b.onClick} data-op={b.op}>
                            {b.icon}
                          </Button>
                        </RoleGate>
                      ))}
                    </div>
                    {why.length > 0 && (
                      <ul className="mt-1 space-y-0.5 px-1 text-xs text-muted-foreground" data-why="">
                        {why.map((b) => (
                          <li key={b.op} id={b.whyId} className={OBVIOUS.has(b.code) || !selected ? "sr-only" : undefined}>
                            {b.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {can && confirmId === id && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5" role="group" aria-label={`Delete ${name}?`}>
                    <p className="text-xs text-foreground">Delete this section?</p>
                    <RoleGate role={role} action={WRITE} mode="hide">
                      <Button size="xs" variant="destructive" onClick={() => run("remove", id)}>
                        Delete
                      </Button>
                    </RoleGate>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmId(null)}>
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
        role={role}
      />
    </div>
  );
}
