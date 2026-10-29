"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Loader2, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { cx } from "@/components/console/cx";
import { Card, CardHeader, CardFooter } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { ConfirmDialog } from "@/components/console/Dialog";
import { Field, Input, Textarea } from "@/components/console/fields";
import { Switch } from "@/components/console/Switch";
import { useToast } from "@/components/console/Toast";
import { getStorefrontView, saveBlock, resetBlock } from "./api";
import { CollectionPicker } from "./RefPicker";
import { ConflictBanner } from "./ConflictBanner";
import PreviewFrame from "./PreviewFrame";
import { useDirtyGuard } from "./useDirtyGuard";

// Home-page editor (S52): hero + homepage sections + collections index on one
// screen, three anchor-linked cards (#hero, #sections, #collections — the
// Overview and Publishing diff deep-link here). ONE save model: every card has
// an explicit, dirty-gated Save (the sections autosave is retired — two save
// models on one screen was the confusion). Saves are CAS-checked (revision
// from the loaded view); a 409 renders the shared ConflictBanner with the two
// honest choices; 422 errors stay in the card as a persistent Banner; success
// is a toast. Reset-to-default confirms first (the old UI reset with none).

const KIND_META = {
  collections: { label: "Collections grid", desc: "Featured collections from your catalog" },
  new: { label: "Newest products", desc: "Latest synced products" },
  banner: { label: "Banner / CTA", desc: "Accent panel with a headline and button" },
  rich_text: { label: "Rich text", desc: "Freeform content (sanitized HTML)" },
};
const NEW_SECTION = {
  collections: { kind: "collections", title: "Shop by collection", limit: 6, enabled: true },
  new: { kind: "new", title: "Fresh drops", limit: 8, enabled: true },
  banner: { kind: "banner", title: "Festive offer", text: "", label: "Shop now", href: "/collections", enabled: true },
  rich_text: { kind: "rich_text", title: "", html: "<p>Tell your story…</p>", enabled: true },
};
const HISTORY_CAP = 30;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

// ---- shape helpers ----------------------------------------------------------

// Hero is edited as a flat form; the nested {primary,secondary} value is built
// on save (validate() turns an empty label into a null CTA, as before).
const heroForm = (h) => ({
  title: h?.title || "",
  highlight: h?.highlight || "",
  subtitle: h?.subtitle || "",
  badge: h?.badge || "",
  pLabel: h?.primary?.label || "",
  pHref: h?.primary?.href || "",
  sLabel: h?.secondary?.label || "",
  sHref: h?.secondary?.href || "",
});
const heroValue = (f) => ({
  title: f.title,
  highlight: f.highlight,
  subtitle: f.subtitle,
  badge: f.badge,
  primary: { label: f.pLabel, href: f.pHref },
  secondary: { label: f.sLabel, href: f.sHref },
});

// Sections carry a CLIENT id (stable React key — reorders keep focus with the
// row). Initial ids are index-derived so SSR and hydration render the same
// DOM ids; ids minted later only ever happen in event handlers (client-only).
const withIds = (list) => (Array.isArray(list) ? list : []).map((s, i) => ({ ...s, _id: `sec-${i}` }));
const stripIds = (list) => list.map(({ _id, ...rest }) => rest);

// Collections index: null = automatic (derive from catalog), object = curated.
const ciLists = (ci) => ({
  featured: Array.isArray(ci?.featured) ? [...ci.featured] : [],
  order: Array.isArray(ci?.order) ? [...ci.order] : [],
  hide: Array.isArray(ci?.hide) ? [...ci.hide] : [],
});
const ciValue = (mode, lists) => (mode === "auto" ? null : { featured: lists.featured, order: lists.order, hide: lists.hide });
// snapshot via the same normalized shape, so stored key order can't fake dirty
const ciSnapOf = (v) => JSON.stringify(v == null ? null : ciValue("curated", ciLists(v)));

// Persistent in-card failure surface (house rule: toasts carry success only).
function CardErrors({ error, className = "" }) {
  if (!error || error.kind !== "errors") return null;
  return (
    <Banner tone="danger" title="Save failed" className={className}>
      {error.errors.map((t, i) => (
        <p key={i}>{t}</p>
      ))}
    </Banner>
  );
}

// Manual handle entry (covers collections the catalog hasn't synced yet).
// Module-level for the same remount reason — it owns the typed draft.
function ManualAdd({ label, badHandle, onAdd }) {
  const [typed, setTyped] = useState("");
  const submit = () => {
    if (!typed.trim()) return;
    if (onAdd(typed)) setTyped("");
  };
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`Add a collection handle to ${label}`}
          mono
          className="max-w-56 py-1.5 text-xs"
          placeholder="collection-handle"
          value={typed}
          invalid={!!badHandle}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <IconButton label={`Add handle to ${label}`} variant="secondary" icon={<Plus size={14} aria-hidden />} onClick={submit} />
      </div>
      {badHandle && <p className="mt-1 text-xs text-danger">“{badHandle}” isn’t a handle — lowercase letters, digits and hyphens only.</p>}
    </div>
  );
}

export default function HomeEditor({ initial }) {
  const toast = useToast();
  const [customized, setCustomized] = useState(initial.customized);
  const [revisions, setRevisions] = useState(initial.revisions);
  const [saving, setSaving] = useState({}); // block key -> request in flight
  const [errs, setErrs] = useState({}); // block key -> {kind:"conflict"} | {kind:"errors", errors}
  const [resetKey, setResetKey] = useState(null); // block pending the reset ConfirmDialog

  // -- hero -------------------------------------------------------------------
  const [hero, setHero] = useState(() => heroForm(initial.blocks.hero));
  const [heroSnap, setHeroSnap] = useState(() => JSON.stringify(heroForm(initial.blocks.hero)));
  const heroDirty = JSON.stringify(hero) !== heroSnap;

  // -- sections ---------------------------------------------------------------
  const [sections, setSections] = useState(() => withIds(initial.blocks.home_sections));
  const [sectionsSnap, setSectionsSnap] = useState(() => JSON.stringify(initial.blocks.home_sections ?? []));
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [sectionsSaved, setSectionsSaved] = useState(false); // "Saved — draft" after a successful save
  const [removeId, setRemoveId] = useState(null); // section _id pending ConfirmDialog
  const idSeq = useRef(initial.blocks.home_sections?.length ?? 0);
  const mintId = () => `sec-c${++idSeq.current}`; // event handlers only (client)
  const sectionsDirty = JSON.stringify(stripIds(sections)) !== sectionsSnap;

  // -- collections index --------------------------------------------------------
  const [ciMode, setCiMode] = useState(initial.blocks.collections_index == null ? "auto" : "curated");
  const [ci, setCi] = useState(() => ciLists(initial.blocks.collections_index));
  const [ciSnap, setCiSnap] = useState(() => ciSnapOf(initial.blocks.collections_index));
  const [ciPicker, setCiPicker] = useState(null); // curated list key with the CollectionPicker open (S53 B2)
  const [handleErr, setHandleErr] = useState({}); // list key -> bad manual handle
  const ciDirty = JSON.stringify(ciValue(ciMode, ci)) !== ciSnap;

  useDirtyGuard(heroDirty || sectionsDirty || ciDirty);

  // -- shared save plumbing -----------------------------------------------------

  const busy = (key, on) => setSaving((s) => ({ ...s, [key]: on }));
  const fail = (key, error) => setErrs((e) => ({ ...e, [key]: error }));

  // Adopt the saved block from a fresh view (every successful PUT returns the
  // full view). Only the saved block's edits/snapshot/revision move — other
  // cards keep the revision their on-screen edits are based on, so a stale
  // save of those still 409s as it should.
  function adopt(view, block) {
    setCustomized(view.customized ?? customized);
    setRevisions((r) => ({ ...r, [block]: view.revisions?.[block] ?? null }));
    if (block === "hero") {
      const f = heroForm(view.blocks.hero);
      setHero(f);
      setHeroSnap(JSON.stringify(f));
    }
    if (block === "home_sections") {
      const server = view.blocks.home_sections ?? [];
      // keep client ids by position so keys (and keyboard focus) survive the
      // round-trip; the server copy is adopted because save normalizes values
      // (clamped limits, default titles, sanitized HTML).
      setSections(server.map((s, i) => ({ ...s, _id: sections[i]?._id ?? mintId() })));
      setSectionsSnap(JSON.stringify(server));
    }
    if (block === "collections_index") {
      const v = view.blocks.collections_index ?? null;
      setCiMode(v == null ? "auto" : "curated");
      setCi(ciLists(v));
      setCiSnap(ciSnapOf(v));
    }
  }

  // One save wire for all three cards. overwrite=true sends the EXPLICIT
  // force flag (S53) — the deliberate post-409 overwrite; otherwise the
  // loaded revision rides along (number = CAS, null = "expect to create").
  async function save(block, value, { overwrite = false, onSaved } = {}) {
    busy(block, true);
    fail(block, null);
    const res = overwrite ? await saveBlock(block, value, undefined, { force: true }) : await saveBlock(block, value, revisions[block] ?? null);
    if (res.ok) {
      adopt(res, block);
      onSaved?.();
      toast.success("Saved as a draft — publish from Publishing");
    } else if (res.conflict) {
      fail(block, { kind: "conflict" });
    } else if (res.errors) {
      fail(block, { kind: "errors", errors: res.errors });
    } else {
      fail(block, { kind: "errors", errors: [res.error || "Save failed"] });
    }
    busy(block, false);
  }

  // "Load their version": refetch the view (handles both conflict shapes —
  // a newer row AND a row that was reset/deleted, where the effective value
  // is the default again) and adopt that block; your unsaved edits go.
  async function takeTheirs(block) {
    busy(block, true);
    const res = await getStorefrontView();
    if (res.ok) {
      adopt(res, block);
      fail(block, null);
      toast.info("Loaded their version — your unsaved edits were discarded");
    } else {
      fail(block, { kind: "errors", errors: [res.error || "Couldn't load their version — try again"] });
    }
    busy(block, false);
  }

  // Reset to default — ConfirmDialog owns the in-flight state; throw = stays
  // open with the error. The response is a full view: adopt it.
  async function doReset(block) {
    const res = await resetBlock(block, revisions[block] ?? undefined);
    if (!res.ok) throw new Error(res.error || (res.errors || []).join("; ") || "Reset failed");
    adopt(res, block);
    fail(block, null);
    if (block === "home_sections") setSectionsSaved(false);
    toast.success("Reset to default — publish from Publishing");
  }

  const RESET_LABELS = { hero: "hero", home_sections: "homepage sections", collections_index: "collections curation" };

  // Card header chrome shared by all three: Customized/Default + Unsaved.
  const chrome = (block, dirty) => (
    <>
      <Badge tone={customized[block] ? "accent" : "neutral"}>{customized[block] ? "Customized" : "Default"}</Badge>
      {dirty && <Badge tone="warning">Unsaved</Badge>}
    </>
  );
  const headerActions = (block, dirty, onSave) => (
    <>
      {customized[block] && (
        <Button size="sm" variant="ghost" onClick={() => setResetKey(block)} disabled={!!saving[block]}>
          Reset to default
        </Button>
      )}
      <Button size="sm" variant="primary" busy={!!saving[block]} disabled={!dirty} onClick={onSave}>
        Save
      </Button>
    </>
  );
  const conflictBanner = (block, value, extra) =>
    errs[block]?.kind === "conflict" && (
      <ConflictBanner
        what={`the ${RESET_LABELS[block] || block}`}
        busy={!!saving[block]}
        onTakeTheirs={() => takeTheirs(block)}
        onOverwrite={() => save(block, value, { overwrite: true, ...extra })}
      />
    );

  // -- sections mutations -------------------------------------------------------

  function mutate(next) {
    setHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), sections]);
    setFuture([]);
    setSections(next);
    setSectionsSaved(false);
  }
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setFuture((f) => [sections, ...f]);
      setSections(h[h.length - 1]);
      setSectionsSaved(false);
      return h.slice(0, -1);
    });
  };
  const redo = () => {
    setFuture((f) => {
      if (!f.length) return f;
      setHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), sections]);
      setSections(f[0]);
      setSectionsSaved(false);
      return f.slice(1);
    });
  };
  const patchSection = (id, p) => mutate(sections.map((s) => (s._id === id ? { ...s, ...p } : s)));
  function moveSection(id, dir) {
    const i = sections.findIndex((s) => s._id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    mutate(next);
    // keys are stable so the row's DOM moves with it; if the pressed arrow
    // just got disabled (row hit an end), hand focus to its counterpart.
    requestAnimationFrame(() => {
      const same = document.getElementById(`${id}-${dir === -1 ? "up" : "down"}`);
      const other = document.getElementById(`${id}-${dir === -1 ? "down" : "up"}`);
      (same && !same.disabled ? same : other)?.focus();
    });
  }
  const duplicateSection = (id) => {
    const i = sections.findIndex((s) => s._id === id);
    if (i < 0) return;
    const copy = { ...JSON.parse(JSON.stringify(stripIds([sections[i]])[0])), _id: mintId() };
    mutate([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)]);
  };
  const addSection = (kind) => mutate([...sections, { ...NEW_SECTION[kind], _id: mintId() }]);

  const sectionsStatus = saving.home_sections
    ? "Saving…"
    : sectionsDirty
      ? "Unsaved changes"
      : sectionsSaved
        ? "Saved — draft"
        : "No unsaved changes";

  // -- collections picker ---------------------------------------------------------

  const LIST_MAX = { featured: 6, order: 50, hide: 50 };
  const addHandle = (list, handle) => {
    const h = String(handle).trim().toLowerCase();
    if (!HANDLE_RE.test(h)) {
      setHandleErr((e) => ({ ...e, [list]: h }));
      return false;
    }
    setHandleErr((e) => ({ ...e, [list]: null }));
    setCi((c) => (c[list].includes(h) || c[list].length >= LIST_MAX[list] ? c : { ...c, [list]: [...c[list], h] }));
    return true;
  };
  const dropHandle = (list, handle) => setCi((c) => ({ ...c, [list]: c[list].filter((x) => x !== handle) }));
  const moveHandle = (list, i, dir) => {
    const j = i + dir;
    setCi((c) => {
      if (j < 0 || j >= c[list].length) return c;
      const next = [...c[list]];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...c, [list]: next };
    });
  };
  // handles that are both shown and hidden — the server rejects this; say so first
  const ciOverlap = ci.hide.filter((h) => ci.featured.includes(h) || ci.order.includes(h));

  // The CollectionPicker (S53 B2) works in catalog ids; this card stores
  // collection HANDLES — picked items convert via their handle field and go
  // through addHandle (same validation/dedup/cap as the manual input).
  const CI_PICKER_TITLES = { featured: "Add to Featured", order: "Add to the explicit order", hide: "Add to Hidden" };
  const ciPickerButton = (list, label) => {
    const room = LIST_MAX[list] - ci[list].length;
    return (
      <Button size="sm" icon={<Plus size={13} aria-hidden />} disabled={room <= 0} onClick={() => setCiPicker(list)}>
        Choose collections…{room <= 0 ? " (list is full)" : ""}
        <span className="sr-only"> for {label}</span>
      </Button>
    );
  };

  // -----------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* jump chips — the three cards are also deep-linked from the Overview */}
      <nav aria-label="On this page" className="flex flex-wrap gap-1.5">
        {[
          ["#hero", "Hero"],
          ["#sections", "Sections"],
          ["#collections", "Collections"],
        ].map(([href, label]) => (
          <a key={href} href={href} className="rounded-ctl border border-edge bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg">
            {label}
          </a>
        ))}
      </nav>

      {/* ---- #hero ---- */}
      <Card id="hero">
        <CardHeader
          title="Hero"
          description="The big home-page opener."
          badge={chrome("hero", heroDirty)}
          actions={headerActions("hero", heroDirty, () => save("hero", heroValue(hero)))}
        />
        <div className="space-y-3">
          {conflictBanner("hero", heroValue(hero))}
          <CardErrors error={errs.hero} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="hero-title" required>
              <Input id="hero-title" value={hero.title} invalid={!hero.title.trim()} onChange={(e) => setHero({ ...hero, title: e.target.value })} />
            </Field>
            <Field label="Highlight" htmlFor="hero-highlight" hint="matching substring of the title gets the accent color">
              <Input id="hero-highlight" value={hero.highlight} onChange={(e) => setHero({ ...hero, highlight: e.target.value })} />
            </Field>
            <Field label="Subtitle" htmlFor="hero-subtitle" className="sm:col-span-2">
              <Input id="hero-subtitle" value={hero.subtitle} onChange={(e) => setHero({ ...hero, subtitle: e.target.value })} />
            </Field>
            <Field label="Badge" htmlFor="hero-badge" hint="blank shows live catalog stats">
              <Input id="hero-badge" value={hero.badge} onChange={(e) => setHero({ ...hero, badge: e.target.value })} />
            </Field>
            <div className="hidden sm:block" aria-hidden />
            <Field label="Primary button label" htmlFor="hero-p-label" hint="blank = no primary button">
              <Input id="hero-p-label" value={hero.pLabel} onChange={(e) => setHero({ ...hero, pLabel: e.target.value })} />
            </Field>
            <Field label="Primary button link" htmlFor="hero-p-href">
              <Input id="hero-p-href" value={hero.pHref} placeholder="/collections" onChange={(e) => setHero({ ...hero, pHref: e.target.value })} />
            </Field>
            <Field label="Secondary button label" htmlFor="hero-s-label" hint="blank = no secondary button">
              <Input id="hero-s-label" value={hero.sLabel} onChange={(e) => setHero({ ...hero, sLabel: e.target.value })} />
            </Field>
            <Field label="Secondary button link" htmlFor="hero-s-href">
              <Input id="hero-s-href" value={hero.sHref} placeholder="#new" onChange={(e) => setHero({ ...hero, sHref: e.target.value })} />
            </Field>
          </div>
        </div>
      </Card>

      {/* ---- #sections ---- */}
      <Card id="sections">
        <CardHeader
          title="Homepage sections"
          description="Compose the home page below the hero. Hidden sections stay here and don't render."
          badge={chrome("home_sections", sectionsDirty)}
          actions={headerActions("home_sections", sectionsDirty, () => save("home_sections", stripIds(sections), { onSaved: () => setSectionsSaved(true) }))}
        />
        <div className="space-y-3">
          {conflictBanner("home_sections", stripIds(sections), { onSaved: () => setSectionsSaved(true) })}
          <CardErrors error={errs.home_sections} />

          <div className="flex flex-wrap items-center gap-1.5">
            <IconButton label="Undo" variant="secondary" icon={<Undo2 size={14} aria-hidden />} onClick={undo} disabled={!history.length} />
            <IconButton label="Redo" variant="secondary" icon={<Redo2 size={14} aria-hidden />} onClick={redo} disabled={!future.length} />
            {/* always-visible, honest save status — the autosave is retired */}
            <span
              role="status"
              className={cx(
                "ml-auto inline-flex items-center gap-1 text-xs font-medium",
                sectionsStatus === "Saved — draft" ? "text-success" : sectionsStatus === "Unsaved changes" ? "text-warning" : "text-fg-muted"
              )}
            >
              {sectionsStatus === "Saving…" && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden />}
              {sectionsStatus === "Saved — draft" && <Check size={13} aria-hidden />}
              {sectionsStatus}
            </span>
          </div>

          <ul className="space-y-3">
            {sections.map((s, i) => (
              <li key={s._id} className={cx("rounded-ctl border border-edge p-3", s.enabled === false && "bg-surface-sunken")}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-fg-muted">
                    {i + 1}. {KIND_META[s.kind]?.label || s.kind}
                  </p>
                  {s.enabled === false && <Badge tone="warning">Hidden</Badge>}
                  <span className="ml-auto flex items-center gap-1">
                    <span className="mr-1 flex items-center gap-1.5 text-xs text-fg-muted">
                      <Switch
                        checked={s.enabled !== false}
                        onChange={(v) => patchSection(s._id, { enabled: v })}
                        label={`${s.enabled === false ? "Show" : "Hide"} section ${i + 1} (${KIND_META[s.kind]?.label || s.kind})`}
                      />
                      {s.enabled === false ? "Hidden" : "Shown"}
                    </span>
                    <IconButton id={`${s._id}-up`} label="Move up" icon={<ArrowUp size={14} aria-hidden />} onClick={() => moveSection(s._id, -1)} disabled={i === 0} />
                    <IconButton
                      id={`${s._id}-down`}
                      label="Move down"
                      icon={<ArrowDown size={14} aria-hidden />}
                      onClick={() => moveSection(s._id, 1)}
                      disabled={i === sections.length - 1}
                    />
                    <Button size="sm" variant="ghost" icon={<Copy size={13} aria-hidden />} onClick={() => duplicateSection(s._id)}>
                      Duplicate
                    </Button>
                    <IconButton label="Remove section" icon={<Trash2 size={14} aria-hidden />} onClick={() => setRemoveId(s._id)} />
                  </span>
                </div>

                <div className={cx(s.enabled === false && "opacity-70")}>
                  {(s.kind === "collections" || s.kind === "new") && (
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <Field label="Title" htmlFor={`${s._id}-title`} className="min-w-40 flex-1">
                        <Input id={`${s._id}-title`} value={s.title || ""} onChange={(e) => patchSection(s._id, { title: e.target.value })} />
                      </Field>
                      <Field label="Items" htmlFor={`${s._id}-limit`} className="w-24" hint="1–24">
                        <Input
                          id={`${s._id}-limit`}
                          type="number"
                          min={1}
                          max={24}
                          step={1}
                          inputMode="numeric"
                          value={s.limit ?? ""}
                          invalid={!(Number(s.limit) >= 1 && Number(s.limit) <= 24)}
                          onChange={(e) => patchSection(s._id, { limit: e.target.value === "" ? "" : Number(e.target.value) })}
                        />
                      </Field>
                    </div>
                  )}
                  {s.kind === "banner" && (
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <Field label="Title" htmlFor={`${s._id}-title`}>
                        <Input id={`${s._id}-title`} value={s.title || ""} onChange={(e) => patchSection(s._id, { title: e.target.value })} />
                      </Field>
                      <Field label="Text" htmlFor={`${s._id}-text`}>
                        <Input id={`${s._id}-text`} value={s.text || ""} onChange={(e) => patchSection(s._id, { text: e.target.value })} />
                      </Field>
                      <Field label="Button label" htmlFor={`${s._id}-label`}>
                        <Input id={`${s._id}-label`} value={s.label || ""} onChange={(e) => patchSection(s._id, { label: e.target.value })} />
                      </Field>
                      <Field label="Button link" htmlFor={`${s._id}-href`}>
                        <Input id={`${s._id}-href`} value={s.href || ""} placeholder="/collections/…" onChange={(e) => patchSection(s._id, { href: e.target.value })} />
                      </Field>
                    </div>
                  )}
                  {s.kind === "rich_text" && (
                    <div className="mt-2 space-y-3">
                      <Field label="Title (optional)" htmlFor={`${s._id}-title`}>
                        <Input id={`${s._id}-title`} value={s.title || ""} onChange={(e) => patchSection(s._id, { title: e.target.value })} />
                      </Field>
                      <Field label="Content" htmlFor={`${s._id}-html`} hint="HTML — scripts and unsafe markup are stripped on save">
                        <Textarea id={`${s._id}-html`} mono rows={5} value={s.html || ""} onChange={(e) => patchSection(s._id, { html: e.target.value })} />
                      </Field>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(KIND_META).map(([kind, meta]) => (
              <Button key={kind} size="sm" variant="secondary" icon={<Plus size={13} aria-hidden />} title={meta.desc} onClick={() => addSection(kind)}>
                {meta.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {/* ---- #collections ---- */}
      <Card id="collections">
        <CardHeader
          title="Collections page & homepage featured"
          description="Curate /collections and the home collections row — or leave it to the catalog."
          badge={chrome("collections_index", ciDirty)}
          actions={headerActions("collections_index", ciDirty, () => save("collections_index", ciValue(ciMode, ci)))}
        />
        <div className="space-y-4">
          {conflictBanner("collections_index", ciValue(ciMode, ci))}
          <CardErrors error={errs.collections_index} />

          <div>
            <span className="inline-flex items-center rounded-ctl border border-edge p-0.5" role="group" aria-label="Collections mode">
              <Button size="sm" variant={ciMode === "auto" ? "primary" : "ghost"} aria-pressed={ciMode === "auto"} onClick={() => setCiMode("auto")}>
                Automatic (from catalog)
              </Button>
              <Button size="sm" variant={ciMode === "curated" ? "primary" : "ghost"} aria-pressed={ciMode === "curated"} onClick={() => setCiMode("curated")}>
                Curated
              </Button>
            </span>
            <p className="mt-1.5 text-xs text-fg-muted">
              {ciMode === "auto"
                ? "Automatic derives everything from your catalog: collections list alphabetically and the biggest lead the homepage row. Saving stores “automatic” — any curated lists below are discarded on save."
                : "Curated replaces the automatic ordering with your lists. Collections you don't mention still appear, alphabetically, after the ordered ones — unless hidden."}
            </p>
          </div>

          {ciMode === "curated" && (
            <div className="space-y-5">
              {ciOverlap.length > 0 && (
                <Banner tone="warning" title="Shown and hidden at once">
                  {ciOverlap.map((h) => `“${h}”`).join(", ")} {ciOverlap.length === 1 ? "is" : "are"} in Featured/Order and also Hidden — the save will be
                  rejected until one side lets go.
                </Banner>
              )}

              {/* Featured */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-fg-muted">
                  Featured <span className="text-fg-subtle">({ci.featured.length}/6)</span> — lead the list with a badge; also the homepage collections row
                </p>
                {ci.featured.length === 0 ? (
                  <p className="text-xs text-fg-subtle">Nothing featured yet — add from your catalog below.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {ci.featured.map((h) => (
                      <span key={h} className="inline-flex items-center gap-1 rounded-ctl border border-edge bg-surface-sunken px-2 py-1 font-mono text-[11px] text-fg">
                        {h}
                        <IconButton label={`Remove ${h} from featured`} icon={<X size={12} aria-hidden />} onClick={() => dropHandle("featured", h)} />
                      </span>
                    ))}
                  </div>
                )}
                {ciPickerButton("featured", "Featured")}
                <ManualAdd label="Featured" badHandle={handleErr.featured} onAdd={(h) => addHandle("featured", h)} />
              </div>

              {/* Order */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-fg-muted">
                  Then, in this order <span className="text-fg-subtle">({ci.order.length}/50)</span> — remaining collections follow alphabetically
                </p>
                {ci.order.length === 0 ? (
                  <p className="text-xs text-fg-subtle">No explicit order — everything after the featured row sorts alphabetically.</p>
                ) : (
                  <ul className="max-w-md divide-y divide-edge rounded-ctl border border-edge">
                    {ci.order.map((h, i) => (
                      <li key={h} className="flex items-center gap-1.5 px-2.5 py-1.5">
                        <span className="w-5 text-right text-[11px] tabular-nums text-fg-subtle">{i + 1}.</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{h}</span>
                        <IconButton label={`Move ${h} up`} icon={<ArrowUp size={13} aria-hidden />} disabled={i === 0} onClick={() => moveHandle("order", i, -1)} />
                        <IconButton
                          label={`Move ${h} down`}
                          icon={<ArrowDown size={13} aria-hidden />}
                          disabled={i === ci.order.length - 1}
                          onClick={() => moveHandle("order", i, 1)}
                        />
                        <IconButton label={`Remove ${h} from order`} icon={<X size={13} aria-hidden />} onClick={() => dropHandle("order", h)} />
                      </li>
                    ))}
                  </ul>
                )}
                {ciPickerButton("order", "Order")}
                <ManualAdd label="Order" badHandle={handleErr.order} onAdd={(h) => addHandle("order", h)} />
              </div>

              {/* Hidden */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-fg-muted">
                  Hidden <span className="text-fg-subtle">({ci.hide.length}/50)</span> — never shown on the collections page or the homepage row
                </p>
                {ci.hide.length === 0 ? (
                  <p className="text-xs text-fg-subtle">Nothing hidden.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {ci.hide.map((h) => (
                      <span key={h} className="inline-flex items-center gap-1 rounded-ctl border border-edge bg-surface-sunken px-2 py-1 font-mono text-[11px] text-fg line-through decoration-fg-subtle">
                        {h}
                        <IconButton label={`Stop hiding ${h}`} icon={<X size={12} aria-hidden />} onClick={() => dropHandle("hide", h)} />
                      </span>
                    ))}
                  </div>
                )}
                {ciPickerButton("hide", "Hidden")}
                <ManualAdd label="Hidden" badHandle={handleErr.hide} onAdd={(h) => addHandle("hide", h)} />
              </div>
            </div>
          )}
        </div>
        <CardFooter>
          <p className="text-xs text-fg-subtle">Collection handles come from Shopify — sync the catalog to see new ones here.</p>
        </CardFooter>
      </Card>

      <PreviewFrame to="/" />

      {/* remove-section confirm */}
      <ConfirmDialog
        open={removeId != null}
        onClose={() => setRemoveId(null)}
        title="Remove section"
        tone="danger"
        confirmLabel="Remove"
        body="Removes this section from your draft. Nothing changes until you press Save — and undo brings it back until you leave the page."
        onConfirm={() => mutate(sections.filter((s) => s._id !== removeId))}
      />

      {/* reset-to-default confirm (the old UI reset with no confirmation) */}
      <ConfirmDialog
        open={resetKey != null}
        onClose={() => setResetKey(null)}
        title="Reset to default"
        tone="danger"
        confirmLabel="Reset to default"
        body={`This discards your customized ${RESET_LABELS[resetKey] || resetKey} draft and returns it to the default. The live site keeps showing the published version until your next publish.`}
        onConfirm={() => doReset(resetKey)}
      />

      {/* S53 B2: curated-list collection picker — one dialog, opened per list.
          Picked collections land through addHandle, so the stored format
          (handles), dedup and the list caps are exactly what typing gives. */}
      <CollectionPicker
        open={ciPicker != null}
        onClose={() => setCiPicker(null)}
        title={ciPicker ? CI_PICKER_TITLES[ciPicker] : "Choose collections"}
        multi
        max={ciPicker ? Math.max(LIST_MAX[ciPicker] - ci[ciPicker].length, 0) : undefined}
        onConfirm={(items) => {
          if (!ciPicker) return;
          for (const it of items) if (it.handle) addHandle(ciPicker, it.handle);
        }}
      />
    </div>
  );
}
