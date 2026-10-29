"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  History,
  Home,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Loader2,
  Megaphone,
  MousePointerClick,
  Plus,
  Redo2,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  TextQuote,
  Trash2,
  Undo2,
} from "lucide-react";
import { cx } from "@/components/console/cx";
import { PageHeader } from "@/components/console/PageHeader";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Card } from "@/components/console/Card";
import { ConfirmDialog, Dialog } from "@/components/console/Dialog";
import { EmptyState, Skeleton, SkeletonText } from "@/components/console/bits";
import { Field, Input, Select, Textarea } from "@/components/console/fields";
import { Switch } from "@/components/console/Switch";
import { useToast } from "@/components/console/Toast";
import { COMPONENTS, HOME_SECTION_KINDS } from "@/lib/cms/registry";
import { getStorefrontView, saveBlock, resetBlock, startPreview, getHistory } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import { MediaPicker } from "./MediaPicker";
import { CollectionPicker } from "./RefPicker";
import { useDirtyGuard } from "./useDirtyGuard";

// The HOME-PAGE DESIGNER (S55 / audit slice 3): section tree · real-storefront
// preview with click-to-select · registry-driven inspector. Data shapes, the
// save wire (CAS → 409 ConflictBanner / 422 Banner), undo history and the
// section mutations are HomeEditor's proven logic verbatim — this screen only
// changes the ARRANGEMENT (select-then-edit instead of all-cards-open) and
// adds the PreviewBridge handshake (components/preview/PreviewBridge.js):
//   parent → "storeasy:designer:hello"            activate select mode
//   parent → {type:"storeasy:sec:highlight", id}  outline + scroll
//   parent → {type:"storeasy:refresh"}            reload after a draft save
//   child  → {type:"storeasy:ready"}              bridge mounted / hello ack
//   child  → {type:"storeasy:sec:click", id}      a [data-sec] was clicked
// The preview iframes the SAVED draft — it refreshes after Save, never live.
//
// S55 (audit slices 4–5) adds: registry setting kinds "media"/"collection"/
// "choice" (pickers fill the value), the pinned "Announcement bar" global
// node (its own dirty + revision, folded into the one Save), and per-block
// draft history (load a past version into the editor as an unsaved change).

const HISTORY_CAP = 30;

const KIND_ICONS = { collections: LayoutGrid, new: Sparkles, banner: Megaphone, rich_text: TextQuote, image_with_text: ImageIcon, product_rail: ShoppingBag };

const DEVICES = [
  { key: "mobile", label: "Mobile", width: 375 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "desktop", label: "Desktop", width: "100%" },
];

// ---- shape helpers (HomeEditor's, unchanged) ---------------------------------

// Hero is edited flat; the nested {primary,secondary} value is built on save.
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

// Announcement is a GLOBAL block (renders on every page), but it lives in the
// designer too — same seed shape as NavigationEditor's card.
const seedAnn = (v) => ({ enabled: !!v?.enabled, text: v?.text ?? "", href: v?.href ?? "" });

// Sections carry a CLIENT key (stable React key; reorders keep focus with the
// row) NEXT TO the durable server id ("sec_…" — the preview's [data-sec]).
// Initial keys are index-derived so SSR and hydration match; keys minted later
// only happen in event handlers (client-only). stripKeys removes ONLY the
// client key — the durable `id` rides along so the server preserves it.
const withKeys = (list) => (Array.isArray(list) ? list : []).map((s, i) => ({ ...s, _key: `k${i}` }));
const stripKeys = (list) => list.map(({ _key, ...rest }) => rest);

const BLOCK_LABELS = { hero: "the hero", announcement: "the announcement bar", home_sections: "the homepage sections" };

const HISTORY_TITLES = { hero: "Hero", announcement: "Announcement bar", home_sections: "Homepage sections" };

// Draft revision history (S55 / audit slice 5): a read-only list of past
// saves for ONE block. "Load this version" hands the historical value back to
// the editor as an UNSAVED change — nothing is written until the ordinary
// Save (validation + CAS + a fresh history entry) runs.
function HistoryDialog({ blockKey, onClose, onLoad }) {
  const [phase, setPhase] = useState("loading"); // loading | error | ready
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [tries, setTries] = useState(0); // retry trigger

  useEffect(() => {
    if (!blockKey) return;
    let stale = false;
    setPhase("loading");
    setError(null);
    getHistory("block", blockKey).then((res) => {
      if (stale) return;
      if (res.ok) {
        setEntries(res.history || []);
        setPhase("ready");
      } else {
        setError(res.error || (res.errors || []).join("; ") || "Couldn't load the history");
        setPhase("error");
      }
    });
    return () => {
      stale = true;
    };
  }, [blockKey, tries]);

  // an unreadable entry (value lost) can't be loaded — the row still shows
  const loadable = (h) => (blockKey === "home_sections" ? Array.isArray(h.value) : h.value != null);

  return (
    <Dialog open={!!blockKey} onClose={onClose} title={`History — ${HISTORY_TITLES[blockKey] || blockKey || ""}`}>
      <div className="space-y-3">
        <p className="text-xs text-fg-muted">
          Every draft save keeps a version. &ldquo;Load this version&rdquo; loads it into the editor — nothing changes until you save.
        </p>
        {phase === "loading" && <SkeletonText lines={4} />}
        {phase === "error" && (
          <Banner
            tone="danger"
            actions={
              <Button size="sm" onClick={() => setTries((n) => n + 1)}>
                Retry
              </Button>
            }
          >
            {error}
          </Banner>
        )}
        {phase === "ready" && entries.length === 0 && (
          <EmptyState title="No versions yet" body="Versions appear here after you save — this block hasn't been saved since history started recording." />
        )}
        {phase === "ready" && entries.length > 0 && (
          <ul className="max-h-80 divide-y divide-edge overflow-y-auto rounded-ctl border border-edge" aria-label="Saved versions, newest first">
            {entries.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg">{new Date(h.created_at).toLocaleString()}</span>
                  <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                    {h.actor || "unknown"}
                    {blockKey === "home_sections" && Array.isArray(h.value)
                      ? ` · ${h.value.length} section${h.value.length === 1 ? "" : "s"}`
                      : ""}
                    {!loadable(h) && " · unreadable entry"}
                  </span>
                </span>
                <Button size="sm" className="shrink-0" disabled={!loadable(h)} onClick={() => onLoad(h.value)}>
                  Load this version
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

export default function Designer({ initial }) {
  const toast = useToast();
  const [customized, setCustomized] = useState(initial.customized);
  const [revisions, setRevisions] = useState(initial.revisions);
  const [saving, setSaving] = useState({}); // block -> request in flight
  const [errs, setErrs] = useState({}); // block -> {kind:"conflict"} | {kind:"errors", errors}

  // -- blocks (HomeEditor's dirty model: JSON vs loaded snapshot) --------------
  const [hero, setHero] = useState(() => heroForm(initial.blocks.hero));
  const [heroSnap, setHeroSnap] = useState(() => JSON.stringify(heroForm(initial.blocks.hero)));
  const heroDirty = JSON.stringify(hero) !== heroSnap;

  const [ann, setAnn] = useState(() => seedAnn(initial.blocks.announcement));
  const [annSnap, setAnnSnap] = useState(() => JSON.stringify(seedAnn(initial.blocks.announcement)));
  const annDirty = JSON.stringify(ann) !== annSnap;

  const [sections, setSections] = useState(() => withKeys(initial.blocks.home_sections));
  const [sectionsSnap, setSectionsSnap] = useState(() => JSON.stringify(initial.blocks.home_sections ?? []));
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const keySeq = useRef(initial.blocks.home_sections?.length ?? 0);
  const mintKey = () => `kc${++keySeq.current}`; // event handlers only (client)
  const sectionsDirty = JSON.stringify(stripKeys(sections)) !== sectionsSnap;

  const dirty = heroDirty || annDirty || sectionsDirty;
  const savingAny = !!(saving.hero || saving.announcement || saving.home_sections);
  useDirtyGuard(dirty);

  // -- selection ---------------------------------------------------------------
  const [selected, setSelected] = useState(null); // "hero" | "announcement" | section _key | null
  const [removeKey, setRemoveKey] = useState(null); // _key pending delete confirm
  const [resetKey, setResetKey] = useState(null); // block pending reset confirm
  const [addOpen, setAddOpen] = useState(false);
  // picker dialogs for "media"/"collection" settings: which setting they fill
  const [picker, setPicker] = useState(null); // { kind:"media"|"collection", sectionKey, settingKey } | null
  const [histFor, setHistFor] = useState(null); // "hero" | "announcement" | "home_sections" | null
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const selSection = selected && selected !== "hero" && selected !== "announcement" ? sections.find((s) => s._key === selected) : null;

  // -- preview -----------------------------------------------------------------
  const iframeRef = useRef(null);
  const activatedRef = useRef(false); // sent the post-ready hello for this load
  const [mint, setMint] = useState({ phase: "minting", error: null }); // minting | error | up
  const [connected, setConnected] = useState(false);
  const [device, setDevice] = useState("desktop");
  const [nonce, setNonce] = useState(0);

  const post = (msg) => iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
  const postHello = () => post("storeasy:designer:hello");
  const postHighlight = (id) => post({ type: "storeasy:sec:highlight", id });
  const postRefresh = () => {
    if (connected) post({ type: "storeasy:refresh" });
    else setNonce((n) => n + 1); // before the handshake, remount the frame instead
  };

  async function mintPreview() {
    setMint({ phase: "minting", error: null });
    setConnected(false);
    const r = await startPreview("/");
    if (!r.ok) setMint({ phase: "error", error: r.error || "Could not start the preview" });
    else {
      setMint({ phase: "up", error: null });
      setNonce((n) => n + 1);
    }
  }
  useEffect(() => {
    mintPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handshake: on iframe load we hello; the bridge replies (or announces)
  // "ready", and we hello ONCE more in case our load-time hello raced its
  // mount — activatedRef stops the ready↔hello loop after that.
  const onFrameLoad = () => {
    setConnected(false);
    activatedRef.current = false;
    postHello();
  };

  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return; // same-origin only
      if (e.source !== iframeRef.current?.contentWindow) return; // our frame only
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "storeasy:ready") {
        setConnected(true);
        if (!activatedRef.current) {
          activatedRef.current = true;
          postHello();
        }
      }
      if (msg.type === "storeasy:sec:click") {
        if (msg.id === "hero") setSelected("hero");
        else if (msg.id === "announcement") setSelected("announcement");
        else {
          const hit = sectionsRef.current.find((s) => s.id === msg.id);
          if (hit) setSelected(hit._key);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Tree selection also highlights in the preview (durable ids only — a
  // never-saved section isn't in the saved draft the preview renders). The
  // Header carries data-sec="announcement"; when the bar is disabled the
  // bridge finds nothing and the highlight is a graceful no-op.
  function selectNode(key) {
    setSelected(key);
    const id = key === "hero" || key === "announcement" ? key : sections.find((s) => s._key === key)?.id;
    if (id) postHighlight(id);
  }

  // -- save wire (HomeEditor's, applied per block) -------------------------------

  const busy = (key, on) => setSaving((s) => ({ ...s, [key]: on }));
  const fail = (key, error) => setErrs((e) => ({ ...e, [key]: error }));

  // Adopt the saved block from a returned view; other blocks keep the revision
  // their on-screen edits are based on, so a stale save of those still 409s.
  function adopt(view, block) {
    setCustomized(view.customized ?? customized);
    setRevisions((r) => ({ ...r, [block]: view.revisions?.[block] ?? null }));
    if (block === "hero") {
      const f = heroForm(view.blocks.hero);
      setHero(f);
      setHeroSnap(JSON.stringify(f));
    }
    if (block === "announcement") {
      const f = seedAnn(view.blocks.announcement);
      setAnn(f);
      setAnnSnap(JSON.stringify(f));
    }
    if (block === "home_sections") {
      const server = view.blocks.home_sections ?? [];
      // keep client keys by position so React keys (and focus) survive; the
      // server copy is adopted because save normalizes values and mints
      // durable ids for new sections.
      setSections(server.map((s, i) => ({ ...s, _key: sectionsRef.current[i]?._key ?? mintKey() })));
      setSectionsSnap(JSON.stringify(server));
    }
  }

  async function saveOne(block, value, { overwrite = false } = {}) {
    busy(block, true);
    fail(block, null);
    const res = overwrite ? await saveBlock(block, value, undefined, { force: true }) : await saveBlock(block, value, revisions[block] ?? null);
    busy(block, false);
    if (res.ok) {
      adopt(res, block);
      return true;
    }
    if (res.conflict) fail(block, { kind: "conflict" });
    else if (res.errors) fail(block, { kind: "errors", errors: res.errors });
    else fail(block, { kind: "errors", errors: [res.error || "Save failed"] });
    return false;
  }

  // ONE Save: each dirty block goes sequentially with its own revision; the
  // preview refreshes if anything landed; the toast only claims full success.
  async function saveAll() {
    let savedAny = false;
    let allOk = true;
    if (heroDirty) {
      const ok = await saveOne("hero", heroValue(hero));
      savedAny = savedAny || ok;
      allOk = allOk && ok;
    }
    if (annDirty) {
      const ok = await saveOne("announcement", { ...ann });
      savedAny = savedAny || ok;
      allOk = allOk && ok;
    }
    if (sectionsDirty) {
      // read through the ref so edits made while the hero request was in
      // flight still ride along
      const ok = await saveOne("home_sections", stripKeys(sectionsRef.current));
      savedAny = savedAny || ok;
      allOk = allOk && ok;
    }
    if (savedAny) postRefresh();
    if (allOk && savedAny) toast.success("Saved as a draft — publish from Publishing");
  }

  // Post-409 overwrite — the EXPLICIT force flag, then the same refresh+toast.
  async function overwrite(block) {
    const value = block === "hero" ? heroValue(hero) : block === "announcement" ? { ...ann } : stripKeys(sections);
    const ok = await saveOne(block, value, { overwrite: true });
    if (ok) {
      postRefresh();
      toast.success("Saved as a draft — publish from Publishing");
    }
  }

  // "Load their version": refetch the full view and adopt that block.
  async function takeTheirs(block) {
    busy(block, true);
    const res = await getStorefrontView();
    if (res.ok) {
      adopt(res, block);
      fail(block, null);
      postRefresh();
      toast.info("Loaded their version — your unsaved edits were discarded");
    } else {
      fail(block, { kind: "errors", errors: [res.error || "Couldn't load their version — try again"] });
    }
    busy(block, false);
  }

  // Reset to default — the ConfirmDialog owns the in-flight state; throw keeps
  // it open with the error. The response is a full view: adopt it.
  async function doReset(block) {
    const res = await resetBlock(block, revisions[block] ?? undefined);
    if (!res.ok) throw new Error(res.error || (res.errors || []).join("; ") || "Reset failed");
    adopt(res, block);
    fail(block, null);
    postRefresh();
    toast.success("Reset to default — publish from Publishing");
  }

  // -- section mutations (HomeEditor's pattern: history-capped mutate) -----------

  function mutate(next) {
    setHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), sections]);
    setFuture([]);
    setSections(next);
  }
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setFuture((f) => [sections, ...f]);
      setSections(h[h.length - 1]);
      return h.slice(0, -1);
    });
  };
  const redo = () => {
    setFuture((f) => {
      if (!f.length) return f;
      setHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), sections]);
      setSections(f[0]);
      return f.slice(1);
    });
  };
  const patchSection = (key, p) => mutate(sections.map((s) => (s._key === key ? { ...s, ...p } : s)));
  function moveSection(key, dir) {
    const i = sections.findIndex((s) => s._key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    mutate(next);
    // stable keys mean the row's DOM moves with it; if the pressed arrow just
    // got disabled (row hit an end), hand focus to its counterpart.
    requestAnimationFrame(() => {
      const same = document.getElementById(`${key}-${dir === -1 ? "up" : "down"}`);
      const other = document.getElementById(`${key}-${dir === -1 ? "down" : "up"}`);
      (same && !same.disabled ? same : other)?.focus();
    });
  }
  const duplicateSection = (key) => {
    const i = sections.findIndex((s) => s._key === key);
    if (i < 0) return;
    const copy = { ...JSON.parse(JSON.stringify(stripKeys([sections[i]])[0])), _key: mintKey() };
    delete copy.id; // a duplicate is a NEW instance — the server mints its durable id
    mutate([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)]);
    setSelected(copy._key);
  };
  const addSection = (kind) => {
    const def = COMPONENTS[kind];
    // defaults come from the registry — no hard-coded kind list or values
    const next = { kind, ...JSON.parse(JSON.stringify(def?.defaults || {})), enabled: true, _key: mintKey() };
    mutate([...sections, next]);
    setSelected(next._key);
    setAddOpen(false);
  };
  const removeSection = (key) => {
    mutate(sections.filter((s) => s._key !== key));
    if (selected === key) setSelected(null);
  };

  // -- history restore: load a past version into the EDITOR, never the store ----
  // Dirty tracking does the rest — the value only persists via the one Save.
  function loadHistorical(value) {
    if (histFor === "hero") setHero(heroForm(value));
    else if (histFor === "announcement") setAnn(seedAnn(value));
    else if (histFor === "home_sections") {
      const list = JSON.parse(JSON.stringify(Array.isArray(value) ? value : []));
      mutate(list.map((s) => ({ ...s, _key: mintKey() }))); // undo brings the current draft back
      setSelected(null); // the old client keys are gone
    }
    setHistFor(null);
    toast.info("Loaded into the editor — nothing changes until you press Save");
  }

  // -- picker fills for "media" / "collection" settings --------------------------

  function onMediaSelect(item) {
    const t = picker;
    setPicker(null);
    if (!t) return;
    const sec = sectionsRef.current.find((x) => x._key === t.sectionKey);
    if (!sec) return;
    const patch = { [t.settingKey]: item.url };
    // picking also fills an EMPTY image_alt (when the kind declares one) with
    // the library alt — an already-typed alt is never overwritten
    const hasAlt = (COMPONENTS[sec.kind]?.settings || []).some((x) => x.key === "image_alt");
    if (hasAlt && !String(sec.image_alt ?? "").trim()) patch.image_alt = item.alt || "";
    patchSection(t.sectionKey, patch);
  }

  function onCollectionPick(items) {
    const t = picker; // single mode closes itself; onClose clears `picker` after us
    if (!t || !items?.[0]) return;
    patchSection(t.sectionKey, { [t.settingKey]: items[0].handle || "" });
  }

  // -- status line ---------------------------------------------------------------

  const dirtyBits = [heroDirty && "hero", annDirty && "announcement", sectionsDirty && "sections"].filter(Boolean);
  const statusText = savingAny ? "Saving…" : dirty ? `Unsaved changes — ${dirtyBits.join(", ")}` : "No unsaved changes";

  // -- pieces ---------------------------------------------------------------------

  const errorBanner = (block) =>
    errs[block]?.kind === "errors" && (
      <Banner key={`${block}-err`} tone="danger" title={`Couldn't save ${BLOCK_LABELS[block]}`}>
        {errs[block].errors.map((t, i) => (
          <p key={i}>{t}</p>
        ))}
      </Banner>
    );

  const treeRow = ({ key, icon: Icon, title, hidden, isSelected, onSelect, controls }) => (
    <li key={key} className={cx("rounded-ctl border", isSelected ? "border-edge-strong bg-surface-sunken" : "border-transparent")}>
      <button
        type="button"
        aria-current={isSelected || undefined}
        onClick={onSelect}
        className={cx(
          "flex w-full items-center gap-2 rounded-ctl px-2 py-1.5 text-left text-sm focus-ring",
          isSelected ? "font-medium text-fg" : "text-fg-muted hover:bg-surface-sunken/60 hover:text-fg"
        )}
      >
        <Icon size={14} aria-hidden className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {hidden && <Badge tone="warning">Hidden</Badge>}
      </button>
      {isSelected && controls && <div className="flex flex-wrap items-center gap-0.5 px-1.5 pb-1.5">{controls}</div>}
    </li>
  );

  const tree = (
    <Card padded={false} className="p-3">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">Sections</h2>
        <IconButton label="Undo" icon={<Undo2 size={14} aria-hidden />} onClick={undo} disabled={!history.length} />
        <IconButton label="Redo" icon={<Redo2 size={14} aria-hidden />} onClick={redo} disabled={!future.length} />
      </div>
      <ul className="space-y-0.5">
        {treeRow({
          key: "hero",
          icon: Home,
          title: "Hero",
          hidden: false,
          isSelected: selected === "hero",
          onSelect: () => selectNode("hero"),
          controls: null,
        })}
        {/* global pseudo-node: pinned, no reorder/remove — the bar renders on
            every page, but it's part of the home page's look, so it lives here */}
        {treeRow({
          key: "announcement",
          icon: Megaphone,
          title: "Announcement bar",
          hidden: !ann.enabled,
          isSelected: selected === "announcement",
          onSelect: () => selectNode("announcement"),
          controls: null,
        })}
        {sections.map((s, i) => {
          const comp = COMPONENTS[s.kind];
          return treeRow({
            key: s._key,
            icon: KIND_ICONS[s.kind] || Layers,
            title: s.title?.trim() || comp?.label || s.kind,
            hidden: s.enabled === false,
            isSelected: selected === s._key,
            onSelect: () => selectNode(s._key),
            controls: (
              <>
                <IconButton id={`${s._key}-up`} label="Move up" icon={<ArrowUp size={14} aria-hidden />} onClick={() => moveSection(s._key, -1)} disabled={i === 0} />
                <IconButton
                  id={`${s._key}-down`}
                  label="Move down"
                  icon={<ArrowDown size={14} aria-hidden />}
                  onClick={() => moveSection(s._key, 1)}
                  disabled={i === sections.length - 1}
                />
                <IconButton
                  label={s.enabled === false ? "Show section" : "Hide section"}
                  icon={s.enabled === false ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
                  onClick={() => patchSection(s._key, { enabled: s.enabled === false })}
                />
                <IconButton label="Duplicate section" icon={<Copy size={14} aria-hidden />} onClick={() => duplicateSection(s._key)} />
                <IconButton label="Remove section" icon={<Trash2 size={14} aria-hidden />} onClick={() => setRemoveKey(s._key)} />
              </>
            ),
          });
        })}
      </ul>
      <div className="mt-3 border-t border-edge pt-3">
        <Button size="sm" className="w-full" icon={<Plus size={13} aria-hidden />} aria-expanded={addOpen} onClick={() => setAddOpen((o) => !o)}>
          Add section
        </Button>
        {addOpen && (
          <ul className="mt-1.5 space-y-0.5" aria-label="Section types" onKeyDown={(e) => e.key === "Escape" && setAddOpen(false)}>
            {HOME_SECTION_KINDS.map((kind) => {
              const comp = COMPONENTS[kind];
              const Icon = KIND_ICONS[kind] || Layers;
              return (
                <li key={kind}>
                  <button
                    type="button"
                    onClick={() => addSection(kind)}
                    className="flex w-full items-center gap-2 rounded-ctl px-2 py-1.5 text-left text-sm text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg"
                  >
                    <Icon size={14} aria-hidden className="shrink-0 text-fg-subtle" />
                    {comp?.label || kind}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );

  // Inspector controls are GENERATED from the registry's settings contract.
  const settingControl = (s, st) => {
    const id = `ins-${s._key}-${st.key}`;
    const v = s[st.key];
    const onChange = (val) => patchSection(s._key, { [st.key]: val });
    if (st.kind === "number") {
      const bad = !(Number(v) >= st.min && Number(v) <= st.max);
      return (
        <Field key={st.key} label={st.label} htmlFor={id} hint={`${st.min}–${st.max}`}>
          <Input
            id={id}
            type="number"
            min={st.min}
            max={st.max}
            step={1}
            inputMode="numeric"
            value={v ?? ""}
            invalid={bad}
            onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </Field>
      );
    }
    if (st.kind === "html") {
      return (
        <Field key={st.key} label={st.label} htmlFor={id} hint="HTML — scripts and unsafe markup are stripped on save">
          <Textarea id={id} mono rows={6} value={v || ""} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    }
    if (st.kind === "link") {
      return (
        <Field key={st.key} label={st.label} htmlFor={id}>
          <Input id={id} mono value={v || ""} placeholder="/collections" onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    }
    if (st.kind === "media") {
      return (
        <Field key={st.key} label={st.label} htmlFor={id} required={st.required} hint="an image URL — Choose opens the media library">
          <div className="flex gap-2">
            <Input
              id={id}
              mono
              value={v || ""}
              invalid={st.required && !String(v || "").trim()}
              onChange={(e) => onChange(e.target.value)}
            />
            <Button className="shrink-0" onClick={() => setPicker({ kind: "media", sectionKey: s._key, settingKey: st.key })}>
              Choose
            </Button>
          </div>
        </Field>
      );
    }
    if (st.kind === "collection") {
      return (
        <Field key={st.key} label={st.label} htmlFor={id} required={st.required} hint="a collection handle — Choose picks from the synced catalog">
          <div className="flex gap-2">
            <Input
              id={id}
              mono
              value={v || ""}
              placeholder="summer-sale"
              invalid={st.required && !String(v || "").trim()}
              onChange={(e) => onChange(e.target.value)}
            />
            <Button className="shrink-0" onClick={() => setPicker({ kind: "collection", sectionKey: s._key, settingKey: st.key })}>
              Choose
            </Button>
          </div>
        </Field>
      );
    }
    if (st.kind === "choice") {
      return (
        <Field key={st.key} label={st.label} htmlFor={id}>
          <Select id={id} value={v ?? ""} onChange={(e) => onChange(e.target.value)}>
            {(st.options || []).map((o) => (
              <option key={o} value={o}>
                {String(o).charAt(0).toUpperCase() + String(o).slice(1)}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    // "text" (and any future kind falls back to a plain text input)
    return (
      <Field key={st.key} label={st.label} htmlFor={id}>
        <Input id={id} value={v || ""} maxLength={st.max} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  };

  const resetButton = (block) =>
    customized[block] && (
      <Button size="sm" variant="ghost" className="w-full" onClick={() => setResetKey(block)} disabled={!!saving[block]}>
        Reset {BLOCK_LABELS[block]} to default
      </Button>
    );

  const inspector = (
    <Card padded={false} className="p-4">
      {selected === "hero" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
                Hero
                <Badge tone={customized.hero ? "accent" : "neutral"}>{customized.hero ? "Customized" : "Default"}</Badge>
                {heroDirty && <Badge tone="warning">Unsaved</Badge>}
              </h2>
              <p className="mt-0.5 text-xs text-fg-muted">The big home-page opener.</p>
            </div>
            <IconButton label="History" icon={<History size={14} aria-hidden />} onClick={() => setHistFor("hero")} />
          </div>
          <Field label="Title" htmlFor="ins-hero-title" required>
            <Input id="ins-hero-title" value={hero.title} invalid={!hero.title.trim()} onChange={(e) => setHero({ ...hero, title: e.target.value })} />
          </Field>
          <Field label="Highlight" htmlFor="ins-hero-highlight" hint="matching substring of the title gets the accent color">
            <Input id="ins-hero-highlight" value={hero.highlight} onChange={(e) => setHero({ ...hero, highlight: e.target.value })} />
          </Field>
          <Field label="Subtitle" htmlFor="ins-hero-subtitle">
            <Input id="ins-hero-subtitle" value={hero.subtitle} onChange={(e) => setHero({ ...hero, subtitle: e.target.value })} />
          </Field>
          <Field label="Badge" htmlFor="ins-hero-badge" hint="blank shows live catalog stats">
            <Input id="ins-hero-badge" value={hero.badge} onChange={(e) => setHero({ ...hero, badge: e.target.value })} />
          </Field>
          <Field label="Primary button label" htmlFor="ins-hero-p-label" hint="blank = no primary button">
            <Input id="ins-hero-p-label" value={hero.pLabel} onChange={(e) => setHero({ ...hero, pLabel: e.target.value })} />
          </Field>
          <Field label="Primary button link" htmlFor="ins-hero-p-href">
            <Input id="ins-hero-p-href" mono value={hero.pHref} placeholder="/collections" onChange={(e) => setHero({ ...hero, pHref: e.target.value })} />
          </Field>
          <Field label="Secondary button label" htmlFor="ins-hero-s-label" hint="blank = no secondary button">
            <Input id="ins-hero-s-label" value={hero.sLabel} onChange={(e) => setHero({ ...hero, sLabel: e.target.value })} />
          </Field>
          <Field label="Secondary button link" htmlFor="ins-hero-s-href">
            <Input id="ins-hero-s-href" mono value={hero.sHref} placeholder="#new" onChange={(e) => setHero({ ...hero, sHref: e.target.value })} />
          </Field>
          {resetButton("hero")}
        </div>
      ) : selected === "announcement" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
                Announcement bar
                <Badge tone={customized.announcement ? "accent" : "neutral"}>{customized.announcement ? "Customized" : "Default"}</Badge>
                {annDirty && <Badge tone="warning">Unsaved</Badge>}
              </h2>
              <p className="mt-0.5 text-xs text-fg-muted">Thin strip above the header — shows on every page.</p>
            </div>
            <IconButton label="History" icon={<History size={14} aria-hidden />} onClick={() => setHistFor("announcement")} />
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Switch checked={ann.enabled} onChange={(val) => setAnn({ ...ann, enabled: val })} label="Show the bar" />
            {ann.enabled ? "Shown above the header" : "Hidden — stays in the draft, doesn't render"}
          </div>
          <Field label="Text" htmlFor="ins-ann-text" hint={`${ann.text.length}/200 characters — required while the bar is on`}>
            <Input
              id="ins-ann-text"
              maxLength={200}
              value={ann.text}
              invalid={ann.enabled && !ann.text.trim()}
              onChange={(e) => setAnn({ ...ann, text: e.target.value })}
            />
          </Field>
          <Field label="Link" htmlFor="ins-ann-href" hint="optional — a path (/collections/sale), an anchor (#new) or a full https:// URL">
            <Input id="ins-ann-href" mono value={ann.href} onChange={(e) => setAnn({ ...ann, href: e.target.value })} />
          </Field>
          {resetButton("announcement")}
        </div>
      ) : selSection ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
                {COMPONENTS[selSection.kind]?.label || selSection.kind}
                {selSection.enabled === false && <Badge tone="warning">Hidden</Badge>}
              </h2>
              <p className="mt-0.5 font-mono text-[11px] text-fg-subtle">{selSection.id || "new — id assigned on save"}</p>
            </div>
            <IconButton label="History" icon={<History size={14} aria-hidden />} onClick={() => setHistFor("home_sections")} />
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Switch
              checked={selSection.enabled !== false}
              onChange={(v) => patchSection(selSection._key, { enabled: v })}
              label={`${selSection.enabled === false ? "Show" : "Hide"} this section`}
            />
            {selSection.enabled === false ? "Hidden — stays in the draft, doesn't render" : "Shown on the home page"}
          </div>
          {(COMPONENTS[selSection.kind]?.settings || []).map((st) => settingControl(selSection, st))}
          {resetButton("home_sections")}
        </div>
      ) : (
        <EmptyState icon={<MousePointerClick size={20} aria-hidden />} title="Nothing selected" body="Click a section in the preview or the tree to edit it here." />
      )}
    </Card>
  );

  const width = DEVICES.find((d) => d.key === device)?.width ?? "100%";

  const previewPane = (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center rounded-ctl border border-edge p-0.5" role="group" aria-label="Preview width">
          {DEVICES.map((d) => (
            <Button key={d.key} size="sm" variant={device === d.key ? "primary" : "ghost"} aria-pressed={device === d.key} onClick={() => setDevice(d.key)}>
              {d.label}
            </Button>
          ))}
        </span>
        <IconButton label="Refresh preview" icon={<RefreshCw size={14} aria-hidden />} onClick={postRefresh} disabled={mint.phase !== "up"} />
        <IconButton
          label="Open preview in a new tab"
          icon={<ExternalLink size={14} aria-hidden />}
          onClick={() => window.open("/", "_blank", "noreferrer")}
          disabled={mint.phase !== "up"}
        />
        <span role="status" className="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-muted">
          {mint.phase === "minting" && (
            <>
              <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden /> Starting preview…
            </>
          )}
          {mint.phase === "up" && !connected && (
            <>
              <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden /> Connecting…
            </>
          )}
          {mint.phase === "up" && connected && "Preview shows your last save"}
        </span>
      </div>
      {mint.phase === "error" && (
        <Banner
          tone="danger"
          title="Preview couldn't start"
          className="mb-2"
          actions={
            <Button size="sm" onClick={mintPreview}>
              Retry
            </Button>
          }
        >
          {mint.error}
        </Banner>
      )}
      <div className="overflow-auto rounded-card border border-edge bg-surface-sunken p-3">
        {mint.phase === "up" ? (
          <iframe
            key={nonce}
            ref={iframeRef}
            src="/"
            title="Home page preview (your last save)"
            onLoad={onFrameLoad}
            style={{ width: typeof width === "number" ? `${width}px` : width }}
            className="mx-auto block min-h-[70vh] rounded-card border border-edge bg-surface shadow-card"
          />
        ) : (
          <Skeleton className="min-h-[70vh] w-full rounded-card" />
        )}
      </div>
    </div>
  );

  // -------------------------------------------------------------------------------

  return (
    <>
      <PageHeader
        title="Designer"
        description="Compose the home page visually. Everything saves as a draft — publish from Publishing."
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Designer" }]}
        actions={
          <>
            <span
              role="status"
              className={cx("inline-flex items-center gap-1 text-xs font-medium", dirty ? "text-warning" : "text-fg-muted")}
            >
              {savingAny && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden />}
              {statusText}
            </span>
            <Link
              href="/admin/releases"
              className="inline-flex items-center gap-1.5 rounded-ctl border border-edge bg-surface px-3 py-1.5 text-xs font-semibold text-fg focus-ring hover:bg-surface-sunken"
            >
              Publishing <ArrowRight size={13} aria-hidden />
            </Link>
            <Button variant="primary" size="sm" busy={savingAny} disabled={!dirty} onClick={saveAll}>
              Save
            </Button>
          </>
        }
      />

      <div className="space-y-3">
        {errs.hero?.kind === "conflict" && (
          <ConflictBanner what={BLOCK_LABELS.hero} busy={!!saving.hero} onTakeTheirs={() => takeTheirs("hero")} onOverwrite={() => overwrite("hero")} />
        )}
        {errs.announcement?.kind === "conflict" && (
          <ConflictBanner
            what={BLOCK_LABELS.announcement}
            busy={!!saving.announcement}
            onTakeTheirs={() => takeTheirs("announcement")}
            onOverwrite={() => overwrite("announcement")}
          />
        )}
        {errs.home_sections?.kind === "conflict" && (
          <ConflictBanner
            what={BLOCK_LABELS.home_sections}
            busy={!!saving.home_sections}
            onTakeTheirs={() => takeTheirs("home_sections")}
            onOverwrite={() => overwrite("home_sections")}
          />
        )}
        {errorBanner("hero")}
        {errorBanner("announcement")}
        {errorBanner("home_sections")}

        {/* three panes from xl up — the console shell caps <main> at max-w-5xl
            with a w-60 sidebar, so at lg the center pane would be ~140px; the
            stacked order (tree → preview → inspector) stays usable instead */}
        <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[16rem_minmax(0,1fr)_20rem] xl:items-start">
          {tree}
          {previewPane}
          {inspector}
        </div>
      </div>

      {/* remove-section confirm */}
      <ConfirmDialog
        open={removeKey != null}
        onClose={() => setRemoveKey(null)}
        title="Remove section"
        tone="danger"
        confirmLabel="Remove"
        body="Removes this section from your draft. Nothing changes until you press Save — and undo brings it back until you leave the page."
        onConfirm={() => removeSection(removeKey)}
      />

      {/* reset-to-default confirm */}
      <ConfirmDialog
        open={resetKey != null}
        onClose={() => setResetKey(null)}
        title="Reset to default"
        tone="danger"
        confirmLabel="Reset to default"
        body={`This discards your customized ${resetKey === "hero" ? "hero" : resetKey === "announcement" ? "announcement bar" : "homepage sections"} draft and returns it to the default. The live site keeps showing the published version until your next publish.`}
        onConfirm={() => doReset(resetKey)}
      />

      {/* draft revision history — loads a version into the editor, never the store */}
      <HistoryDialog blockKey={histFor} onClose={() => setHistFor(null)} onLoad={loadHistorical} />

      {/* pickers for "media" / "collection" settings */}
      <MediaPicker open={picker?.kind === "media"} onClose={() => setPicker(null)} onSelect={onMediaSelect} />
      <CollectionPicker open={picker?.kind === "collection"} onClose={() => setPicker(null)} multi={false} onConfirm={onCollectionPick} />
    </>
  );
}
