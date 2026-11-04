"use client";

// P3-INSPECTOR (TOK-03, AU-02): the form for the design document (doc_design:
// settings { brand, theme }). Props only, no store:
//   DesignForm { value (the doc_design body), onChange(nextBody, { path,
//   value }), issues, focusRequest?, readOnlyReason? }
// It is SettingsForm for type "design" (SettingsForm hands that type here)
// with the design document's own words: the store's brand tokens in the
// words of today's brand screen (BrandAdmin), the look (theme kit) from
// lib/brand.js KIT_SURFACES, a note while the store uses the platform
// default, and "Go back to the platform's default brand".
//
// BrandControl and ThemeControl are the controls of the "brand" and "theme"
// setting kinds (inspectorModel CONTROL_OF_KIND). Edits go through
// inspectorModel `design`: the button text colour on the accent
// (accent_label) is worked out again on every brand change, so it never goes
// stale. Readability (TOK-02) is checked at publish: its notes arrive as
// issues on the brand field and show under the brand group. Choosing a look
// here changes only the look; applying a kit with its starter brand and
// words stays with "Apply" on the theme screen (P3-DESIGN).
import { useEffect } from "react";
import { Input, Select } from "../../../console/fields.js";
import { Button } from "../../../console/Button.js";
import { Notes } from "./controls.js";
import {
  idOf,
  notesId,
  notesAt,
  blocks,
  design,
  BRAND_FIELDS,
  stepWords,
  lookChoices,
  lookIdOf,
  fieldsOf,
  anchorsOf,
  issuesOf,
  placeIssues,
  orphanAnchors,
  focusAnchor,
  applyFocus,
  setAt,
} from "./inspectorModel.js";
import { documentType, fieldAnchor } from "../../../../lib/registry/index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const described = (anchor, notes) => (notes.length ? notesId(anchor) : undefined);

export function BrandControl({ field, value, onChange, issues, owner = null, readOnly }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const { usingDefault, values } = design.brandView(value);
  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 space-y-3 rounded-ctl border border-edge p-3">
      <p id={`${id}--label`} className="text-xs font-medium text-fg-muted">
        {field.label}
      </p>
      {usingDefault && <p className="text-xs text-fg-muted">Your store uses the platform's default brand. Change anything below to start your own.</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {BRAND_FIELDS.filter((b) => b.kind === "colour").map((b) => {
          const bid = idOf(owner, `${field.path}.${b.key}`);
          const bnotes = notesAt(issues, bid);
          const v = String(values[b.key] ?? "");
          return (
            <div key={b.key} className="min-w-0">
              <label htmlFor={bid} className="mb-1 block text-xs font-medium text-fg-muted">
                {b.label}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${b.label} picker`}
                  value={design.colourOk(v) ? v.toLowerCase() : "#000000"}
                  disabled={readOnly}
                  onChange={(e) => onChange(design.setToken(value, b.key, e.target.value))}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-ctl border border-edge bg-surface focus-ring"
                />
                <Input id={bid} mono className="w-28" value={v} disabled={readOnly} invalid={blocks(bnotes) || !design.colourOk(v)} aria-describedby={described(bid, bnotes)} placeholder="#84cc16" onChange={(e) => onChange(design.setToken(value, b.key, e.target.value.trim()))} />
              </div>
              {b.help && <p className="mt-1 text-xs text-fg-subtle">{b.help}</p>}
              {!design.colourOk(v) && <p className="mt-1 text-xs text-warning">A colour is # and six letters or digits, like #84cc16.</p>}
              <Notes anchor={bid} notes={bnotes} />
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {BRAND_FIELDS.filter((b) => b.kind === "step").map((b) => {
          const bid = idOf(owner, `${field.path}.${b.key}`);
          const bnotes = notesAt(issues, bid);
          const v = values[b.key];
          return (
            <div key={b.key} className="min-w-0">
              <label htmlFor={bid} className="mb-1 block text-xs font-medium text-fg-muted">
                {b.label}
              </label>
              <Select id={bid} value={b.options.includes(v) ? v : ""} disabled={readOnly} invalid={blocks(bnotes)} aria-describedby={described(bid, bnotes)} onChange={(e) => onChange(design.setToken(value, b.key, e.target.value))}>
                {!b.options.includes(v) && <option value="">Not one of the choices: choose one</option>}
                {b.options.map((o) => (
                  <option key={o} value={o}>
                    {stepWords(o)}
                  </option>
                ))}
              </Select>
              <Notes anchor={bid} notes={bnotes} />
            </div>
          );
        })}
      </div>
      {!usingDefault && (
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => onChange(design.reset())}>
          Go back to the platform's default brand
        </Button>
      )}
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

export function ThemeControl({ field, value, onChange, issues, owner = null, readOnly }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const looks = lookChoices();
  const current = value == null ? "" : lookIdOf(value);
  const known = looks.some((l) => l.id === current);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">
        {field.label}
      </label>
      <Select id={id} value={known ? current : ""} disabled={readOnly} invalid={blocks(notes)} aria-describedby={described(id, notes)} onChange={(e) => onChange(design.setLook(value, e.target.value))}>
        {!known && <option value="">{value == null ? "The platform's default look" : "A look we don't know: choose one"}</option>}
        {looks.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </Select>
      <p className="mt-1 text-xs text-fg-subtle">The look sets your header and hero colours. To also take a look's starter brand and words, apply it from the theme screen.</p>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

const DESIGN_CONTROLS = { brand: BrandControl, theme: ThemeControl };

export default function DesignForm({ value, onChange, issues = [], focusRequest = null, readOnlyReason = null }) {
  const t = documentType("design");
  const body = isObj(value) ? value : { type: "design", settings: {} };
  const settings = isObj(body.settings) ? body.settings : {};
  const fields = fieldsOf(t.settings, null);
  const rootId = fieldAnchor({ sectionId: null, field: null });
  const known = new Set([rootId, ...fields.flatMap((f) => anchorsOf(f, settings[f.key], null))]);
  const placed = placeIssues(issuesOf(issues, null), known);
  const orphans = orphanAnchors(placed, known);
  const rootNotes = notesAt(placed, rootId);
  const focusId = focusAnchor(focusRequest, { sectionId: null, known });
  const readOnly = !!readOnlyReason;

  useEffect(() => {
    if (focusId && typeof document !== "undefined") applyFocus(document, focusId, focusRequest?.offset ?? null);
  }, [focusRequest]);

  const set = (key, v) => onChange?.(setAt(body, `settings.${key}`, v), { path: key, value: v });
  return (
    <section id={rootId} data-form="design" tabIndex={-1} aria-labelledby={`${rootId}--title`} aria-describedby={described(rootId, rootNotes)} className="space-y-4">
      <h2 id={`${rootId}--title`} className="text-sm font-semibold text-fg">
        {t.label}
      </h2>
      <p className="text-xs text-fg-muted">Your colours, corners, text size and look, for every page. Shoppers see a change after you publish it.</p>
      {readOnly && <p className="rounded-ctl bg-surface-sunken px-3 py-2 text-xs text-fg-muted">{readOnlyReason}</p>}
      <Notes anchor={rootId} notes={rootNotes} />
      {orphans.map((a) => (
        <div key={a} id={a} tabIndex={-1} aria-describedby={notesId(a)}>
          <Notes anchor={a} notes={notesAt(placed, a)} />
        </div>
      ))}
      {fields.map((f) => {
        const C = DESIGN_CONTROLS[f.control];
        return C ? <C key={f.key} field={f} value={settings[f.key] ?? null} onChange={(v) => set(f.key, v)} issues={placed} owner={null} readOnly={readOnly} /> : null;
      })}
    </section>
  );
}
