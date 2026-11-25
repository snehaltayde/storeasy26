// Canonical Ecosystem contracts for Phase 2+:
//   A) Two-Tier Plugin System (Tier 1 Declarative / Tier 2 Remote App & Webhooks)
//   B) Open Uploadable Theme Engine (Full UI Freedom, Zero Logic Access)
//
// Security invariant: neither plugins nor uploaded themes EVER execute arbitrary
// JavaScript inside Storeasy's Next.js runtime, nor can they access tenant DBs,
// secrets, auth cookies, or commerce pricing/checkout logic.

import type { BrandTokens } from "./tenant";
import type { EffectiveProduct, Cart, ShippingQuote } from "./commerce";

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
// B. OPEN UPLOADABLE THEME ENGINE CONTRACTS (Full UI Freedom, Zero Logic Access)
// ============================================================================

export type ThemeTemplateSurface =
  | "layout"
  | "home"
  | "product"
  | "collection"
  | "collections_index"
  | "cart"
  | "page"
  | "campaign"
  | "journal"
  | "search"
  | "404";

export interface ThemeSettingField {
  id: string;
  type:
    | "color"
    | "font_picker"
    | "range"
    | "select"
    | "checkbox"
    | "text"
    | "textarea"
    | "image_picker"
    | "url"
    | "header";
  label: string;
  info?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  /** Optional CSS custom property name mapped onto :root, e.g. "--theme-hero-pad" */
  cssVar?: string;
}

export interface ThemeSettingsGroup {
  name: string;
  settings: ThemeSettingField[];
}

export interface ThemeSectionSchema {
  kind: string; // e.g. "hero", "product_rail", or custom "theme:lookbook_split"
  name: string;
  surfaces: Array<"home" | "page" | "campaign" | "product" | "collection">;
  maxBlocks?: number;
  settings: ThemeSettingField[];
  blocks?: Array<{
    type: string;
    name: string;
    limit?: number;
    settings: ThemeSettingField[];
  }>;
  presets?: Array<{
    name: string;
    settings?: Record<string, unknown>;
    blocks?: Array<{ type: string; settings?: Record<string, unknown> }>;
  }>;
}

export interface ThemePackageManifest {
  schemaVersion: 1;
  id: string; // slug: /^[a-z0-9][a-z0-9-]{1,48}$/
  name: string;
  version: string; // semver
  author: {
    name: string;
    url?: string;
  };
  description?: string;
  previewImage?: string; // relative path inside zip, e.g. "assets/preview.webp"
  engineRange: string; // e.g. ">=1.0.0 <2.0.0"
  defaultBrand: BrandTokens;
  /** File map inside `.storeasy-theme.zip` */
  entry: {
    styles: string[]; // scoped CSS files, e.g. ["assets/theme.css"]
    settingsSchema: string; // "config/settings_schema.json"
    settingsData?: string; // "config/settings_data.json"
    layout: string; // "layout/theme.stml"
    templates: Partial<Record<Exclude<ThemeTemplateSurface, "layout">, string>>;
    sectionsDir?: string; // "sections/"
    snippetsDir?: string; // "snippets/"
  };
}

/**
 * Logic-free compiled template AST node (compiled on upload, never eval'd at runtime).
 * Supports only safe interpolation, conditionals, loops, snippets, and protected
 * `<storeasy:*>` commerce primitives.
 */
export type TemplateAstNode =
  | { type: "text"; value: string }
  | { type: "expr"; path: string[]; filters?: Array<{ name: string; args?: unknown[] }> }
  | { type: "element"; tag: string; attrs: Record<string, string | TemplateAstNode[]>; children: TemplateAstNode[] }
  | { type: "primitive"; name: ProtectedPrimitiveName; props: Record<string, unknown>; children?: TemplateAstNode[] }
  | { type: "if"; test: TemplateCondition; consequent: TemplateAstNode[]; alternate?: TemplateAstNode[] }
  | { type: "for"; itemName: string; indexName?: string; iterablePath: string[]; body: TemplateAstNode[]; empty?: TemplateAstNode[] }
  | { type: "slot"; name: string };

export type TemplateCondition =
  | { op: "truthy"; path: string[] }
  | { op: "not"; expr: TemplateCondition }
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; left: string[]; right: unknown }
  | { op: "and" | "or"; items: TemplateCondition[] };

/**
 * Protected platform commerce primitives that themes can position and style
 * via CSS variables/parts, but NEVER override the internal logic of.
 */
export type ProtectedPrimitiveName =
  | "storeasy:add-to-cart"
  | "storeasy:variant-selector"
  | "storeasy:buy-box"
  | "storeasy:cart-drawer"
  | "storeasy:checkout-button"
  | "storeasy:bundle-add"
  | "storeasy:search-box"
  | "storeasy:wishlist-button"
  | "storeasy:pincode-check"
  | "storeasy:plugin-slot"
  | "storeasy:section-outlet";

/**
 * Read-only view model injected into logic-free theme templates during SSR.
 * Contains ZERO secrets, ZERO DB handles, ZERO server functions, and ZERO
 * raw Shopify-only fields (`catalog_title`, `sku` stripped from cart).
 */
export interface StorefrontDataContext {
  shop: {
    name: string;
    tagline: string;
    currency: string;
    logo: { url: string; alt: string } | null;
    wordmark: { text1: string; text2: string };
  };
  theme: {
    id: string;
    version: string;
    settings: Record<string, unknown>;
  };
  page: {
    surface: ThemeTemplateSurface;
    path: string;
    title: string;
    description: string;
    preview: boolean;
  };
  nav: {
    header: Array<{ label: string; href: string; children?: Array<{ label: string; href: string }> }>;
    footer: Array<{ label: string; href: string }>;
  };
  announcement: { enabled: boolean; text: string; href: string } | null;
  cart: Pick<Cart, "count" | "subtotal" | "discountTotal" | "total" | "grandTotal" | "currency"> & {
    shipping: ShippingQuote | null;
  };
  product?: EffectiveProduct;
  collection?: {
    id: string;
    handle: string;
    title: string;
    description: string | null;
    image: string | null;
    products: EffectiveProduct[];
    total: number;
  };
  sections?: Array<{
    id: string;
    kind: string;
    settings: Record<string, unknown>;
    data?: Record<string, unknown>;
  }>;
}
