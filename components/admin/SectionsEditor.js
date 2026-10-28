"use client";

import { useEffect, useRef, useState } from "react";

// Home-page section editor (S37 / MC08). Section tree with add / duplicate /
// hide / remove / reorder (buttons — keyboard reachable), schema-driven
// settings per kind, undo/redo, debounced AUTOSAVE with an honest indicator,
// and the S35 conflict surface (409 → your changes stay, nothing lost).
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

const input = "mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm";

export default function SectionsEditor({ initial, revision: initialRevision, customized, onReset, busy: parentBusy }) {
  const [sections, setSections] = useState(initial);
  const [revision, setRevision] = useState(initialRevision);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [save, setSave] = useState({ state: "idle", errors: [] }); // idle|dirty|saving|saved|conflict|error
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

  const indicator = {
    idle: ["text-zinc-400", "All changes saved"],
    dirty: ["text-zinc-400", "Unsaved changes…"],
    saving: ["text-zinc-500", "Saving…"],
    saved: ["text-lime-700", "Saved ✓ (draft — publish to go live)"],
    conflict: ["text-amber-700", "Conflict: someone else saved this. Your version is still here."],
    error: ["text-red-600", save.errors[0] || "Save failed"],
  }[save.state];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={undo} disabled={!history.length} className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-semibold text-zinc-600 disabled:opacity-30">
          ↩ Undo
        </button>
        <button type="button" onClick={redo} disabled={!future.length} className="rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-semibold text-zinc-600 disabled:opacity-30">
          ↪ Redo
        </button>
        <span role="status" className={`ml-auto text-xs font-medium ${indicator[0]}`}>
          {indicator[1]}
        </span>
      </div>

      {save.state === "conflict" && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Someone else edited the home sections since you loaded this page. Reload to see their version, or{" "}
          <button type="button" onClick={() => doSave({ overwrite: true })} className="font-bold underline">
            save yours anyway
          </button>
          .
        </div>
      )}
      {save.state === "error" && save.errors.length > 1 && (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{save.errors.join(" · ")}</div>
      )}

      <ul className="space-y-3">
        {sections.map((s, i) => (
          <li key={`${s.kind}-${i}`} className={`rounded-xl border p-3 ${s.enabled === false ? "border-zinc-100 bg-zinc-50 opacity-70" : "border-zinc-200"}`}>
            <div className="flex items-center gap-2">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                {i + 1}. {KIND_META[s.kind]?.label || s.kind}
              </p>
              <span className="ml-auto flex items-center gap-1">
                <button type="button" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30">↑</button>
                <button type="button" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === sections.length - 1} className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30">↓</button>
                <button type="button" onClick={() => patch(i, { enabled: s.enabled === false })} className="rounded px-1.5 py-0.5 text-xs font-semibold text-zinc-500 hover:bg-zinc-100">
                  {s.enabled === false ? "Show" : "Hide"}
                </button>
                <button type="button" onClick={() => mutate([...sections.slice(0, i + 1), JSON.parse(JSON.stringify(s)), ...sections.slice(i + 1)])} className="rounded px-1.5 py-0.5 text-xs font-semibold text-zinc-500 hover:bg-zinc-100">
                  Duplicate
                </button>
                <button type="button" onClick={() => confirm("Remove this section?") && mutate(sections.filter((_, k) => k !== i))} className="rounded px-1.5 py-0.5 text-xs font-semibold text-red-500 hover:bg-red-50">
                  Remove
                </button>
              </span>
            </div>

            {(s.kind === "collections" || s.kind === "new") && (
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <label className="min-w-40 flex-1 text-sm">
                  Title
                  <input className={input} value={s.title || ""} onChange={(e) => patch(i, { title: e.target.value })} />
                </label>
                <label className="text-sm">
                  Items
                  <input className="mt-1 w-20 rounded-lg border border-zinc-200 px-2 py-2 text-sm" value={s.limit ?? ""} onChange={(e) => patch(i, { limit: e.target.value })} />
                </label>
              </div>
            )}
            {s.kind === "banner" && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">Title<input className={input} value={s.title || ""} onChange={(e) => patch(i, { title: e.target.value })} /></label>
                <label className="text-sm">Text<input className={input} value={s.text || ""} onChange={(e) => patch(i, { text: e.target.value })} /></label>
                <label className="text-sm">Button label<input className={input} value={s.label || ""} onChange={(e) => patch(i, { label: e.target.value })} /></label>
                <label className="text-sm">Button link<input className={input} value={s.href || ""} onChange={(e) => patch(i, { href: e.target.value })} placeholder="/collections/…" /></label>
              </div>
            )}
            {s.kind === "rich_text" && (
              <div className="mt-2 space-y-3">
                <label className="block text-sm">Title (optional)<input className={input} value={s.title || ""} onChange={(e) => patch(i, { title: e.target.value })} /></label>
                <label className="block text-sm">
                  Content (HTML — scripts and unsafe markup are stripped on save)
                  <textarea rows={5} className={`${input} font-mono text-xs`} value={s.html || ""} onChange={(e) => patch(i, { html: e.target.value })} />
                </label>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(KIND_META).map(([kind, meta]) => (
          <button
            key={kind}
            type="button"
            onClick={() => mutate([...sections, { ...NEW_SECTION[kind] }])}
            title={meta.desc}
            className="rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
          >
            + {meta.label}
          </button>
        ))}
        {customized && (
          <button type="button" onClick={onReset} disabled={parentBusy} className="ml-auto text-xs font-medium text-zinc-400 underline hover:text-zinc-600">
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  );
}
