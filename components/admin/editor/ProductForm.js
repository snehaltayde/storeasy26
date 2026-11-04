"use client";

// P4-EDITOR (OVL-04, OVL-01, OVL-06, ED-12): one product's content.
//
//   <ProductForm body entity access readOnly issues context focusRequest on />
//     body      the draft (product_content: { settings, sections })
//     entity    what Shopify sends now and how this product may be edited
//               (openEntityContent's answer, or lib/admin/entity-entry.js
//               readEntityContent for a read-only person): inShopify,
//               shopify { title, handle, description_html, vendor,
//               product_type, gallery }, titleEditable, titleBlockedReason,
//               shopifyAdminUrl, commerce { price, variants, stock }
//     access    { canPublish, reason } (getDocument's)
//     readOnly  plain words when this person can look but not change
//     on        edit({ path, value })          a document setting
//               sectionEdit({ sectionId, path, value })  a module's setting
//               treeChange(sections, meta)     a module added, moved, removed
//               resolve(field, choice)         "Keep mine" ('keep') or
//                                              "Use Shopify's" ('shopify')
//               discard()                      "Discard edits" (an orphan)
//
// What it shows (the rules are editorModel.productFormModel, pure):
//   - the name shoppers see, with "Shopify title: X" always under it (OVL-06)
//   - the overlay fields (name, description, images, brand, product type):
//     each with Shopify's value beside it, "Differs from Shopify" or "Same as
//     Shopify", and "Reset to Shopify" (the field follows Shopify again).
//     When the title gate is closed, the name, brand and type are disabled
//     with the reason; Reset on them stays available.
//   - a notice per EDITED field Shopify changed since: "Keep mine" or "Use
//     Shopify's" ("Shopify's images changed" for the images)
//   - price, variants and stock read-only, with "Change in Shopify"
//   - badge, layout, keep variant images, "Goes well with" (PairsControl)
//   - the modules: rich text, text and FAQ can be added (offeredKinds); an
//     older image-with-text module stays editable
//   - a product that left Shopify: "No longer in Shopify", the values Shopify
//     had when it was edited, Reset and the notice off, and "Discard edits"
//     for an owner or admin (staff see why not)
// Nothing here is shown to shoppers: this is console-only markup.
import { ArrowDown, ArrowUp, ExternalLink, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/console/Button";
import { Input, Select } from "@/components/console/fields";
import { Notes, TextControl, ToggleControl } from "./fields/controls.js";
import RichTextField from "./fields/RichTextField.js";
import GalleryControl from "./fields/GalleryControl.js";
import PairsControl from "./fields/PairsControl.js";
import SettingsForm from "./fields/SettingsForm.js";
import { fieldsOf, idOf, issuesOf, notesAt, placeIssues, orphanAnchors, notesId, choiceWords } from "./fields/inspectorModel.js";
import { add as addSection, moveUp, moveDown, remove as removeSection } from "./tree/treeModel.js";
import { PRODUCT_WORDS, editOverlay, productFormModel } from "./editorModel.js";
import { documentType, sectionType } from "@/lib/registry/index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TYPE = "product_content";

// The registry's declared settings of product content, as field descriptors.
export const productFields = () => fieldsOf(documentType(TYPE)?.settings || [], null);
const fieldOf = (key) => productFields().find((f) => f.key === key);

// Which control edits each declared setting of this form (the parity list,
// parity.js, checks every founder setting resolves to one of these).
export const PRODUCT_CONTROLS = Object.freeze({
  title: "overlay_text",
  description_html: "overlay_rich_text",
  gallery: "gallery",
  display_vendor: "overlay_text",
  display_type: "overlay_text",
  badge: "text",
  template: "layout",
  pairs: "pairs",
  keep_variant_images: "toggle",
  sections: "modules",
});

const money = (v, cur) => {
  if (v == null) return "—";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(v));
  } catch {
    return `${v} ${cur || ""}`.trim();
  }
};

function Pill({ differs }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${differs ? "bg-warning-bg text-fg" : "bg-surface-sunken text-fg-muted"}`}
      data-differs={differs ? "" : undefined}
      data-same={differs ? undefined : ""}
    >
      {differs ? PRODUCT_WORDS.differs : PRODUCT_WORDS.same}
    </span>
  );
}

function FieldHead({ f, label, onReset }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <Pill differs={f.differs} />
      <Button
        size="sm"
        variant="ghost"
        icon={<RotateCcw size={12} aria-hidden />}
        disabled={f.resetDisabled}
        title={f.resetReason || undefined}
        aria-label={`${PRODUCT_WORDS.reset}: ${f.label}`}
        onClick={onReset}
        data-reset={f.key}
      >
        {PRODUCT_WORDS.reset}
      </Button>
    </div>
  );
}

// The layout choice: the store's layout (null) or one of the declared ones.
export function LayoutSelect({ id, ownerKey, setting, value, onChange, readOnly, notes = [] }) {
  const options = setting?.options || [];
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">
        {setting?.label || "Layout"}
      </label>
      <Select id={id} value={options.includes(value) ? value : ""} disabled={readOnly} aria-describedby={notes.length ? notesId(id) : undefined} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Your store&rsquo;s layout for every page like this</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {choiceWords(ownerKey, "template", o)}
          </option>
        ))}
      </Select>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

function Commerce({ commerce, adminUrl }) {
  const c = isObj(commerce) ? commerce : null;
  return (
    <section aria-label="Price, variants and stock" className="space-y-2 rounded-ctl bg-surface-sunken px-3.5 py-3 text-xs text-fg-muted" data-shopify-owned="">
      <p className="text-fg">{PRODUCT_WORDS.shopifyOwns}</p>
      {c && (
        <>
          <p>
            {`${PRODUCT_WORDS.price}: ${money(c.priceMin, c.currency)}${c.priceMax != null && c.priceMax !== c.priceMin ? ` to ${money(c.priceMax, c.currency)}` : ""}`}
            {" · "}
            {`${PRODUCT_WORDS.stock}: ${c.available ? PRODUCT_WORDS.inStock : PRODUCT_WORDS.soldOut}${c.totalInventory != null ? ` (${c.totalInventory})` : ""}`}
          </p>
          {Array.isArray(c.variants) && c.variants.length > 0 && (
            <table className="w-full text-left" data-variants="">
              <caption className="sr-only">{PRODUCT_WORDS.variants}</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-0.5 font-medium">{PRODUCT_WORDS.variants}</th>
                  <th scope="col" className="py-0.5 font-medium">{PRODUCT_WORDS.price}</th>
                  <th scope="col" className="py-0.5 font-medium">{PRODUCT_WORDS.stock}</th>
                </tr>
              </thead>
              <tbody>
                {c.variants.map((v, i) => (
                  <tr key={i}>
                    <td className="py-0.5">{v.title || "Default"}</td>
                    <td className="py-0.5">{money(v.price, v.currency || c.currency)}</td>
                    <td className="py-0.5">{v.available ? PRODUCT_WORDS.inStock : PRODUCT_WORDS.soldOut}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {adminUrl ? (
        <a href={adminUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-fg underline-offset-2 hover:underline focus-ring" data-change-in-shopify="">
          {PRODUCT_WORDS.changeInShopify} <ExternalLink size={12} aria-hidden />
        </a>
      ) : (
        <p>{PRODUCT_WORDS.noAdminLink}</p>
      )}
    </section>
  );
}

function Modules({ sections, issues, context, readOnly, focusRequest, selection, on }) {
  const list = Array.isArray(sections) ? sections.filter(isObj) : [];
  const options = productFormModel({}).modules;
  const change = (r, meta) => r?.ok && on.treeChange?.(r.sections, meta);
  return (
    <section aria-label={PRODUCT_WORDS.modulesTitle} className="space-y-3" data-product-modules="">
      <p className="text-xs font-medium text-fg-muted">{PRODUCT_WORDS.modulesTitle}</p>
      {list.length === 0 && <p className="text-xs text-fg-subtle">{PRODUCT_WORDS.noModules}</p>}
      {list.map((s, j) => {
        const d = sectionType(s.kind);
        const name = `${d?.label || "module"} ${j + 1}`;
        return (
          <div key={s.id} className="rounded-ctl border border-edge p-3" data-product-module={s.id}>
            <div className="mb-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">{`${j + 1}. ${d?.label || s.kind}`}</span>
              <IconButton label={`Move ${name} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={readOnly || j === 0} onClick={() => change(moveUp(list, s.id, { type: TYPE }), { op: "moveUp", id: s.id })} />
              <IconButton label={`Move ${name} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={readOnly || j === list.length - 1} onClick={() => change(moveDown(list, s.id, { type: TYPE }), { op: "moveDown", id: s.id })} />
              <IconButton label={`Remove ${name}`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={() => change(removeSection(list, s.id, { type: TYPE }), { op: "remove", id: s.id })} />
            </div>
            <SettingsForm
              kind={s.kind}
              sectionId={s.id}
              value={s.settings}
              issues={issues}
              focusRequest={selection === s.id ? focusRequest : null}
              context={context}
              readOnlyReason={readOnly || null}
              onChange={(_n, m) => on.sectionEdit?.({ sectionId: s.id, path: m.path, value: m.value })}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={PRODUCT_WORDS.addModule}>
        <span className="text-xs text-fg-muted">{PRODUCT_WORDS.addModule}:</span>
        {options.map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant="secondary"
            icon={<Plus size={12} aria-hidden />}
            disabled={readOnly}
            data-add-module={kind}
            onClick={() => {
              const r = addSection(list, kind, list.length, { type: TYPE });
              change(r, { op: "add", id: r.id, selectedId: r.id });
            }}
          >
            {sectionType(kind)?.label || kind}
          </Button>
        ))}
      </div>
    </section>
  );
}

export default function ProductForm({ body, entity = null, access = null, readOnly = null, issues = [], context = {}, focusRequest = null, selection = null, busy = false, on = {} }) {
  const m = productFormModel({ body, entity, access, readOnly });
  const settings = isObj(body) && isObj(body.settings) ? body.settings : {};
  const shopify = isObj(entity?.shopify) ? entity.shopify : null;
  const ent = { shopify, inShopify: m.inShopify };
  const docIssues = issuesOf(issues, null);
  // every element this form renders for the document's own settings, so each
  // issue is shown under its own field (AU-02)
  const known = new Set();
  for (const k of ["title", "description_html", "display_vendor", "display_type", "badge", "template", "keep_variant_images"]) {
    known.add(idOf(null, k));
    known.add(idOf(null, `${k}.value`));
  }
  for (const p of GalleryControl.paths(fieldOf("gallery"), settings.gallery ?? null)) known.add(idOf(null, p));
  for (const p of PairsControl.paths(fieldOf("pairs"), settings.pairs ?? null)) known.add(idOf(null, p));
  const placed = placeIssues(docIssues, known);
  const notesFor = (k) => [...notesAt(placed, idOf(null, k)), ...notesAt(placed, idOf(null, `${k}.value`))];
  const set = (path, value) => on.edit?.({ path, value });
  const setOverlay = (key, next) => set(key, editOverlay(key, settings[key], next, ent));
  const field = (key) => m.fields.find((f) => f.key === key);
  const decl = (key) => fieldOf(key);
  const ctx = { ...context, shopify: shopify ? { ...shopify, gallery: Array.isArray(shopify.gallery) ? shopify.gallery : [] } : null, shopifyMissing: !m.inShopify, ownerKey: "product_layout", readOnlyReason: readOnly || null };
  const leftover = orphanAnchors(placed, known);

  const textField = (key, regLabel) => {
    const f = field(key);
    const id = idOf(null, key);
    const notes = notesFor(key);
    return (
      <div className="min-w-0" data-overlay={key} key={key}>
        <FieldHead f={f} label={regLabel} onReset={() => set(key, null)} />
        <label htmlFor={id} className="sr-only">
          {regLabel}
        </label>
        <Input id={id} value={f.value ?? ""} disabled={f.disabled || busy} aria-describedby={[f.disabledReason ? `${id}--why` : null, notes.length ? notesId(id) : null].filter(Boolean).join(" ") || undefined} onChange={(e) => setOverlay(key, e.target.value)} />
        {f.shopifyLine && <p className="mt-1 text-xs text-fg-muted" data-shopify-value={key}>{f.shopifyLine}</p>}
        {f.disabledReason && !readOnly && (
          <p id={`${id}--why`} className="mt-1 text-xs text-fg-muted" data-gated={key}>
            {f.disabledReason}
          </p>
        )}
        <Notes anchor={id} notes={notes} />
      </div>
    );
  };

  const desc = field("description_html");
  const gal = field("gallery");
  const descId = idOf(null, "description_html");
  const descMax = decl("description_html")?.setting?.max ?? null;
  const descLen = typeof desc.value === "string" ? desc.value.length : 0;

  return (
    <div className="space-y-5" data-product-form="" data-orphan={m.orphan ? "" : undefined}>
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-fg" data-product-heading="">
          {m.heading || "Untitled product"}
        </h3>
        <p className="text-xs text-fg-muted" data-shopify-title="">
          {m.shopifyTitleLine}
        </p>
        {m.readOnly && <p className="rounded-ctl bg-surface-sunken px-3 py-2 text-xs text-fg-muted" data-read-only="">{m.readOnly}</p>}
        {m.gateClosed && !m.readOnly && (
          <p className="rounded-ctl border border-warning-edge bg-warning-bg px-3 py-2 text-xs text-fg" data-title-gate="">
            {m.gateReason}
          </p>
        )}
      </header>

      {m.orphan && (
        <section aria-label={PRODUCT_WORDS.orphan} className="space-y-2 rounded-ctl border border-warning-edge bg-warning-bg px-3 py-3 text-xs text-fg" data-orphan-notice="">
          <p className="font-semibold">{PRODUCT_WORDS.orphan}</p>
          <p>{PRODUCT_WORDS.orphanWords}</p>
          {m.discard?.offered ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => on.discard?.()} data-discard="">
              {PRODUCT_WORDS.discard}
            </Button>
          ) : (
            <p data-discard-reason="">{m.discard?.reason}</p>
          )}
        </section>
      )}

      {m.notices.map((n) => (
        <section key={n.field} aria-label={n.title} className="space-y-2 rounded-ctl border border-warning-edge bg-warning-bg px-3 py-3 text-xs text-fg" data-shopify-changed={n.field}>
          <p className="font-semibold">{n.title}</p>
          <p>{n.words}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || Boolean(readOnly)} onClick={() => on.resolve?.(n.field, "keep")} aria-label={`${n.keep}: ${field(n.field).label}`} data-keep-mine={n.field}>
              {n.keep}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy || Boolean(readOnly)} onClick={() => on.resolve?.(n.field, "shopify")} aria-label={`${n.useShopify}: ${field(n.field).label}`} data-use-shopify={n.field}>
              {n.useShopify}
            </Button>
          </div>
        </section>
      ))}

      {leftover.map((a) => (
        <div key={a} id={a} tabIndex={-1} aria-describedby={notesId(a)}>
          <Notes anchor={a} notes={notesAt(placed, a)} />
        </div>
      ))}

      <section aria-label="What shoppers see" className="space-y-4" data-overlays="">
        {textField("title", decl("title")?.label || "Name")}
        <div className="min-w-0" data-overlay="description_html">
          <FieldHead f={desc} label={decl("description_html")?.label || "Description"} onReset={() => set("description_html", null)} />
          <RichTextField
            id={descId}
            label={decl("description_html")?.label || "Description"}
            value={typeof desc.value === "string" ? desc.value : ""}
            issues={notesFor("description_html")}
            readOnlyReason={readOnly || null}
            onChange={(html) => setOverlay("description_html", html)}
          />
          {!desc.following && descMax != null && <p className="mt-1 text-xs text-fg-subtle">{PRODUCT_WORDS.descriptionCount(descLen, descMax)}</p>}
          {desc.following && m.inShopify && <p className="mt-1 text-xs text-fg-muted">{"This is Shopify's description. Change it here to use your own."}</p>}
          {m.caps.description_html && (
            <p className="mt-1 text-xs text-danger" data-cap="description_html">
              {m.caps.description_html}
            </p>
          )}
        </div>
        <div className="min-w-0" data-overlay="gallery">
          <FieldHead f={gal} label={decl("gallery")?.label || "Images"} onReset={() => set("gallery", null)} />
          {m.galleryNote && (
            <p className="mb-2 rounded-ctl bg-surface-sunken px-3 py-2 text-xs text-fg" data-gallery-note="">
              {m.galleryNote}
            </p>
          )}
          <GalleryControl
            field={decl("gallery")}
            value={settings.gallery ?? null}
            onChange={(v) => set("gallery", v == null ? null : editOverlay("gallery", settings.gallery, v.value, ent))}
            issues={placed}
            owner={null}
            context={ctx}
            readOnly={Boolean(readOnly)}
          />
          {m.caps.gallery && (
            <p className="mt-1 text-xs text-danger" data-cap="gallery">
              {m.caps.gallery}
            </p>
          )}
        </div>
        {textField("display_vendor", decl("display_vendor")?.label || "Brand shown")}
        {textField("display_type", decl("display_type")?.label || "Product type shown")}
      </section>

      <Commerce commerce={m.commerce} adminUrl={m.adminUrl} />

      <section aria-label="More for this product" className="space-y-4" data-product-more="">
        <TextControl field={decl("badge")} value={settings.badge ?? ""} onChange={(v) => set("badge", v === "" ? null : v)} issues={placed} owner={null} readOnly={Boolean(readOnly)} />
        <LayoutSelect id={idOf(null, "template")} ownerKey="product_layout" setting={decl("template")?.setting} value={settings.template ?? null} onChange={(v) => set("template", v)} readOnly={Boolean(readOnly)} notes={notesFor("template")} />
        <ToggleControl field={decl("keep_variant_images")} value={settings.keep_variant_images === true} onChange={(v) => set("keep_variant_images", v)} issues={placed} owner={null} readOnly={Boolean(readOnly)} />
        <PairsControl
          field={decl("pairs")}
          value={settings.pairs ?? null}
          onChange={(v) => set("pairs", v)}
          issues={placed}
          owner={null}
          context={ctx}
          readOnly={Boolean(readOnly)}
        />
      </section>

      <Modules sections={isObj(body) ? body.sections : []} issues={issues} context={ctx} readOnly={readOnly} focusRequest={focusRequest} selection={selection} on={on} />
    </div>
  );
}
