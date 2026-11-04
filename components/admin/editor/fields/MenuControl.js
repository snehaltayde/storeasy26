"use client";

// P3-INSPECTOR (ED-12): the menu control for the header and footer documents
// (their nav_items setting). Ported from components/admin/cms/NavigationEditor
// by behaviour, not by sharing code (the legacy file is untouched):
//   - Automatic or Custom menu (the document's `mode` setting, a separate
//     field; this control reads it from context.menuMode)
//   - up to 12 items, each with up to 8 sub-items, one level deep
//   - each row: its label, where it goes, move up, move down, remove (an item
//     goes with its sub-items); "Add an item" and "Add a sub-item" with the
//     count, disabled at the limit
// Changed on purpose, in inspectorModel `menu`: links are typed (a
// collection, a product, one of your pages or an address on the store), so
// a link to another site is reported where the legacy screen let it save;
// switching to Automatic keeps the items (with a note) where the legacy
// screen discarded them on save; a custom menu with no items says that
// shoppers see no menu.
//
// Props: { field, value (the items), onChange(items), issues (placed),
// owner, context: { ownerKey: "header" | "footer", menuMode, collections,
// products, pages }, readOnly }. Ids: inspectorModel pathsOf "menu".
import { ArrowDown, ArrowUp, CornerDownRight, Plus, Trash2 } from "lucide-react";
import { Input } from "../../../console/fields.js";
import { Button, IconButton } from "../../../console/Button.js";
import { LinkControl, Notes } from "./controls.js";
import { idOf, notesId, notesAt, blocks, menu, MENU_LIMITS, counterOf } from "./inspectorModel.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const described = (anchor, notes) => (notes.length ? notesId(anchor) : undefined);

function Row({ owner, path, name, item, index, total, onEdit, onMove, onRemove, issues, context, readOnly, child }) {
  const rid = idOf(owner, path);
  const lid = idOf(owner, `${path}.label`);
  const rnotes = notesAt(issues, rid);
  const lnotes = notesAt(issues, lid);
  const it = isObj(item) ? item : {};
  const label = typeof it.label === "string" ? it.label : "";
  return (
    <div id={rid} role="group" tabIndex={-1} aria-label={name} aria-describedby={described(rid, rnotes)} className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        {child && <CornerDownRight size={14} className="mt-7 shrink-0 text-fg-subtle" aria-hidden />}
        <div className="min-w-0 w-40 flex-1">
          <label htmlFor={lid} className="mb-1 block text-xs font-medium text-fg-muted">
            {`${name} label`}
          </label>
          <Input id={lid} value={label} placeholder="Label" disabled={readOnly} invalid={blocks(lnotes)} aria-describedby={described(lid, lnotes)} onChange={(e) => onEdit({ label: e.target.value })} />
          {label.length > 40 && <p className="mt-1 text-xs text-fg-subtle">{counterOf(label, { max: 40 })}</p>}
          <Notes anchor={lid} notes={lnotes} />
        </div>
        <div className="min-w-0 w-56 flex-[2]">
          <LinkControl owner={owner} path={`${path}.link`} label={`${name} link`} value={it.link ?? null} onChange={(l) => onEdit({ link: l })} issues={issues} context={context} readOnly={readOnly} />
        </div>
        <span className="mt-6 flex shrink-0 items-center">
          <IconButton label={`Move ${name.toLowerCase()} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={readOnly || index === 0} onClick={() => onMove(-1)} />
          <IconButton label={`Move ${name.toLowerCase()} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={readOnly || index === total - 1} onClick={() => onMove(1)} />
          <IconButton label={child ? `Remove ${name.toLowerCase()}` : `Remove ${name.toLowerCase()} and its sub-items`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={onRemove} />
        </span>
      </div>
      <Notes anchor={rid} notes={rnotes} />
    </div>
  );
}

export default function MenuControl({ field, value, onChange, issues, owner = null, context = {}, readOnly = false }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const items = Array.isArray(value) ? value : [];
  const view = menu.view({ mode: context.menuMode, items }, context.ownerKey);
  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 space-y-3 rounded-ctl border border-edge p-3">
      <p id={`${id}--label`} className="text-xs font-medium text-fg-muted">
        {field.label}
      </p>
      {view.auto && <div className="rounded-ctl bg-surface-sunken px-3.5 py-2.5 text-sm text-fg-muted">{view.autoText}</div>}
      {view.keptNote && <p className="text-xs text-warning">{view.keptNote}</p>}
      {view.emptyNote && <p className="text-xs text-warning">{view.emptyNote}</p>}
      <p className="text-xs text-fg-muted">{`${view.count} · ${view.childNote}`}</p>
      <ul className={`space-y-2 ${view.auto ? "opacity-60" : ""}`}>
        {items.map((item, i) => {
          const at = `${field.path}.${i}`;
          const kids = isObj(item) && Array.isArray(item.children) ? item.children : [];
          const cid = idOf(owner, `${at}.children`);
          const cnotes = notesAt(issues, cid);
          return (
            <li key={i} className="rounded-ctl border border-edge p-3">
              <Row
                owner={owner}
                path={at}
                name={`Item ${i + 1}`}
                item={item}
                index={i}
                total={items.length}
                issues={issues}
                context={context}
                readOnly={readOnly}
                onEdit={(patch) => onChange(menu.edit(items, [i], patch))}
                onMove={(d) => onChange(menu.move(items, [i], d))}
                onRemove={() => onChange(menu.remove(items, [i]))}
              />
              {kids.length > 0 && (
                <div id={cid} role="group" tabIndex={-1} aria-label={`Sub-items of item ${i + 1}`} aria-describedby={described(cid, cnotes)} className="mt-2 space-y-2 pl-6">
                  {kids.map((c, j) => (
                    <Row
                      key={j}
                      child
                      owner={owner}
                      path={`${at}.children.${j}`}
                      name={`Sub-item ${j + 1}`}
                      item={c}
                      index={j}
                      total={kids.length}
                      issues={issues}
                      context={context}
                      readOnly={readOnly}
                      onEdit={(patch) => onChange(menu.edit(items, [i, j], patch))}
                      onMove={(d) => onChange(menu.move(items, [i, j], d))}
                      onRemove={() => onChange(menu.remove(items, [i, j]))}
                    />
                  ))}
                  <Notes anchor={cid} notes={cnotes} />
                </div>
              )}
              <div className="mt-2 pl-6">
                <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} disabled={readOnly || kids.length >= MENU_LIMITS.children} onClick={() => onChange(menu.addChild(items, i))}>
                  {`Add a sub-item (${kids.length}/${MENU_LIMITS.children})`}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={readOnly || !view.canAdd} onClick={() => onChange(menu.add(items))}>
        {`Add an item (${items.length}/${MENU_LIMITS.items})`}
      </Button>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}
