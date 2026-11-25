// Theme kits (Documents-only). Pure data + doc_design apply logic.
//
// A KIT is a named, versioned look for a vertical: brand-token defaults,
// display-font choice, surface styling ([data-kit="<id>-<version>"]), and
// optional hero preset. (Phase 2 expands this into the Open Uploadable Theme
// Engine.)
//
// applyKit ALWAYS writes a DRAFT of doc_design (and optionally doc_home) via
// the documents service — never publishes and never writes control-plane
// config directly.
import { currentTenant } from "../tenant-context.js";
import { getCmsMode, StoreUsesDocumentsError } from "../cms-mode.js";
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

export const HERO_RACE_NOTE = "Your theme and brand were applied. The hero wasn't changed, because someone else edited it just now.";
export const DEFAULT_THEME = { kit: "pulse", version: 1 };
export const DESIGN_ID = "doc_design";

export const getKit = (id) => KITS[id] || null;
export const kitFor = (theme) => KITS[theme?.kit] || KITS.pulse;

export const kitAttr = (theme) => {
  const kit = kitFor(theme);
  const version = theme?.kit === kit.id && theme?.version != null ? theme.version : kit.version;
  return `${kit.id}-${version}`;
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const draftDesignOf = (config) => ({ brand: (isObj(config) && config.brand) || null, theme: (isObj(config) && config.theme) || null });
export const themePinOf = (config) => {
  if (!isObj(config)) return null;
  if (Object.hasOwn(config, "theme_pin")) return isObj(config.theme_pin) ? config.theme_pin : null;
  return config.theme || null;
};

export const kitUpgradeAvailable = (theme) => {
  const kit = theme?.kit && KITS[theme.kit];
  return Boolean(kit && theme.version != null && theme.version < kit.version);
};

const DOCUMENTS_API = ["getDocument", "createDocument", "saveDraft"];
const hasDocumentsApi = (d) => isObj(d) && DOCUMENTS_API.every((f) => typeof d[f] === "function");

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

export async function publishBlockers(body, documentId) {
  const R = await import("../registry/index.js");
  const r = R.validateDocument(body, { mode: "publish", documentId });
  const problems = r.issues
    .filter((i) => i.severity === "error")
    .map((i) => {
      const at = R.where(i, body);
      return at ? `${at}: ${i.message}` : i.message;
    });
  return documentId === DESIGN_ID ? [...problems, ...(await themePackageBlockers(body))] : problems;
}

// Phase 5 line 3: what stops a design that names an uploaded theme package
// from going live. The package must be on this store and installed (not
// archived), and the brand must read on the package's own header and hero
// surfaces (checkBrand with them; pairs that fail without the surfaces are
// the design rule's own, reported there, so they are not repeated here).
// publish() (lib/documents/publish.js) runs this for every doc_design it
// publishes, so the Themes page and the editor share one gate.
export const PACKAGE_ARCHIVED_WORDS = "This theme was archived. Choose another before publishing.";
export const PACKAGE_MISSING_WORDS = "This theme isn't on your store any more. Choose another before publishing.";
export async function themePackageBlockers(body, { live = null } = {}) {
  const s = isObj(body?.settings) ? body.settings : {};
  const id = isObj(s.theme) ? s.theme.package : null;
  if (id == null) return [];
  const { libsql } = await import("../db.js");
  let row = null;
  try {
    row = (await libsql.execute({ sql: "SELECT id, slug, base_kit, package, status FROM theme_packages WHERE id = ?", args: [String(id)] })).rows[0] ?? null;
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
  }
  if (!row) return [PACKAGE_MISSING_WORDS];
  if (String(row.status) !== "installed") return [PACKAGE_ARCHIVED_WORDS];
  const { renderablePackage } = await import("./live-package.js");
  const pkg = renderablePackage({ id: String(row.id), slug: String(row.slug), base_kit: String(row.base_kit), package: String(row.package) });
  if (!pkg) return [PACKAGE_MISSING_WORDS];
  if (!pkg.surfaces) return [];
  const { checkBrand, validateBrand } = await import("../brand.js");
  if (s.brand != null && (!isObj(s.brand) || validateBrand(s.brand).errors.length)) return [];
  const liveS = isObj(live?.settings) ? live.settings : {};
  const opts = { kit: kitAttr(s.theme), live: liveS.brand ?? null, liveKit: kitAttr(liveS.theme ?? null) };
  const plain = new Set(checkBrand(s.brand ?? null, opts).issues.filter((i) => i.severity === "error").flatMap((i) => i.pairs));
  return checkBrand(s.brand ?? null, { ...opts, surfaces: pkg.surfaces })
    .issues.filter((i) => i.severity === "error" && !i.pairs.every((p) => plain.has(p)))
    .map((i) => i.message);
}

async function readDesign(docs) {
  try {
    return await docs.getDocument(DESIGN_ID);
  } catch (e) {
    if (e?.status === 404 || e?.name === "NotFoundError") return null;
    throw e;
  }
}

// Phase 5 line 3 (docs/DECISIONS.md "Theme templates ride in the surface
// drafts"): the layout documents an uploaded theme's templates are written to,
// so they take effect when the founder publishes them with the design.
export const SURFACE_TEMPLATE_DOCS = Object.freeze({ header: ["doc_header", "header"], footer: ["doc_footer", "footer"], pdp: ["doc_product_layout", "product_layout"], collection: ["doc_collection_layout", "collection_layout"] });

/**
 * Write settings.template on each surface's layout draft: a choice (creating
 * the draft when the document doesn't exist yet) or null (clears it; missing
 * documents are left alone). Each save names the revision it read, so a
 * concurrent edit answers 409 DOCUMENT_CHANGED. An archived layout document
 * is skipped, never written. Returns { written: ids whose draft changed,
 * skipped: [{ id, surface, note }] }.
 */
const SURFACE_WORDS = Object.freeze({ header: "Header", footer: "Footer", pdp: "Product page", collection: "Collection page" });
export async function writeSurfaceTemplates(documents, templates, { actor = null } = {}) {
  const R = await import("../registry/index.js");
  const written = [];
  const skipped = [];
  for (const [surface, [id, type]] of Object.entries(SURFACE_TEMPLATE_DOCS)) {
    if (!Object.hasOwn(templates, surface)) continue;
    const want = templates[surface] ?? null;
    const cur = await readDoc(documents, id);
    if (!cur) {
      if (want == null) continue;
      const body = R.emptyBody(type);
      await documents.createDocument({ type, body: { ...body, settings: { ...(isObj(body.settings) ? body.settings : {}), template: want } }, actor });
      written.push(id);
      continue;
    }
    if (cur.archivedAt) {
      if (want != null) skipped.push({ id, surface, note: `${SURFACE_WORDS[surface]} layout is archived, so the theme's ${SURFACE_WORDS[surface].toLowerCase()} wasn't applied.` });
      continue;
    }
    const settings = isObj(cur.body?.settings) ? cur.body.settings : {};
    if ((settings.template ?? null) === want) continue;
    await documents.saveDraft({ id, revision: cur.revision, body: { ...cur.body, settings: { ...settings, template: want } }, actor });
    written.push(id);
  }
  return { written, skipped };
}

async function readDoc(docs, id) {
  try {
    return await docs.getDocument(id);
  } catch (e) {
    if (e?.status === 404 || e?.name === "NotFoundError") return null;
    throw e;
  }
}

export async function applyKit(kitId, { actor = null, withPresets = true, withBrand = true, documents = null, revision } = {}) {
  const kit = KITS[kitId];
  if (!kit) throw new Error(`unknown theme kit "${kitId}"`);
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("This store runs on environment config — themes need a control-plane tenant");

  const mode = await getCmsMode(); // 500 STORE_MODE_INVALID on any other mode
  if (!hasDocumentsApi(documents)) throw new StoreUsesDocumentsError(mode);

  const R = await import("../registry/index.js");
  const theme = { kit: kit.id, version: kit.version, applied_at: new Date().toISOString() };
  const cur = await readDesign(documents);
  const base = cur ? cur.body : R.emptyBody("design");
  const settings = { ...(isObj(base.settings) ? base.settings : {}), theme, ...(withBrand ? { brand: { ...kit.brand } } : {}) };
  const body = { ...base, settings };
  // Phase 5 line 3: leaving an uploaded theme for a built-in look also clears
  // the layouts that theme wrote into the surface drafts
  const leavingPackage = Boolean(base.settings?.theme?.package) || Boolean(cur?.publishedVersionId && themePinOf(currentTenant()?.config)?.package);
  const saved = cur
    ? await documents.saveDraft({ id: DESIGN_ID, revision: Number.isInteger(revision) ? revision : cur.revision, body, actor })
    : await documents.createDocument({ type: "design", body, actor });
  const design = saved.document;
  slog("content_write", { mode: "documents", document: DESIGN_ID, source: `theme:${kit.id}@${kit.version}`, revision: design.revision });

  const cleared = leavingPackage ? (await writeSurfaceTemplates(documents, { header: null, footer: null, pdp: null, collection: null }, { actor })).written : [];
  const presets = [];
  const notes = [];
  const blocked = [];
  const designProblems = await publishBlockers(design.body, DESIGN_ID);
  if (designProblems.length) blocked.push({ label: "Your brand", problems: designProblems });

  if (withPresets && kit.presets?.hero) {
    const { writeContentDrafts, ContentWriteConflictError } = await import("../content-writes.js");
    try {
      await writeContentDrafts({ hero: { value: kit.presets.hero, merge: false } }, { actor, source: `theme:${kit.id}@${kit.version}`, documents });
      presets.push("hero");
    } catch (e) {
      const race = e instanceof ContentWriteConflictError || e?.code === "DOCUMENT_CHANGED";
      if (!race) throw e;
      notes.push(HERO_RACE_NOTE);
      slog("theme_hero_conflict", { kit: kit.id, version: kit.version, mode: "documents" });
    }
    if (presets.includes("hero")) {
      try {
        const home = await documents.getDocument("doc_home");
        const problems = await publishBlockers(home.body, "doc_home");
        if (problems.length) blocked.push({ label: "Your home page", problems });
      } catch {
        /* advice only */
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
    ...(cleared.length ? { cleared } : {}),
    document: { id: design.id, revision: design.revision, draftHash: design.draftHash },
    ...(blocked.length ? { unpublishable: blocked.map((b) => ({ label: b.label, problems: b.problems })) } : {}),
    ...(note ? { note } : {}),
  };
}
