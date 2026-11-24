// The onboarding Brand step's model (Phase 1 line 6): pure, no React. Moved
// here from components/admin/first-run/FirstRun.js and BrandStep.js (retired)
// and extended with the live preview's overlay message and the unsaved
// choices' keep / undo / clear.
//
// The starter store: GET /api/admin/first-run says what was made, whether it
// can be made now, and the catalog sync's progress; when the store can be made
// and isn't yet, POST /api/admin/first-run is asked ONCE (useStarterStore.js).
// Which view shows (viewOf, first match wins):
//   1. a home page the generator made        "ready": what was made (from the
//                                            server's summary), what was kept,
//                                            where to change each part; a later
//                                            sync that runs or failed is a note
//   2. a home page the founder started       "kept"
//   3. the catalog isn't in yet, or its      "syncing" / "sync-failed": the
//      sync failed                           sync's own progress and retry
//   4. it can be made and isn't yet          "make" (the POST: "making", then
//                                            "ready"; a failed POST
//                                            "make-failed"; a POST that made
//                                            the home page and stopped before
//                                            the colours "half")
//   otherwise                                "blocked": the reason in words
//
// The brand form: POST /api/admin/brand-step (lib/first-run/brand-step.js)
//   Save   { paletteId, logo: { media, alt? } | null, description?, revision }
//   Skip   { skip: true }
// A save whose design was stored but whose step record wasn't (503
// BRAND_STEP_PARTIAL) carries the design's new revision: the next Save sends
// THAT revision, and the answer still says the colours show after Publish.
// Founder words only: never a command, a status code or a raw error.
import { paletteById } from "@/lib/themes/palettes";
import { brandCssVars } from "@/lib/brand";

export const FIRST_RUN_URL = "/api/admin/first-run";
export const BRAND_STEP_URL = "/api/admin/brand-step";
// The editor at the home page: where the founder edits it, and where the
// editor's Publish is (lib/admin/editor-entry.js EDITOR_PUBLISH_HREF).
export const EDIT_HOME_HREF = "/admin/editor?doc=doc_home";
export const PUBLISH_HREF = "/admin/editor?doc=doc_home";
export const PREVIEW_HREF = "/admin/editor";
export const BRAND_FORM_ID = "brand";
const KIT = "pulse-1";

export const LIVE = new Set(["running", "retrying"]);
export const BROKEN = new Set(["failed", "stalled"]);
const HOME = "doc_home";
export const DESIGN = "doc_design";

export const START_WORDS = Object.freeze({
  loading: "Loading your store…",
  loadFailed: "We couldn't load your starting store just now. Reload the page to try again.",
  making: "Making your starting store from your products…",
  makeFailed: "We couldn't make your starting store. Try again.",
  tryAgain: "Try again",
  readyTitle: "Your starting store is ready",
  readyNoSummary: "Your home page is ready in the editor.",
  keptTitle: "Your home page",
  keptHome: "We kept the home page you already started.",
  keptDesign: "We kept the colours you already chose.",
  closed: "Nothing is public yet.",
  open: "Your store is open. Changes you make show to shoppers after you publish.",
  editHome: "Edit the home page",
  changeBrand: "Change colours and logo",
  empty: "Your Shopify store has no products yet. Add products in Shopify, then sync again.",
  emptyRefill: "If you haven't changed your home page, product rows appear after your next sync. Otherwise add them in the editor.",
  noCollections:
    "Your products have no collections in Shopify yet, so your home page shows your newest products. Add collections in Shopify to get collection rows.",
  syncTitle: "Your products from Shopify",
  syncWaiting: "Your starting store is made as soon as your products are in.",
  syncNote: "Your products are being brought in again",
  blockedTitle: "Your starting store",
});

// The reasons nothing was made (lib/first-run/generate.js FIRST_RUN_WORDS,
// which is Node only), for the views that show one.
export const REASON_WORDS = Object.freeze({
  cannot_edit: "Only someone who can edit this store can make its starting pages.",
  migrating: "Your store is being updated. Try again in a few minutes.",
  live: "Your store is already open, so the starting store wasn't made again. Your live store hasn't changed.",
  race: "Your store changed while the starting store was being made, so nothing was saved. Try again.",
  home_left_for_founder: "Your home page is open in the editor, so it was left for you.",
  legacy: "This store still uses the current Storefront editor, so no starting store was made here.",
});

// P6-FIX3: a run that made the home page and stopped before the colours
// (the POST's ran:false with homeWritten: true), by reason. The same words as
// lib/first-run/generate.js FIRST_RUN_HALF_WORDS (Node only; test-first-run
// checks they match). Never "We couldn't make your starting store" or
// "nothing was saved": the home page was made.
export const HALF_WORDS = Object.freeze({
  race: "Your home page was made, but your colours were not, because your store changed at the same time. Try again.",
  live: "Your home page was made, but your colours were not, because your store opened at the same time. Your live store hasn't changed.",
  catalog_not_confirmed: "Your home page was made, but your colours were not, because your products are being brought in again. Try again once they have all arrived.",
  other: "Your home page was made, but your colours were not. Try again.",
});
// the half-finished reasons where pressing Try again here can help
export const HALF_RETRY = Object.freeze(["race", "catalog_not_confirmed", "other"]);
export const halfWords = (reason) => HALF_WORDS[Object.hasOwn(HALF_WORDS, reason) ? reason : "other"];

export const BRAND_WORDS = Object.freeze({
  title: "Colours, logo and description",
  intro: "Pick the colours your store uses, add your logo, and say in one line what you sell.",
  loading: "Loading your colours and logo…",
  loadFailed: "We couldn't load your colours and logo just now. Reload the page to try again.",
  colours: "Colours",
  ownColours: "Your store uses colours you chose yourself. Choose a colour set here to replace them, or skip to keep yours.",
  logo: "Logo",
  noLogo: "No logo yet. Your store name shows instead.",
  uploadLogo: "Upload a logo",
  pickLogo: "Choose from your library",
  changeLogo: "Change logo",
  removeLogo: "Remove logo",
  uploading: "Uploading your logo…",
  logoAlt: "Logo description (for screen readers)",
  altHint: "If empty, your store name is used.",
  notLibrary: "Choose a picture from your library for the logo.",
  description: "One-line description",
  descriptionHint: (max) => `Up to ${max} characters. It shows under your store name in search results and when your store is shared.`,
  counter: (n, max) => `${n}/${max}`,
  snippetLabel: "How your store can look in search results",
  snippetEmpty: "Your one-line description shows here.",
  cannotDescribe: "Only the store owner or an admin can change the store's description.",
  readOnly: "Your role can look at this page but not change it.",
  closedBefore: "Nothing shows to shoppers until you open your store.",
  openBefore: "Your description shows now. Colours and logo show after you publish.",
  publishLink: "Publish in the editor",
  save: "Save",
  skip: "Skip for now",
  undo: "Undo my changes",
  unsaved: "Unsaved changes. They show in the preview, and nowhere else, until you save.",
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
  loadLatest: "Load the latest",
  keptOnLatest: "We loaded the latest saved version and kept the changes you made here on top of it. Check them, then save.",
  failed: "We couldn't save just now. Check your connection, then try again.",
});

export const PREVIEW_WORDS = Object.freeze({
  title: "Preview",
  open: "Preview",
  close: "Close preview",
  phone: "Phone",
  computer: "Computer",
  width: "Preview width",
  noHome: "Your preview appears once your starting store is made.",
  frameTitle: "Your store's home page, with your unsaved choices",
  readOnly: "The preview shows what is saved.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const LIBRARY_RE = /^\/api\/media\/[A-Za-z0-9_-]{1,120}$/;
export const DESCRIPTION_MAX = 160;
export const ALT_MAX = 300;

const list = (items) => {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs.join("");
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
};
const series = (items) => {
  const xs = items.filter(Boolean);
  if (xs.length <= 2) return list(xs);
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
};

// What was made, in one sentence, from the server's summary
// ({ heroImage: { productTitle } | null, collections, rails, paletteId }).
// Nothing in it is fixed text about the catalog: every name comes from the
// summary. null when there is no summary (the home isn't the generator's).
export function madeSentence(summary, { empty = false } = {}) {
  if (!summary || typeof summary !== "object") return null;
  const parts = ["your store name"];
  const photo = summary.heroImage?.productTitle;
  if (photo) parts.push(`a photo of ${photo}`);
  const rails = Array.isArray(summary.rails) ? summary.rails.filter((x) => typeof x === "string" && x.trim()) : [];
  if (rails.length) parts.push(`${rails.length === 1 ? "a row" : "rows"} for ${list(rails)}`);
  if (Array.isArray(summary.collections) && summary.collections.length) parts.push("a grid of your collections");
  if (!empty) parts.push("a row of your newest products");
  const palette = paletteById(summary.paletteId);
  if (palette) parts.push(`the ${palette.label} colours`);
  return `A home page with ${series(parts)}.`;
}

// The view for what the server said (first match wins; see the top).
export function viewOf(firstRun, sync) {
  if (!firstRun) return "loading";
  const kept = Array.isArray(firstRun.kept) ? firstRun.kept : [];
  const mine = Array.isArray(firstRun.byGenerator) ? firstRun.byGenerator : [];
  if (firstRun.generated) {
    if (mine.includes(HOME) || firstRun.summary) return "ready";
    if (kept.includes(HOME)) return "kept";
    if (firstRun.eligible) return "make"; // an untouched, empty home page: filled from the catalog
    return "ready";
  }
  if (firstRun.reason === "founder_started") return "kept";
  // an open store already has its home page: describeFirstStore stops at the
  // live check before reading rows, so generated is false here. Never the
  // "made as soon as your products are in" view, even while a later sync runs
  // or after it failed (the blocked view keeps a small sync note).
  if (firstRun.reason === "live") return "blocked";
  const state = sync?.state;
  if (firstRun.reason === "catalog_not_confirmed" || LIVE.has(state) || BROKEN.has(state)) return BROKEN.has(state) ? "sync-failed" : "syncing";
  if (firstRun.eligible) return "make";
  return "blocked";
}

// The description after a POST that ran: the store now has its home page.
export function afterMake(prev, r) {
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const kept = skipped.filter((s) => s?.reason === "founder").map((s) => s.id);
  const byGenerator = [...(r?.created || []), ...(r?.refilled || []), ...(r?.unchanged || [])];
  return {
    ...(prev || {}),
    eligible: false,
    reason: null,
    generated: true,
    byGenerator,
    kept,
    summary: kept.includes(HOME) ? null : r?.summary ?? null,
    empty: prev?.empty ?? r?.products === 0,
  };
}

// Whether the store has a home page to preview: a ready or kept view, a
// half-finished run (the home page was made), or an open store.
export const hasHomeFor = (state, firstRun) => state === "ready" || state === "kept" || state === "half" || firstRun?.reason === "live";

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

// A refused or failed request's words.
export function errorOf(r) {
  if (Array.isArray(r?.body?.errors) && r.body.errors.length) return r.body.errors.join(" ");
  if (typeof r?.body?.error === "string" && r.body.error && r.status > 0 && r.status < 500) return r.body.error;
  if (r?.body?.code === "BRAND_STEP_PARTIAL" && r.body.error) return r.body.error;
  return BRAND_WORDS.failed;
}

// ---- the form: saved, unsaved, kept across reloads ---------------------------------------

// The form as the GET answer has it saved.
export function formOf(current) {
  const c = isObj(current) ? current : {};
  const logo = isObj(c.logo) && typeof c.logo.media === "string" ? { media: c.logo.media } : null;
  return {
    paletteId: typeof c.paletteId === "string" ? c.paletteId : null,
    logo,
    alt: logo && typeof c.logo.alt === "string" ? c.logo.alt : "",
    description: typeof c.description === "string" ? c.description : "",
  };
}

export function isDirty(form, saved) {
  if (!form || !saved) return false;
  return (form.paletteId ?? null) !== (saved.paletteId ?? null) || (form.logo?.media ?? null) !== (saved.logo?.media ?? null) || (form.logo ? (form.alt || "").trim() : "") !== (saved.logo ? (saved.alt || "").trim() : "") || (form.description ?? "") !== (saved.description ?? "");
}

// The message the preview frame draws (components/preview/bridge-core.js
// look mode). A form equal to what is saved is all null: the frame shows the
// page as it rendered (the saved drafts). Otherwise every field is the
// form's: the palette id (null keeps the page's own colours, the founder's
// own), the logo (false: no picture, the store name shows; the alt falls back
// to the store name) and the description.
export const CLEAR_MESSAGE = Object.freeze({ type: "storeasy:brand", paletteId: null, logo: null, description: null });
export function overlayMessage(form, saved, { storeName = "" } = {}) {
  if (!form || !isDirty(form, saved)) return { ...CLEAR_MESSAGE };
  return {
    type: "storeasy:brand",
    paletteId: paletteById(form.paletteId) ? form.paletteId : null,
    logo: form.logo && LIBRARY_RE.test(form.logo.media) ? { media: form.logo.media, alt: (form.alt || "").trim() || storeName || "" } : false,
    description: typeof form.description === "string" ? form.description.slice(0, DESCRIPTION_MAX) : null,
  };
}

// "Load the latest" after a 409: what is saved now, with each choice the
// founder changed here (form against the save it started from) kept on top.
// The logo and its alt go together.
export function mergeOnLatest(form, before, latest) {
  if (!form || !before) return latest;
  const out = { ...latest };
  if ((form.paletteId ?? null) !== (before.paletteId ?? null)) out.paletteId = form.paletteId ?? null;
  if ((form.logo?.media ?? null) !== (before.logo?.media ?? null) || (form.alt || "").trim() !== (before.alt || "").trim()) {
    out.logo = form.logo ? { media: form.logo.media } : null;
    out.alt = form.logo ? form.alt || "" : "";
  }
  if ((form.description ?? "") !== (before.description ?? "")) out.description = form.description ?? "";
  return out;
}

// Unsaved choices are kept in sessionStorage (this tab, this store's origin)
// across step switches and reloads, and cleared on Save, Skip and Undo.
export const DRAFT_KEY = "storeasy:onboarding:brand";
export function draftText(form) {
  return JSON.stringify({ v: 1, form });
}
// The kept choices, checked as anything read from storage is: a known
// palette or null, a library logo or none, text capped. Not usable: null.
export function readDraft(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(d) || d.v !== 1 || !isObj(d.form)) return null;
  const f = d.form;
  if (f.paletteId != null && !paletteById(f.paletteId)) return null;
  if (f.logo != null && !(isObj(f.logo) && typeof f.logo.media === "string" && LIBRARY_RE.test(f.logo.media))) return null;
  return {
    paletteId: f.paletteId ?? null,
    logo: f.logo ? { media: f.logo.media } : null,
    alt: f.logo && typeof f.alt === "string" ? f.alt.slice(0, ALT_MAX) : "",
    description: typeof f.description === "string" ? f.description.replace(/[\r\n]+/g, " ").slice(0, DESCRIPTION_MAX) : "",
  };
}
// storage that throws (private mode, blocked) only loses the keeping
export function keepDraft(storage, form, saved) {
  try {
    if (!storage) return;
    if (form && isDirty(form, saved)) storage.setItem(DRAFT_KEY, draftText(form));
    else storage.removeItem(DRAFT_KEY);
  } catch {
    /* not kept */
  }
}
export function takeDraft(storage) {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    return raw ? readDraft(raw) : null;
  } catch {
    return null;
  }
}
export function clearDraft(storage) {
  try {
    storage?.removeItem(DRAFT_KEY);
  } catch {
    /* nothing kept */
  }
}

// The search-result snippet: the store's name, its address and the line.
export function snippetOf({ storeName = "", address = "", description = "" } = {}) {
  return { title: storeName || "", url: address ? `https://${String(address).replace(/^https?:\/\//, "")}` : "", text: String(description || "").slice(0, DESCRIPTION_MAX) };
}
