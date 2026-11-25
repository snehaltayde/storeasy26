// Canonical control-plane, tenant, session, and RBAC contracts.
// Consumed by Phases 2–6 (TypeScript modules) and JSDoc annotations in JS modules.

export type TenantStatus = "active" | "suspended" | "offboarded";

export type MerchantRole = "owner" | "admin" | "staff" | "support";

export type SessionKind = "merchant" | "operator";

// What validateShippingConfig (lib/admin/settings.js) stores. Optional fields
// are absent unless the founder set them.
export interface DayRange {
  min: number;
  max: number;
}

export interface ShippingZone {
  label: string;
  prefixes: string[];
  flatRate?: number;
  freeThreshold?: number;
  // Phase 8: the zone's own delivery days; `cod: false` hides cash on delivery
  deliveryDays?: DayRange;
  cod?: boolean;
}

export interface ShippingConfig {
  currency: string;
  basis: "net" | "gross";
  freeThreshold: number | null;
  flatRate: number;
  codFee: number;
  codFeeWaivedAt: number | null;
  zones: ShippingZone[];
  // Phase 8: calendar days to dispatch, and the default delivery days
  dispatchDays?: number;
  deliveryDays?: DayRange;
}

// Phase 8 (decisions 11 and 12): what validatePaymentConfig stores.
export interface PrepaidDiscount {
  kind: "percent" | "fixed";
  value: number; // percent (at most 20) or store-currency amount
  max?: number; // cap in store currency
}

export interface CodRules {
  otp: "off" | "always" | "above";
  maxTotal?: number;
  otpAbove?: number; // only when otp is "above"
  // only when otp is not "off". "sms" confirms the phone and is refused where no
  // SMS provider is set; "email" confirms only the email address.
  otpChannel?: "sms" | "email";
}

// tenants.config.payment_config (Phase 8 line 2): read by lib/checkout/payment-terms.js,
// saved by buildSettingsPatch through validatePaymentConfig. Absent sections stay absent.
export interface PaymentConfig {
  prepaid?: PrepaidDiscount;
  cod?: CodRules;
}

// tenants.config.markets (Phase 8 line 4): selling in another currency and
// country. Saved by buildSettingsPatch through lib/markets.js validateMarkets.
export interface Market {
  id: string; // its first country code
  countries: string[]; // ISO 3166-1 alpha-2, never the store's own
  currency: string; // on RAZORPAY_CURRENCIES (lib/money.js)
  rate: number; // base units per 1 market unit
  rateSetAt: string; // ISO 8601 UTC
  rounding: "exact" | "whole" | "x.99";
  flatRate: number; // in the market's currency
  freeThreshold: number | null;
  enabled: boolean;
  international: boolean; // the founder's Razorpay international payments tick
}

export interface BrandTokens {
  accent?: string;
  accent_hover?: string;
  on_accent?: string;
  background?: string;
  surface?: string;
  surface_sunken?: string;
  surface_strong?: string;
  foreground?: string;
  text_muted?: string;
  text_faint?: string;
  border?: string;
  radius?: "sharp" | "soft" | "rounded" | "pill" | string;
  font_display?: string;
  font_body?: string;
  header_variant?: string;
  footer_variant?: string;
}

export interface ThemePin {
  kit: string;
  version: number | null;
  applied_at?: string | null;
  published_at?: string | null;
  release?: string | null;
  /** Phase 5 line 3: the uploaded theme package live on the store (thm_ + 16 hex), or null for a built-in look */
  package?: string | null;
  /** the package's own id (its slug), version and name, read when the pin is written */
  slug?: string | null;
  package_version?: string | null;
  package_name?: string | null;
}

export interface TenantConfig {
  site?: {
    name?: string;
    tagline?: string;
    logo_text_1?: string;
    logo_text_2?: string;
    footer_tagline?: string;
    legal_name?: string;
    support_email?: string;
    support_phone?: string;
  };
  currency?: string;
  country?: string;
  timezone?: string;
  merchant_timezone?: string;
  checkout_mode?: "direct" | "disabled" | "shopify";
  shipping_config?: Partial<ShippingConfig>;
  payment_config?: PaymentConfig;
  markets?: Market[]; // Phase 8 line 4: lib/markets.js validateMarkets
  theme_pin?: ThemePin | null;
  theme_pin_at?: string | null;
  maintenance?: {
    enabled?: boolean;
    message?: string;
    eta?: string;
  };
  // Phase 1 line 4: the Shopify connection (expiring offline tokens)
  shopify_store_domain?: string;
  shopify_client_id?: string;
  shopify_scopes?: string | null;
  shopify_connected_at?: string | null;
  shopify_connected_by?: string | null;
  shopify_token_expires_at?: string | null;
  shopify_refresh_expires_at?: string | null;
  shopify_reauth_needed_at?: string | null;
  shopify_app_uninstalled_at?: string | null;
  onboarding?: {
    manual?: Record<string, { done: boolean; at?: string }>;
    brand_step?: {
      paletteId?: string;
      skipped?: boolean;
      at?: string;
    };
  };
  billing?: {
    plan?: string;
    status?: string;
    degraded?: boolean;
  };
  /** Phase 2+: installed plugin configs & enabled theme package pointer */
  active_theme_id?: string | null;
  active_theme_version?: string | null;
}

export interface TenantSecrets {
  shopify_store_domain?: string;
  shopify_admin_token?: string;
  shopify_refresh_token?: string | null;
  shopify_client_secret?: string;
  shopify_storefront_token?: string;
  shopify_webhook_secret?: string;
  razorpay_key_id?: string;
  razorpay_key_secret?: string;
  razorpay_webhook_secret?: string;
  order_link_secret?: string;
  ga4_api_secret?: string;
  meta_capi_token?: string;
}

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  domains: string[];
  dbUrl: string;
  dbToken: string | null;
  config: TenantConfig;
  secrets: TenantSecrets;
  createdAt?: string;
  updatedAt?: string;
}

export interface Actor {
  kind: "merchant" | "bootstrap" | "operator" | "system";
  id: string;
  role?: MerchantRole | string;
  email?: string;
  name?: string;
}
