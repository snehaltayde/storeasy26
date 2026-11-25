// Merchant settings for the tenant console (Session 22). Pure build/validate
// logic — the API route supplies the tenant + DB counts and persists the patch
// via patchTenant, so everything here is unit-testable without a server.
import { validateMarkets } from "../markets.js";
import { SHIPPING_CONFIG, computeShipping } from "../shipping.js";
import { deliveryLine } from "../delivery-estimate.js";
import { shippingRatesChosen } from "../brand-tenants.js";
import { isTimeZone } from "./schedule.js";

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
      // S52: the brand-surface strings finally get an editor (they were
      // seed-script-only). All live-on-save, like the rest of config.site.
      title: cfg.site?.title || "",
      tagline: cfg.site?.tagline || "",
      footer_tagline: cfg.site?.footer_tagline || "",
      logo_text1: cfg.site?.logo?.text1 || "",
      logo_text2: cfg.site?.logo?.text2 || "",
      legal_name: cfg.site?.legal_name || "",
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
    payment_config: cfg.payment_config || {}, // Phase 8 line 2: prepaid discount and COD rules
    shipping_is_default: !shippingRatesChosen(tenant), // GEN-03: the form above is showing starter rates, not the store's
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
    // Phase 8: the zone's own delivery days, and `cod: false` hides cash on delivery there
    const zoneDays = dayRange(z.deliveryDays, `Zone ${i + 1} delivery days`, errors);
    if (zoneDays) zone.deliveryDays = zoneDays;
    if (z.cod === false || z.cod === true) zone.cod = z.cod;
    else if (z.cod != null && z.cod !== "") errors.push(`Zone ${i + 1}: cash on delivery must be on or off`);
    value.zones.push(zone);
  }

  // Phase 8: days to dispatch and the default delivery days (decision 9).
  // Absent stays absent, so a store that never set them saves the same JSON.
  const dispatch = days(input.dispatchDays, "Dispatch days", errors);
  if (dispatch != null) value.dispatchDays = dispatch;
  const delivery = dayRange(input.deliveryDays, "Delivery days", errors);
  if (delivery) value.deliveryDays = delivery;

  if (!errors.length) {
    try {
      computeShipping({ subtotal: 1000, paymentMethod: "cod", pincode: "110001", config: value });
    } catch (e) {
      errors.push(`Config rejected by the shipping engine: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, errors, value };
}

// Phase 8: a whole number of calendar days, or null when the field is blank.
// Line 1: dispatch takes 0–10 days, delivery 1–30 (plan "Line 1" item 4).
const DISPATCH_DAYS = { min: 0, max: 10 };
const DELIVERY_DAYS = { min: 1, max: 30 };
function days(v, label, errors, { min, max } = DISPATCH_DAYS) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${label} must be a whole number from ${min} to ${max}`);
    return null;
  }
  return n;
}

// Phase 8: { min, max } delivery days, or null when both are blank.
function dayRange(v, label, errors) {
  if (v == null) return null;
  if (typeof v !== "object") {
    errors.push(`${label} must have a minimum and a maximum`);
    return null;
  }
  const blank = (x) => x == null || x === "";
  if (blank(v.min) && blank(v.max)) return null;
  if (blank(v.min) || blank(v.max)) {
    errors.push(`${label} need both a minimum and a maximum`);
    return null;
  }
  const min = days(v.min, `${label} minimum`, errors, DELIVERY_DAYS);
  const max = days(v.max, `${label} maximum`, errors, DELIVERY_DAYS);
  if (min == null || max == null) return null;
  if (max < min) {
    errors.push(`${label}: the maximum can't be less than the minimum`);
    return null;
  }
  return { min, max };
}

// Phase 8 (decisions 11 and 12): how shoppers pay. `prepaid` is the optional
// nudge for paying online; `cod` limits cash on delivery and asks for an OTP.
// Absent sections stay absent. Returns { ok, errors[], value }.
export const PREPAID_PERCENT_MAX = 20;
export const COD_OTP_MODES = ["off", "always", "above"];
export const COD_OTP_CHANNELS = ["sms", "email"];
export function validatePaymentConfig(input = {}) {
  const errors = [];
  const value = {};
  const money = (v, label) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${label} must be a number ≥ 0`);
      return null;
    }
    return n;
  };

  // a blank or zero amount means no prepaid discount
  const p = input?.prepaid;
  if (p != null && p !== false) {
    if (typeof p !== "object" || !["percent", "fixed"].includes(p.kind)) {
      errors.push('Prepaid discount must be "percent" or "fixed"');
    } else {
      const v = money(p.value, "Prepaid discount");
      if (!v) {
        // nothing to store
      } else if (p.kind === "percent" && v > PREPAID_PERCENT_MAX) {
        errors.push(`Prepaid discount can be at most ${PREPAID_PERCENT_MAX}%`);
      } else {
        const prepaid = { kind: p.kind, value: v };
        const max = money(p.max, "Prepaid discount cap");
        if (max != null) prepaid.max = max;
        value.prepaid = prepaid;
      }
    }
  }

  const c = input?.cod;
  if (c != null) {
    if (typeof c !== "object") {
      errors.push("Cash-on-delivery rules are invalid");
    } else {
      const otp = c.otp == null || c.otp === "" ? "off" : c.otp;
      if (!COD_OTP_MODES.includes(otp)) errors.push('Cash-on-delivery OTP must be "off", "always" or "above"');
      const cod = { otp };
      const maxTotal = money(c.maxTotal, "Cash-on-delivery limit");
      if (maxTotal != null) cod.maxTotal = maxTotal;
      if (otp === "above") {
        const above = money(c.otpAbove, "OTP threshold");
        if (above == null) errors.push("Say the order total above which cash on delivery asks for an OTP");
        else cod.otpAbove = above;
      }
      if (otp !== "off") {
        const channel = c.otpChannel == null || c.otpChannel === "" ? "email" : c.otpChannel;
        if (!COD_OTP_CHANNELS.includes(channel)) errors.push('The OTP goes by "sms" or "email"');
        else cod.otpChannel = channel;
      }
      value.cod = cod;
    }
  }

  return { ok: errors.length === 0, errors, value };
}

// GEN-03: did the founder really change the shipping form? Compares what the
// values mean, so "79" retyped over 79 is no change. Anything invalid counts as
// a change, so the save goes through and the founder sees the error.
export function shippingFormChanged(form, saved) {
  const a = validateShippingConfig(form);
  return !a.ok || JSON.stringify(a.value) !== JSON.stringify(validateShippingConfig(saved).value);
}

// Turn form input into a { config, secrets } patch for patchTenant. Only the
// sections PRESENT in the input are touched; secret fields are write-only
// (empty string = keep current). Returns { ok, errors, patch }.
// `smsAvailable`: whether this server can send SMS (lib/messaging/sms.js); the
// route passes it, so the SMS channel is refused where no provider is set.
export const SMS_UNAVAILABLE = "SMS codes need an SMS provider, and this store has none yet. Choose email for now.";
export function buildSettingsPatch(input = {}, currentConfig = {}, { smsAvailable = false } = {}) {
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
    };
    // a support field the input leaves out keeps its value (onboarding step 4
    // sends only what the founder filled in); an empty string clears it
    if (id.support_email !== undefined) config.site.support_email = email || null;
    if (id.support_phone !== undefined) config.site.support_phone = str(id.support_phone) || null;
    // S52: optional brand-surface strings — only touched when the form sends
    // them (older clients that omit the fields leave them alone).
    if (id.title !== undefined) config.site.title = str(id.title).slice(0, 120) || null;
    if (id.tagline !== undefined) config.site.tagline = str(id.tagline).slice(0, 300) || null;
    if (id.footer_tagline !== undefined) config.site.footer_tagline = str(id.footer_tagline).slice(0, 300) || null;
    if (id.legal_name !== undefined) config.site.legal_name = str(id.legal_name).slice(0, 160) || null;
    if (id.logo_text1 !== undefined || id.logo_text2 !== undefined) {
      const text1 = id.logo_text1 !== undefined ? str(id.logo_text1).slice(0, 40) : currentConfig.site?.logo?.text1 || "";
      const text2 = id.logo_text2 !== undefined ? str(id.logo_text2).slice(0, 40) : currentConfig.site?.logo?.text2 || "";
      config.site.logo = text1 || text2 ? { text1, text2 } : null;
    }
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
      if (tz && (!/^[A-Za-z_]+\/[A-Za-z0-9_+-]+$/.test(tz) || !isTimeZone(tz))) errors.push("Timezone must be an IANA name like Asia/Kolkata");
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

  // Phase 8 line 2 (decisions 11–13): prepaid discount and COD rules.
  if (input.payment_config) {
    const res = validatePaymentConfig(input.payment_config);
    if (!res.ok) errors.push(...res.errors);
    else if (res.value.cod?.otpChannel === "sms" && !smsAvailable) errors.push(SMS_UNAVAILABLE);
    else config.payment_config = res.value;
  }

  // Phase 8 line 4 (decisions 14, 16): markets, each checked against the
  // Razorpay allowlist and the international tick; a rate keeps its date
  // unless it changed.
  if (input.markets !== undefined) {
    const res = validateMarkets(input.markets, { config: currentConfig, previous: currentConfig.markets || [] });
    if (!res.ok) errors.push(...res.errors);
    else config.markets = res.value;
  }

  if (str(input.admin_password)) {
    if (str(input.admin_password).length < 8) errors.push("New console password must be at least 8 characters");
    else secrets.admin_password = str(input.admin_password);
  }

  return { ok: errors.length === 0, errors, patch: { config, secrets } };
}

// Phase 2 line 7: the Shipping tab's worked example, in words, from the
// shipping engine itself (so the words match what a shopper is charged).
// input: the form's values (validated here); → [sentence] or [] when invalid.
// Phase 8 line 1: plus the delivery estimate a shopper sees today (opts.now,
// opts.timeZone: the store's) when the store set delivery days.
export function shippingExample(input = {}, { now = new Date(), timeZone } = {}) {
  const { ok, value } = validateShippingConfig({ ...input, zones: [] });
  if (!ok) return [];
  const rupees = (n) => `₹${Number(n).toLocaleString("en-IN")}`;
  const pays = (subtotal, paymentMethod) => computeShipping({ subtotal, paymentMethod, config: value }).total;
  const out = [];
  const below = value.freeThreshold != null ? Math.max(value.freeThreshold - 1, 0) : 999;
  if (value.freeThreshold == null || value.freeThreshold > 0) {
    const n = pays(below, "prepaid");
    out.push(`An order of ${rupees(below)} paid online pays ${n ? rupees(n) : "nothing"} for shipping.`);
  }
  if (value.freeThreshold != null) out.push(`An order of ${rupees(value.freeThreshold)} or more ships free.`);
  if (value.codFee > 0) {
    const cod = pays(below, "cod");
    out.push(
      `Paying cash on delivery adds ${rupees(value.codFee)}, so that ${rupees(below)} order pays ${rupees(cod)}${value.codFeeWaivedAt != null ? `; from ${rupees(value.codFeeWaivedAt)} there is no cash-on-delivery fee` : ""}.`,
    );
  }
  const { estimate } = computeShipping({ subtotal: below, config: value });
  if (estimate) {
    const span = estimate.minDays === estimate.maxDays ? `${estimate.maxDays}` : `${estimate.minDays}–${estimate.maxDays}`;
    out.push(`An order placed today arrives in ${span} days: shoppers see "${deliveryLine(estimate, { from: now, timeZone })}".`);
  }
  return out;
}

// Phase 2 line 7: the Checkout tab's "Shoppers can pay with …" line, from the
// open checks' payment item (lib/documents/opening.js paymentItem()).
export function shoppersPayWith(item) {
  if (!item) return null;
  if (item.level === "ok") return "Shoppers can pay with cards, UPI and cash on delivery.";
  if (item.level === "info") return "Shoppers can pay with cash on delivery only. Add your Razorpay keys to take cards and UPI.";
  return `Shoppers can't pay right now. ${item.message || item.title || ""}`.trim();
}

// Phase 2 line 7: the Details tab sends only the identity fields the founder
// changed, so a tab opened before another save (onboarding's Brand step setting
// the logo text, another admin's tagline) never writes those older values back.
// form, saved: { field: string } → { field: value } of the changed ones only
export function changedIdentity(form = {}, saved = {}) {
  return Object.fromEntries(Object.entries(form).filter(([k, v]) => (v ?? "") !== (saved[k] ?? "")));
}
