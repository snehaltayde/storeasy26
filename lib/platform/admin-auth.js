// Platform OPERATOR auth (Session 22) — distinct from the per-tenant merchant
// console auth (lib/admin-auth.js). One password for the whole platform
// (PLATFORM_ADMIN_PASSWORD env; console disabled when unset), cookie token
// derived from it so rotation revokes all operator sessions. Edge-safe.

export const PLATFORM_COOKIE = "_platform";

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const operatorPassword = () => process.env.PLATFORM_ADMIN_PASSWORD || "";

export const platformAdminConfigured = () => Boolean(operatorPassword());

export const platformSessionToken = () => sha256Hex(`storeasy-platform|${operatorPassword()}`);

export async function verifyPlatformToken(cookieValue) {
  if (!platformAdminConfigured() || !cookieValue) return false;
  return cookieValue === (await platformSessionToken());
}

export async function checkPlatformPassword(password) {
  if (!platformAdminConfigured() || typeof password !== "string") return false;
  const a = await sha256Hex(`pw|${password}`);
  const b = await sha256Hex(`pw|${operatorPassword()}`);
  return a === b;
}
