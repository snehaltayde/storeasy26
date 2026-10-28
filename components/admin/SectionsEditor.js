"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Eye, EyeOff, Loader2, Plus, Redo2, Trash2, Undo2 } from "lucide-react";
import { cx } from "@/components/console/cx";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { ConfirmDialog } from "@/components/console/Dialog";
import { Field, Input, Textarea } from "@/components/console/fields";

// Home-page section editor (S37 / MC08, restyled S50). Section tree with add /
// duplicate / hide / remove / reorder (buttons — keyboard reachable),
// schema-driven settings per kind, undo/redo, debounced AUTOSAVE (1200ms) with
// an honest role="status" indicator, and the S35 conflict surface (409 → your
// changes stay, nothing lost; "save yours anyway" resends WITHOUT a revision).
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

export default function SectionsEditor({ initial, revision: initialRevision, customized, onReset, busy: parentBusy }) {
  const [sections, setSections] = useState(initial);
  const [revision, setRevision] = useState(initialRevision);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [save, setSave] = useState({ state: "idle", errors: [] }); // idle|dirty|saving|saved|conflict|error
  const [removeIdx, setRemoveIdx] = useState(null); // section index pending ConfirmDialog
  const timer = useRef(null);
  const latest = useRef({ sections, revision });
  latest.current = { sections, revision };

  // one mutation entry point: records history, schedules the autosave
  function mutate(next) {
    setHistory((h) => [...h.slice(-30), sections]);
    setFuture([]);
    setSections(next);
    schedule();
  }
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setFuture((f) => [sections, ...f]);
      setSections(h[h.length - 1]);
      schedule();
      return h.slice(0, -1);
    });
  };
  const redo = () => {
    setFuture((f) => {
      if (!f.length) return f;
      setHistory((h) => [...h, sections]);
      setSections(f[0]);
      schedule();
      return f.slice(1);
    });
  };

  function schedule() {
    setSave((s) => ({ ...s, state: "dirty" }));
    clearTimeout(timer.current);
    timer.current = setTimeout(doSave, 1200);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  async function doSave({ overwrite = false } = {}) {
    clearTimeout(timer.current);
    setSave({ state: "saving", errors: [] });
    // S35 CAS: the autosave carries the loaded revision; the post-conflict
    // "save yours anyway" OMITS it = deliberate overwrite.
    const body = { block: "home_sections", value: latest.current.sections };
    if (!overwrite) body.revision = latest.current.revision;
    const res = await fetch("/api/admin/storefront", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setRevision(json.revisions?.home_sections ?? null);
      setSave({ state: "saved", errors: [] });
    } else if (res.status === 409) {
      setSave({ state: "conflict", errors: [] });
    } else {
      setSave({ state: "error", errors: json.errors || [json.error || `Save failed (${res.status})`] });
    }
  }

  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    mutate(next);
  };
  const patch = (i, p) => mutate(sections.map((x, k) => (k === i ? { ...x, ...p } : x)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <IconButton label="Undo" variant="secondary" icon={<Undo2 size={14} aria-hidden />} onClick={undo} disabled={!history.length} />
        <IconButton label="Redo" variant="secondary" icon={<Redo2 size={14} aria-hidden />} onClick={redo} disabled={!future.length} />
        {/* honest autosave indicator — idle renders nothing (role=status stays mounted) */}
        <span
          role="status"
          className={cx("ml-auto inline-flex items-center gap-1 text-xs font-medium", save.state === "saved" ? "text-success" : "text-fg-muted")}
        >
          {save.state === "dirty" && "Unsaved changes"}
          {save.state === "saving" && (
            <>
              <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden /> Saving…
            </>
          )}
          {save.state === "saved" && (
            <>
              <Check size={13} aria-hidden /> Saved — draft; publish to go live
            </>
          )}
        </span>
      </div>

      {save.state === "conflict" && (
        <Banner
          tone="danger"
          title="Someone else edited the home sections since you loaded this page."
          actions={
            <Button size="sm" onClick={() => doSave({ overwrite: true })}>
              Save yours anyway
            </Button>
          }
        >
          Reload to see their version, or save yours anyway. Your version is still here.
        </Banner>
      )}
      {save.state === "error" && (
        <Banner tone="danger">
          {(save.errors.length ? save.errors : ["Save failed"]).map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </Banner>
      )}

      <ul className="space-y-3">
        {sections.map((s, i) => (
          <li key={`${s.kind}-${i}`} className={cx("rounded-ctl border p-3", s.enabled === false ? "border-edge bg-surface-sunken opacity-70" : "border-edge")}>
            <div className="flex flex-wrap items-center gap-1">
              <p className="text-xs font-semibold text-fg-muted">
                {i + 1}. {KIND_META[s.kind]?.label || s.kind}
              </p>
              <span className="ml-auto flex items-center gap-1">
                <IconButton label="Move up" icon={<ArrowUp size={14} aria-hidden />} onClick={() => move(i, -1)} disabled={i === 0} />
                <IconButton label="Move down" icon={<ArrowDown size={14} aria-hidden />} onClick={() => move(i, 1)} disabled={i === sections.length - 1} />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={s.enabled === false ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
                  onClick={() => patch(i, { enabled: s.enabled === false })}
                >
                  {s.enabled === false ? "Show" : "Hide"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={13} aria-hidden />}
                  onClick={() => mutate([...sections.slice(0, i + 1), JSON.parse(JSON.stringify(s)), ...sections.slice(i + 1)])}
                >
                  Duplicate
                </Button>
                <IconButton label="Remove section" icon={<Trash2 size={14} aria-hidden />} onClick={() => setRemoveIdx(i)} />
              </span>
            </div>

            {(s.kind === "collections" || s.kind === "new") && (
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <Field label="Title" htmlFor={`hs-${i}-title`} className="min-w-40 flex-1">
                  <Input id={`hs-${i}-title`} value={s.title || ""} onChange={(e) => patch(i, { title: e.target.value })} />
                </Field>
                <Field label="Items" htmlFor={`hs-${i}-limit`} className="w-20">
                  <Input id={`hs-${i}-limit`} value={s.limit ?? ""} onChange={(e) => patch(i, { limit: e.target.value })} />
                </Field>
              </div>
            )}
            {s.kind === "banner" && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Title" htmlFor={`hs-${i}-title`}>
                  <Input id={`hs-${i}-title`} value={s.title || ""} onChange={(e) => patch(i, { title: e.target.value })} />
                </Field>
                <Field label="Text" htmlFor={`hs-${i}-text`}>
                  <Input id={`hs-${i}-text`} value={s.text || ""} onChange={(e) => patch(i, { text: e.target.value })} />
                </Field>
                <Field label="Button label" htmlFor={`hs-${i}-label`}>
                  <Input id={`hs-${i}-label`} value={s.label || ""} onChange={(e) => patch(i, { label: e.target.value })} />
                </Field>
                <Field label="Button link" htmlFor={`hs-${i}-href`}>
                  <Input id={`hs-${i}-href`} value={s.href || ""} onChange={(e) => patch(i, { href: e.target.value })} placeholder="/collections/…" />
                </Field>
              </div>
            )}
            {s.kind === "rich_text" && (
              <div className="mt-2 space-y-3">
                <Field label="Title (optional)" htmlFor={`hs-${i}-title`}>
                  <Input id={`hs-${i}-title`} value={s.title || ""} onChange={(e) => patch(i, { title: e.target.value })} />
                </Field>
                <Field label="Content" htmlFor={`hs-${i}-html`} hint="HTML — scripts and unsafe markup are stripped on save">
                  <Textarea id={`hs-${i}-html`} mono rows={5} value={s.html || ""} onChange={(e) => patch(i, { html: e.target.value })} />
                </Field>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(KIND_META).map(([kind, meta]) => (
          <Button
            key={kind}
            size="sm"
            variant="secondary"
            icon={<Plus size={13} aria-hidden />}
            title={meta.desc}
            onClick={() => mutate([...sections, { ...NEW_SECTION[kind] }])}
          >
            {meta.label}
          </Button>
        ))}
        {customized && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onReset} disabled={parentBusy}>
            Reset to defaults
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={removeIdx != null}
        onClose={() => setRemoveIdx(null)}
        title="Remove section"
        tone="danger"
        confirmLabel="Remove"
        body="Removes this home-page section. Autosave stores it as a draft; undo brings it back until you leave the page."
        onConfirm={() => mutate(sections.filter((_, k) => k !== removeIdx))}
      />
    </div>
  );
}
