// Platform OPERATOR auth — distinct from the per-tenant merchant console auth
// (lib/admin-auth.js). Since Session 26 (OP01): individual operator users with
// mandatory TOTP and short revocable sessions (kind "operator" — a merchant
// session can never pass here). BOOTSTRAP fallback: while NO active operator
// user exists, the legacy PLATFORM_ADMIN_PASSWORD derived token still works
// (create the first operator with `pnpm operator:create` to switch it off).
// Edge-safe: verification is crypto.subtle + a control-plane lookup.

import { platformConfigured } from "./control.js";
import { verifySession, operatorsExist } from "./sessions.js";

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

async function verifyLegacyPlatformToken(cookieValue) {
  if (!platformAdminConfigured() || !cookieValue) return false;
  return cookieValue === (await platformSessionToken());
}

export async function verifyPlatformToken(cookieValue) {
  if (!cookieValue) return false;
  if (platformConfigured()) {
    const s = await verifySession(cookieValue, "operator");
    if (s) return true;
    // Bootstrap only: the shared password dies with the first operator user.
    if (!(await operatorsExist())) return verifyLegacyPlatformToken(cookieValue);
    return false;
  }
  return verifyLegacyPlatformToken(cookieValue);
}

export async function checkPlatformPassword(password) {
  if (!platformAdminConfigured() || typeof password !== "string") return false;
  const a = await sha256Hex(`pw|${password}`);
  const b = await sha256Hex(`pw|${operatorPassword()}`);
  return a === b;
}
