// Merchant settings for the tenant console (Session 22). Pure build/validate
// logic — the API route supplies the tenant + DB counts and persists the patch
// via patchTenant, so everything here is unit-testable without a server.
import { SHIPPING_CONFIG, computeShipping } from "../shipping.js";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const has = (v) => Boolean(v);

// What the console shows. SECRET VALUES NEVER LEAVE THE SERVER — only
// presence flags; the form's secret fields are write-only ("blank = keep").
export function settingsView(tenant, { counts = null } = {}) {
  const cfg = tenant?.config || {};
  const sec = tenant?.secrets || {};
  const readOnly = !tenant || tenant.id === "_default";
  return {
    tenantId: tenant?.id || "_default",
    readOnly, // env-fallback tenant has no control-plane row to patch
    identity: {
      name: cfg.site?.name || "",
      support_email: cfg.site?.support_email || "",
      support_phone: cfg.site?.support_phone || "",
      site_url: cfg.site_url || "",
    },
    domains: tenant?.domains || [],
    shopify: {
      store_domain: cfg.shopify_store_domain || "",
      connected: has(sec.shopify_admin_token),
      connected_at: cfg.shopify_connected_at || null,
      uninstalled_at: cfg.shopify_app_uninstalled_at || null,
    },
    payments: {
      razorpay_key_id: cfg.razorpay_key_id || "",
      has_key_secret: has(sec.razorpay_key_secret),
      has_webhook_secret: has(sec.razorpay_webhook_secret),
    },
    // S32 (MC22/BE06): commerce preferences — mode + timezone are OURS to
    // edit; currency/prices/tax stay Shopify-owned (display only).
    commerce: {
      checkout_mode: cfg.checkout_mode || "direct",
      timezone: cfg.timezone || "Asia/Kolkata",
      shopper_emails: "Shopify sends order confirmation/fulfillment emails (native, S18); Storeasy sends none — no duplicates.",
    },
    tracking: {
      ga4_measurement_id: cfg.ga4_measurement_id || "",
      has_ga4_api_secret: has(sec.ga4_api_secret),
      meta_pixel_id: cfg.meta_pixel_id || "",
      has_meta_capi_token: has(sec.meta_capi_token),
      meta_test_event_code: cfg.meta_test_event_code || "",
    },
    shipping: { ...SHIPPING_CONFIG, ...(cfg.shipping_config || {}) },
    sync: counts, // { products, collections, lastSyncedAt } — route fills in
  };
}

// Coerce + validate a shipping config from form input. Returns
// { ok, errors[], value } — value is safe to hand to computeShipping.
export function validateShippingConfig(input = {}) {
  const errors = [];
  const num = (v, label, { min = 0, nullable = false } = {}) => {
    if (v == null || v === "") {
      if (nullable) return null;
      errors.push(`${label} is required`);
      return 0;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) {
      errors.push(`${label} must be a number ≥ ${min}`);
      return 0;
    }
    return n;
  };

  const value = {
    currency: str(input.currency) || "INR",
    basis: input.basis === "gross" ? "gross" : input.basis === "net" || !input.basis ? "net" : null,
    freeThreshold: num(input.freeThreshold, "Free-shipping threshold", { nullable: true }),
    flatRate: num(input.flatRate, "Flat rate"),
    codFee: num(input.codFee, "COD fee"),
    codFeeWaivedAt: num(input.codFeeWaivedAt, "COD-fee waiver threshold", { nullable: true }),
    zones: [],
  };
  if (value.basis === null) errors.push('Basis must be "net" or "gross"');

  const zones = Array.isArray(input.zones) ? input.zones : [];
  for (const [i, z] of zones.entries()) {
    const prefixes = (Array.isArray(z.prefixes) ? z.prefixes : String(z.prefixes || "").split(","))
      .map((p) => String(p).trim())
      .filter(Boolean);
    if (!prefixes.length || prefixes.some((p) => !/^\d{1,6}$/.test(p))) {
      errors.push(`Zone ${i + 1}: prefixes must be 1–6 digit pincode starts`);
      continue;
    }
    const zone = { label: str(z.label) || `Zone ${i + 1}`, prefixes };
    if (z.flatRate != null && z.flatRate !== "") zone.flatRate = num(z.flatRate, `Zone ${i + 1} flat rate`);
    if (z.freeThreshold != null && z.freeThreshold !== "") zone.freeThreshold = num(z.freeThreshold, `Zone ${i + 1} free threshold`);
    value.zones.push(zone);
  }

  if (!errors.length) {
    try {
      computeShipping({ subtotal: 1000, paymentMethod: "cod", pincode: "110001", config: value });
    } catch (e) {
      errors.push(`Config rejected by the shipping engine: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors, value };
}

// Turn form input into a { config, secrets } patch for patchTenant. Only the
// sections PRESENT in the input are touched; secret fields are write-only
// (empty string = keep current). Returns { ok, errors, patch }.
export function buildSettingsPatch(input = {}, currentConfig = {}) {
  const errors = [];
  const config = {};
  const secrets = {};

  if (input.identity) {
    const id = input.identity;
    const email = str(id.support_email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Support email looks invalid");
    const site_url = str(id.site_url);
    if (site_url && !/^https?:\/\//.test(site_url)) errors.push("Site URL must start with http(s)://");
    config.site = {
      ...(currentConfig.site || {}),
      name: str(id.name) || currentConfig.site?.name || "",
      support_email: email || null,
      support_phone: str(id.support_phone) || null,
    };
    if (!config.site.name) errors.push("Store name is required");
    if (site_url) config.site_url = site_url.replace(/\/$/, "");
  }

  // S32 (MC22/BE06): checkout mode is an EXPLICIT choice (never silently
  // switched) and the merchant timezone drives schedule displays.
  if (input.commerce) {
    const c = input.commerce;
    if (c.checkout_mode !== undefined) {
      const mode = str(c.checkout_mode).toLowerCase();
      if (!["direct", "disabled"].includes(mode)) {
        errors.push('Checkout mode must be "direct" or "disabled" (shopify-hosted arrives in a later release)');
      } else {
        config.checkout_mode = mode;
      }
    }
    if (c.timezone !== undefined) {
      const tz = str(c.timezone);
      if (tz && !/^[A-Za-z_]+\/[A-Za-z0-9_+-]+$/.test(tz)) errors.push("Timezone must be an IANA name like Asia/Kolkata");
      else if (tz) config.timezone = tz;
    }
  }

  if (input.payments) {
    const p = input.payments;
    const keyId = str(p.razorpay_key_id);
    if (keyId && !/^rzp_(test|live)_/.test(keyId)) errors.push('Razorpay key id should start with "rzp_test_" or "rzp_live_"');
    config.razorpay_key_id = keyId || null;
    if (str(p.razorpay_key_secret)) secrets.razorpay_key_secret = str(p.razorpay_key_secret);
    if (str(p.razorpay_webhook_secret)) secrets.razorpay_webhook_secret = str(p.razorpay_webhook_secret);
  }

  if (input.tracking) {
    const t = input.tracking;
    const ga4 = str(t.ga4_measurement_id);
    if (ga4 && !/^G-[A-Z0-9]{4,}$/i.test(ga4)) errors.push('GA4 measurement id should look like "G-XXXXXXX"');
    const pixel = str(t.meta_pixel_id);
    if (pixel && !/^\d{5,20}$/.test(pixel)) errors.push("Meta pixel id should be numeric");
    config.ga4_measurement_id = ga4 || null;
    config.meta_pixel_id = pixel || null;
    config.meta_test_event_code = str(t.meta_test_event_code) || null;
    if (str(t.ga4_api_secret)) secrets.ga4_api_secret = str(t.ga4_api_secret);
    if (str(t.meta_capi_token)) secrets.meta_capi_token = str(t.meta_capi_token);
  }

  if (input.shipping) {
    const res = validateShippingConfig(input.shipping);
    if (!res.ok) errors.push(...res.errors);
    else config.shipping_config = res.value;
  }

  if (str(input.admin_password)) {
    if (str(input.admin_password).length < 8) errors.push("New console password must be at least 8 characters");
    else secrets.admin_password = str(input.admin_password);
  }

  return { ok: errors.length === 0, errors, patch: { config, secrets } };
}
