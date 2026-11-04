// Theme kits (Session 37 / MC07 + OP07). Pure data + apply logic.
//
// A KIT is a named, versioned look for a vertical: brand-token defaults, a
// display-font choice, surface styling (header/hero/footer colors via the
// [data-kit="<id>-<version>"] CSS blocks in globals.css) and optional content
// presets. The platform's own look is the `pulse` kit (nutrition /
// performance — the original BeastLife-derived design); `glow` (beauty /
// self-care) is the second kit, proving two tenants on one codebase can look
// like different products.
//
// Pinning (OP07): a tenant's config.theme = { kit, version, applied_at } is
// an EXPLICIT pin — nothing upgrades it silently. The kit's CSS is keyed by
// "<id>-<version>", so shipping glow v2 adds a NEW css block and v1 tenants
// keep rendering v1 until a merchant applies the upgrade (which, like every
// content change since S36, is draft-until-publish for released stores).
// Within one version the CSS is code and bugfixes apply — that's the deal.
//
// applyKit NEVER touches the live release pointer: it writes draft state
// (config.theme + config.brand defaults + optional preset blocks) only.
// P2-WRITERS: the hero preset goes through lib/content-writes.js.
//
// P3-DESIGN (TOK-03): on a documents store the theme pin and brand live in
// the design document (doc_design, settings { brand, theme }). applyKit then
// saves a DRAFT of doc_design through the documents service (validated,
// revision-checked, checkpointed) and never touches config.theme or
// config.brand; nothing publishes. The caller hands the service in as
// opts.documents (lib/documents/service.js is Node-only and this module is
// reachable from the storefront). Without it a documents store refuses (409,
// nothing written): fail closed. A 'migrating' store refuses as before.
//
// This file is on the TOK-03 guard's allowlist (scripts/test-design-doc.js):
// it reads config.theme and config.brand only on the legacy path and in
// draftDesignOf / themePinOf below, which other files use instead of reading
// those keys themselves.
import { patchTenant } from "../platform/control.js";
import { currentTenant, tenantOwnCfg } from "../tenant-context.js";
import { validateBlock } from "../cms/validate.js";
import { getCmsMode, StoreUsesDocumentsError } from "../cms-mode.js";
// lib/content-writes.js and lib/registry are loaded with import() in applyKit,
// so a storefront request (kitAttr in the layout) never runs them. The
// documents service is handed in by the caller (see above).
import { audit } from "../platform/audit.js";
import { slog } from "../log.js";

export const KITS = {
  pulse: {
    id: "pulse",
    version: 1,
    label: "Pulse",
    vertical: "Nutrition & performance",
    description: "High-energy and bold: dark header and hero, punchy accent, tight sans type. The original storeasy look.",
    fonts: { display: "sans" },
    brand: { accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "md", type_scale: "regular" },
    // preview swatches for the library card (first = accent)
    swatch: ["#84cc16", "#0a0a0b", "#ffffff"],
    presets: {
      hero: {
        title: "Fuel the work.",
        highlight: "Fuel",
        subtitle: "Proteins, pre-workouts and daily essentials — live offers, fast checkout.",
        primary: { label: "Shop all collections", href: "/collections" },
        secondary: { label: "See what’s new", href: "#new" },
      },
    },
  },
  glow: {
    id: "glow",
    version: 1,
    label: "Glow",
    vertical: "Beauty & self-care",
    description: "Soft and editorial: airy light surfaces, warm rose accent, serif display type, generous corners.",
    fonts: { display: "serif" },
    brand: { accent: "#e11d48", background: "#fffbf7", foreground: "#1c1917", radius: "xl", type_scale: "regular" },
    swatch: ["#e11d48", "#fff1ee", "#1c1917"],
    presets: {
      hero: {
        title: "Your glow, daily.",
        highlight: "glow",
        subtitle: "Skincare and self-care rituals, picked with love — delivered fast.",
        primary: { label: "Shop the edit", href: "/collections" },
        secondary: { label: "What’s new", href: "#new" },
      },
    },
  },
};

// What a founder hears when the theme and brand went in but the hero preset
// lost a race with someone else's hero edit (P2-FIX4).
export const HERO_RACE_NOTE = "Your theme and brand were applied. The hero wasn't changed, because someone else edited it just now.";

export const DEFAULT_THEME = { kit: "pulse", version: 1 };

export const getKit = (id) => KITS[id] || null;

// The kit a theme pin resolves to (unknown/absent → the platform default).
export const kitFor = (theme) => KITS[theme?.kit] || KITS.pulse;

// data-kit attribute value — version-keyed so future kit versions ship as new
// CSS blocks instead of restyling pinned tenants.
export const kitAttr = (theme) => {
  const kit = kitFor(theme);
  const version = theme?.kit === kit.id && theme?.version != null ? theme.version : kit.version;
  return `${kit.id}-${version}`;
};

// ---- where the brand and the theme pin are read from (TOK-03) ----------------------
//
// draftDesignOf(config)  { brand, theme } as a LEGACY store keeps them: its
//                        control-plane config.brand and config.theme (drafts
//                        until the next release). Readers call this on the
//                        legacy path instead of reading those keys themselves;
//                        on a documents store they read doc_design instead
//                        (lib/admin/brand-readability.js storeDesign).
// themePinOf(config)     the look an operator screen shows for a store:
//                        config.theme_pin when a design publish wrote one
//                        (lib/documents/after-commit.js; null there means the
//                        platform default), else config.theme, the legacy pin.
//                        Known limit: a documents store that has never
//                        published its design has no theme_pin yet, so it
//                        shows its old legacy pin until the first design
//                        publish (MIG-01 should write theme_pin at cutover).
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const draftDesignOf = (config) => ({ brand: (isObj(config) && config.brand) || null, theme: (isObj(config) && config.theme) || null });
export const themePinOf = (config) => {
  if (!isObj(config)) return null;
  if (Object.hasOwn(config, "theme_pin")) return isObj(config.theme_pin) ? config.theme_pin : null;
  return config.theme || null;
};

// Upgrade availability for the console/registry (never auto-applied).
export const kitUpgradeAvailable = (theme) => {
  const kit = theme?.kit && KITS[theme.kit];
  return Boolean(kit && theme.version != null && theme.version < kit.version);
};

// Apply a kit to the CURRENT tenant as DRAFT state: pin + brand defaults, and
// (optionally) the kit's hero preset. Live shoppers see nothing until the
// next publish (S36) — pre-first-publish stores change immediately, like any
// draft. Returns what was written.
// S52: withBrand/withPresets are the merchant's explicit choices — applying a
// kit used to silently overwrite a customized brand and the hero copy, which
// the first real onboarding hit. Defaults stay true (API compatibility; the
// console now asks).
// P3-DESIGN: opts.documents (lib/documents/service.js) and opts.revision (the
// doc_design revision the founder's screen showed; optional) for a documents
// store, see applyKitToDesign.
export async function applyKit(kitId, { actor = null, withPresets = true, withBrand = true, documents = null, revision } = {}) {
  const kit = KITS[kitId];
  if (!kit) throw new Error(`unknown theme kit "${kitId}"`);
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("This store runs on environment config — themes need a control-plane tenant");

  // TOK-03: read fresh on every call (P2-GUARD). A documents store keeps its
  // brand and theme in doc_design; any other store not on legacy refuses the
  // whole apply, before anything is written.
  const mode = await getCmsMode();
  if (mode === "documents" && hasDocumentsApi(documents)) return applyKitToDesign(kit, { actor, withPresets, withBrand, documents, revision });
  if (mode !== "legacy") throw new StoreUsesDocumentsError(mode);

  const theme = { kit: kit.id, version: kit.version, applied_at: new Date().toISOString() };
  await patchTenant(tenant.id, { config: { theme, ...(withBrand ? { brand: { ...kit.brand } } : {}) } });

  let presets = [];
  let note = null;
  if (withPresets && kit.presets?.hero) {
    const { ok, value } = validateBlock("hero", kit.presets.hero);
    if (ok) {
      // a draft write that replaces the hero copy, at the revision it was read at
      const { writeContentDrafts, ContentWriteConflictError } = await import("../content-writes.js");
      try {
        await writeContentDrafts({ hero: { value, merge: false } }, { actor, source: `theme:${kit.id}@${kit.version}` });
        presets.push("hero");
      } catch (e) {
        // P2-FIX4: the theme pin and brand are already saved, so a hero race
        // must not be reported as "nothing was saved". The colleague's hero
        // stays; the apply answers success and says so in plain words.
        if (!(e instanceof ContentWriteConflictError)) throw e;
        note = HERO_RACE_NOTE;
        slog("theme_hero_conflict", { kit: kit.id, version: kit.version });
      }
    }
  }
  slog("theme_applied", { kit: kit.id, version: kit.version, presets: presets.join(","), with_brand: withBrand, hero_skipped: !!note });
  await audit({ actor, action: "storefront.write", resource: `theme:${kit.id}@${kit.version}`, diff: { presets, withBrand, ...(note ? { heroSkipped: "conflict" } : {}) } });
  return { theme, brand: withBrand ? kit.brand : tenantOwnCfg("brand", null, null) || null, presets, ...(note ? { note } : {}) };
}

// ---- documents mode (P3-DESIGN, TOK-03) ---------------------------------------------

const DOCUMENTS_API = ["getDocument", "createDocument", "saveDraft"];
const hasDocumentsApi = (d) => isObj(d) && DOCUMENTS_API.every((f) => typeof d[f] === "function");
export const DESIGN_ID = "doc_design";

// What a founder hears when the kit went in but left a draft that can't be
// published yet, naming what to fix. `blocked`: [{ label, problems: [words] }].
export function unpublishableNote(blocked) {
  const parts = (blocked || []).filter((b) => b?.problems?.length);
  if (!parts.length) return null;
  return parts
    .map((b) => {
      const shown = b.problems.slice(0, 3);
      const more = b.problems.length - shown.length;
      return `${b.label} was saved as a draft but can't be published yet. Fix this in the editor first: ${shown.join(" ")}${more > 0 ? ` (and ${more} more)` : ""}`;
    })
    .join(" ");
}

// What stops a saved draft from publishing, in plain words: the issues of a
// publish-mode check, each with where it is ("Hero · Title: …").
export async function publishBlockers(body, documentId) {
  const R = await import("../registry/index.js");
  const r = R.validateDocument(body, { mode: "publish", documentId });
  return r.issues
    .filter((i) => i.severity === "error")
    .map((i) => {
      const at = R.where(i, body);
      return at ? `${at}: ${i.message}` : i.message;
    });
}

async function readDesign(docs) {
  try {
    return await docs.getDocument(DESIGN_ID);
  } catch (e) {
    if (e?.status === 404 || e?.name === "NotFoundError") return null; // never saved: made below
    throw e;
  }
}

// The kit into the doc_design DRAFT: settings.theme is the kit's pin, and
// with withBrand settings.brand is the kit's starter brand (else the draft's
// brand stays). One saveDraft at `revision` (the founder's, else the one just
// read): a design form save that lands first makes this a 409
// DOCUMENT_CHANGED with the current document, and nothing is written. A store
// whose design was never saved gets it created (a racing create is 409
// DOCUMENT_EXISTS with the current document). Then the hero preset, as a
// doc_home draft through lib/content-writes.js. Nothing publishes, and the
// control-plane config is never written.
async function applyKitToDesign(kit, { actor, withPresets, withBrand, documents: docs, revision }) {
  const R = await import("../registry/index.js");
  const theme = { kit: kit.id, version: kit.version, applied_at: new Date().toISOString() };
  const cur = await readDesign(docs);
  const base = cur ? cur.body : R.emptyBody("design");
  const settings = { ...(isObj(base.settings) ? base.settings : {}), theme, ...(withBrand ? { brand: { ...kit.brand } } : {}) };
  const body = { ...base, settings };
  let saved;
  if (cur) saved = await docs.saveDraft({ id: DESIGN_ID, revision: Number.isInteger(revision) ? revision : cur.revision, body, actor });
  else saved = await docs.createDocument({ type: "design", body, actor });
  const design = saved.document;
  slog("content_write", { mode: "documents", document: DESIGN_ID, source: `theme:${kit.id}@${kit.version}`, revision: design.revision });

  const presets = [];
  const notes = [];
  const blocked = [];
  const designProblems = await publishBlockers(design.body, DESIGN_ID);
  if (designProblems.length) blocked.push({ label: "Your brand", problems: designProblems });
  if (withPresets && kit.presets?.hero) {
    const { ok, value } = validateBlock("hero", kit.presets.hero);
    if (ok) {
      const { writeContentDrafts, ContentWriteConflictError } = await import("../content-writes.js");
      try {
        await writeContentDrafts({ hero: { value, merge: false } }, { actor, source: `theme:${kit.id}@${kit.version}`, documents: docs });
        presets.push("hero");
      } catch (e) {
        // the design is saved: a hero race is said plainly, never "nothing was saved"
        const race = e instanceof ContentWriteConflictError || e?.code === "DOCUMENT_CHANGED";
        if (!race) throw e;
        notes.push(HERO_RACE_NOTE);
        slog("theme_hero_conflict", { kit: kit.id, version: kit.version, mode: "documents" });
      }
      if (presets.includes("hero")) {
        try {
          const home = await docs.getDocument("doc_home");
          const problems = await publishBlockers(home.body, "doc_home");
          if (problems.length) blocked.push({ label: "Your home page", problems });
        } catch {
          /* the hero is saved; the check is advice only */
        }
      }
    }
  }
  const unpublishable = unpublishableNote(blocked);
  if (unpublishable) notes.push(unpublishable);
  slog("theme_applied", { kit: kit.id, version: kit.version, presets: presets.join(","), with_brand: withBrand, mode: "documents", unpublishable: blocked.length });
  await audit({ actor, action: "storefront.write", resource: `theme:${kit.id}@${kit.version}`, diff: { presets, withBrand, document: DESIGN_ID, revision: design.revision } });
  const note = notes.length ? notes.join(" ") : null;
  return {
    theme,
    brand: isObj(design.body?.settings?.brand) ? design.body.settings.brand : null,
    presets,
    document: { id: design.id, revision: design.revision, draftHash: design.draftHash },
    ...(blocked.length ? { unpublishable: blocked.map((b) => ({ label: b.label, problems: b.problems })) } : {}),
    ...(note ? { note } : {}),
  };
}
