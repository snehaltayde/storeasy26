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
import { roleAllows, isWriteAction } from "./platform/authz.js";
import { sameOrigin } from "./origin-check.js";
import { verifyPlatformToken, PLATFORM_COOKIE } from "./platform/admin-auth.js";
import { activeSupportGrant, verifySupportSession, SUPPORT_COOKIE } from "./platform/support.js";

export { PLATFORM_COOKIE, SUPPORT_COOKIE };

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
    // Bootstrap: no member users yet → the tenant's shared password still
    // works. S53 (audit A3): ONLY a successful zero-rows lookup opens that
    // path — a lookup failure denies, it never resurrects the bootstrap
    // credential on a tenant that has accounts.
    let hasMembers;
    try {
      hasMembers = await tenantHasMembers(tenantId());
    } catch {
      return false;
    }
    if (!hasMembers) return verifyLegacyAdminToken(cookieValue);
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
// S53: a failed lookup reports NOT-bootstrap (fail closed) — callers use
// this to decide whether the shared password is still an accepted path.
export async function adminBootstrapMode() {
  if (!(platformConfigured() && currentTenant())) return true;
  try {
    return !(await tenantHasMembers(tenantId()));
  } catch {
    return false;
  }
}

// S34 (OP10): an OPERATOR may enter this tenant's console only through an
// ACTIVE support grant — always as the read-only, PII-redacted SUPPORT role.
// Checked fresh per request: a lapsed/revoked grant fails the next call, open
// tabs included.
// Phase 3 line 5: or a host-only `__Host-support` session (entry across hosts,
// lib/platform/support.js): a live support session of an active operator whose
// grant is this host's store's open grant. The _platform path on the same host
// stays.
export async function supportActor(platformCookieValue, supportCookieValue = null) {
  if (!(platformConfigured() && currentTenant())) return null;
  if (supportCookieValue) {
    const s = await verifySupportSession(supportCookieValue, tenantId());
    if (s) return { kind: "operator-support", id: String(s.userId), role: "support", grantId: s.grantId };
  }
  if (!platformCookieValue) return null;
  if (!(await verifyPlatformToken(platformCookieValue))) return null;
  const grant = await activeSupportGrant(tenantId());
  if (!grant) return null;
  return { kind: "operator-support", id: String(grant.operator), role: "support", grantId: grant.id };
}

// Who is acting on this tenant's console: merchant session, bootstrap cookie,
// or an operator under an active support grant. Pages use this for both
// access and role-aware rendering.
export async function adminActor(adminCookieValue, platformCookieValue = null, supportCookieValue = null) {
  const user = await adminSessionUser(adminCookieValue);
  if (user) return { kind: "merchant", id: user.userId, role: user.role };
  if (adminCookieValue && (await verifyAdminToken(adminCookieValue))) {
    return { kind: "bootstrap", id: "bootstrap", role: "owner" };
  }
  return supportActor(platformCookieValue, supportCookieValue);
}

// S27 (BE03): the one gate every admin API route calls — authentication,
// per-action role authorization, and the CSRF origin check for writes, in one
// place. The tenant is ALWAYS the host-resolved context; a tenant id in the
// URL or body never authorizes anything.
//   const auth = await requireAdmin(request, "offers.write");
//   if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
// Bootstrap/legacy cookies act as role "owner" (single-password mode predates
// users); individual sessions carry their membership role.
// Phase 0 (F2): the origin check also covers every mutating METHOD, read
// actions included — preview-session, releases preview and the integrations
// test all change state or call out under a ".read" action. A request with no
// method (older suites' hand-made requests) keeps the action-only rule.
const mutatingMethod = (request) => Boolean(request.method) && !["GET", "HEAD"].includes(String(request.method).toUpperCase());

export async function requireAdmin(request, action) {
  if ((isWriteAction(action) || mutatingMethod(request)) && !sameOrigin(request)) {
    return { ok: false, status: 403, error: "Cross-origin request rejected" };
  }
  const cookieValue = request.cookies.get(ADMIN_COOKIE)?.value;

  const user = await adminSessionUser(cookieValue);
  if (user) {
    if (!roleAllows(user.role, action)) {
      return {
        ok: false,
        status: 403,
        error: `Your role (${user.role}) can't do that`,
        actor: { kind: "merchant", id: user.userId, role: user.role },
      };
    }
    return { ok: true, actor: { kind: "merchant", id: user.userId, role: user.role } };
  }
  if (await verifyAdminToken(cookieValue)) {
    return { ok: true, actor: { kind: "bootstrap", id: "bootstrap", role: "owner" } };
  }
  // S34 (OP10): operator under an ACTIVE support grant → support role only
  const support = await supportActor(request.cookies.get(PLATFORM_COOKIE)?.value, request.cookies.get(SUPPORT_COOKIE)?.value);
  if (support) {
    if (!roleAllows(support.role, action)) {
      return { ok: false, status: 403, error: "Support access is read-only", actor: support };
    }
    return { ok: true, actor: support };
  }
  return { ok: false, status: 401, error: "Unauthorized" };
}

export async function checkAdminPassword(password) {
  if (!adminConfigured() || typeof password !== "string") return false;
  // constant-time-ish: compare digests, not raw strings
  const a = await sha256Hex(`pw|${password}`);
  const b = await sha256Hex(`pw|${adminPassword()}`);
  return a === b;
}
