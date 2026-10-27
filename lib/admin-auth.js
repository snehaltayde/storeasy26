// Merchant console auth. Since Session 26 (BE02/MC01) this is a USER system:
// individual accounts + revocable server-side sessions in the control plane
// (lib/platform/sessions.js), verified fresh on every request so revocation
// holds across instances. Two bounded fallbacks keep older modes working:
//   • LEGACY mode (no PLATFORM_DB_URL): the original shared-password derived
//     token, unchanged — current production and pre-S20 local dev.
//   • BOOTSTRAP: platform mode but the tenant has NO member users yet — the
//     tenant's admin_password still works until the first user is created.
// Edge-safe (crypto.subtle + libsql HTTP) because /admin pages render under
// the edge layout. Password hashing lives in lib/platform/identity.js (Node).

import { tenantOwnSecret, tenantId, currentTenant } from "./tenant-context.js";
import { platformConfigured } from "./platform/control.js";
import { verifySession, membershipRole, tenantHasMembers } from "./platform/sessions.js";

export const ADMIN_COOKIE = "_admin";

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Session 20: each tenant has its own console password (tenant secrets;
// ADMIN_PASSWORD env is the default-tenant fallback). The session token binds
// to BOTH tenant id and password, so a cookie from one tenant's console can
// never authorize another's, and rotating a password revokes that tenant only.
const adminPassword = () => tenantOwnSecret("admin_password", "ADMIN_PASSWORD"); // S24: no cross-tenant fallback

export const adminConfigured = () => Boolean(adminPassword());

export const adminSessionToken = () =>
  sha256Hex(`storeasy-admin|${tenantId()}|${adminPassword() || ""}`);

// Session 22: token for EXPLICIT values — the settings route re-issues the
// cookie right after a password rotation (the old token dies with the patch).
export const adminSessionTokenFor = (tid, password) =>
  sha256Hex(`storeasy-admin|${tid}|${password || ""}`);

// Legacy/bootstrap check: the shared-password derived token.
async function verifyLegacyAdminToken(cookieValue) {
  if (!adminConfigured() || !cookieValue) return false;
  return cookieValue === (await adminSessionToken());
}

export async function verifyAdminToken(cookieValue) {
  if (!cookieValue) return false;
  if (platformConfigured() && currentTenant()) {
    // Session path: live merchant session + membership on THIS tenant.
    const s = await verifySession(cookieValue, "merchant");
    if (s && (await membershipRole(s.userId, tenantId()))) return true;
    // Bootstrap: no member users yet → the tenant's shared password still works.
    if (!(await tenantHasMembers(tenantId()))) return verifyLegacyAdminToken(cookieValue);
    return false;
  }
  return verifyLegacyAdminToken(cookieValue); // legacy single-tenant mode
}

// The signed-in user for a merchant session (null on legacy/bootstrap cookies).
export async function adminSessionUser(cookieValue) {
  if (!cookieValue || !(platformConfigured() && currentTenant())) return null;
  const s = await verifySession(cookieValue, "merchant");
  if (!s) return null;
  const role = await membershipRole(s.userId, tenantId());
  return role ? { userId: s.userId, role, sessionId: s.sessionId } : null;
}

// True when this tenant still accepts the shared bootstrap password.
export async function adminBootstrapMode() {
  if (!(platformConfigured() && currentTenant())) return true;
  return !(await tenantHasMembers(tenantId()));
}

export async function checkAdminPassword(password) {
  if (!adminConfigured() || typeof password !== "string") return false;
  // constant-time-ish: compare digests, not raw strings
  const a = await sha256Hex(`pw|${password}`);
  const b = await sha256Hex(`pw|${adminPassword()}`);
  return a === b;
}
