"use client";

// P5-EDITOR (COM-02, COM-01): the inspector's bundle picker.
//
//   BundleControl       a setting of kind "bundle": one bundle, { id } or null
//   BundleListControl   a setting of kind "bundle_list": the bundles of a
//                       grid, in order, [{ id }] (add, remove, move)
//   CreateBundleDialog  the inline "Create a bundle" Dialog (BundleForm in
//                       compact mode)
//
// Props are the other controls' (controls.js): field, value, onChange,
// issues, owner, context, readOnly. The context gives (DocumentEditor):
//   bundles            { status: "loading" | "ready" | "failed", items }: the
//                      rows of GET /api/admin/refs?type=bundle, read once at
//                      mount, again on window focus and after a create
//   searchBundles(q)   the same read with q= (resolves with rows)
//   refreshBundles()   read them again
//   canCreateBundles   the session has offers.write (OQ-A)
//   currency           the store's currency, for the create form
//
// Picking writes { id } and nothing else, so picking again over an old
// { id, title } clears it. Every picked bundle (the one, and each row of a
// grid) shows its chip and the bundle-words status line
// (inspectorModel.bundleView), and "Bundles" in it is a link to
// /admin/bundles in a new tab. When the bundles can't be read (a
// failed or 403 read), a picked bundle shows its id with "You can't see
// bundles here." and can be removed, not replaced.
//
// P5-FIX2 (the P5-EDITOR review):
// - a picked id whose ids= read has not answered yet (context.bundles.pending)
//   reads "Checking this bundle…", never "deleted";
// - the Dialog's page name starts empty each time it opens or closes, so the
//   live-now sentence never names the page of an earlier name;
// - a full grid turns "Create a bundle" off and says why (a bundle made
//   there would be live and not placed);
// - a grid row stored in an older shape ({ id, title }) has "Pick again",
//   which rewrites that row as { id } in place (bundleList.replace);
// - a failed read says "You can't see bundles here." once.
//
// Element ids are the anchors inspectorModel.pathsOf lists: the setting's
// path for the control, and "<path>.<j>" for each row of a grid, so a
// validation note (incomplete, UNKNOWN_FIELD, INVALID_VALUE on an index)
// lands on the control or its row. This file does not import controls.js
// (controls.js imports it for its CONTROLS map).
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Input, Button, IconButton, Badge, Dialog } from "./parts.js";
import { BundleForm } from "../../bundles/BundleForm.js";
import { idOf, notesId, notesAt, noteTone, bundleView, bundleOptions, pickBundle, bundleList, linkParts, bundleSlugGuess, isOldBundleChoice, bundleGridMax, BUNDLE_WORDS } from "./inspectorModel.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TONE = { danger: "text-destructive", warning: "text-warning-text", muted: "text-muted-foreground" };
const OPTIONS_SHOWN = 8;

function Notes({ anchor, notes }) {
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

// A line, with "Bundles" as a link that opens in a new tab.
export function LinkedLine({ line, ...rest }) {
  return (
    <p {...rest}>
      {linkParts(line).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

// One picked bundle: title (or its id), price, chip, status line, overlap.
function BundleSummary({ view, index = null }) {
  const name = view.title || view.id || "A bundle";
  return (
    <div className="min-w-0 space-y-1" data-bundle-picked={view.id || ""}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`min-w-0 truncate text-sm text-foreground ${view.title ? "" : "font-mono"}`}>{index != null ? `${index + 1}. ${name}` : name}</span>
        {view.price && <span className="text-xs text-muted-foreground">{view.price}</span>}
        {view.chip && (
          <Badge tone={view.chip.tone}>
            <span data-bundle-chip="">{view.chip.words}</span>
          </Badge>
        )}
      </div>
      {view.line && <LinkedLine line={view.line} data-bundle-status="" className="text-xs text-muted-foreground" />}
      {view.overlap && (
        <p data-bundle-overlap="" className="text-xs text-warning-text">
          {view.overlap}
        </p>
      )}
    </div>
  );
}

// The search field and its options. Without words it lists the bundles the
// editor read; with words it asks the server (q=) when the editor can.
export function BundleSearch({ id, label, context, picked = [], onPick, disabled }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState(null); // { q, items } from a search
  const seq = useRef(0);
  const items = context?.bundles?.items || [];
  useEffect(() => {
    const words = q.trim();
    if (!words || typeof context?.searchBundles !== "function") return undefined;
    const mine = ++seq.current;
    const h = setTimeout(() => {
      Promise.resolve(context.searchBundles(words)).then(
        (rows) => mine === seq.current && setFound({ q: words, items: Array.isArray(rows) ? rows : [] }),
        () => mine === seq.current && setFound({ q: words, items: [] }),
      );
    }, 250);
    return () => clearTimeout(h);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const words = q.trim();
  // the server's answer for these words, else the local filter of what was read
  const source = found && found.q === words ? [...found.items, ...items.filter((b) => !found.items.some((f) => f?.id === b?.id))] : items;
  const options = bundleOptions(source, words, picked).slice(0, OPTIONS_SHOWN);
  const listId = `${id}--options`;
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input id={id} type="search" value={q} disabled={disabled} placeholder="Search your bundles" aria-controls={listId} onChange={(e) => setQ(e.target.value)} />
      <ul id={listId} className="divide-y divide-border rounded-md border border-border" data-bundle-options="">
        {options.length === 0 && <li className="px-2.5 py-1.5 text-xs text-muted-foreground">{words ? BUNDLE_WORDS.noMatch : context?.bundles?.status === "ready" ? BUNDLE_WORDS.noBundles : BUNDLE_WORDS.checking}</li>}
        {options.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              disabled={disabled}
              data-bundle-option={o.id}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
              onClick={() => {
                onPick(o.id);
                setQ("");
              }}
            >
              <span className="min-w-0 flex-1 truncate">{o.title}</span>
              {o.price && <span className="text-xs text-muted-foreground">{o.price}</span>}
              {o.chip && <Badge tone={o.chip.tone}>{o.chip.words}</Badge>}
              {o.picked && <span className="text-xs text-muted-foreground">Picked</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The inline create (OQ-C): BundleForm compact in a Dialog that says the
// bundle goes live at once. BundleForm keeps "Create bundle" off until the
// live check passes, and the server saves nothing that fails (mustPass), so
// a retry never makes a second bundle.
export function CreateBundleDialog({ open, currency, onClose, onCreated }) {
  const [title, setTitle] = useState("");
  // the name typed belongs to one opening: reset it as the Dialog opens or
  // closes (during render, so not even one frame names an old page)
  const [openedAs, setOpenedAs] = useState(open);
  const changed = openedAs !== open;
  if (changed) {
    setOpenedAs(open);
    setTitle("");
  }
  const name = changed ? "" : title;
  return (
    <Dialog open={open} onClose={onClose} title="Create a bundle" size="lg">
      <div className="space-y-3" data-bundle-create="">
        <p className="text-[13px] text-foreground" data-bundle-live-now="">
          {BUNDLE_WORDS.liveNow(bundleSlugGuess(name))}
        </p>
        {open && <BundleForm compact currency={currency} onTitleChange={setTitle} onSaved={onCreated} onCancel={onClose} />}
      </div>
    </Dialog>
  );
}

// "Create a bundle", or why it isn't there. `full`: the sentence why a full
// grid can't take one more (the button is off).
function CreateBundle({ context, onCreated, readOnly, full = null }) {
  const [open, setOpen] = useState(false);
  if (!context?.canCreateBundles) {
    return (
      <p className="text-xs text-muted-foreground" data-bundle-ask-owner="">
        {BUNDLE_WORDS.askOwner}
      </p>
    );
  }
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} disabled={readOnly || !!full} onClick={() => !full && setOpen(true)}>
        Create a bundle
      </Button>
      {full && (
        <p className="text-xs text-muted-foreground" data-bundle-full="">
          {full}
        </p>
      )}
      <CreateBundleDialog
        open={open}
        currency={context?.currency}
        onClose={() => setOpen(false)}
        onCreated={async (b) => {
          setOpen(false);
          if (b?.id) onCreated(b.id);
          await context?.refreshBundles?.();
        }}
      />
    </>
  );
}

function Group({ id, label, notes, required, hint, children }) {
  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 rounded-md border border-border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <p id={`${id}--label`} className="mb-2 text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </p>
      <div className="space-y-3">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      <Notes anchor={id} notes={notes} />
    </div>
  );
}

const bundlesOf = (context) => ({
  status: context?.bundles?.status ?? "loading",
  items: Array.isArray(context?.bundles?.items) ? context.bundles.items : [],
  pending: Array.isArray(context?.bundles?.pending) ? context.bundles.pending : [],
});
const entryOf = (items, id) => (id ? items.find((b) => isObj(b) && b.id === id) : undefined);

export function BundleControl({ field, value, onChange, issues = [], owner = null, context = {}, readOnly = false }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const { status, items, pending } = bundlesOf(context);
  const cur = isObj(value) && typeof value.id === "string" && value.id ? value.id : null;
  const view = cur ? bundleView(cur, entryOf(items, cur), { status, pending }) : null;
  const canSee = status !== "failed";
  return (
    <Group id={id} label={field.label} notes={notes} required={field.setting?.required} hint={field.setting?.help}>
      {view ? (
        <div className="flex items-start gap-2">
          <BundleSummary view={view} />
          <span className="ml-auto shrink-0">
            <IconButton label="Remove this bundle" icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={() => onChange(null)} />
          </span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{value == null ? BUNDLE_WORDS.none : canSee ? "This bundle couldn't be read. Pick it again." : BUNDLE_WORDS.cantSee}</p>
      )}
      {canSee ? (
        <>
          <BundleSearch id={`${id}--search`} label={view ? "Pick another bundle" : "Pick a bundle"} context={context} picked={cur ? [cur] : []} disabled={readOnly} onPick={(bid) => onChange(pickBundle(bid))} />
          <CreateBundle context={context} readOnly={readOnly} onCreated={(bid) => onChange(pickBundle(bid))} />
        </>
      ) : (
        // the line above already says it for a picked or unreadable value
        value == null && <p className="text-xs text-muted-foreground">{BUNDLE_WORDS.cantSee}</p>
      )}
    </Group>
  );
}

export function BundleListControl({ field, value, onChange, issues = [], owner = null, context = {}, readOnly = false }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const { status, items, pending } = bundlesOf(context);
  const list = Array.isArray(value) ? value : [];
  const max = field.setting?.max ?? undefined;
  const [refused, setRefused] = useState(null);
  const canSee = status !== "failed";
  const apply = (r) => {
    setRefused(r.error);
    if (!r.error) onChange(r.list);
  };
  const ids = bundleList.ids(list);
  return (
    <Group id={id} label={field.label} notes={notes} required={field.setting?.required} hint={max != null ? `${list.length} of ${max} bundles` : null}>
      {list.length === 0 && <p className="text-xs text-muted-foreground">No bundles yet.</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border" data-bundle-rows="">
          {list.map((x, j) => {
            const rid = idOf(owner, `${field.path}.${j}`);
            const rnotes = notesAt(issues, rid);
            const bid = ids[j];
            const view = bid ? bundleView(bid, entryOf(items, bid), { status, pending }) : null;
            const old = isOldBundleChoice(x);
            const name = view?.title || bid || `bundle ${j + 1}`;
            return (
              <li key={`${j}:${bid ?? ""}`} className="px-2.5 py-1.5" data-bundle-row={j}>
                <div className="flex items-start gap-1.5">
                  <div id={rid} tabIndex={-1} aria-describedby={described(rid, rnotes)} className="min-w-0 flex-1">
                    {view ? <BundleSummary view={view} index={j} /> : <p className="text-sm text-foreground">{`${j + 1}. This bundle couldn't be read`}</p>}
                  </div>
                  <span className="flex shrink-0 items-center">
                    {old && (
                      <Button size="sm" variant="ghost" aria-label={`Pick ${name} again`} disabled={readOnly} onClick={() => apply(bundleList.replace(list, j, bid))} data-bundle-repick={j}>
                        Pick again
                      </Button>
                    )}
                    <IconButton label={`Move ${name} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={readOnly || j === 0} onClick={() => apply(bundleList.move(list, j, -1))} />
                    <IconButton label={`Move ${name} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={readOnly || j === list.length - 1} onClick={() => apply(bundleList.move(list, j, 1))} />
                    <IconButton label={`Remove ${name}`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={() => apply(bundleList.remove(list, j))} />
                  </span>
                </div>
                <Notes anchor={rid} notes={rnotes} />
              </li>
            );
          })}
        </ul>
      )}
      {refused && (
        <p role="alert" className="text-xs text-warning-text" data-bundle-refused="">
          {refused}
        </p>
      )}
      {canSee ? (
        <>
          <BundleSearch id={`${id}--search`} label="Add a bundle" context={context} picked={ids.filter(Boolean)} disabled={readOnly} onPick={(bid) => apply(bundleList.add(list, bid, max))} />
          <CreateBundle context={context} readOnly={readOnly} full={list.length >= bundleGridMax(field.setting) ? BUNDLE_WORDS.full(bundleGridMax(field.setting)) : null} onCreated={(bid) => apply(bundleList.add(list, bid, max))} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{BUNDLE_WORDS.cantSee}</p>
      )}
    </Group>
  );
}

export default BundleControl;
