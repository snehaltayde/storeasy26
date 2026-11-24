"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, CircleCheck, Eye, ImageIcon, Library, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/components/ui/utils";
import { SyncProgressBody, readSync, requestSync, POLL_MS } from "@/components/admin/SyncProgress";
import { MediaPicker } from "@/components/admin/shared/MediaPicker";
import { uploadImage } from "@/lib/media-upload";
import { PALETTES } from "@/lib/themes/palettes";
import BrandPreview from "./BrandPreview";
import useStarterStore, { call } from "./useStarterStore";
import {
  ALT_MAX,
  BRAND_FORM_ID,
  BRAND_STEP_URL,
  BRAND_WORDS,
  BROKEN,
  DESCRIPTION_MAX,
  DESIGN,
  EDIT_HOME_HREF,
  HALF_RETRY,
  LIBRARY_RE,
  LIVE,
  PREVIEW_HREF,
  PREVIEW_WORDS,
  PUBLISH_HREF,
  REASON_WORDS,
  START_WORDS,
  clearDraft,
  errorOf,
  formOf,
  halfWords,
  hasHomeFor,
  isDirty,
  keepDraft,
  mergeOnLatest,
  madeSentence,
  overlayMessage,
  paletteStyle,
  saveBody,
  savedLines,
  snippetOf,
  takeDraft,
} from "./brandModel";

// Onboarding step 3, Brand (Phase 1 line 6): the starter store (made once,
// automatically, for a role that can edit), then colours, logo and the
// one-line description beside a live preview of this store's home page.
// Every change shows in the preview at once (a message to the frame, never a
// write); nothing is saved until Save. Unsaved choices are kept in this tab's
// sessionStorage across step switches and reloads, and a page leave asks
// first. From 1024px the form and the preview sit side by side (the preview
// sticky); narrower, a sticky "Preview" button opens it in a bottom sheet.
// There is one preview: mounted at once from 1024px, or on the first open
// below, then never unmounted; crossing 1024px only moves it with CSS, so a
// resize never mints a second preview session.
//   canEdit     the role may save and skip (storefront.write); false: every
//               control is disabled with `reason`, nothing is ever POSTed
//   canSync     the role may run a sync (SyncProgress's retry and start)
//   store       { name, address } for the search-result snippet and the alt
//   onChange()  re-read the steps (after the store is made, a sync settles,
//               Save or Skip)

const storage = () => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

function Notice({ tone = "danger", children, ...rest }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : tone === "info" ? "bg-muted text-foreground" : "bg-success/10 text-success")} {...rest}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-2">{typeof children === "string" ? <p>{children}</p> : children}</div>
    </div>
  );
}

const linkClass = "font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

// ---- the starter store ------------------------------------------------------------

// SyncProgress's own body, polled with its own readSync, so this page knows
// when the products are in (and then reads the first run again). Old screen:
// data-legacy until SyncProgress is restyled (Phase 2).
function SyncPanel({ initial, canRun, showStart = false, onSettled, pollMs }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const was = useRef(initial?.state);

  useEffect(() => {
    if (view && view.state !== was.current) {
      const before = was.current;
      was.current = view.state;
      if (LIVE.has(before) && !LIVE.has(view.state)) onSettled?.(view);
    }
    if (!view || !LIVE.has(view.state)) return undefined;
    const timer = setTimeout(async () => {
      const next = await readSync().catch(() => null);
      if (next) setView(next);
      else setView((v) => ({ ...v }));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [view]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await requestSync(body);
    if (res.ok && res.sync) setView(res.sync);
    else if (!res.ok) setError(res.error);
    setBusy(false);
  }

  if (!view) return null;
  return (
    <div data-legacy className="contents">
      <SyncProgressBody view={view} busy={busy} error={error} canRun={canRun} showStart={showStart} onRetry={() => act({ retry: true })} onStart={() => act({})} />
    </div>
  );
}

function NextLinks({ onBrand }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      <Link href={EDIT_HOME_HREF} className={linkClass}>
        {START_WORDS.editHome}
      </Link>
      <button type="button" onClick={onBrand} className={cn(linkClass, "text-left")} data-brand-scroll="" data-onboarding="view">
        {START_WORDS.changeBrand}
      </button>
    </div>
  );
}

function CatalogNotes({ firstRun, sync, canSync, onSettled, pollMs }) {
  if (firstRun.empty) {
    return (
      <div className="space-y-2 rounded-md bg-card p-3" data-first-run-note="empty">
        <p className="text-sm text-foreground">{START_WORDS.empty}</p>
        <p className="text-xs text-muted-foreground">{START_WORDS.emptyRefill}</p>
        {sync && <SyncPanel initial={sync} canRun={canSync} showStart onSettled={onSettled} pollMs={pollMs} />}
      </div>
    );
  }
  if (firstRun.noCollections) {
    return (
      <div className="rounded-md bg-card p-3" data-first-run-note="no-collections">
        <p className="text-sm text-foreground">{START_WORDS.noCollections}</p>
      </div>
    );
  }
  return null;
}

function SyncNote({ sync, canSync, onSettled, pollMs }) {
  return (
    <div className="space-y-2 border-t border-border pt-3" data-first-run-note="sync">
      <p className="text-xs font-medium text-muted-foreground">{START_WORDS.syncNote}</p>
      <SyncPanel initial={sync} canRun={canSync} onSettled={onSettled} pollMs={pollMs} />
    </div>
  );
}

function StarterStore({ starter, canEdit, canSync, pollMs, onBrand }) {
  const { state, firstRun, sync, error, halfReason, make, reload } = starter;
  const open = firstRun.reason === "live";
  const syncShows = sync && (LIVE.has(sync.state) || BROKEN.has(sync.state));
  const openNote = <p className="text-sm text-muted-foreground">{open ? START_WORDS.open : START_WORDS.closed}</p>;
  const retry = (
    <Button variant="outline" onClick={() => make()}>
      <RotateCcw aria-hidden />
      {START_WORDS.tryAgain}
    </Button>
  );
  let body;
  if (state === "loading" || state === "making") {
    body = (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {state === "making" ? START_WORDS.making : START_WORDS.loading}
      </p>
    );
  } else if (state === "load-failed") {
    body = <Notice>{error}</Notice>;
  } else if (state === "half") {
    body = (
      <div className="space-y-3">
        <Notice tone="warning">{halfWords(halfReason)}</Notice>
        <NextLinks onBrand={onBrand} />
        {canEdit && HALF_RETRY.includes(halfReason) && retry}
      </div>
    );
  } else if (state === "make-failed") {
    body = (
      <div className="space-y-3">
        <Notice>{error || START_WORDS.makeFailed}</Notice>
        {canEdit && retry}
      </div>
    );
  } else if (state === "ready") {
    const kept = Array.isArray(firstRun.kept) ? firstRun.kept : [];
    body = (
      <div className="space-y-3">
        <p className="text-sm text-foreground">{madeSentence(firstRun.summary, { empty: firstRun.empty }) || START_WORDS.readyNoSummary}</p>
        {kept.includes(DESIGN) && <p className="text-sm text-foreground">{START_WORDS.keptDesign}</p>}
        {openNote}
        <NextLinks onBrand={onBrand} />
        <CatalogNotes firstRun={firstRun} sync={sync} canSync={canSync} onSettled={reload} pollMs={pollMs} />
        {syncShows && !firstRun.empty && <SyncNote sync={sync} canSync={canSync} onSettled={reload} pollMs={pollMs} />}
      </div>
    );
  } else if (state === "kept") {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-foreground">{START_WORDS.keptHome}</p>
        {openNote}
        <NextLinks onBrand={onBrand} />
      </div>
    );
  } else if (state === "syncing" || state === "sync-failed") {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{START_WORDS.syncWaiting}</p>
        {sync && <SyncPanel initial={sync} canRun={canSync} onSettled={reload} pollMs={pollMs} />}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-foreground">{REASON_TEXT(firstRun.reason)}</p>
        {firstRun.reason !== "cannot_edit" && <NextLinks onBrand={onBrand} />}
        {open && syncShows && <SyncNote sync={sync} canSync={canSync} onSettled={reload} pollMs={pollMs} />}
      </div>
    );
  }
  const title = state === "ready" ? (firstRun.summary ? START_WORDS.readyTitle : START_WORDS.keptTitle) : state === "kept" ? START_WORDS.keptTitle : state === "syncing" || state === "sync-failed" ? START_WORDS.syncTitle : START_WORDS.blockedTitle;
  return (
    <section aria-labelledby="starter-store-title" className="space-y-3 rounded-md bg-muted p-4" data-first-run={state}>
      <h3 id="starter-store-title" className="text-base leading-snug font-semibold">
        {title}
      </h3>
      {body}
    </section>
  );
}
const REASON_TEXT = (reason) => REASON_WORDS[reason] || REASON_WORDS.cannot_edit;

// ---- the brand form ---------------------------------------------------------------

function Swatch({ palette, disabled }) {
  const style = paletteStyle(palette.brand);
  return (
    <RadioGroupItem
      value={palette.id}
      disabled={disabled}
      aria-label={palette.label}
      data-palette={palette.id}
      className="flex aspect-auto size-auto flex-col items-stretch gap-2 rounded-md border border-border bg-card p-2 text-left text-sm transition-colors not-disabled:hover:border-muted-foreground/40 motion-reduce:transition-none data-[state=checked]:border-primary data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:ring-1 data-[state=checked]:ring-primary"
    >
      {/* a tiny storefront in the palette's own colours: a page, a button, two lines of text */}
      <span aria-hidden className="flex h-14 flex-col justify-end gap-1.5 rounded-sm border p-2" style={{ ...style, background: "var(--background)", borderColor: "var(--sf-border)" }}>
        <span className="h-1.5 w-10 rounded-full" style={{ background: "var(--sf-text)" }} />
        <span className="flex items-center gap-1.5">
          <span className="h-4 w-8 rounded-full" style={{ background: "var(--accent-500)" }} />
          <span className="h-1.5 w-6 rounded-full" style={{ background: "var(--sf-text-muted)" }} />
        </span>
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{palette.label}</span>
        <span aria-hidden className="hidden size-4 items-center justify-center rounded-full bg-primary text-primary-foreground group-data-[state=checked]/radio-group-item:flex">
          <Check className="size-3" strokeWidth={3} />
        </span>
      </span>
    </RadioGroupItem>
  );
}

// true from 1024px; null until known (nothing mints before then)
function useWide() {
  const [wide, setWide] = useState(null);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mql = matchMedia("(min-width: 1024px)");
    const on = () => setWide(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return wide;
}

export default function BrandStepPanel({ canEdit = false, canSync = false, reason = null, store = null, pollMs = POLL_MS, onChange }) {
  const starter = useStarterStore({ canEdit, onChange });
  const [info, setInfo] = useState(null); // the GET answer
  const [phase, setPhase] = useState("loading"); // loading | idle | load-failed
  const [saved, setSaved] = useState(null); // the form as saved
  const [form, setForm] = useState(null);
  const [revision, setRevision] = useState(null);
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false); // a 409: offer "Load the latest"
  const [keptNote, setKeptNote] = useState(false); // after it: the founder's changes were kept
  const [done, setDone] = useState(null); // the last successful answer
  const [carried, setCarried] = useState(false);
  const [saves, setSaves] = useState(0); // each Save or Skip reloads the preview
  const [sheet, setSheet] = useState(false); // below 1024px: the preview sheet is open
  const [previewOn, setPreviewOn] = useState(false); // the one BrandPreview is mounted (never unmounted after)
  const fileRef = useRef(null);
  const formRef = useRef(null);
  const previewButton = useRef(null);
  const wide = useWide();
  // wide: the preview mounts at once; narrow: on the first open. Either way it
  // then stays mounted: crossing 1024px only moves it (CSS), one session
  useEffect(() => {
    if (wide === true) setPreviewOn(true);
  }, [wide]);
  // the sheet is non-modal (no focus trap, by design): opening moves focus to
  // its close button, closing returns it to the Preview button once that
  // button shows again (it is hidden while the sheet is open)
  const sheetClose = useRef(null);
  const refocus = useRef(false);
  const closeSheet = () => {
    refocus.current = true;
    setSheet(false);
  };
  useEffect(() => {
    if (sheet) sheetClose.current?.focus?.();
    else if (refocus.current) {
      refocus.current = false;
      previewButton.current?.focus?.();
    }
  }, [sheet]);
  // crossing to 1024px and up: the sheet becomes the column, so it closes
  useEffect(() => {
    if (wide === true) setSheet(false);
  }, [wide]);
  useEffect(() => {
    if (!sheet || wide !== false || typeof window === "undefined") return undefined;
    const onKey = (e) => e.key === "Escape" && closeSheet();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, wide]);
  const storeName = store?.name || "";

  const describeOk = Boolean(info?.canEditDescription) && canEdit;
  const max = info?.descriptionMax || DESCRIPTION_MAX;

  function take(data, { restore = false, keep = null } = {}) {
    const s = formOf(data.current);
    setInfo(data);
    setSaved(s);
    setRevision(data.design?.revision ?? null);
    let f = s;
    if (keep && canEdit) {
      // "Load the latest": the founder's changes stay on top of what is saved now
      f = mergeOnLatest(keep.form, keep.saved, s);
      if (!data.canEditDescription) f = { ...f, description: s.description };
    } else if (restore && canEdit) {
      const kept = takeDraft(storage());
      if (kept && isDirty(kept, s)) f = data.canEditDescription ? kept : { ...kept, description: s.description };
    } else clearDraft(storage());
    setForm(f);
  }

  async function load({ restore = false, keep = null } = {}) {
    const r = await call("GET", BRAND_STEP_URL);
    if (r.ok && r.body.ok) {
      take(r.body, { restore, keep });
      setPhase("idle");
    } else {
      setPhase("load-failed");
    }
  }
  useEffect(() => {
    load({ restore: true });
  }, []);

  const dirty = isDirty(form, saved);
  // keep (or clear) the unsaved choices for this tab
  const formKey = JSON.stringify(form);
  useEffect(() => {
    if (canEdit && form && saved) keepDraft(storage(), form, saved);
  }, [formKey, JSON.stringify(saved)]);
  // a page leave with unsaved choices asks first
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return undefined;
    const guard = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const change = (patch) => {
    setDone(null);
    setKeptNote(false);
    setForm((f) => ({ ...f, ...patch }));
  };

  async function send(body, { skip = false } = {}) {
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    setStale(false);
    setDone(null);
    const r = await call("POST", BRAND_STEP_URL, body);
    if (r.ok && r.body.ok) {
      setDone({ ...r.body, lines: savedLines(r.body, { carried: carried && !skip }) });
      if (!skip) setCarried(false);
      if (Number.isInteger(r.body.design?.revision)) setRevision(r.body.design.revision);
      setInfo((i) => (i ? { ...i, storeOpen: Boolean(r.body.storeOpen), brandStep: r.body.brandStep ?? i.brandStep } : i));
      // Save: what was sent is what is saved; Skip: the unsaved choices go
      if (skip) setForm(saved);
      else setSaved({ ...form, description: describeOk ? form.description : saved.description });
      clearDraft(storage());
      setKeptNote(false);
      setSaves((n) => n + 1);
      onChange?.();
    } else if (r.status === 503 && r.body.code === "BRAND_STEP_PARTIAL") {
      // the design IS saved: retry from the revision it now has
      if (Number.isInteger(r.body.design?.revision)) setRevision(r.body.design.revision);
      setCarried(true);
      setError(errorOf(r));
    } else if (r.status === 409 && r.body.code === "DOCUMENT_CHANGED") {
      if (Number.isInteger(r.body.current?.revision)) setRevision(r.body.current.revision);
      setError(BRAND_WORDS.changed);
      setStale(true);
    } else {
      setError(errorOf(r));
    }
    setBusy(false);
  }

  const save = () => send(saveBody({ ...form, canEditDescription: describeOk, revision }));
  const skip = () => send({ skip: true }, { skip: true });
  const undo = () => {
    setDone(null);
    setError(null);
    setForm(saved);
    setKeptNote(false);
    clearDraft(storage());
  };
  async function loadLatest() {
    setError(null);
    setStale(false);
    await load({ keep: { form, saved } });
    setDone(null);
    setKeptNote(true);
  }

  function picked(m) {
    setPicking(false);
    if (!m || typeof m.url !== "string" || !LIBRARY_RE.test(m.url)) {
      setError(BRAND_WORDS.notLibrary);
      return;
    }
    setError(null);
    change({ logo: { media: m.url }, alt: typeof m.alt === "string" ? m.alt.slice(0, ALT_MAX) : "" });
  }
  async function upload(file) {
    if (!file || !canEdit) return;
    setUploading(true);
    setError(null);
    const r = await uploadImage(file);
    if (fileRef.current) fileRef.current.value = "";
    setUploading(false);
    if (!r.ok) return setError(r.message);
    picked({ url: r.media?.url, alt: r.media?.alt || "" });
  }

  const toForm = () => {
    const el = formRef.current;
    if (!el) return;
    el.scrollIntoView?.({ behavior: "smooth", block: "start" });
    el.focus?.({ preventScroll: true });
  };

  const locked = !canEdit || busy;
  const hasHome = hasHomeFor(starter.state, starter.firstRun);
  const message = overlayMessage(form, saved, { storeName });
  const preview = hasHome ? <BrandPreview message={message} canEdit={canEdit} saved={saves} address={store?.address} /> : <p className="rounded-card border border-dashed border-border p-6 text-sm text-muted-foreground" data-preview-waiting="">{PREVIEW_WORDS.noHome}</p>;
  const snippet = snippetOf({ storeName, address: store?.address, description: form?.description });
  const reasonId = "brand-reason";
  const why = !canEdit && reason ? { "aria-describedby": reasonId } : {};

  let formBody;
  if (phase === "loading") formBody = <p className="text-sm text-muted-foreground">{BRAND_WORDS.loading}</p>;
  else if (phase === "load-failed") formBody = <Notice>{BRAND_WORDS.loadFailed}</Notice>;
  else
    formBody = (
      <div className="space-y-6">
        {!canEdit && (
          <Notice tone="info">
            <p id={reasonId} data-onboarding="reason">
              {reason || BRAND_WORDS.readOnly}
            </p>
          </Notice>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{BRAND_WORDS.colours}</legend>
          {form.paletteId == null && <p className="text-[0.8125rem] text-muted-foreground">{BRAND_WORDS.ownColours}</p>}
          <RadioGroup value={form.paletteId ?? ""} onValueChange={(id) => change({ paletteId: id })} disabled={locked} aria-label={BRAND_WORDS.colours} className="grid-cols-2 sm:grid-cols-3" {...why}>
            {PALETTES.map((p) => (
              <Swatch key={p.id} palette={p} disabled={locked} />
            ))}
          </RadioGroup>
        </fieldset>

        <div className="space-y-2" data-brand-logo={form.logo ? "set" : "none"}>
          <p className="text-sm font-medium">{BRAND_WORDS.logo}</p>
          <div className="flex flex-wrap items-center gap-3">
            {form.logo ? (
              <img src={form.logo.media} alt="" className="h-16 w-auto max-w-48 rounded-md border border-border bg-card object-contain p-2" />
            ) : (
              <>
                <span aria-hidden className="flex size-16 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted text-muted-foreground">
                  <ImageIcon className="size-5" />
                </span>
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">{BRAND_WORDS.noLogo}</p>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden disabled={locked || uploading} onChange={(e) => upload(e.target.files?.[0])} data-brand-upload="" />
            <Button variant="outline" size="sm" disabled={locked || uploading} onClick={() => fileRef.current?.click()} {...why}>
              <Upload aria-hidden />
              {uploading ? BRAND_WORDS.uploading : form.logo ? BRAND_WORDS.changeLogo : BRAND_WORDS.uploadLogo}
            </Button>
            <Button variant="outline" size="sm" disabled={locked || uploading} onClick={() => setPicking(true)} {...why}>
              <Library aria-hidden />
              {BRAND_WORDS.pickLogo}
            </Button>
            {form.logo && (
              <Button variant="ghost" size="sm" disabled={locked || uploading} onClick={() => change({ logo: null, alt: "" })} {...why}>
                <Trash2 aria-hidden />
                {BRAND_WORDS.removeLogo}
              </Button>
            )}
          </div>
          {form.logo && (
            <div className="space-y-1.5 pt-1">
              <Label htmlFor="brand-logo-alt">{BRAND_WORDS.logoAlt}</Label>
              <Input id="brand-logo-alt" value={form.alt} maxLength={ALT_MAX} disabled={locked} aria-describedby="brand-logo-alt-hint" onChange={(e) => change({ alt: String(e.target.value) })} />
              <p id="brand-logo-alt-hint" className="text-xs text-muted-foreground">
                {BRAND_WORDS.altHint}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="brand-description">{BRAND_WORDS.description}</Label>
            <span className="font-mono text-xs text-muted-foreground tabular-nums" data-brand-counter="" aria-live="polite">
              {BRAND_WORDS.counter(form.description.length, max)}
            </span>
          </div>
          <Input id="brand-description" value={form.description} maxLength={max} disabled={locked || !describeOk} aria-describedby="brand-description-hint" onChange={(e) => change({ description: String(e.target.value).replace(/[\r\n]+/g, " ").slice(0, max) })} />
          <p id="brand-description-hint" className="text-xs text-muted-foreground">
            {describeOk ? BRAND_WORDS.descriptionHint(max) : BRAND_WORDS.cannotDescribe}
          </p>
          <figure className="mt-3 space-y-2" data-brand-snippet="">
            <figcaption className="text-xs text-muted-foreground">{BRAND_WORDS.snippetLabel}</figcaption>
            <div className="space-y-0.5 rounded-md border border-border bg-card px-3 py-2.5">
              {snippet.url && <p className="truncate text-xs text-muted-foreground">{snippet.url}</p>}
              <p className="truncate text-base font-medium text-foreground">{snippet.title}</p>
              {snippet.text ? <p className="line-clamp-2 text-[0.8125rem] text-muted-foreground">{snippet.text}</p> : <p className="text-[0.8125rem] text-muted-foreground italic">{BRAND_WORDS.snippetEmpty}</p>}
            </div>
          </figure>
        </div>

        <p className="text-sm text-muted-foreground" data-brand-before={info.storeOpen ? "open" : "closed"}>
          {info.storeOpen ? (
            <>
              {BRAND_WORDS.openBefore}{" "}
              <Link href={PUBLISH_HREF} className={linkClass}>
                {BRAND_WORDS.publishLink}
              </Link>
            </>
          ) : (
            BRAND_WORDS.closedBefore
          )}
        </p>

        {error && (
          <Notice>
            <p>{error}</p>
            {stale && (
              <Button variant="outline" size="sm" onClick={loadLatest} data-brand-load-latest="">
                {BRAND_WORDS.loadLatest}
              </Button>
            )}
          </Notice>
        )}

        {done && (
          <Notice tone="success" aria-live="polite" data-brand-done={done.skipped ? "skipped" : "saved"}>
            {done.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <Link href={PREVIEW_HREF} className={linkClass}>
                {BRAND_WORDS.preview}
              </Link>
              <Link href={PUBLISH_HREF} className={linkClass}>
                {info.storeOpen ? BRAND_WORDS.reviewPublish : BRAND_WORDS.reviewOpen}
              </Link>
            </div>
          </Notice>
        )}

        <div className="space-y-3 border-t border-border pt-4">
        {dirty && (
          <p className="flex items-start gap-2 text-[0.8125rem] text-warning-text" role="status" data-brand-dirty="">
            <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-warning" />
            {keptNote ? BRAND_WORDS.keptOnLatest : BRAND_WORDS.unsaved}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={locked || form.paletteId == null} onClick={() => save()} {...why}>
            {busy ? `${BRAND_WORDS.save}…` : BRAND_WORDS.save}
          </Button>
          <Button variant="outline" disabled={locked} onClick={skip} {...why}>
            {BRAND_WORDS.skip}
          </Button>
          {dirty && (
            <Button variant="ghost" disabled={locked} onClick={undo}>
              <RotateCcw aria-hidden />
              {BRAND_WORDS.undo}
            </Button>
          )}
        </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-8" data-brand-panel="">
      <StarterStore starter={starter} canEdit={canEdit} canSync={canSync} pollMs={pollMs} onBrand={toForm} />
      <div className="border-t border-border pt-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
        <section ref={formRef} id={BRAND_FORM_ID} tabIndex={-1} aria-labelledby="brand-form-title" className="min-w-0 space-y-4 outline-none" data-brand-step="">
          <div className="space-y-1">
            <h3 id="brand-form-title" className="text-[1.125rem] leading-snug font-semibold">
              {BRAND_WORDS.title}
            </h3>
            <p className="text-sm text-muted-foreground">{BRAND_WORDS.intro}</p>
          </div>
          {formBody}
        </section>

        {wide !== null && (
          <>
            {/* below 1024px: the sticky Preview button */}
            <div className={cn("sticky bottom-4 z-10 mt-6 flex justify-end lg:hidden", sheet && "hidden")}>
              <Button ref={previewButton} size="lg" className="h-10 px-4 shadow-overlay" onClick={() => (setPreviewOn(true), setSheet(true))} aria-expanded={sheet} aria-controls="brand-preview-slot" data-brand-preview-open="" data-onboarding="view">
                <Eye aria-hidden />
                {PREVIEW_WORDS.open}
              </Button>
            </div>
            {/* the one preview: a sticky column from 1024px, a bottom sheet below (open or hidden) */}
            <div
              id="brand-preview-slot"
              role={wide === false ? "dialog" : undefined}
              aria-modal={wide === false ? "false" : undefined}
              aria-labelledby={wide === false ? "brand-preview-title" : undefined}
              data-brand-sheet=""
              data-state={sheet ? "open" : "closed"}
              className={cn(
                "min-w-0 lg:sticky lg:top-8 lg:z-auto lg:block lg:max-h-none lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none",
                sheet ? "fixed inset-x-0 bottom-0 z-50 max-h-[90vh] overflow-y-auto rounded-t-card border-t border-border bg-popover p-4 shadow-overlay" : "hidden",
              )}
            >
              <div className="mb-3 flex items-center justify-between gap-3 lg:hidden">
                <h3 id="brand-preview-title" className="text-base font-semibold">
                  {PREVIEW_WORDS.title}
                </h3>
                <Button ref={sheetClose} variant="ghost" size="icon-sm" onClick={closeSheet} aria-label={PREVIEW_WORDS.close} data-brand-sheet-close="" data-onboarding="view">
                  <X aria-hidden />
                </Button>
              </div>
              {previewOn && preview}
            </div>
          </>
        )}
      </div>
      {canEdit && (
        <div data-legacy className="contents">
          <MediaPicker open={picking} onClose={() => setPicking(false)} onSelect={picked} />
        </div>
      )}
    </div>
  );
}
