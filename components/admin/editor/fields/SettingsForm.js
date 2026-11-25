"use client";

// P3-INSPECTOR (ED-12, AU-02, ED-04): the registry-driven settings form. One
// form edits one section, or one document's own settings (and a page's
// details: address, title, dates). Props only, no store:
//
//   SettingsForm {
//     kind, sectionId      a section: value is its settings object
//     type                 a document: value is its body ({ meta, settings, … })
//     value
//     onChange(next, { path, value })
//                          next is the whole new settings object (section) or
//                          body (document); path is the field path that
//                          changed, in validate.js's words ("title",
//                          "primary", "meta.title", "items")
//     issues               the document's issues (validateDocument, the
//                          save and publish answers); the form takes the ones
//                          of this section (by sectionId) or of the document
//     focusRequest?        { path, offset? } (ED-04): focus that field
//     readOnlyReason?      nothing can be changed, and this says why
//     context?             { collections, products, pages, pickImage }: the
//                          pickers' catalog rows ([{ handle, id, title,
//                          available_count }]) and the media library opener
//   }
//
// Each field's element has the id fieldAnchor gives its path, and each issue
// is shown under the element whose id is fieldAnchor(issue, { known }) where
// known is every id this form renders (AU-02). An issue whose field the form
// has no control for (a section's kind, an unknown setting, the section
// list) is shown in a note of its own at the top, with that anchor as its id.
// Labels are shown exactly as the registry declares them.
import { useEffect } from "react";
import { CONTROLS, Notes } from "./controls.js";
import MenuControl from "./MenuControl.js";
import DesignForm, { BrandControl, ThemeControl } from "./DesignForm.js";
import { formOf, anchorsOf, issuesOf, placeIssues, notesAt, notesId, orphanAnchors, focusAnchor, applyFocus, setAt, getAt, pathsOf } from "./inspectorModel.js";
import { sectionType, fieldAnchor } from "../../../../lib/registry/index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Every control the forms use, by control name (inspectorModel
// CONTROL_NAMES). The inspector suite checks the two lists match.
export const CONTROL_COMPONENTS = Object.freeze({ ...CONTROLS, menu: MenuControl, brand: BrandControl, theme: ThemeControl });

const FORM_NOTES = {
  protected: "Shopify keeps this part's photos, price, options and buy button. You can move it on the page, but not change or hide it.",
  sections: "This page is made of its sections. Pick a section in the list or in the preview to change it.",
  system: "Your store makes this from what you publish. There is nothing to change here.",
};

// The rich text fields of a form: they take the focus request themselves.
const richIds = (fields, valueOf, owner) =>
  new Set(
    fields.flatMap((f) =>
      f.control === "rich_text"
        ? anchorsOf(f, valueOf(f), owner)
        : f.control === "qa_list"
          ? pathsOf(f, valueOf(f))
              .filter((p) => p.endsWith(".a"))
              .map((p) => fieldAnchor({ sectionId: owner, field: p }))
          : [],
    ),
  );

export default function SettingsForm(props) {
  if (props.type === "design") return <DesignForm {...props} />;
  return <Form {...props} />;
}

function Form({ value, onChange, issues = [], focusRequest = null, kind = null, type = null, sectionId = null, context = {}, readOnlyReason = null }) {
  const form = formOf(kind ? { kind, sectionId } : { type });
  const owner = form?.of === "section" ? sectionId : null;
  const rootId = fieldAnchor({ sectionId: owner, field: null });
  const body = form?.of === "document" && isObj(value) ? value : {};
  const settings = form?.of === "section" ? (isObj(value) ? value : {}) : isObj(body.settings) ? body.settings : {};
  const fields = form ? [...(form.meta || []), ...form.fields] : [];
  const valueOf = (f) => (f.path.startsWith("meta.") ? getAt(body, f.path) : settings[f.key]);
  const known = new Set([rootId, ...fields.flatMap((f) => anchorsOf(f, valueOf(f), owner))]);
  const placed = placeIssues(issuesOf(issues, owner), known);
  const orphans = orphanAnchors(placed, known);
  const rootNotes = notesAt(placed, rootId);
  const focusId = focusAnchor(focusRequest, { sectionId: owner, known });
  const rich = richIds(fields, valueOf, owner);
  const readOnly = !!readOnlyReason;

  useEffect(() => {
    if (!focusId || rich.has(focusId) || typeof document === "undefined") return;
    applyFocus(document, focusId, focusRequest?.offset ?? null);
  }, [focusRequest]);

  if (!form) {
    return (
      <section id={rootId} className="text-sm text-muted-foreground">
        This can't be edited here.
      </section>
    );
  }

  const set = (f, v) => {
    if (form.of === "section") onChange?.(setAt(settings, f.path, v), { path: f.path, value: v });
    else if (f.path.startsWith("meta.")) onChange?.(setAt(body, f.path, v), { path: f.path, value: v });
    else onChange?.(setAt(body, `settings.${f.path}`, v), { path: f.path, value: v });
  };
  const ctx = {
    ...context,
    ownerKey: form.of === "section" ? form.kind : form.type,
    minItems: form.of === "section" ? (sectionType(form.kind)?.minItems ?? 1) : null,
    menuMode: settings.mode,
    readOnlyReason,
    focus: focusId ? { id: focusId, request: focusRequest } : null,
  };
  const note = FORM_NOTES[form.form] || (form.form === "page" ? FORM_NOTES.sections : null);

  return (
    <section id={rootId} data-form={form.form} tabIndex={-1} aria-labelledby={`${rootId}--title`} aria-describedby={rootNotes.length ? notesId(rootId) : undefined} className="space-y-4">
      <div>
        <h2 id={`${rootId}--title`} className="text-sm font-semibold text-foreground">
          {form.label}
        </h2>
        {form.placeholder && <p className="mt-0.5 text-xs text-muted-foreground">{form.placeholder}</p>}
      </div>
      {readOnly && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{readOnlyReason}</p>}
      {form.waits && <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">{form.waits}</p>}
      <Notes anchor={rootId} notes={rootNotes} />
      {orphans.map((a) => (
        <div key={a} id={a} tabIndex={-1} aria-describedby={notesId(a)}>
          <Notes anchor={a} notes={notesAt(placed, a)} />
        </div>
      ))}
      {fields.map((f) => {
        const C = CONTROL_COMPONENTS[f.control];
        if (!C) return null;
        return <C key={f.path} field={f} value={valueOf(f) ?? null} onChange={(v) => set(f, v)} issues={placed} owner={owner} context={ctx} readOnly={readOnly} />;
      })}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
