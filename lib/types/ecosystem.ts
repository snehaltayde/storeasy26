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

export type PluginTier = "declarative" | "remote";

export type PluginScope =
  | "storefront:read"
  | "catalog:read"
  | "orders:read"
  | "customers:read"
  | "analytics:write"
  | "checkout:ui"
  | "admin:ui"
  | "webhooks:receive";

export type ExtensionSlotId =
  | "storefront.head"
  | "storefront.pdp.under_price"
  | "storefront.pdp.under_atc"
  | "storefront.pdp.tabs"
  | "storefront.pdp.below_fold"
  | "storefront.cart.above_total"
  | "storefront.cart.below_cta"
  | "storefront.checkout.order_summary"
  | "storefront.footer.above"
  | "admin.nav"
  | "admin.order.detail_panel"
  | "admin.product.detail_panel";

export type WebhookTopic =
  | "order.created"
  | "order.paid"
  | "order.cancelled"
  | "order.refunded"
  | "customer.created"
  | "cart.abandoned"
  | "catalog.synced"
  | "release.published"
  | "app.uninstalled";

export interface PluginSettingField {
  key: string;
  type: "text" | "textarea" | "number" | "boolean" | "select" | "color" | "url" | "secret";
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ label: string; value: string }>;
}

export interface PluginSectionDeclaration {
  kind: string; // namespaced, e.g. "plugin:<pluginId>:<kind>"
  label: string;
  surfaces: Array<"home" | "page" | "campaign" | "product" | "collection">;
  settings: PluginSettingField[];
  /** Declarative template or sandboxed widget endpoint */
  template?: string;
  widgetUrl?: string;
}

export interface PluginManifest {
  id: string; // slug: /^[a-z0-9][a-z0-9-]{1,48}$/
  name: string;
  version: string; // semver
  tier: PluginTier;
  author: {
    name: string;
    url?: string;
    supportEmail?: string;
  };
  description: string;
  iconUrl?: string;
  scopes: PluginScope[];
  settingsSchema: PluginSettingField[];
  slots?: Array<{
    slot: ExtensionSlotId;
    kind: "declarative_template" | "iframe_widget" | "script_tag";
    template?: string;
    iframeUrl?: string;
    scriptUrl?: string; // strict HTTPS allowlist + SRI integrity hash
    sri?: string;
  }>;
  sections?: PluginSectionDeclaration[];
  webhooks?: Array<{
    topic: WebhookTopic;
    endpointPath: string; // resolved against appBaseUrl
  }>;
  appBaseUrl?: string; // required for tier === "remote" (HTTPS only)
  adminPanelPath?: string; // iframe path inside /admin/apps/[id]
}

export interface InstalledPlugin {
  pluginId: string;
  version: string;
  enabled: boolean;
  grantedScopes: PluginScope[];
  settings: Record<string, unknown>;
  installedAt: string;
  updatedAt: string;
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
