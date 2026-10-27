// Simple single-operator admin auth (Session 19). ADMIN_PASSWORD env → login
// sets an httpOnly cookie whose value is a derived token (never the password).
// Edge-safe (crypto.subtle) because /admin pages render under the edge layout.
// Single store, single operator — deliberately NOT a user system.

import { tenantOwnSecret, tenantId } from "./tenant-context.js";

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

export async function verifyAdminToken(cookieValue) {
  if (!adminConfigured() || !cookieValue) return false;
  return cookieValue === (await adminSessionToken());
}

export async function checkAdminPassword(password) {
  if (!adminConfigured() || typeof password !== "string") return false;
  // constant-time-ish: compare digests, not raw strings
  const a = await sha256Hex(`pw|${password}`);
  const b = await sha256Hex(`pw|${adminPassword()}`);
  return a === b;
}
