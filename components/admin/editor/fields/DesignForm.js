"use client";

// P3-INSPECTOR (TOK-03, AU-02): the form for the design document (doc_design:
// settings { brand, theme }). Props only, no store:
//   DesignForm { value (the doc_design body), onChange(nextBody, { path,
//   value }), issues, focusRequest?, readOnlyReason?, context? }
// It is SettingsForm for type "design" (SettingsForm hands that type here)
// with the design document's own words: the store's brand tokens in the
// words of today's brand screen (BrandAdmin), the look (theme kit) from
// lib/brand.js KIT_SURFACES, a note while the store uses the platform
// default, and "Go back to your starting colours (<palette>)".
//
// P6-NAV (GEN-04, GEN-01; owner answer OQ-P6-8): Reset goes back to the
// store's starting palette, never the platform's lime default. The editor page
// works it out (startingPaletteId of the tenant's config.onboarding: the brand
// step's palette, else slate) and hands it down as context.startingBrand
// (DocumentEditor's inspector context). With no startingBrand in the context
// (a test or an older caller) it is the default palette's (slate) brand. The
// button shows whenever the stored brand is not exactly the starting one (a
// null brand included), and a first colour edit on a store with no brand
// starts from the starting palette too (design.setToken's start). The colour
// placeholder and hint show the starting accent, and "Change your logo and
// colours" links to the brand step (/admin/start).
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
import { paletteById, paletteIdOfBrand, DEFAULT_PALETTE_ID } from "../../../../lib/themes/palettes.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const described = (anchor, notes) => (notes.length ? notesId(anchor) : undefined);

// The brand step's address (P6-START-UI's page).
export const START_HREF = "/admin/start";

// The store's starting brand and its palette's name, from the inspector
// context. Never null, never the platform default.
export function startingOf(context) {
  const given = isObj(context) && isObj(context.startingBrand) ? context.startingBrand : null;
  const brand = given || paletteById(DEFAULT_PALETTE_ID).brand;
  const p = paletteById(paletteIdOfBrand(brand));
  return { brand, label: p ? p.label : null };
}

// The same brand, key for key (order does not matter).
export function sameBrand(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

export function BrandControl({ field, value, onChange, issues, owner = null, readOnly, context = null }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const { usingDefault, values } = design.brandView(value);
  const start = startingOf(context);
  const startAccent = String(start.brand.accent);
  const atStart = sameBrand(value, start.brand);
  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 space-y-3 rounded-ctl border border-edge p-3">
      <p id={`${id}--label`} className="text-xs font-medium text-fg-muted">
        {field.label}
      </p>
      {usingDefault && <p className="text-xs text-fg-muted">Your store uses the platform's default colours. Go back to your starting colours, or change anything below.</p>}
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
                  onChange={(e) => onChange(design.setToken(value, b.key, e.target.value, start.brand))}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-ctl border border-edge bg-surface focus-ring"
                />
                <Input id={bid} mono className="w-28" value={v} disabled={readOnly} invalid={blocks(bnotes) || !design.colourOk(v)} aria-describedby={described(bid, bnotes)} placeholder={startAccent} onChange={(e) => onChange(design.setToken(value, b.key, e.target.value.trim(), start.brand))} />
              </div>
              {b.help && <p className="mt-1 text-xs text-fg-subtle">{b.help}</p>}
              {!design.colourOk(v) && <p className="mt-1 text-xs text-warning">A colour is # and six letters or digits, like {startAccent}.</p>}
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
              <Select id={bid} value={b.options.includes(v) ? v : ""} disabled={readOnly} invalid={blocks(bnotes)} aria-describedby={described(bid, bnotes)} onChange={(e) => onChange(design.setToken(value, b.key, e.target.value, start.brand))}>
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
      {!atStart && (
        <Button size="sm" variant="ghost" disabled={readOnly} data-design-reset="" onClick={() => onChange(design.reset(start.brand))}>
          {start.label ? `Go back to your starting colours (${start.label})` : "Go back to your starting colours"}
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

export default function DesignForm({ value, onChange, issues = [], focusRequest = null, readOnlyReason = null, context = null }) {
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
      <p className="text-xs">
        <a href={START_HREF} data-design-start="" className="font-medium text-fg underline underline-offset-2 focus-ring">
          Change your logo and colours
        </a>
      </p>
      {readOnly && <p className="rounded-ctl bg-surface-sunken px-3 py-2 text-xs text-fg-muted">{readOnlyReason}</p>}
      <Notes anchor={rootId} notes={rootNotes} />
      {orphans.map((a) => (
        <div key={a} id={a} tabIndex={-1} aria-describedby={notesId(a)}>
          <Notes anchor={a} notes={notesAt(placed, a)} />
        </div>
      ))}
      {fields.map((f) => {
        const C = DESIGN_CONTROLS[f.control];
        return C ? <C key={f.key} field={f} value={settings[f.key] ?? null} onChange={(v) => set(f.key, v)} issues={placed} owner={null} readOnly={readOnly} context={context} /> : null;
      })}
    </section>
  );
}
