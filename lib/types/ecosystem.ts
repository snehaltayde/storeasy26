// Canonical Ecosystem contracts for Phase 2+:
//   A) Two-Tier Plugin System (Tier 1 Declarative / Tier 2 Remote App & Webhooks)
//   B) Uploadable themes: data-only packages, format storeasy-theme/1
//
// Security invariant: neither plugins nor uploaded themes EVER execute arbitrary
// JavaScript inside Storeasy's Next.js runtime, nor can they access tenant DBs,
// secrets, auth cookies, or commerce pricing/checkout logic.

// ============================================================================
// A. PLUGIN SYSTEM CONTRACTS
// ============================================================================

// Phase 4 line 1: the manifest a first-party plugin declares in code
// (lib/plugins/first-party/<id>/manifest.js), checked by lib/plugins/manifest.js.
// Plugins never run their own JavaScript in Storeasy: storefront blocks are
// declarative only (line 2), events reach them as signed webhooks (line 3).

/** A key of APP_PERMISSIONS (lib/platform/authz.js): read-only, `<area>.<verb>`. */
export type PluginScope = "storefront.read" | "offers.read" | "orders.read";

export type PluginKind = "first_party" | "custom";

/** Registry setting kinds a plugin may use, plus `list` and the write-only `secret`. */
export type PluginFieldKind = "text" | "number" | "boolean" | "choice";

export interface PluginField {
  key: string; // /^[a-z][a-z0-9_]*$/
  kind: PluginFieldKind;
  label?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  max?: number;
  min?: number;
  options?: string[]; // choice only
}

export type PluginSetting =
  | PluginField
  | (Omit<PluginField, "kind" | "options"> & { kind: "list"; fields: PluginField[]; max: number })
  | (Omit<PluginField, "kind" | "options" | "default"> & { kind: "secret" });

export interface PluginManifest {
  id: string; // slug: /^[a-z0-9][a-z0-9-]{1,48}$/
  name: string;
  version: string; // semver
  summary: string; // one line for the catalog card
  description: string;
  icon: string; // a lucide-react icon name
  author: { name: string };
  scopes: PluginScope[];
  settings: PluginSetting[];
  // line 2: blocks (declarative only: no iframe or script slot kinds)
  blocks?: PluginBlock[];
  // line 3: events and egress
  events?: Exclude<WebhookTopic, "ping">[]; // handlers: lib/plugins/handlers.js
  egress?: string[]; // the hosts its handlers may call (lowercase DNS names, never Shopify)
}

/** Phase 4 line 3: store events a plugin receives (lib/plugins/topics.js TOPICS). */
export type WebhookTopic = "order.created" | "order.fulfilled" | "ping";

export type DeliveryStatus = "pending" | "retrying" | "delivered" | "failed" | "skipped";

/** The body POSTed to a custom app, signed per Standard Webhooks v1. No customer details. */
export interface WebhookBody {
  id: string; // "evt_" + 16 hex
  type: WebhookTopic;
  created_at: string;
  store: string | null; // the store's host
  data: Record<string, unknown>;
}

// Phase 4 line 2: storefront slots and block primitives (lib/plugins/slots.js, lib/plugins/blocks.js).
export type SlotId =
  | "storefront.pdp.under_price"
  | "storefront.pdp.under_atc"
  | "storefront.pdp.below_fold"
  | "storefront.order.status"
  | "storefront.footer.above";

export type BlockPrimitive = "badge_row" | "notice";

export interface PluginBlock {
  id: string;
  label: string;
  primitive: BlockPrimitive;
  slots: SlotId[];
  settings?: PluginField[];
  // in-repo, Edge-safe; its output joins the placement's settings as props
  data?: (ctx: Record<string, string | number | boolean | null>, extra: { installSettings: Record<string, unknown> }) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export type PlacementState = "off" | "live";

export type PluginInstallStatus = "enabled" | "disabled" | "uninstalled";

/** An install as the console reads it: secrets only as "set" or "not set". */
export interface PluginInstall {
  id: string; // "pin_" + 16 hex
  pluginId: string;
  kind: PluginKind;
  name: string;
  version: string;
  status: PluginInstallStatus;
  killed: boolean; // turned off by Storeasy (the ff_plugin-<id> flag)
  grantedScopes: PluginScope[];
  settings: Record<string, unknown>;
  secretsSet: Record<string, boolean>;
  installedBy: string;
  installedByName: string | null;
  installedAt: string;
  updatedAt: string;
}

/** Phase 4 line 4: what an app token may be limited to (APP_PERMISSIONS keys; read-only). */
export type AppTokenScope = PluginScope;

export type AppTokenStatus = "active" | "expiring" | "expired" | "revoked";

/** A token as the console lists it: never the secret or its hash. */
export interface AppToken {
  id: string; // "tok_" + 16 hex, also inside the token string "sea_<id>.<secret>"
  name: string;
  scopes: AppTokenScope[];
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: AppTokenStatus;
}

// ============================================================================
// B. UPLOADABLE THEME PACKAGES (Phase 5: data only, format storeasy-theme/1)
// ============================================================================
// One JSON file (≤ 256 KB) checked by the package scanner and validators;
// constants in lib/themes/package-format.js, styles compiled by
// lib/themes/styles.js. Unknown keys anywhere are refused. No templates of
// markup, no CSS files, no scripts, no assets (image fields stay empty).

export type ThemeFormat = "storeasy-theme/1";

/** A built-in kit a package rides on (lib/themes/kits.js). */
export type ThemeBase = "pulse" | "glow";

/** Exactly the keys validateBrand() (lib/brand.js) accepts. */
export interface ThemeTokens {
  accent?: string; // #rrggbb
  background?: string; // #rrggbb
  foreground?: string; // #rrggbb
  radius?: "sm" | "md" | "lg" | "xl";
  type_scale?: "compact" | "regular" | "large";
  button_shape?: "pill" | "rounded" | "square";
  section_spacing?: "compact" | "regular" | "airy";
  heading_font?: "sans" | "serif"; // Phase 7: absent = the kit decides
}

/** A dark surface's colours; fg and muted need 4.5:1 against bg. */
export interface ThemeSurface {
  bg: string;
  fg: string;
  muted: string;
}

/** A registry home section (lib/registry/sections.js; product_main excluded). */
export interface ThemeHomeSection {
  kind: string;
  settings: Record<string, unknown>;
}

export interface ThemeTemplates {
  pdp?: "classic" | "editorial";
  collection?: "standard" | "sidebar";
  header?: "standard" | "centered";
  footer?: "columns" | "minimal";
  home?: { sections: ThemeHomeSection[] };
}

/** PARTS in lib/themes/package-format.js; none inside buy box, cart or checkout. */
export type ThemePart =
  | "header"
  | "header-link"
  | "announcement"
  | "footer"
  | "footer-link"
  | "hero"
  | "hero-title"
  | "hero-subtitle"
  | "section"
  | "section-heading"
  | "product-card"
  | "product-card-title"
  | "product-card-price"
  | "collection-card"
  | "badge";

/** PROPS in lib/themes/package-format.js, each value matched whole. */
export interface ThemeStyleSet {
  color?: string; // #rgb | #rrggbb | role:<ROLE_IDS>
  "background-color"?: string;
  "border-color"?: string;
  "border-width"?: string; // 0px–4px
  "border-radius"?: string; // 0px–48px
  "font-weight"?: number | string; // 300–900, step 100
  "font-style"?: "normal" | "italic";
  "letter-spacing"?: string; // -0.05em–0.3em | normal
  "text-transform"?: "none" | "uppercase" | "lowercase" | "capitalize";
  "text-align"?: "left" | "center" | "right" | "start" | "end";
  "padding-block"?: string; // 0rem–8rem
  "padding-inline"?: string; // 0rem–8rem
  gap?: string; // 0rem–4rem
  "box-shadow"?: "none" | "sm" | "md" | "lg";
}

/** Compiled to :where([data-theme="<id>"]) [data-part="<part>"]{…}. ≤ 60 rules. */
export interface ThemeStyleRule {
  part: ThemePart;
  set: ThemeStyleSet;
}

export interface ThemePackage {
  format: ThemeFormat;
  id: string; // /^[a-z0-9-]{1,40}$/, the data-theme attribute
  name: string;
  version: string; // x.y.z
  author?: { name: string };
  description?: string; // ≤ 300 chars
  base: ThemeBase;
  tokens?: ThemeTokens;
  surfaces?: { header?: ThemeSurface; hero?: ThemeSurface };
  templates?: ThemeTemplates;
  styles?: ThemeStyleRule[];
}

export type ThemePackageStatus = "installed" | "archived";

/** A theme_packages row (migrations/tenant/0034_theme_packages.sql, 0035 source). */
export interface ThemePackageRow {
  id: string; // "thm_" + 16 hex, immutable
  slug: string; // ThemePackage.id
  version: string;
  name: string;
  author: string | null;
  description: string | null;
  base_kit: ThemeBase;
  package: string; // normalised, validated JSON of a ThemePackage
  sha256: string;
  size_bytes: number;
  status: ThemePackageStatus;
  uploaded_by: string;
  uploaded_at: string; // ISO 8601 UTC
  archived_by: string | null;
  archived_at: string | null;
  source: "upload" | "storeasy"; // 0035: a founder's upload or a Storeasy flagship
}

/** doc_design.body.settings.theme (lib/registry/settings.js). */
export interface ThemeSelection {
  kit: ThemeBase;
  version: number;
  applied_at?: string;
  package?: string; // /^thm_[0-9a-f]{16}$/
}

/** One refusal or check failure, "<plain words> (at <path>)" when shown. */
export interface ThemeIssue {
  path: string;
  message: string;
}
