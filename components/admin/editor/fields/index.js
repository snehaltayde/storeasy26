"use client";

// P4-PICKER (MED-03, OVL-04, ED-12): the editor controls the product and
// collection content forms need, and the library picker's glue.
//
//   GalleryControl, PairsControl, ProductListControl, ProductPicks
//                         the controls (their files say what each does)
//   ENTITY_CONTROLS       setting control name -> component, for the kinds
//                         the inspector's map (inspectorModel CONTROL_OF_KIND,
//                         P4-EDITOR's in batch 4) doesn't cover yet:
//                         gallery (an overlay of kind gallery), pairs and
//                         product_ids
//   entityControlOf(s)    which of those edits a declared setting, or null
//   entityFieldsOf(type)  the field descriptors of a document type's settings
//                         those controls edit ({ key, path, anchor, control,
//                         label, setting }, as inspectorModel.fieldsOf)
//   EntityFields          renders them for one document's settings, each
//                         issue shown under its own element (AU-02)
//   mediaPick(selection)  MediaPicker's { url, alt, id } -> { media, alt },
//                         media always "/api/media/<id>"; null for anything
//                         that isn't a library file
//   createLibraryPicker(onOpenChange)
//                         the editor's context.pickImage: pick() opens the
//                         MediaPicker and resolves with mediaPick(choice), or
//                         null when it is closed without a choice
import { documentType } from "../../../../lib/registry/index.js";
import { controlOf } from "../../../../lib/registry/settings.js";
import GalleryControl from "./GalleryControl.js";
import PairsControl from "./PairsControl.js";
import ProductListControl, { ProductPicks } from "./ProductListControl.js";
import { Notes } from "./controls.js";
import { idOf, notesAt, placeIssues, issuesOf, orphanAnchors, notesId } from "./inspectorModel.js";

export { GalleryControl, PairsControl, ProductListControl, ProductPicks };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const ENTITY_CONTROLS = Object.freeze({ gallery: GalleryControl, pairs: PairsControl, product_ids: ProductListControl });

export function entityControlOf(s) {
  if (!isObj(s)) return null;
  if (s.kind === "overlay" && s.of === "gallery") return "gallery";
  if (s.kind === "pairs") return "pairs";
  if (s.kind === "product_ids") return "product_ids";
  return null;
}

export function entityFieldsOf(type) {
  const t = documentType(type);
  if (!t) return [];
  return (t.settings || [])
    .filter((s) => entityControlOf(s))
    .map((s) => ({ key: s.key, path: s.key, anchor: idOf(null, s.key), control: entityControlOf(s), label: s.label, setting: controlOf(s) }));
}

// Every element id the controls render for these fields and values.
export function entityAnchors(fields, settings, owner = null) {
  const out = new Set();
  for (const f of fields) {
    const C = ENTITY_CONTROLS[f.control];
    for (const p of C.paths(f, isObj(settings) ? settings[f.key] : null)) out.add(idOf(owner, p));
  }
  return out;
}

// A library file's address, from what MediaPicker hands back.
const MEDIA_PATH = /^\/api\/media\/([A-Za-z0-9_-]{1,80})(?:[?#].*)?$/;
export function mediaPick(sel) {
  if (!isObj(sel)) return null;
  let id = typeof sel.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(sel.id) ? sel.id : null;
  if (!id && typeof sel.url === "string") {
    let path = sel.url;
    try {
      path = new URL(sel.url, "http://local").pathname;
    } catch {
      path = "";
    }
    id = MEDIA_PATH.exec(path)?.[1] ?? null;
  }
  if (!id) return null;
  return { media: `/api/media/${id}`, alt: typeof sel.alt === "string" ? sel.alt : "" };
}

export function createLibraryPicker(onOpenChange = () => {}) {
  let pending = null;
  const settle = (value) => {
    const p = pending;
    pending = null;
    onOpenChange(false);
    p?.resolve(value);
  };
  return {
    isOpen: () => pending != null,
    path: () => pending?.path ?? null,
    pick(opts = {}) {
      if (pending) settle(null);
      return new Promise((resolve) => {
        pending = { resolve, path: isObj(opts) && typeof opts.path === "string" ? opts.path : null };
        onOpenChange(true);
      });
    },
    select: (sel) => settle(mediaPick(sel)),
    close: () => settle(null),
  };
}

// The gallery, pairs and pinned products of one document's own settings.
// value is the document body; onEdit({ path, value }) as SettingsForm's.
export function EntityFields({ type, value, issues = [], context = {}, onEdit, readOnlyReason = null }) {
  const fields = entityFieldsOf(type);
  if (!fields.length) return null;
  const settings = isObj(value) && isObj(value.settings) ? value.settings : {};
  const known = entityAnchors(fields, settings, null);
  // only the issues of these fields: the rest are SettingsForm's
  const mine = issuesOf(issues, null).filter((i) => fields.some((f) => typeof i.field === "string" && (i.field === f.path || i.field.startsWith(`${f.path}.`))));
  const placed = placeIssues(mine, known);
  const orphans = orphanAnchors(placed, known);
  return (
    <div className="space-y-4" data-entity-fields="">
      {orphans.map((a) => (
        <div key={a} id={`${a}--more`} aria-describedby={notesId(a)}>
          <Notes anchor={a} notes={notesAt(placed, a)} />
        </div>
      ))}
      {fields.map((f) => {
        const C = ENTITY_CONTROLS[f.control];
        return <C key={f.path} field={f} value={settings[f.key] ?? null} onChange={(v) => onEdit?.({ path: f.path, value: v })} issues={placed} owner={null} context={context} readOnly={!!readOnlyReason} />;
      })}
    </div>
  );
}
