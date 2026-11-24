// P6-BRAND (GEN-04, US-01): the brand step of "Start your store"
// (/admin/start), server side. Node only (behind app/api/admin/brand-step,
// runtime nodejs). It never publishes: colours and the logo go into the
// founder's doc_design DRAFT, and show to shoppers with the founder's next
// Publish (on a closed store, the first one, which opens it).
//
//   readBrandStep({ actor })      what the step shows (GET)
//   saveBrandStep(input, actor)   Save, Remove logo, Skip (POST)
//
// saveBrandStep({ paletteId, logo, description, skip, revision }, actor):
//   skip: true        writes NO document. Records config.onboarding.brand_step
//                     = { …the earlier record, at, skipped: true }, so a
//                     paletteId an earlier save recorded is kept (owner answer
//                     OQ-P6-8: the design settings' Reset goes back to
//                     startingPaletteId(config.onboarding), the founder's
//                     chosen palette). Everything else in the input is ignored.
//   otherwise         paletteId (required, one of PALETTES, else 400) and
//                     logo ({ media, alt } a library file, null = "Remove
//                     logo", left out = keep the current one) go into the
//                     doc_design draft:
//                       the current draft (or emptyBody('design') when there
//                       is none), with settings.brand = a COPY of the
//                       palette's brand (paletteById(...).brand is frozen),
//                       settings.logo as asked, settings.theme kept (the
//                       palette's kit when it is null);
//                     written by createDocument when absent, else saveDraft at
//                     the revision the client sent (or the current one), under
//                     the founder's own actor, so updated_by is the merchant
//                     and the first-run writer skips the design ('founder')
//                     from then on. A founder-owned draft whose content would
//                     not change is not written again (no revision bump for an
//                     editor that has it open).
//                     description (optional): one line, at most 160
//                     characters once trimmed (stricter than Settings' 300 on
//                     purpose: it is the store's one-line description). It is
//                     written only when it differs from config.site.tagline,
//                     and then needs settings.write, the permission the
//                     Settings writer (lib/admin/settings.js, PUT
//                     /api/admin/settings) needs for config.site. A tagline
//                     over 160 that the founder sends back unchanged is kept.
//                     Then ONE control-plane write (patchTenant, the function
//                     the Settings route persists with) merges, into the
//                     latest tenant config read just before it,
//                     config.onboarding.brand_step = { at, skipped: false,
//                     paletteId } and, when changed, config.site.tagline (by
//                     the Settings writer's own tagline rule,
//                     buildSettingsPatch). onboarding.manual and every other
//                     key are kept.
//   Order: every refusal (store, mode, permission, palette, logo, description)
//   is decided before anything is written, so a refusal writes nothing. The
//   document goes first (a stale revision is a 409 and stops there), the
//   config second.
//   Answer: { ok, skipped, design: { id, revision } | null, liveNow:
//   ['description'] when it changed, afterPublish: ['colours', 'logo'] (each
//   when the draft's colours or logo changed), storeOpen, brandStep }. The
//   console says "Your description shows now. Colours and logo show after you
//   publish." from it.
//
// Refusals are DocumentError (a status, a code and plain words) or
// ValidationError (422 with the issues); anything else is infrastructure.
// A store not in documents mode: 500 STORE_MODE_INVALID (lib/cms-mode.js).
import { libsql } from "../db.js";
import { getCmsMode } from "../cms-mode.js";
import { DocumentError, createDocument, saveDraft, getDocument } from "../documents/service.js";
import { singletonId } from "../documents/ids.js";
import { emptyBody, validateDocument, ensureIds, documentHash } from "../registry/index.js";
import { LOGO_MEDIA_RE } from "../registry/settings.js";
import { ValidationError, NotFoundError, issue } from "../cms/issues.js";
import { PALETTES, DEFAULT_PALETTE_ID, paletteById, paletteIdOfBrand, designBodyFor } from "../themes/palettes.js";
import { roleAllows } from "../platform/authz.js";
import { buildSettingsPatch } from "../admin/settings.js";
import { getTenant, patchTenant } from "../platform/control.js";
import { currentTenant } from "../tenant-context.js";
import { slog } from "../log.js";

export const DESIGN_ID = singletonId("design");
export const DESCRIPTION_MAX = 160;
// The permission the Settings writer needs for config.site (PUT /api/admin/settings).
export const DESCRIPTION_PERMISSION = "settings.write";
export const EDIT_PERMISSION = "storefront.write";
const FIRST_RUN_BY = "system:first-run";

export const BRAND_STEP_WORDS = Object.freeze({
  noControlPlane: "This store runs on environment settings, so nothing can be saved here.",
  cannotEdit: "Your role can look at this page but not change it, so nothing was saved.",
  cannotDescribe: "Only the store owner or an admin can change the store's description, so nothing was saved. Leave the description as it is, or ask them to change it.",
  unknownPalette: "Choose one of the colour sets shown, then save again. Nothing was saved.",
  unreadable: "The page sent something we couldn't read, so nothing was saved. Reload the page and try again.",
  descriptionTooLong: `Keep your description to ${DESCRIPTION_MAX} characters or fewer, then save again. Nothing was saved.`,
  logoNotInLibrary: "That picture is no longer in your library, so nothing was saved. Choose another one.",
  configFailed: "Your colours and logo were saved, but your description wasn't. Try saving again.",
  configFailedNoDescription: "Your colours and logo were saved, but this step wasn't marked as done. Try saving again.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = (status, code, message, extra) => new DocumentError(status, code, message, extra);
// The Settings writer's own text rule (lib/admin/settings.js str): trimmed.
const str = (v) => (typeof v === "string" ? v.trim() : "");
// One line: a pasted line break becomes a space.
const oneLine = (v) => (typeof v === "string" ? v.replace(/\s*[\r\n]+\s*/g, " ") : v);

function logoOf(v) {
  if (!isObj(v) || typeof v.media !== "string" || !LOGO_MEDIA_RE.test(v.media)) return null;
  return typeof v.alt === "string" ? { media: v.media, alt: v.alt } : { media: v.media };
}

// 500 STORE_MODE_INVALID (StoreModeInvalidError) on a store not in documents mode
const assertDocumentsStore = () => getCmsMode();

function controlPlaneTenant() {
  const t = currentTenant();
  if (!t || t.id === "_default") throw refuse(409, "STORE_SETTINGS_READ_ONLY", BRAND_STEP_WORDS.noControlPlane);
  return t;
}

// The latest row, read fresh (never the 30 s cache), for the one merged write.
async function latestConfig(id) {
  const t = await getTenant(id, { fresh: true });
  return isObj(t?.config) ? t.config : {};
}

async function readDesign() {
  try {
    return await getDocument(DESIGN_ID);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

async function designUpdatedBy() {
  const r = await libsql.execute({ sql: "SELECT updated_by FROM documents WHERE id = ?", args: [DESIGN_ID] });
  const v = r.rows[0]?.updated_by;
  return v == null ? null : String(v);
}

export async function storeIsOpen() {
  const r = await libsql.execute("SELECT live_release_id FROM release_state WHERE id = 1");
  return r.rows[0]?.live_release_id != null;
}

async function mediaInLibrary(path) {
  const id = path.slice("/api/media/".length);
  const r = await libsql.execute({ sql: "SELECT id FROM media WHERE id = ?", args: [id] });
  return r.rows.length > 0;
}

export const canEditDescription = (actor) => roleAllows(actor?.role, DESCRIPTION_PERMISSION);
const canEditDesign = (actor) => roleAllows(actor?.role, EDIT_PERMISSION);

const paletteChoices = () => PALETTES.map((p) => ({ id: p.id, label: p.label, brand: { ...p.brand } }));

// ---- read ----------------------------------------------------------------------------

// What the brand step shows. Reads only; on a legacy or moving store it
// refuses as a save does (the console's own page sends a legacy store to
// Setup before asking).
//   { brandStep, palettes: [{ id, label, brand }], current: { paletteId, logo,
//     description }, design: { id, revision } | null, storeOpen,
//     canEditDescription, descriptionMax }
// current.paletteId: the palette the draft's brand draws as
// (paletteIdOfBrand), else DEFAULT_PALETTE_ID when the store has no design
// at all (the generator and PUB-12 write slate), else null (the founder made
// their own colours: nothing is preselected).
export async function readBrandStep({ actor = null } = {}) {
  await assertDocumentsStore();
  const tenant = currentTenant();
  const config = isObj(tenant?.config) ? tenant.config : {};
  const design = await readDesign();
  const settings = isObj(design?.body?.settings) ? design.body.settings : {};
  const paletteId = paletteIdOfBrand(settings.brand) || (design ? null : DEFAULT_PALETTE_ID);
  return {
    brandStep: isObj(config.onboarding?.brand_step) ? { ...config.onboarding.brand_step } : null,
    palettes: paletteChoices(),
    current: { paletteId, logo: logoOf(settings.logo), description: typeof config.site?.tagline === "string" ? config.site.tagline : "" },
    design: design ? { id: design.id, revision: design.revision } : null,
    storeOpen: await storeIsOpen(),
    canEditDescription: canEditDescription(actor),
    descriptionMax: DESCRIPTION_MAX,
  };
}

// ---- save ----------------------------------------------------------------------------

function parseInput(input) {
  if (!isObj(input)) throw refuse(400, "BRAND_STEP_UNREADABLE", BRAND_STEP_WORDS.unreadable);
  if (input.skip !== undefined && typeof input.skip !== "boolean") throw refuse(400, "BRAND_STEP_UNREADABLE", BRAND_STEP_WORDS.unreadable);
  if (input.skip === true) return { skip: true };
  if (input.revision !== undefined && input.revision !== null && !Number.isInteger(input.revision)) throw refuse(400, "BRAND_STEP_UNREADABLE", BRAND_STEP_WORDS.unreadable);
  const palette = paletteById(input.paletteId);
  if (!palette) throw refuse(400, "PALETTE_UNKNOWN", BRAND_STEP_WORDS.unknownPalette);
  let logo;
  if (input.logo === undefined) logo = undefined;
  else if (input.logo === null) logo = null;
  else if (isObj(input.logo)) {
    // only the two keys the logo kind takes; the kind checks their values
    logo = { media: input.logo.media };
    if (input.logo.alt !== undefined && input.logo.alt !== null) logo.alt = input.logo.alt;
  } else throw refuse(400, "BRAND_STEP_UNREADABLE", BRAND_STEP_WORDS.unreadable);
  if (input.description !== undefined && input.description !== null && typeof input.description !== "string") throw refuse(400, "BRAND_STEP_UNREADABLE", BRAND_STEP_WORDS.unreadable);
  return { skip: false, palette, logo, description: input.description === undefined ? undefined : oneLine(input.description ?? ""), revision: Number.isInteger(input.revision) ? input.revision : null };
}

// The tagline the Settings writer would store for this text (its own rule).
function settingsTagline(text, config) {
  return buildSettingsPatch({ identity: { tagline: text } }, config).patch.config.site.tagline ?? null;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function saveBrandStep(input, actor) {
  const tenant = controlPlaneTenant();
  const want = parseInput(input);
  await assertDocumentsStore();
  if (!canEditDesign(actor)) throw refuse(403, "BRAND_STEP_NOT_ALLOWED", BRAND_STEP_WORDS.cannotEdit);
  const storeOpen = await storeIsOpen();
  const at = new Date().toISOString();

  if (want.skip) {
    const design = await readDesign();
    const config = await latestConfig(tenant.id);
    const onboarding = isObj(config.onboarding) ? config.onboarding : {};
    const earlier = isObj(onboarding.brand_step) ? onboarding.brand_step : {};
    const brandStep = { ...earlier, at, skipped: true };
    await patchTenant(tenant.id, { config: { onboarding: { ...onboarding, brand_step: brandStep } } });
    return { ok: true, skipped: true, design: design ? { id: design.id, revision: design.revision } : null, liveNow: [], afterPublish: [], storeOpen, brandStep };
  }

  // the description: decided (and refused) before anything is written
  const before = await latestConfig(tenant.id);
  const currentTagline = typeof before.site?.tagline === "string" ? before.site.tagline : "";
  const descriptionChanged = want.description !== undefined && str(want.description) !== str(currentTagline);
  if (descriptionChanged) {
    if (!canEditDescription(actor)) throw refuse(403, "DESCRIPTION_NOT_ALLOWED", BRAND_STEP_WORDS.cannotDescribe);
    if (str(want.description).length > DESCRIPTION_MAX) throw refuse(400, "DESCRIPTION_TOO_LONG", BRAND_STEP_WORDS.descriptionTooLong, { max: DESCRIPTION_MAX });
  }

  // the design body: the current draft with this palette and logo
  const design = await readDesign();
  const base = design && isObj(design.body) ? design.body : emptyBody("design");
  const was = isObj(base.settings) ? base.settings : {};
  const start = designBodyFor(want.palette.id); // fresh copies: the palette itself is frozen
  const settings = {
    ...was,
    brand: start.brand,
    theme: was.theme ?? start.theme,
    logo: want.logo === undefined ? (was.logo ?? null) : want.logo,
  };
  const body = { ...base, type: "design", settings };
  const checked = validateDocument(ensureIds(body), { mode: "draft", documentId: DESIGN_ID });
  if (!checked.ok) throw new ValidationError(checked.issues);
  if (want.logo && !(await mediaInLibrary(want.logo.media))) {
    throw new ValidationError([issue({ documentId: DESIGN_ID, field: "logo.media", code: "LOGO_NOT_IN_LIBRARY", message: BRAND_STEP_WORDS.logoNotInLibrary })]);
  }
  const colours = !sameJson(was.brand, checked.body.settings.brand) || !sameJson(was.theme, checked.body.settings.theme) || !design;
  const logoChanged = !sameJson(logoOf(was.logo), logoOf(checked.body.settings.logo));

  // the document first: a stale revision stops here, before the config
  let saved;
  if (!design) {
    saved = (await createDocument({ type: "design", body, actor })).document;
  } else {
    const unchanged = (await documentHash(checked.body)) === design.draftHash;
    const generatorOwned = (await designUpdatedBy()) === FIRST_RUN_BY;
    const revision = want.revision ?? design.revision;
    if (unchanged && !generatorOwned && revision === design.revision) saved = design;
    else saved = (await saveDraft({ id: DESIGN_ID, revision, body, actor })).document;
  }
  const draftChanged = saved !== design;
  const afterPublish = draftChanged ? [...(colours ? ["colours"] : []), ...(logoChanged ? ["logo"] : [])] : [];

  // then ONE control-plane write, merged into the latest config
  const brandStep = { at, skipped: false, paletteId: want.palette.id };
  try {
    const latest = await latestConfig(tenant.id);
    const patch = { onboarding: { ...(isObj(latest.onboarding) ? latest.onboarding : {}), brand_step: brandStep } };
    if (descriptionChanged) patch.site = { ...(isObj(latest.site) ? latest.site : {}), tagline: settingsTagline(want.description, latest) };
    await patchTenant(tenant.id, { config: patch });
  } catch (e) {
    // the design IS saved: say so, never "nothing was saved" (the raw error
    // goes to the log only)
    slog("brand_step_config_failed", { tenant: tenant.id, error: String(e?.message || e).slice(0, 300) });
    throw refuse(503, "BRAND_STEP_PARTIAL", descriptionChanged ? BRAND_STEP_WORDS.configFailed : BRAND_STEP_WORDS.configFailedNoDescription, { design: { id: saved.id, revision: saved.revision }, retryable: true });
  }
  return {
    ok: true,
    skipped: false,
    design: { id: saved.id, revision: saved.revision },
    liveNow: descriptionChanged ? ["description"] : [],
    afterPublish,
    storeOpen,
    brandStep,
  };
}
