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
// P2-WRITERS: the hero preset goes through lib/content-writes.js. The theme
// pin and brand are control-plane writes that a documents store keeps in
// doc_design (TOK-03), so applyKit refuses any store not on legacy (409
// STORE_USES_DOCUMENTS) before it writes anything.
import { patchTenant } from "../platform/control.js";
import { currentTenant, tenantOwnCfg } from "../tenant-context.js";
import { validateBlock } from "../cms/validate.js";
import { assertLegacyContentWrites } from "../cms-mode.js";
// lib/content-writes.js is loaded with import() in applyKit, so a storefront
// request (kitAttr in the layout) never runs it. applyKit never needs the
// documents service: it refuses any store not on legacy first.
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
export async function applyKit(kitId, { actor = null, withPresets = true, withBrand = true } = {}) {
  const kit = KITS[kitId];
  if (!kit) throw new Error(`unknown theme kit "${kitId}"`);
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("This store runs on environment config — themes need a control-plane tenant");

  // TOK-03: brand and theme move to doc_design; until then a store not on
  // legacy refuses the whole apply, before the pin or the brand is written
  await assertLegacyContentWrites();

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
