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
//
// Phase 6 line 1 (the studio, docs/plans/phase-6.md features 3 to 6), only
// with `draggable` (the editor leaves it off and behaves as before):
//     draggable    each row gets a 24px handle, a button "Reorder <label>"
//                  (storefront.write only, ./dragModel.js canGrab), and
//                  "Add a section here" insert points sit between the rows
//     dragBlocked  words: the handles are there but disabled (a 409 until
//                  the founder chooses a version)
//     onPreview(sections, { id })  the order to draw in the frame at once
//                  while a section is held or dragged (id: the held one;
//                  null when it is let go without a move)
//     onAnnounce(text)  the live region's words (dragModel.SAY)
// Pointer: from the handle only (touch-action:none, setPointerCapture),
// after 4px; the row follows the pointer, a line shows the drop spot, the
// list's scroll parent scrolls near its edges, a refused spot reads "Can't
// drop here" with the registry's reason and the row snaps back; Escape
// cancels. Keyboard on the handle: Space or Enter picks up, arrows (Home,
// End) move the section, not focus, Space or Enter drops, Escape returns it.
// Focus stays on the handle all along.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Copy, Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RoleGate } from "@/components/kit/role-gate";
import AddSection from "./AddSection";
import { moveUp, moveDown, hide, show, duplicate, remove, rowActions, rowState } from "./treeModel";
import { DRAG_THRESHOLD_PX, NO_DROP, SAY, canGrab, edgeScroll, grab, holdKey, labelOf, pointerTarget } from "./dragModel";

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

// "Add a section here" between two rows (the studio only): it opens the
// section picker at that index
function InsertPoint({ index, onOpen, after = false }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      data-tree-insert={index}
      className={cn(
        "group/ins absolute inset-x-2 z-[1] flex h-3 items-center justify-center rounded-md text-xs text-muted-foreground opacity-0 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none",
        after ? "-bottom-2" : "-top-2",
      )}
    >
      <span className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 shadow-xs group-hover/ins:border-primary group-hover/ins:text-primary group-focus-visible/ins:border-primary group-focus-visible/ins:text-primary group-focus-visible/ins:ring-2 group-focus-visible/ins:ring-ring group-focus-visible/ins:ring-offset-1 group-focus-visible/ins:ring-offset-background">
        <Plus aria-hidden className="size-3" />
        Add a section here
      </span>
    </button>
  );
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

const scrollParent = (el) => el?.closest?.("[data-studio-panel]") || el?.ownerDocument?.scrollingElement || null;

export default function SectionTree({ type, sections, selectedId = null, onChange, onSelect, issuesBySection = {}, collections = null, body = null, confirmingId = null, role = null, draggable = false, dragBlocked = null, onPreview, onAnnounce }) {
  const [confirmId, setConfirmId] = useState(confirmingId);
  const [hold, setHold] = useState(null); // the keyboard hold (dragModel)
  const [holdOrder, setHoldOrder] = useState(null);
  const [drag, setDrag] = useState(null); // { id, from, to, ok, reason, dy } while a pointer drag is on
  const [insertAt, setInsertAt] = useState(null);
  const listRef = useRef(null);
  const handles = useRef({});
  const pointer = useRef(null); // { id, pointerId, startY, rows, scroller, scroll0, y, active, target }
  const base = Array.isArray(sections) ? sections : [];
  const list = holdOrder || base;
  const grabbing = draggable && canGrab(role);
  const blocked = grabbing && typeof dragBlocked === "string" && dragBlocked ? dragBlocked : null;
  const say = (text) => onAnnounce?.(text);

  // focus stays on the held handle while its row moves in the list, and
  // after the drop (the saved order re-renders the rows once more)
  const keep = useRef(null);
  useEffect(() => {
    const id = hold?.id || keep.current;
    if (!id) return;
    const el = handles.current[id];
    if (el && el.ownerDocument?.activeElement !== el) el.focus();
  });

  // ---- keyboard hold ----
  const applyStep = (step) => {
    keep.current = step.hold ? null : hold.id;
    if (!step.hold) {
      const was = hold.id;
      setTimeout(() => keep.current === was && (keep.current = null), 1500); // until the saved order has re-rendered
    }
    setHold(step.hold);
    setHoldOrder(step.hold ? step.sections : null);
    say(step.say);
    if (step.done && !blocked) {
      onChange?.(step.done, { op: "move", id: hold.id, selectedId });
    } else {
      onPreview?.(step.sections, { id: step.hold ? step.hold.id : null });
    }
  };
  const onHandleKey = (e, id) => {
    if (!grabbing || blocked) return;
    if (hold && hold.id === id) {
      const step = holdKey(hold, e.key);
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      applyStep(step);
      return;
    }
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    const g = grab(base, id, { role, type });
    if (!g) return;
    setHold(g.hold);
    setHoldOrder(g.sections);
    say(g.say);
    onPreview?.(g.sections, { id });
  };
  const onHandleBlur = (e) => {
    // tabbing away lets go (a row moving in the list blurs with no relatedTarget)
    if (e.relatedTarget) keep.current = null;
    if (hold && e.relatedTarget && e.relatedTarget !== handles.current[hold.id]) {
      const step = holdKey(hold, "Escape");
      setHold(null);
      setHoldOrder(null);
      say(step.say);
      onPreview?.(step.sections, { id: null });
    }
  };

  // a 409 (dragBlocked) ends any hold or drag: the saved order comes back,
  // nothing is sent, and focus goes to the row's select button (the handle
  // is disabled now)
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (!blocked) return;
    const id = hold?.id || pointer.current?.id || null;
    if (hold) {
      const step = holdKey(hold, "Escape");
      setHold(null);
      setHoldOrder(null);
      keep.current = null;
      say(step.say);
      onPreview?.(base, { id: null });
    } else if (pointer.current) endPointer(true);
    if (id) listRef.current?.querySelector?.(`[data-section-row="${id}"] [data-tree-select]`)?.focus?.();
  }, [blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- pointer drag ----
  const endPointer = (cancelled) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p) return;
    clearInterval(p.timer);
    try {
      p.el?.releasePointerCapture?.(p.pointerId);
    } catch {
      /* already released */
    }
    if (!p.active) return;
    setDrag(null);
    const t = p.target;
    const label = labelOf(base[p.from]);
    if (cancelled || !t || blockedRef.current) {
      say(SAY.cancelled(label, p.from + 1));
      onPreview?.(base, { id: null });
      return;
    }
    if (!t.ok) {
      say(SAY.refused(t.reason));
      onPreview?.(base, { id: null });
      return;
    }
    say(SAY.dropped(label, (t.to === p.from ? p.from : t.to) + 1, base.length));
    if (t.to !== p.from) onChange?.(t.sections, { op: "move", id: p.id, selectedId });
    else onPreview?.(base, { id: null });
  };
  const track = (clientY) => {
    const p = pointer.current;
    if (!p) return;
    p.y = clientY;
    const shift = (p.scroller?.scrollTop || 0) - p.scroll0;
    const t = pointerTarget(base, p.id, clientY + shift, p.rows, { type });
    const changed = !p.target || p.target.to !== t.to || p.target.ok !== t.ok;
    p.target = t;
    setDrag({ id: p.id, from: p.from, to: t.to, ok: t.ok, reason: t.reason, dy: clientY - p.startY + shift });
    if (changed) onPreview?.(t.ok ? t.sections : base, { id: p.id });
  };
  const onPointerDown = (e, id) => {
    if (!grabbing || blocked || hold || e.button !== 0) return;
    keep.current = null;
    const el = e.currentTarget;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* no capture: the drag still follows moves over the handle */
    }
    const rows = [...(listRef.current?.querySelectorAll?.(":scope > [data-section-row]") || [])].map((r) => {
      const b = r.getBoundingClientRect();
      return { top: b.top, height: b.height };
    });
    const scroller = scrollParent(listRef.current);
    pointer.current = { id, el, pointerId: e.pointerId, startY: e.clientY, y: e.clientY, rows, scroller, scroll0: scroller?.scrollTop || 0, from: base.findIndex((s) => s?.id === id), active: false, target: null, timer: null };
  };
  const onPointerMove = (e) => {
    const p = pointer.current;
    if (!p || e.pointerId !== p.pointerId) return;
    if (!p.active) {
      if (Math.abs(e.clientY - p.startY) < DRAG_THRESHOLD_PX) return;
      p.active = true;
      e.preventDefault();
      say(SAY.pickedUp(labelOf(base[p.from]), p.from + 1, base.length));
      // the rail scrolls by itself while the pointer rests near its edges
      p.timer = setInterval(() => {
        const q = pointer.current;
        if (!q?.scroller) return;
        const n = edgeScroll(q.y, q.scroller.getBoundingClientRect?.());
        if (n) {
          q.scroller.scrollTop += n;
          track(q.y);
        }
      }, 16);
    }
    track(e.clientY);
  };
  useEffect(() => {
    if (!drag) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      endPointer(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearInterval(pointer.current?.timer), []);

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
        <>
        {grabbing && insertAt === 0 && <AddSection type={type} sections={base} index={0} collections={collections} body={body} onChange={onChange} onSelect={onSelect} role={role} open onClose={() => setInsertAt(null)} where="Adds at the top" />}
        <ol ref={listRef} aria-label="Sections" className="space-y-0.5" onKeyDown={moveRowFocus} data-tree-dragging={drag ? "" : undefined}>
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
            const dragging = drag && drag.id === id;
            const held = hold && hold.id === id;
            // the drop line: before row i when moving up to i, after it when moving down to i
            const lineBefore = drag && drag.ok && drag.to !== drag.from && drag.to < drag.from && drag.to === i;
            const lineAfter = drag && drag.ok && drag.to !== drag.from && drag.to > drag.from && drag.to === i;
            return (
              <li
                key={id ?? `at-${i}`}
                data-section-row={id ?? ""}
                data-selected={selected ? "" : undefined}
                data-unfinished={row.unfinished ? "" : undefined}
                data-dragging={dragging ? "" : undefined}
                data-held={held ? "" : undefined}
                style={dragging ? { transform: `translateY(${drag.dy}px)`, zIndex: 10 } : undefined}
                className={cn(
                  "group relative rounded-md px-2 py-1.5 transition-colors motion-reduce:transition-none",
                  selected ? "bg-muted" : "hover:bg-muted/60",
                  row.hidden && "text-muted-foreground",
                  (dragging || held) && "bg-card shadow-md ring-2 ring-ring",
                  dragging && !drag.ok && "bg-muted opacity-80 ring-border",
                )}
              >
                {grabbing && i === 0 && insertAt !== 0 && !hold && !drag && <InsertPoint index={0} onOpen={setInsertAt} />}
                {lineBefore && <span aria-hidden className="absolute inset-x-1 -top-0.5 h-[3px] rounded-full bg-primary" data-drop-line="" />}
                {lineAfter && <span aria-hidden className="absolute inset-x-1 -bottom-0.5 h-[3px] rounded-full bg-primary" data-drop-line="" />}
                {selected && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
                <div className="flex items-center gap-1.5">
                  {grabbing && id && (
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) handles.current[id] = el;
                        else delete handles.current[id];
                      }}
                      aria-label={`Reorder ${row.label}`}
                      title={blocked || `Reorder ${row.label}`}
                      disabled={!!blocked}
                      aria-pressed={held ? true : undefined}
                      onKeyDown={(e) => onHandleKey(e, id)}
                      onBlur={onHandleBlur}
                      onPointerDown={(e) => onPointerDown(e, id)}
                      onPointerMove={onPointerMove}
                      onPointerUp={() => endPointer(false)}
                      onPointerCancel={() => endPointer(true)}
                      style={{ touchAction: "none" }}
                      data-tree-handle={id}
                      className={cn("flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md border border-border bg-background text-muted-foreground outline-none transition-colors hover:border-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none", (dragging || held) && "cursor-grabbing text-foreground")}
                    >
                      <GripVertical aria-hidden className="size-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    disabled={!id}
                    onClick={() => id && onSelect?.(id)}
                    data-tree-select=""
                    data-read-control=""
                    className="flex min-w-0 flex-1 flex-col items-start rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
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
                {dragging && !drag.ok && (
                  <p className="mt-1 px-1 text-xs text-muted-foreground" data-drop-refused="">
                    {NO_DROP}
                    {drag.reason ? `: ${drag.reason}` : ""}
                  </p>
                )}
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
                {grabbing && insertAt === i + 1 && (
                  <div className="mt-1">
                    <AddSection type={type} sections={base} index={i + 1} afterLabel={row.label.toLowerCase()} collections={collections} body={body} onChange={onChange} onSelect={onSelect} role={role} open onClose={() => setInsertAt(null)} />
                  </div>
                )}
                {grabbing && i < list.length - 1 && insertAt !== i + 1 && !hold && !drag && <InsertPoint index={i + 1} onOpen={setInsertAt} after />}
              </li>
            );
          })}
        </ol>
        </>
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
