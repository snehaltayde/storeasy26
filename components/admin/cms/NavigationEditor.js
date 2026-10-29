"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, CornerDownRight, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";
import { saveBlock, resetBlock, getStorefrontView } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import { useDirtyGuard } from "./useDirtyGuard";
import PreviewFrame from "./PreviewFrame";

// Navigation editor (S52): announcement bar + header/footer menus as three
// anchored cards. The menus are STRUCTURED rows now (the S50 screen was a
// `Label | /path` textarea); "Automatic" stays a first-class mode that saves
// the block as null — the storefront then derives the menu from the catalog
// (header: every collection A-Z; footer: top 5), exactly the pre-CMS default.
//
// Wire contract (S35, via ./api): save with the loaded revision (number =
// CAS, null = expect-create); a 409 renders ConflictBanner, whose overwrite
// re-sends with the revision OMITTED. 422 renders a persistent Banner.

const LIMITS = { items: 12, children: 8 };

// ---------------------------------------------------------------- shared save

// Per-block save state: revision/customized ride the block, every outcome of
// a PUT lands in exactly one surface (toast = success, ConflictBanner = 409,
// Banner = 422/network). `onFresh` re-seeds the card's form from the server's
// normalized value after any successful round-trip.
function useBlockSaver(key, view, onFresh) {
  const toast = useToast();
  const [rev, setRev] = useState(view.revisions?.[key] ?? null);
  const [customized, setCustomized] = useState(!!view.customized?.[key]);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState(null); // string[] | null

  async function run(fn, toastText) {
    setBusy(true);
    const res = await fn();
    if (res.ok) {
      setConflict(false);
      setErrors(null);
      setRev(res.revisions?.[key] ?? null);
      setCustomized(!!res.customized?.[key]);
      onFresh(res.blocks?.[key]);
      toast.success(toastText);
    } else if (res.conflict) {
      setErrors(null);
      setConflict(true);
    } else {
      setConflict(false);
      setErrors(res.errors || [res.error || "Request failed"]);
    }
    setBusy(false);
    return res;
  }

  return {
    customized,
    busy,
    conflict,
    errors,
    save: (value) => run(() => saveBlock(key, value, rev), "Saved as a draft — publish from Publishing"),
    overwrite: (value) => run(() => saveBlock(key, value, undefined, { force: true }), "Overwrote their version — publish from Publishing"),
    takeTheirs: () => run(() => getStorefrontView(), "Loaded their version — your edits were discarded"),
    reset: () => run(() => resetBlock(key, rev ?? undefined), "Reset to default — publish from Publishing"),
  };
}

// The card chrome every block shares: Customized/Default + Unsaved badges,
// its own Save (enabled only while dirty), Reset behind ConfirmDialog, and
// the conflict/validation surfaces INSIDE the card.
function EditorCard({ id, title, description, saver, dirty, currentValue, what, children }) {
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <Card id={id}>
      <CardHeader
        title={title}
        description={description}
        badge={
          <>
            <Badge tone={saver.customized ? "accent" : "neutral"}>{saver.customized ? "Customized" : "Default"}</Badge>
            {dirty && <Badge tone="warning">Unsaved</Badge>}
          </>
        }
        actions={
          <>
            {saver.customized && (
              <Button size="sm" variant="ghost" disabled={saver.busy} onClick={() => setConfirmReset(true)}>
                Reset to default
              </Button>
            )}
            <Button size="sm" variant="primary" busy={saver.busy} disabled={!dirty} onClick={() => saver.save(currentValue())}>
              Save
            </Button>
          </>
        }
      />
      {saver.conflict && (
        <div className="mb-4">
          <ConflictBanner what={what} busy={saver.busy} onTakeTheirs={saver.takeTheirs} onOverwrite={() => saver.overwrite(currentValue())} />
        </div>
      )}
      {saver.errors && (
        <Banner tone="danger" title="Fix these to save" className="mb-4">
          {saver.errors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </Banner>
      )}
      {children}
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title={`Reset ${what}?`}
        body={`This discards your draft and returns ${what} to the automatic default. The live site keeps the published version until your next publish.`}
        confirmLabel="Reset to default"
        tone="danger"
        onConfirm={() => saver.reset()}
      />
    </Card>
  );
}

// ---------------------------------------------------------- announcement bar

const seedAnn = (v) => ({ enabled: !!v?.enabled, text: v?.text ?? "", href: v?.href ?? "" });

function AnnouncementCard({ view }) {
  const [form, setForm] = useState(() => seedAnn(view.blocks.announcement));
  const [snap, setSnap] = useState(() => JSON.stringify(seedAnn(view.blocks.announcement)));
  const saver = useBlockSaver("announcement", view, (v) => {
    const f = seedAnn(v);
    setForm(f);
    setSnap(JSON.stringify(f));
  });
  const dirty = JSON.stringify(form) !== snap;
  useDirtyGuard(dirty);

  return (
    <EditorCard
      id="announcement"
      title="Announcement bar"
      description="Thin strip above the header — offers, shipping thresholds, launches."
      saver={saver}
      dirty={dirty}
      currentValue={() => form}
      what="the announcement bar"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <span className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
          <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Show the bar" />
          Show the bar
        </span>
        <Field label="Text" htmlFor="ann-text" hint={`${form.text.length}/200 characters — required while the bar is on`}>
          <Input id="ann-text" maxLength={200} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
        </Field>
        <Field label="Link" htmlFor="ann-href" hint="optional — a path (/collections/sale), an anchor (#new) or a full https:// URL">
          <Input id="ann-href" mono invalid={badHref(form.href)} value={form.href} onChange={(e) => setForm({ ...form, href: e.target.value })} />
        </Field>
      </div>
    </EditorCard>
  );
}

// ------------------------------------------------------------- menu editors

const badHref = (h) => {
  const t = String(h ?? "").trim();
  return t !== "" && !(t.startsWith("/") || t.startsWith("#") || /^https?:\/\//.test(t));
};

// null = automatic (catalog-derived); an array = custom menu. The editor keeps
// that distinction as an explicit mode instead of "empty textarea means auto".
const seedNav = (v) =>
  Array.isArray(v)
    ? {
        mode: "custom",
        items: v.map((i) => ({
          label: i?.label ?? "",
          href: i?.href ?? "",
          children: (i?.children || []).map((c) => ({ label: c?.label ?? "", href: c?.href ?? "" })),
        })),
      }
    : { mode: "auto", items: [] };

// Automatic mode — and a custom menu with no rows — save null (catalog-derived),
// matching the old "empty = automatic" semantics. Empty children arrays are
// dropped so the stored shape stays {label, href, children?}.
const navValue = (form) =>
  form.mode === "auto" || form.items.length === 0
    ? null
    : form.items.map((i) => ({
        label: i.label,
        href: i.href,
        ...(i.children.length ? { children: i.children.map((c) => ({ label: c.label, href: c.href })) } : {}),
      }));

function NavRow({ idx, total, label, href, onPatch, onMove, onRemove, child = false, removeLabel }) {
  const name = child ? `Sub-item ${idx + 1}` : `Item ${idx + 1}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {child && <CornerDownRight size={14} className="shrink-0 text-fg-subtle" aria-hidden />}
      <Input
        aria-label={`${name} label`}
        className="w-36 flex-1"
        maxLength={40}
        placeholder="Label"
        value={label}
        onChange={(e) => onPatch({ label: e.target.value })}
      />
      <Input
        aria-label={`${name} link`}
        mono
        className="w-48 flex-[2]"
        placeholder="/collections/sale · #anchor · https://…"
        invalid={badHref(href)}
        value={href}
        onChange={(e) => onPatch({ href: e.target.value })}
      />
      <span className="flex shrink-0 items-center">
        <IconButton label={`Move ${name.toLowerCase()} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={idx === 0} onClick={() => onMove(-1)} />
        <IconButton label={`Move ${name.toLowerCase()} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={idx === total - 1} onClick={() => onMove(1)} />
        <IconButton label={removeLabel} icon={<Trash2 size={14} aria-hidden />} onClick={onRemove} />
      </span>
    </div>
  );
}

function MenuCard({ id, blockKey, title, description, view, what, autoLabel, autoBlurb, childNote, afterEditor = null }) {
  const [form, setForm] = useState(() => seedNav(view.blocks[blockKey]));
  const [snap, setSnap] = useState(() => JSON.stringify(seedNav(view.blocks[blockKey])));
  const saver = useBlockSaver(blockKey, view, (v) => {
    const f = seedNav(v);
    setForm(f);
    setSnap(JSON.stringify(f));
  });
  const dirty = JSON.stringify(form) !== snap;
  useDirtyGuard(dirty);

  const setItems = (fn) => setForm((f) => ({ ...f, items: fn(f.items) }));
  const patchItem = (i, patch) => setItems((it) => it.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (arr, i, d) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return arr;
    const c = [...arr];
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  };

  return (
    <EditorCard id={id} title={title} description={description} saver={saver} dirty={dirty} currentValue={() => navValue(form)} what={what}>
      <div className="space-y-4">
        <span className="inline-flex items-center rounded-ctl border border-edge p-0.5" role="group" aria-label={`${title} mode`}>
          <Button size="sm" variant={form.mode === "auto" ? "primary" : "ghost"} aria-pressed={form.mode === "auto"} onClick={() => setForm({ ...form, mode: "auto" })}>
            {autoLabel}
          </Button>
          <Button size="sm" variant={form.mode === "custom" ? "primary" : "ghost"} aria-pressed={form.mode === "custom"} onClick={() => setForm({ ...form, mode: "custom" })}>
            Custom menu
          </Button>
        </span>

        {form.mode === "auto" ? (
          <div className="rounded-ctl bg-surface-sunken px-3.5 py-2.5 text-sm text-fg-muted">{autoBlurb}</div>
        ) : (
          <>
            <p className="text-xs text-fg-muted">
              {form.items.length} / {LIMITS.items} items · {childNote}
            </p>
            {form.items.length === 0 && (
              <p className="text-sm text-fg-muted">No items yet — add one below. A custom menu with no items saves as “{autoLabel}”.</p>
            )}
            <ul className="space-y-2">
              {form.items.map((item, i) => (
                <li key={i} className="rounded-ctl border border-edge p-3">
                  <NavRow
                    idx={i}
                    total={form.items.length}
                    label={item.label}
                    href={item.href}
                    onPatch={(patch) => patchItem(i, patch)}
                    onMove={(d) => setItems((it) => move(it, i, d))}
                    onRemove={() => setItems((it) => it.filter((_, j) => j !== i))}
                    removeLabel="Remove item (and its sub-items)"
                  />
                  {item.children.length > 0 && (
                    <div className="mt-2 space-y-2 pl-6">
                      {item.children.map((c, j) => (
                        <NavRow
                          key={j}
                          child
                          idx={j}
                          total={item.children.length}
                          label={c.label}
                          href={c.href}
                          onPatch={(patch) => patchItem(i, { children: item.children.map((y, k) => (k === j ? { ...y, ...patch } : y)) })}
                          onMove={(d) => patchItem(i, { children: move(item.children, j, d) })}
                          onRemove={() => patchItem(i, { children: item.children.filter((_, k) => k !== j) })}
                          removeLabel="Remove sub-item"
                        />
                      ))}
                    </div>
                  )}
                  <div className="mt-2 pl-6">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Plus size={13} aria-hidden />}
                      disabled={item.children.length >= LIMITS.children}
                      onClick={() => patchItem(i, { children: [...item.children, { label: "", href: "" }] })}
                    >
                      Add sub-item ({item.children.length}/{LIMITS.children})
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              icon={<Plus size={13} aria-hidden />}
              disabled={form.items.length >= LIMITS.items}
              onClick={() => setItems((it) => [...it, { label: "", href: "", children: [] }])}
            >
              Add item ({form.items.length}/{LIMITS.items})
            </Button>
            <p className="text-xs text-fg-subtle">
              Links must be a path (/…), an anchor (#…) or a full http(s) URL. They aren’t checked against your catalog here — that happens when
              you publish.
            </p>
          </>
        )}
        {afterEditor}
      </div>
    </EditorCard>
  );
}

// ---------------------------------------------------------------- the screen

export default function NavigationEditor({ initial }) {
  return (
    <div className="space-y-4">
      <AnnouncementCard view={initial} />

      <MenuCard
        id="header"
        blockKey="nav_header"
        title="Header menu"
        description="The storefront's main menu. Sub-items render as a keyboard-reachable dropdown under their parent (one level only)."
        view={initial}
        what="the header menu"
        autoLabel="Automatic — every collection, A-Z"
        autoBlurb="The header lists every collection in your catalog, alphabetically. New collections appear on their own; nothing to maintain here."
        childNote="each item can hold sub-items (a dropdown), no deeper nesting"
      />

      <MenuCard
        id="footer"
        blockKey="nav_footer"
        title="Footer shop links"
        description="The Shop column in the storefront footer. The footer has no dropdowns — sub-items are flattened and render as “· label” under their parent."
        view={initial}
        what="the footer shop links"
        autoLabel="Automatic — top 5 collections"
        autoBlurb="The footer's Shop column lists your top 5 collections from the catalog."
        childNote="sub-items are flattened in the footer (shown as “· label”)"
        afterEditor={
          <div className="rounded-ctl border border-edge bg-surface-sunken p-3.5">
            <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-fg">
              The footer also adds, automatically
              <Badge tone="neutral">Not editable here</Badge>
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-fg-muted">
              <li>An “All collections” link always leads the Shop column, before the items above.</li>
              <li>The Company column: About (when that page exists), Contact, and up to 6 of your enabled policy pages — managed under Pages.</li>
              <li>The Support column: the support email and phone from Settings.</li>
            </ul>
          </div>
        }
      />

      <PreviewFrame to="/" />
    </div>
  );
}
