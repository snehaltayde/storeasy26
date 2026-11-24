// Phase 1 line 4: a founder connects Shopify from onboarding step 1. Node only;
// runs in TENANT context (the store is always the request's host).
//
//   connectFacts(tenant)   presence flags only, never a secret value:
//     { shopDomain, appReady, tokenHeld, uninstalledAt, reauthNeededAt,
//       missingScopes, locked }
//     appReady  the store's Shopify app is set up (client id and secret)
//     locked    the domain can no longer change here (connected, or the app
//               is set up for that shop)
//   startFounderConnect({ actor, shopInput, origin, adminCookie })
//     saves the domain while it isn't locked (audit shopify:domain), then
//     → { appReady: false } (nothing more to do until Storeasy sets the app up)
//     | { appReady: true, authorizeUrl, nonce } (the route sets the nonce cookie)
//     throws ConnectError: invalid | custom_domain | empty | locked |
//       other_store | suspended
//   finishFounderConnect({ params, search, actor, adminCookie, nonce, origin, defer, started })
//     checks, in order: state (session, store, nonce, expiry), Shopify's answer
//     (denied), the store's status, the app, HMAC, the shop, another store
//     holding the shop; then completeConnection (exclusive) and the audit row.
//     → { ok: true, missing } | { ok: false, code }
//     Nothing is exchanged or written before every check has passed.
import { currentTenant } from "../tenant-context.js";
import { getTenant, patchTenant } from "../platform/control.js";
import { audit } from "../platform/audit.js";
import { buildAuthorizeUrl, missingScopes, newNonce, signFounderState, verifyFounderState, verifyOAuthCallbackHmac } from "../platform/oauth.js";
import { ConnectError, completeConnection, otherTenantHoldingShop } from "../platform/shopify-connect.js";
import { normalizeShopDomain } from "../shopify-origin.js";
import { slog } from "../log.js";

export const CALLBACK_PATH = "/api/admin/shopify/callback";
export const NONCE_COOKIE = "_shopify_connect";

export function connectFacts(t) {
  const c = t?.config || {};
  const s = t?.secrets || {};
  const tokenHeld = Boolean(s.shopify_admin_token);
  const appReady = Boolean(c.shopify_client_id && s.shopify_client_secret);
  return {
    shopDomain: c.shopify_store_domain || null,
    appReady,
    tokenHeld,
    uninstalledAt: c.shopify_app_uninstalled_at || null,
    reauthNeededAt: c.shopify_reauth_needed_at || null,
    missingScopes: tokenHeld && c.shopify_scopes ? missingScopes(c.shopify_scopes) : [],
    locked: tokenHeld || appReady || Boolean(c.shopify_connected_at),
  };
}

async function storeRow() {
  const t = currentTenant();
  if (!t || t.id === "_default") throw new ConnectError("unsupported", "This store is set up from its environment config.");
  const row = await getTenant(t.id, { fresh: true });
  if (!row) throw new ConnectError("unsupported", "This store is set up from its environment config.");
  if (row.status !== "active") throw new ConnectError("suspended");
  return row;
}

export async function startFounderConnect({ actor, shopInput, origin, adminCookie }) {
  let row = await storeRow();
  let facts = connectFacts(row);
  if (!facts.locked) {
    const n = normalizeShopDomain(shopInput);
    if (!n.ok) throw new ConnectError(n.code, n.words);
    if (n.shop !== facts.shopDomain) {
      const other = await otherTenantHoldingShop(n.shop, row.id);
      if (other) throw new ConnectError("other_store");
      await patchTenant(row.id, { config: { shopify_store_domain: n.shop } });
      await audit({ actor, action: "settings.write", resource: "shopify:domain", diff: { from: facts.shopDomain, to: n.shop } });
      slog("shopify_domain_saved", { tenant: row.id });
      row = await getTenant(row.id, { fresh: true });
      facts = connectFacts(row);
    }
  } else if (shopInput != null && String(shopInput).trim()) {
    const n = normalizeShopDomain(shopInput);
    if (!n.ok || n.shop !== facts.shopDomain) throw new ConnectError("locked", "This store's Shopify address can't be changed here. Wrong store? Contact Storeasy support");
  }
  if (!facts.appReady) return { appReady: false, shopDomain: facts.shopDomain };
  if (!facts.shopDomain) throw new ConnectError("empty");
  if (await otherTenantHoldingShop(facts.shopDomain, row.id)) throw new ConnectError("other_store");
  if (!adminCookie) throw new ConnectError("mismatch");
  const nonce = newNonce();
  const state = signFounderState({ tenantId: row.id, adminCookie, nonce });
  const authorizeUrl = buildAuthorizeUrl({ shopDomain: facts.shopDomain, clientId: row.config.shopify_client_id, redirectUri: `${origin}${CALLBACK_PATH}`, state });
  return { appReady: true, authorizeUrl, nonce };
}

const fail = (code, tenantId) => {
  slog("shopify_connect_failed", { tenant: tenantId, code });
  return { ok: false, code };
};

export async function finishFounderConnect({ params, search, actor, adminCookie, nonce, origin, defer = null, started = Date.now() }) {
  const t = currentTenant();
  if (!t || t.id === "_default") return fail("mismatch", null);
  const st = verifyFounderState(params.get("state"), { tenantId: t.id, adminCookie, nonce });
  if (!st.ok) return fail(st.code, t.id);
  if (params.get("error")) return fail("denied", t.id);
  const row = await getTenant(t.id, { fresh: true });
  if (!row) return fail("mismatch", t.id);
  if (row.status !== "active") return fail("suspended", t.id);
  const clientSecret = row.secrets?.shopify_client_secret;
  if (!clientSecret || !row.config?.shopify_client_id) return fail("no_app", t.id);
  if (!verifyOAuthCallbackHmac(search, clientSecret)) return fail("hmac", t.id);
  const shop = String(params.get("shop") || "").toLowerCase();
  const expected = String(row.config?.shopify_store_domain || "").toLowerCase();
  if (!shop || shop !== expected) return fail("wrong_shop", t.id);
  if (await otherTenantHoldingShop(shop, row.id)) return fail("other_store", t.id);
  const code = params.get("code");
  if (!code) return fail("token_failed", t.id);
  let r;
  try {
    r = await completeConnection({ tenant: row, code, shop, connectedBy: actor?.id ?? null, platformUrl: process.env.PLATFORM_URL || origin, defer, started, exclusive: true });
  } catch (e) {
    if (e instanceof ConnectError) return fail(e.code, t.id);
    throw e;
  }
  const scopeCount = r.scope ? r.scope.split(",").filter(Boolean).length : 0;
  await audit({ actor, action: "settings.write", resource: "shopify:connection", diff: { shop, scopes: scopeCount, missing: r.missing } });
  return { ok: true, missing: r.missing, syncQueued: r.syncQueued };
}
