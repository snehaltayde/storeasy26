"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ImagePlus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { cx } from "@/components/console/cx";
import { MediaPicker } from "@/components/admin/cms/MediaPicker";
import { PALETTES } from "@/lib/themes/palettes";
import { brandCssVars } from "@/lib/brand";

// P6-START-UI (GEN-04, US-01): the brand step of "Start your store", at
// /admin/start#brand. It reads GET /api/admin/brand-step and saves with POST
// /api/admin/brand-step (lib/first-run/brand-step.js):
//   Save         { paletteId, logo: { media, alt? } | null, description?, revision }
//   Remove logo  the same Save with logo: null
//   Skip         { skip: true }
// The six colour sets come from lib/themes/palettes.js; each swatch is drawn
// with the palette's own variables (lib/brand.js brandCssVars), so it shows
// the colours the store will use. The current palette is preselected
// (current.paletteId: slate on a generated store), so Save with no change is
// one click. The logo comes from the media library (MediaPicker). The
// description is one line of at most 160 characters; a role that can't change
// it (canEditDescription false) sees it disabled and never sends it.
//
// A save whose design was stored but whose step record wasn't (503
// BRAND_STEP_PARTIAL) carries the design's new revision: the next Save sends
// THAT revision, and because the colours and logo were already saved, the
// answer still tells the founder they show after Publish even when the retry
// itself changed nothing.
// Read-only (canEdit false): the step is shown, nothing can be chosen, and it
// never POSTs.

export const BRAND_STEP_URL = "/api/admin/brand-step";
export const PUBLISH_HREF = "/admin/editor?doc=doc_home";
export const PREVIEW_HREF = "/admin/editor";
const KIT = "pulse-1";

export const BRAND_WORDS = Object.freeze({
  title: "Colours, logo and description",
  intro: "Pick the colours your store uses, add your logo, and say in one line what you sell.",
  loading: "Loading your colours and logo…",
  loadFailed: "We couldn't load your colours and logo just now. Reload the page to try again.",
  colours: "Colours",
  ownColours: "Your store uses colours you chose yourself. Choose a colour set here to replace them, or skip to keep yours.",
  logo: "Logo",
  noLogo: "No logo yet. Your store name shows instead.",
  pickLogo: "Choose a logo",
  changeLogo: "Change logo",
  removeLogo: "Remove logo",
  logoAlt: "Logo description (for screen readers)",
  altHint: "If empty, your store name is used.",
  notLibrary: "Choose a picture from your library for the logo.",
  description: "One-line description",
  descriptionHint: (max) => `Up to ${max} characters. It shows under your store name in search results and when your store is shared.`,
  cannotDescribe: "Only the store owner or an admin can change the store's description.",
  readOnly: "Your role can look at this page but not change it.",
  closedBefore: "Nothing shows to shoppers until you open your store.",
  openBefore: "Your description shows now. Colours and logo show after you publish.",
  publishLink: "Publish in the editor",
  save: "Save",
  skip: "Skip for now",
  saved: "Saved.",
  skipped: "Skipped. You can come back to this any time.",
  descriptionLiveNow: "Your description shows now.",
  descriptionWaits: "Your description is saved. Shoppers see it once you open your store.",
  afterPublish: "Your colours and logo are saved. They show after you publish.",
  preview: "See it in the preview",
  reviewOpen: "Review and open your store",
  reviewPublish: "Review and publish",
  changed:
    "Your colours or logo were changed somewhere else (in the editor, maybe) since this page opened, so nothing was saved. Check your choices here, then save again.",
  failed: "We couldn't save just now. Check your connection, then try again.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const LIBRARY_RE = /^\/api\/media\/[A-Za-z0-9_-]{1,120}$/;

// One palette's variables as a React style object, from brandCssVars'
// ":root{--name:value;…}", so a swatch draws with the store's own colours.
export function paletteStyle(brand) {
  const css = brandCssVars(brand, { kit: KIT });
  const inner = css.replace(/^:root\{/, "").replace(/\}$/, "");
  const style = {};
  for (const decl of inner.split(";")) {
    const at = decl.indexOf(":");
    if (at > 0) style[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return style;
}

// What Save sends. The logo is the one shown (null after Remove logo); the
// alt is left out when empty (the store name is used). The description goes
// only to a role that may change it. `revision` is the design's: the one GET
// gave, or the one a partial save answered with.
export function saveBody({ paletteId, logo, alt, description, canEditDescription, revision }) {
  const body = { paletteId };
  body.logo = logo ? { media: logo.media, ...(typeof alt === "string" && alt.trim() ? { alt: alt.trim() } : {}) } : null;
  if (canEditDescription) body.description = typeof description === "string" ? description : "";
  if (Number.isInteger(revision)) body.revision = revision;
  return body;
}

// The founder's words for a save's answer. `carried`: an earlier save in this
// visit stored the colours and logo but not the step record (503
// BRAND_STEP_PARTIAL), so they still wait for Publish whatever this one says.
export function savedLines(answer, { carried = false } = {}) {
  if (answer?.skipped) return [BRAND_WORDS.skipped];
  const lines = [BRAND_WORDS.saved];
  if (Array.isArray(answer?.liveNow) && answer.liveNow.includes("description")) lines.push(answer.storeOpen ? BRAND_WORDS.descriptionLiveNow : BRAND_WORDS.descriptionWaits);
  if ((Array.isArray(answer?.afterPublish) && answer.afterPublish.length > 0) || carried) lines.push(BRAND_WORDS.afterPublish);
  return lines;
}

async function call(method, body) {
  const init = { method, headers: { Accept: "application/json" }, cache: "no-store" };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(BRAND_STEP_URL, init);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body: isObj(data) ? data : {} };
  } catch {
    return { status: 0, ok: false, body: {} };
  }
}

const errorOf = (r) => {
  if (Array.isArray(r.body.errors) && r.body.errors.length) return r.body.errors.join(" ");
  if (typeof r.body.error === "string" && r.body.error && r.status > 0 && r.status < 500) return r.body.error;
  if (r.body.code === "BRAND_STEP_PARTIAL" && r.body.error) return r.body.error;
  return BRAND_WORDS.failed;
};

function Swatch({ palette, selected, disabled, onPick }) {
  const style = paletteStyle(palette.brand);
  return (
    <label
      className={cx(
        "flex cursor-pointer flex-col gap-2 rounded-ctl border p-2 text-sm focus-within:ring-2 focus-within:ring-primary",
        selected ? "border-primary ring-1 ring-primary" : "border-edge",
        disabled && "cursor-not-allowed opacity-70",
      )}
      data-palette={palette.id}
    >
      <input type="radio" name="palette" aria-label={palette.label} value={palette.id} checked={selected} disabled={disabled} onChange={() => onPick(palette.id)} className="sr-only" />
      <span aria-hidden className="flex h-14 items-end gap-1.5 rounded-[6px] border p-2" style={{ ...style, background: "var(--background)", borderColor: "var(--sf-border)" }}>
        <span className="h-6 w-10 rounded-full" style={{ background: "var(--accent-500)" }} />
        <span className="h-2 w-8 rounded-full" style={{ background: "var(--sf-text)" }} />
        <span className="h-2 w-5 rounded-full" style={{ background: "var(--sf-text-muted)" }} />
      </span>
      <span className="font-medium text-fg">{palette.label}</span>
    </label>
  );
}

export default function BrandStep({ canEdit = false }) {
  const [info, setInfo] = useState(null); // the GET answer
  const [phase, setPhase] = useState("loading"); // loading | idle | load-failed
  const [paletteId, setPaletteId] = useState(null);
  const [logo, setLogo] = useState(null);
  const [alt, setAlt] = useState("");
  const [description, setDescription] = useState("");
  const [revision, setRevision] = useState(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // the last successful answer
  const [carried, setCarried] = useState(false);

  function take(data) {
    setInfo(data);
    setPaletteId(data.current?.paletteId ?? null);
    setLogo(data.current?.logo ?? null);
    setAlt(data.current?.logo?.alt ?? "");
    setDescription(data.current?.description ?? "");
    setRevision(data.design?.revision ?? null);
  }

  async function load() {
    const r = await call("GET");
    if (r.ok && r.body.ok) {
      take(r.body);
      setPhase("idle");
    } else {
      setPhase("load-failed");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function send(body, { skip = false } = {}) {
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const r = await call("POST", body);
    if (r.ok && r.body.ok) {
      setDone({ ...r.body, lines: savedLines(r.body, { carried: carried && !skip }) });
      if (!skip) setCarried(false);
      if (Number.isInteger(r.body.design?.revision)) setRevision(r.body.design.revision);
      setInfo((i) => (i ? { ...i, storeOpen: Boolean(r.body.storeOpen), brandStep: r.body.brandStep ?? i.brandStep } : i));
    } else if (r.status === 503 && r.body.code === "BRAND_STEP_PARTIAL") {
      // the design IS saved: retry from the revision it now has
      if (Number.isInteger(r.body.design?.revision)) setRevision(r.body.design.revision);
      setCarried(true);
      setError(errorOf(r));
    } else if (r.status === 409 && r.body.code === "DOCUMENT_CHANGED") {
      if (Number.isInteger(r.body.current?.revision)) setRevision(r.body.current.revision);
      setError(BRAND_WORDS.changed);
    } else {
      setError(errorOf(r));
    }
    setBusy(false);
  }

  const save = () => send(saveBody({ paletteId, logo, alt, description, canEditDescription: Boolean(info?.canEditDescription), revision }));
  const skip = () => send({ skip: true }, { skip: true });
  // Remove logo takes it off this form; the next Save sends logo: null.
  function removeLogo() {
    setLogo(null);
    setAlt("");
    setDone(null);
  }
  function picked(m) {
    setPicking(false);
    if (!m || typeof m.url !== "string" || !LIBRARY_RE.test(m.url)) {
      setError(BRAND_WORDS.notLibrary);
      return;
    }
    setError(null);
    setLogo({ media: m.url });
    setAlt(typeof m.alt === "string" ? m.alt : "");
  }

  const max = info?.descriptionMax || 160;
  const storeOpen = Boolean(info?.storeOpen);
  const describeOk = Boolean(info?.canEditDescription);
  const locked = !canEdit || busy;

  let body;
  if (phase === "loading") body = <p className="text-sm text-fg-muted">{BRAND_WORDS.loading}</p>;
  else if (phase === "load-failed")
    body = (
      <Banner tone="danger">
        <p>{BRAND_WORDS.loadFailed}</p>
      </Banner>
    );
  else
    body = (
      <div className="space-y-5">
        {!canEdit && (
          <Banner tone="info">
            <p>{BRAND_WORDS.readOnly}</p>
          </Banner>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-fg-muted">{BRAND_WORDS.colours}</legend>
          {paletteId == null && <p className="text-xs text-fg-muted">{BRAND_WORDS.ownColours}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PALETTES.map((p) => (
              <Swatch key={p.id} palette={p} selected={paletteId === p.id} disabled={locked} onPick={setPaletteId} />
            ))}
          </div>
        </fieldset>

        <div className="space-y-2">
          <p className="text-xs font-medium text-fg-muted">{BRAND_WORDS.logo}</p>
          {logo ? (
            <div className="flex items-center gap-3">
              <img src={logo.media} alt="" className="h-12 w-auto max-w-40 rounded border border-edge bg-surface object-contain p-1" />
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={<ImagePlus size={14} aria-hidden />} disabled={busy} onClick={() => setPicking(true)}>
                    {BRAND_WORDS.changeLogo}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} aria-hidden />} disabled={busy} onClick={removeLogo}>
                    {BRAND_WORDS.removeLogo}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-fg-muted">{BRAND_WORDS.noLogo}</p>
              {canEdit && (
                <Button size="sm" icon={<ImagePlus size={14} aria-hidden />} disabled={busy} onClick={() => setPicking(true)}>
                  {BRAND_WORDS.pickLogo}
                </Button>
              )}
            </div>
          )}
          {logo && (
            <Field label={BRAND_WORDS.logoAlt} hint={BRAND_WORDS.altHint} htmlFor="brand-logo-alt">
              <Input id="brand-logo-alt" value={alt} maxLength={300} disabled={locked} aria-describedby="fd-brand-logo-alt" onChange={(e) => setAlt(e.target.value)} />
            </Field>
          )}
        </div>

        <Field label={BRAND_WORDS.description} hint={describeOk ? BRAND_WORDS.descriptionHint(max) : BRAND_WORDS.cannotDescribe} htmlFor="brand-description">
          <Input
            id="brand-description"
            value={description}
            maxLength={max}
            disabled={locked || !describeOk}
            aria-describedby="fd-brand-description"
            onChange={(e) => setDescription(String(e.target.value).replace(/[\r\n]+/g, " "))}
          />
        </Field>

        <p className="text-sm text-fg-muted" data-brand-before={storeOpen ? "open" : "closed"}>
          {storeOpen ? (
            <>
              {BRAND_WORDS.openBefore}{" "}
              <Link href={PUBLISH_HREF} className="font-medium text-primary underline underline-offset-2">
                {BRAND_WORDS.publishLink}
              </Link>
            </>
          ) : (
            BRAND_WORDS.closedBefore
          )}
        </p>

        {error && (
          <Banner tone="danger">
            <p>{error}</p>
          </Banner>
        )}

        {done && (
          <div className="space-y-2 rounded-ctl border border-edge bg-surface-sunken p-3" aria-live="polite" data-brand-done={done.skipped ? "skipped" : "saved"}>
            {done.lines.map((l) => (
              <p key={l} className="text-sm text-fg">
                {l}
              </p>
            ))}
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              <Link href={PREVIEW_HREF} className="font-medium text-primary underline underline-offset-2">
                {BRAND_WORDS.preview}
              </Link>
              <Link href={PUBLISH_HREF} className="font-medium text-primary underline underline-offset-2">
                {storeOpen ? BRAND_WORDS.reviewPublish : BRAND_WORDS.reviewOpen}
              </Link>
            </div>
          </div>
        )}

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy} disabled={paletteId == null} onClick={() => save()}>
              {BRAND_WORDS.save}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={skip}>
              {BRAND_WORDS.skip}
            </Button>
          </div>
        )}
      </div>
    );

  return (
    <Card id="brand">
      <div data-brand-step="">
        <CardHeader title={BRAND_WORDS.title} description={BRAND_WORDS.intro} />
        {body}
      </div>
      {canEdit && <MediaPicker open={picking} onClose={() => setPicking(false)} onSelect={picked} />}
    </Card>
  );
}
