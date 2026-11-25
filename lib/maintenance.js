// Maintenance curtain decision (S43 / OP12). A cookie only lifts the curtain
// when its VALUE verifies for this tenant — merely sending `_admin=x` proves
// nothing. Every check fails closed: a lookup error shows the curtain.
//
// The `_mx` pass is an HMAC-signed, tenant-bound, 15-minute value, and only a
// verified staff session can obtain one. It is not needed to sign in:
// /admin/login lives in the (console) route group, outside the curtain (S50).
//
// Edge-safe (crypto.subtle + libsql HTTP): the storefront layout runs this.
// Hiding the page is only half of it: lib/storefront-request.js applies the
// same decision to the data path, because the layout alone hides nothing from
// the response. Checkout is separate — checkoutCapability closes it for
// everyone, staff too.
import { tenantId, tenantOwnCfg, tenantOwnSecret } from "./tenant-context.js";
import { ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE, verifyAdminToken } from "./admin-auth.js";
import { verifySupportSession } from "./platform/support.js";
import { verifyPlatformToken } from "./platform/admin-auth.js";
import { accentShades, contrastRatio, mixHex, resolveBrand } from "./brand.js";

export const MAINTENANCE_PASS_COOKIE = "_mx";
export const MAINTENANCE_PASS_TTL_S = 15 * 60;

export const MAINTENANCE_GATE = {
  status: 503,
  code: "STORE_MAINTENANCE",
  message: "The store is briefly down for maintenance. Please try again shortly.",
  retryAfter: "300",
};

const te = new TextEncoder();

// No dev fallback, unlike preview tokens: without the tenant's own secret no
// pass can be issued or accepted. Staff sessions still work.
function passSecret() {
  const base = tenantOwnSecret("order_link_secret", "ORDER_LINK_SECRET");
  return base ? `${base}|maintenance-pass` : null;
}

const passKey = (secret) =>
  crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const passMessage = (exp) => te.encode(`${tenantId()}|${exp}`);

async function signPass(exp, secret) {
  const sig = await crypto.subtle.sign("HMAC", await passKey(secret), passMessage(exp));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `m.${exp}.${hex}`;
}

export async function verifyMaintenancePass(value, { now = Date.now() } = {}) {
  const m = /^m\.(\d{1,12})\.([0-9a-f]{64})$/.exec(String(value || ""));
  const secret = passSecret();
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  if (now > exp * 1000) return false;
  const sig = Uint8Array.from(m[2].match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", await passKey(secret), sig, passMessage(m[1]));
}

async function verified(check, value) {
  if (!value) return false;
  try {
    return (await check(value)) === true;
  } catch {
    return false;
  }
}

async function hasStaffSession(jar) {
  return (
    (await verified(verifyAdminToken, jar.get(ADMIN_COOKIE)?.value)) ||
    (await verified(verifyPlatformToken, jar.get(PLATFORM_COOKIE)?.value)) ||
    // Phase 3 line 5: an operator's support session on this host
    (await verified(async (v) => Boolean(await verifySupportSession(v, tenantId())), jar.get(SUPPORT_COOKIE)?.value))
  );
}

// `jar` is anything with get(name)?.value: next/headers cookies() or
// request.cookies. Call inside the tenant context.
export async function maintenanceBypass(jar) {
  return (await verified(verifyMaintenancePass, jar.get(MAINTENANCE_PASS_COOKIE)?.value)) || hasStaffSession(jar);
}

// Cheap on purpose: an in-memory config read, so an open store pays nothing.
export const maintenanceConfig = () => tenantOwnCfg("maintenance", null, null);
export const maintenanceOn = () => Boolean(maintenanceConfig()?.enabled);

// The maintenance config when THIS visitor must see the closed page, else null.
export async function maintenanceCurtain(jar) {
  if (!maintenanceOn()) return null;
  return (await maintenanceBypass(jar)) ? null : maintenanceConfig();
}

// Every page of a closed store carries this title. Its pages can't read their
// own titles (the gate withholds the data), so without it each one falls
// through to not-found.js's "Page not found", a soft 404 to a crawler.
export const curtainTitle = (name) => `${name} will be right back`;

// Closed-page colours: the store's own background and text, which validateBrand
// holds to 4.5:1, plus the softest muted tone that still reaches 4.5:1. They
// are applied inline, because globals.css's unlayered `body` rule beats utility
// classes, and fixed greys vanish on a dark brand.
export function curtainPalette(brand) {
  const raw = resolveBrand(brand);
  const b = contrastRatio(raw.foreground, raw.background) >= 4.5 ? raw : resolveBrand(null);
  const muted = [0.4, 0.3, 0.2, 0.1, 0]
    .map((t) => mixHex(b.foreground, b.background, t))
    .find((c) => contrastRatio(c, b.background) >= 4.5);
  return {
    background: b.background,
    foreground: b.foreground,
    muted,
    border: mixHex(b.foreground, b.background, 0.8),
    accent: accentShades(b.accent)[400],
  };
}

// A signed pass for a verified staff session, else null. A pass alone cannot
// renew itself, so it never outlives its 15 minutes.
export async function issueMaintenancePass(jar, { now = Date.now() } = {}) {
  const secret = passSecret();
  if (!secret || !(await hasStaffSession(jar))) return null;
  return signPass(Math.floor(now / 1000) + MAINTENANCE_PASS_TTL_S, secret);
}
