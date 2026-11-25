"use client";

// P3-INSPECTOR (ED-12, AU-02, ED-04): one control per setting kind
// (inspectorModel CONTROL_OF_KIND), plus the route details' controls. Every
// control takes props only and imports no store:
//
//   field     { key, path, anchor, control, label, setting } (inspectorModel)
//   value     the setting's current value
//   onChange  (nextValue) for the whole setting
//   issues    the form's placed issues ([{ anchor, issue }], placeIssues);
//             each control shows the ones at its own element ids
//   owner     the section id, or null for the document itself
//   context   { ownerKey, collections, products, pages, minItems, menuMode,
//               pickImage, focus: { id, request }, and (P5-EDITOR) bundles,
//               searchBundles, refreshBundles, canCreateBundles, currency }
//   readOnly  true: nothing can be changed
//
// Element ids: each control's element has the id of its field path
// (idOf(owner, path) = fieldAnchor), and each sub-part (a button's text, a
// list item, a menu sub-item's link) the id of its own path, exactly the
// anchors inspectorModel.pathsOf lists. Each issue's message is shown right
// under the element it belongs to, in an element whose id is notesId(anchor)
// and which that element names in aria-describedby.
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Input, Textarea, Select, Button, IconButton } from "./parts.js";
import RichTextField from "./RichTextField.js";
import { BundleControl, BundleListControl } from "./BundleControl.js";
import {
  idOf,
  notesId,
  notesAt,
  noteTone,
  blocks,
  choiceWords,
  counterOf,
  numberFrom,
  dateInputOf,
  dateFromInput,
  moveIn,
  removeAt,
  linkFrom,
  pageLinkTarget,
  linkHref,
  LINK_KIND_WORDS,
  PAGE_FAMILY_KEYS,
  PAGE_FAMILY_WORDS,
  collectionChoices,
  choiceLabel,
  railSuggestion,
} from "./inspectorModel.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TONE = { danger: "text-destructive", warning: "text-warning-text", muted: "text-muted-foreground" };

// ---- shared pieces -----------------------------------------------------------------

export function Notes({ anchor, notes }) {
  if (!notes || !notes.length) return null;
  return (
    <div id={notesId(anchor)} data-for={anchor} className="mt-1 space-y-0.5">
      {notes.map((n, i) => (
        <p key={i} className={`text-xs ${TONE[noteTone(n)]}`}>
          {n.message}
        </p>
      ))}
    </div>
  );
}
const described = (anchor, notes) => (notes.length ? notesId(anchor) : undefined);

function Label({ htmlFor, id, children, required }) {
  return (
    <label htmlFor={htmlFor} id={id} className="mb-1 block text-xs font-medium text-muted-foreground">
      {children}
      {required && <span className="text-destructive"> *</span>}
    </label>
  );
}
const Hint = ({ children }) => (children ? <p className="mt-1 text-xs text-muted-foreground">{children}</p> : null);

// A labelled text box at one path.
function TextBox({ id, label, value, onChange, notes, readOnly, mono, placeholder, hint, multiline, required, type }) {
  const Tag = multiline ? Textarea : Input;
  return (
    <div className="min-w-0">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <Tag
        id={id}
        type={multiline ? undefined : type || "text"}
        mono={mono}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={readOnly}
        invalid={blocks(notes)}
        aria-describedby={described(id, notes)}
        onChange={(e) => onChange(e.target.value)}
      />
      <Hint>{hint}</Hint>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

// A group of parts (a button, an image, a list): the element with the
// field's id, focusable, labelled, with its own notes under it.
function Group({ id, label, notes, required, hint, children }) {
  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 rounded-md border border-border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <p id={`${id}--label`} className="mb-2 text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </p>
      <div className="space-y-3">{children}</div>
      <Hint>{hint}</Hint>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

function RowButtons({ name, index, total, onMove, onRemove, readOnly }) {
  return (
    <span className="flex shrink-0 items-center">
      <IconButton label={`Move ${name} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={readOnly || index === 0} onClick={() => onMove(-1)} />
      <IconButton label={`Move ${name} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={readOnly || index === total - 1} onClick={() => onMove(1)} />
      <IconButton label={`Remove ${name}`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={onRemove} />
    </span>
  );
}

const textOf = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

// ---- simple kinds -----------------------------------------------------------------------

export function TextControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  const hint = [field.setting.help, counterOf(textOf(value), field.setting)].filter(Boolean).join(" · ");
  return (
    <TextBox
      id={id}
      label={field.label}
      required={field.setting.required}
      value={textOf(value)}
      onChange={onChange}
      notes={notesAt(issues, id)}
      readOnly={readOnly}
      placeholder={field.setting.placeholder}
      hint={hint}
      multiline={field.multiline}
    />
  );
}

export function NumberControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  const { min, max } = field.setting;
  return (
    <TextBox
      id={id}
      type="number"
      label={field.label}
      required={field.setting.required}
      value={value == null ? "" : String(value)}
      onChange={(t) => onChange(numberFrom(t))}
      notes={notesAt(issues, id)}
      readOnly={readOnly}
      hint={max != null ? `From ${min ?? 0} to ${max}.` : field.setting.help}
    />
  );
}

export function ToggleControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const on = value === true;
  return (
    <div className="min-w-0">
      <span className="flex items-center gap-2 text-sm text-foreground">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={`${id}--label`}
          aria-describedby={described(id, notes)}
          disabled={readOnly}
          onClick={() => onChange(!on)}
          className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed ${on ? "bg-primary" : "bg-input"}`}
        >
          <span className={`size-4 rounded-full bg-card shadow-card ${on ? "translate-x-[1.375rem]" : "translate-x-0.5"}`} />
        </button>
        <span id={`${id}--label`}>{field.label}</span>
      </span>
      <Hint>{field.setting.help}</Hint>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

export function SelectControl({ field, value, onChange, issues, owner, context, readOnly }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const options = field.setting.options || [];
  const known = options.includes(value);
  // Phase 5 line 2: a layout with no default can stay unchosen (null): the live theme's, then the platform's
  const unset = field.key === "template" && field.setting.default === null;
  return (
    <div className="min-w-0">
      <Label htmlFor={id} required={field.setting.required}>
        {field.label}
      </Label>
      <Select id={id} value={known ? value : ""} disabled={readOnly} invalid={blocks(notes)} aria-describedby={described(id, notes)} onChange={(e) => onChange(unset && e.target.value === "" ? null : e.target.value)}>
        {unset ? <option value="">Your theme&rsquo;s layout</option> : !known && <option value="">{value == null ? "Choose one" : "Not one of the choices: choose one"}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {choiceWords(context.ownerKey, field.key, o)}
          </option>
        ))}
      </Select>
      <Hint>{field.setting.help}</Hint>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

// The rich text field gets the focus request itself (its interface), only
// when the request lands on it.
const focusFor = (context, id) => (context?.focus?.id === id ? context.focus.request : null);

export function RichTextControl({ field, value, onChange, issues, owner, context, readOnly }) {
  const id = idOf(owner, field.path);
  return (
    <RichTextField
      id={id}
      label={field.label}
      required={field.setting.required}
      placeholder={field.setting.placeholder}
      value={typeof value === "string" ? value : ""}
      onChange={onChange}
      issues={notesAt(issues, id)}
      focusRequest={focusFor(context, id)}
      readOnlyReason={readOnly ? context?.readOnlyReason || "You can't change this here." : null}
    />
  );
}

// ---- lists -----------------------------------------------------------------------------

export function ParagraphsControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  const list = Array.isArray(value) ? value : [];
  const max = field.setting.max;
  return (
    <Group id={id} label={field.label} notes={notesAt(issues, id)} required={field.setting.required} hint={max != null ? `${list.length} of ${max} paragraphs` : null}>
      {list.map((p, j) => {
        const pid = idOf(owner, `${field.path}.${j}`);
        return (
          <div key={j} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <TextBox
                id={pid}
                multiline
                label={`Paragraph ${j + 1}`}
                value={textOf(p)}
                onChange={(t) => onChange(list.map((x, k) => (k === j ? t : x)))}
                notes={notesAt(issues, pid)}
                readOnly={readOnly}
                hint={counterOf(textOf(p), { max: field.setting.maxEach })}
              />
            </div>
            <RowButtons name={`paragraph ${j + 1}`} index={j} total={list.length} readOnly={readOnly} onMove={(d) => onChange(moveIn(list, j, d))} onRemove={() => onChange(removeAt(list, j))} />
          </div>
        );
      })}
      <Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={readOnly || (max != null && list.length >= max)} onClick={() => onChange([...list, ""])}>
        Add a paragraph
      </Button>
    </Group>
  );
}

export function QaListControl({ field, value, onChange, issues, owner, context, readOnly }) {
  const id = idOf(owner, field.path);
  const list = Array.isArray(value) ? value : [];
  const max = field.setting.max;
  const patch = (j, p) => onChange(list.map((x, k) => (k === j ? { ...(isObj(x) ? x : {}), ...p } : x)));
  return (
    <Group id={id} label={field.label} notes={notesAt(issues, id)} required={field.setting.required} hint={max != null ? `${list.length} of ${max} questions` : null}>
      {list.map((item, j) => {
        const at = `${field.path}.${j}`;
        const iid = idOf(owner, at);
        const it = isObj(item) ? item : {};
        return (
          <div key={j} id={iid} role="group" tabIndex={-1} aria-label={`Question ${j + 1}`} aria-describedby={described(iid, notesAt(issues, iid))} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <TextBox id={idOf(owner, `${at}.q`)} label={`Question ${j + 1}`} value={textOf(it.q)} onChange={(t) => patch(j, { q: t })} notes={notesAt(issues, idOf(owner, `${at}.q`))} readOnly={readOnly} />
              </div>
              <RowButtons name={`question ${j + 1}`} index={j} total={list.length} readOnly={readOnly} onMove={(d) => onChange(moveIn(list, j, d))} onRemove={() => onChange(removeAt(list, j))} />
            </div>
            <RichTextField
              id={idOf(owner, `${at}.a`)}
              label="Answer"
              value={typeof it.a === "string" ? it.a : ""}
              onChange={(html) => patch(j, { a: html })}
              issues={notesAt(issues, idOf(owner, `${at}.a`))}
              focusRequest={focusFor(context, idOf(owner, `${at}.a`))}
              readOnlyReason={readOnly ? context?.readOnlyReason || "You can't change this here." : null}
            />
            <Notes anchor={iid} notes={notesAt(issues, iid)} />
          </div>
        );
      })}
      <Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={readOnly || (max != null && list.length >= max)} onClick={() => onChange([...list, { q: "", a: "" }])}>
        Add a question
      </Button>
    </Group>
  );
}

// ---- links --------------------------------------------------------------------------------

const LINK_KINDS = ["collection", "product", "page", "url"];
const linkPartPaths = (path, v) =>
  !isObj(v) ? [] : v.type === "url" ? [`${path}.href`] : v.type === "collection" || v.type === "product" ? [`${path}.handle`] : v.type === "page" ? [`${path}.family`, `${path}.slug`] : [];

// Pick a catalog row from a list, or type its web name when the editor gave
// no list. Sends the row (or { handle }) to onPick, or null when cleared.
function CatalogPick({ id, label, rows, current, onPick, notes, readOnly, noun }) {
  if (rows && rows.length) {
    const choices = collectionChoices(rows, current);
    return (
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <Select
          id={id}
          value={isObj(current) && current.handle ? current.handle : ""}
          disabled={readOnly}
          invalid={blocks(notes)}
          aria-describedby={described(id, notes)}
          onChange={(e) => onPick(choices.find((c) => c.handle === e.target.value) || null)}
        >
          <option value="">{`Choose a ${noun}`}</option>
          {choices.map((c) => (
            <option key={c.handle} value={c.handle}>
              {choiceLabel(c)}
            </option>
          ))}
        </Select>
        <Notes anchor={id} notes={notes} />
      </div>
    );
  }
  return (
    <TextBox
      id={id}
      mono
      label={label}
      value={isObj(current) ? textOf(current.handle) : ""}
      onChange={(t) => onPick(t.trim() ? { handle: t.trim() } : null)}
      notes={notes}
      readOnly={readOnly}
      placeholder={noun === "product" ? "the product's web name, as in /products/…" : "the collection's web name, as in /collections/…"}
      hint={`Your ${noun}s aren't listed here yet. Type the last part of its web address.`}
    />
  );
}

export function LinkControl({ owner, path, label, value, onChange, issues, context = {}, readOnly, required }) {
  const id = idOf(owner, path);
  const link = isObj(value) ? value : null;
  // A kind picked with no target yet stays here, not in the document.
  const [pending, setPending] = useState(null); // { kind, family? } | null
  const kind = pending?.kind ?? (link && LINK_KINDS.includes(link.type) ? link.type : link ? "unknown" : "none");
  // the notes of parts not shown while a new kind is pending
  const hidden = pending && link && pending.kind !== link.type ? linkPartPaths(path, link).flatMap((p) => notesAt(issues, idOf(owner, p))) : [];
  const notes = [...notesAt(issues, id), ...hidden];
  const pick = (k, target) => {
    const next = linkFrom(k, target);
    if (next) {
      setPending(null);
      onChange(next);
    } else {
      setPending({ kind: k, family: target?.family ?? pending?.family });
      if (link) onChange(null);
    }
  };
  const onKind = (k) => {
    if (k === "none") {
      setPending(null);
      onChange(null);
    } else if (k === "url") {
      setPending(null);
      onChange({ type: "url", href: (link && linkHref(link)) || "" });
    } else if (k === link?.type) setPending(null);
    else setPending({ kind: k });
  };
  const partId = (p) => idOf(owner, `${path}.${p}`);
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
        <Select id={id} value={kind} disabled={readOnly} invalid={blocks(notes)} aria-describedby={described(id, notes)} onChange={(e) => onKind(e.target.value)}>
          <option value="none">No link</option>
          {kind === "unknown" && <option value="unknown">A link we can't read: choose again</option>}
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              {LINK_KIND_WORDS[k]}
            </option>
          ))}
        </Select>
        <Notes anchor={id} notes={notes} />
      </div>
      {kind === "url" && (
        <TextBox
          id={partId("href")}
          mono
          label="Address"
          value={link?.type === "url" ? textOf(link.href) : ""}
          onChange={(t) => onChange({ type: "url", href: t })}
          notes={notesAt(issues, partId("href"))}
          readOnly={readOnly}
          placeholder="/collections/sale or #new"
          hint="A page of your store, starting with /, or a part of this page, starting with #."
        />
      )}
      {(kind === "collection" || kind === "product") && (
        <CatalogPick
          id={partId("handle")}
          label={kind === "collection" ? "Collection" : "Product"}
          noun={kind}
          rows={kind === "collection" ? context.collections : context.products}
          current={link?.type === kind ? link : null}
          onPick={(row) => pick(kind, row)}
          notes={notesAt(issues, partId("handle"))}
          readOnly={readOnly}
        />
      )}
      {kind === "page" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor={partId("family")}>Kind of page</Label>
            <Select
              id={partId("family")}
              value={link?.type === "page" ? textOf(link.family) : pending?.family || "page"}
              disabled={readOnly}
              aria-describedby={described(partId("family"), notesAt(issues, partId("family")))}
              onChange={(e) => (link?.type === "page" ? pick("page", pageLinkTarget(context.pages, link.slug, e.target.value)) : setPending({ kind: "page", family: e.target.value }))}
            >
              {PAGE_FAMILY_KEYS.map((f) => (
                <option key={f} value={f}>
                  {PAGE_FAMILY_WORDS[f]}
                </option>
              ))}
            </Select>
            <Notes anchor={partId("family")} notes={notesAt(issues, partId("family"))} />
          </div>
          <TextBox
            id={partId("slug")}
            mono
            label="Web address"
            value={link?.type === "page" ? textOf(link.slug) : ""}
            onChange={(t) => {
              const family = link?.type === "page" ? link.family : pending?.family || "page";
              pick("page", pageLinkTarget(context.pages, t, family));
            }}
            notes={notesAt(issues, partId("slug"))}
            readOnly={readOnly}
            placeholder="shipping-policy"
          />
        </div>
      )}
    </div>
  );
}

export function LinkSettingControl({ field, value, onChange, issues, owner, context, readOnly }) {
  return <LinkControl owner={owner} path={field.path} label={field.label} required={field.setting.required} value={value} onChange={onChange} issues={issues} context={context} readOnly={readOnly} />;
}

// cta: { label, link } or null (no button)
export function ButtonControl({ field, value, onChange, issues, owner, context, readOnly }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  if (!isObj(value)) {
    return (
      <Group id={id} label={field.label} notes={notes} required={field.setting.required}>
        <p className="text-xs text-muted-foreground">{value == null ? "No button." : "This button couldn't be read."}</p>
        <Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={readOnly} onClick={() => onChange({ label: "", link: null })}>
          Add a button
        </Button>
      </Group>
    );
  }
  const lid = idOf(owner, `${field.path}.label`);
  return (
    <Group id={id} label={field.label} notes={notes} required={field.setting.required}>
      <TextBox id={lid} label="Button text" value={textOf(value.label)} onChange={(t) => onChange({ ...value, label: t })} notes={notesAt(issues, lid)} readOnly={readOnly} hint={counterOf(textOf(value.label), { max: 40 })} />
      <LinkControl owner={owner} path={`${field.path}.link`} label="Where it goes" value={value.link} onChange={(l) => onChange({ ...value, link: l })} issues={issues} context={context} readOnly={readOnly} />
      <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden />} disabled={readOnly} onClick={() => onChange(null)}>
        Remove the button
      </Button>
    </Group>
  );
}

// ---- images and catalog picks ------------------------------------------------------------

export function ImageControl({ field, value, onChange, issues, owner, context, readOnly }) {
  const id = idOf(owner, field.path);
  const v = isObj(value) ? value : {};
  const mid = idOf(owner, `${field.path}.media`);
  const aid = idOf(owner, `${field.path}.alt`);
  const set = (p) => {
    const next = { media: v.media ?? "", alt: v.alt ?? "", ...p };
    onChange(!textOf(next.media).trim() && !textOf(next.alt).trim() ? null : next);
  };
  return (
    <Group id={id} label={field.label} notes={notesAt(issues, id)} required={field.setting.required}>
      <TextBox id={mid} mono label="Image address" value={textOf(v.media)} onChange={(t) => set({ media: t })} notes={notesAt(issues, mid)} readOnly={readOnly} placeholder="https://… or an image from your library" />
      {typeof context?.pickImage === "function" && (
        <Button
          size="sm"
          disabled={readOnly}
          onClick={async () => {
            const picked = await context.pickImage({ path: field.path });
            if (isObj(picked) && typeof picked.media === "string") set({ media: picked.media, ...(typeof picked.alt === "string" && !textOf(v.alt).trim() ? { alt: picked.alt } : {}) });
          }}
        >
          Choose from your library
        </Button>
      )}
      <TextBox id={aid} label="Alt text" value={textOf(v.alt)} onChange={(t) => set({ alt: t })} notes={notesAt(issues, aid)} readOnly={readOnly} hint="What a screen reader says about the image." />
    </Group>
  );
}

function RefControl({ field, value, onChange, issues, owner, context, readOnly, noun }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const rows = noun === "collection" ? context?.collections : context?.products;
  const toValue = (row) => (row ? (row.id ? { handle: row.handle, id: row.id } : { handle: row.handle }) : null);
  // an empty product rail suggests a collection with enough available
  // products (railSuggestion: real available counts only)
  const suggestion = noun === "collection" && !isObj(value) && context?.minItems != null ? railSuggestion(rows, context.minItems) : null;
  return (
    <div className="min-w-0 space-y-1">
      <CatalogPick id={id} label={field.label} noun={noun} rows={rows} current={isObj(value) ? value : null} onPick={(row) => onChange(toValue(row))} notes={notes} readOnly={readOnly} />
      {suggestion && (
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => onChange(toValue(suggestion))}>
          {`Use ${suggestion.title || suggestion.handle}`}
        </Button>
      )}
    </div>
  );
}
export const CollectionControl = (p) => <RefControl {...p} noun="collection" />;
export const ProductControl = (p) => <RefControl {...p} noun="product" />;

function RefListControl({ field, value, onChange, issues, owner, context, readOnly, noun }) {
  const id = idOf(owner, field.path);
  const list = Array.isArray(value) ? value : [];
  const max = field.setting.max;
  const rows = noun === "collection" ? context?.collections : context?.products;
  const choices = collectionChoices(rows);
  const titleOf = (h) => choices.find((c) => c.handle === h)?.title ?? h;
  const present = new Set(list.filter(isObj).map((c) => c.handle));
  const full = max != null && list.length >= max;
  const [typed, setTyped] = useState("");
  const add = (row) => row && !present.has(row.handle) && !full && onChange([...list, row.id ? { handle: row.handle, id: row.id } : { handle: row.handle }]);
  const addId = `${id}--add`;
  return (
    <Group id={id} label={field.label} notes={notesAt(issues, id)} required={field.setting.required} hint={max != null ? `${list.length} of ${max} ${noun}s` : null}>
      {list.length === 0 && <p className="text-xs text-muted-foreground">{`No ${noun}s yet.`}</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.map((c, j) => {
            const rid = idOf(owner, `${field.path}.${j}`);
            const rnotes = notesAt(issues, rid);
            const h = isObj(c) ? textOf(c.handle) : "";
            return (
              <li key={j} className="px-2.5 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span id={rid} tabIndex={-1} aria-describedby={described(rid, rnotes)} className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {`${j + 1}. ${h ? titleOf(h) : `This ${noun} couldn't be read`}`}
                  </span>
                  <RowButtons name={h ? titleOf(h) : `${noun} ${j + 1}`} index={j} total={list.length} readOnly={readOnly} onMove={(d) => onChange(moveIn(list, j, d))} onRemove={() => onChange(removeAt(list, j))} />
                </div>
                <Notes anchor={rid} notes={rnotes} />
              </li>
            );
          })}
        </ul>
      )}
      {choices.length ? (
        <div className="min-w-0">
          <Label htmlFor={addId}>{`Add a ${noun}`}</Label>
          <Select id={addId} value="" disabled={readOnly || full} onChange={(e) => add(choices.find((c) => c.handle === e.target.value))}>
            <option value="">{full ? "The list is full" : `Choose a ${noun}`}</option>
            {choices
              .filter((c) => !present.has(c.handle))
              .map((c) => (
                <option key={c.handle} value={c.handle}>
                  {choiceLabel(c)}
                </option>
              ))}
          </Select>
        </div>
      ) : (
        <div className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <Label htmlFor={addId}>{`Add a ${noun} by its web name`}</Label>
            <Input id={addId} mono value={typed} disabled={readOnly || full} onChange={(e) => setTyped(e.target.value)} placeholder={noun === "product" ? "as in /products/…" : "as in /collections/…"} />
          </div>
          <IconButton
            label={`Add this ${noun}`}
            variant="secondary"
            icon={<Plus size={14} aria-hidden />}
            disabled={readOnly || full || !typed.trim()}
            onClick={() => {
              add({ handle: typed.trim() });
              setTyped("");
            }}
          />
        </div>
      )}
    </Group>
  );
}
export const CollectionsControl = (p) => <RefListControl {...p} noun="collection" />;
export const ProductsControl = (p) => <RefListControl {...p} noun="product" />;

// ---- the store's own lists and a page's details ----------------------------------------

export function SystemControl({ field, issues, owner }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  return (
    <div className="min-w-0">
      <p id={id} tabIndex={-1} aria-describedby={described(id, notes)} className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        {`${field.label}: made by your store from what you publish. Nothing to change here.`}
      </p>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

export function AddressControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  return (
    <TextBox id={id} mono label={field.label} required={field.setting.required} value={textOf(value)} onChange={onChange} notes={notesAt(issues, id)} readOnly={readOnly} hint={field.setting.help} placeholder="summer-sale" />
  );
}

export function DateTimeControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  return (
    <TextBox
      id={id}
      type="datetime-local"
      label={field.label}
      value={dateInputOf(value)}
      onChange={(t) => onChange(dateFromInput(t))}
      notes={notesAt(issues, id)}
      readOnly={readOnly}
      hint={field.setting.help}
    />
  );
}

export function AddressListControl({ field, value, onChange, issues, owner, readOnly }) {
  const id = idOf(owner, field.path);
  const list = Array.isArray(value) ? value : [];
  return (
    <Group id={id} label={field.label} notes={notesAt(issues, id)} hint={field.setting.help}>
      {list.map((a, j) => {
        const rid = idOf(owner, `${field.path}.${j}`);
        return (
          <div key={j} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextBox id={rid} mono label={`Old address ${j + 1}`} value={textOf(a)} onChange={(t) => onChange(list.map((x, k) => (k === j ? t : x)))} notes={notesAt(issues, rid)} readOnly={readOnly} />
            </div>
            <IconButton label={`Remove old address ${j + 1}`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={() => onChange(removeAt(list, j))} />
          </div>
        );
      })}
      <Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={readOnly} onClick={() => onChange([...list, ""])}>
        Add an old address
      </Button>
    </Group>
  );
}

// ---- the map ---------------------------------------------------------------------------------

// control name (inspectorModel CONTROL_OF_KIND and META_CONTROLS) ->
// component. The menu (MenuControl.js) and the brand and look controls
// (DesignForm.js) build on the parts here, so SettingsForm adds them to this
// map (SettingsForm CONTROL_COMPONENTS) rather than this file importing them.
export const CONTROLS = Object.freeze({
  text: TextControl,
  number: NumberControl,
  toggle: ToggleControl,
  select: SelectControl,
  rich_text: RichTextControl,
  paragraphs: ParagraphsControl,
  qa_list: QaListControl,
  link: LinkSettingControl,
  button: ButtonControl,
  image: ImageControl,
  collection: CollectionControl,
  product: ProductControl,
  collections: CollectionsControl,
  products: ProductsControl,
  // P5-EDITOR: the bundle picker (BundleControl.js)
  bundle: BundleControl,
  bundle_list: BundleListControl,
  system: SystemControl,
  address: AddressControl,
  datetime: DateTimeControl,
  address_list: AddressListControl,
});
