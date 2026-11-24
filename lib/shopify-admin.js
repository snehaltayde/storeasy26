// Shopify Admin API helper (SERVER-ONLY). Never import into client code.
//
// Token resolution order:
//   1. SHOPIFY_ADMIN_TOKEN  — an offline token from OAuth (preferred). Phase 1
//      line 4: a token with a refresh token and an expiry (Shopify's expiring
//      offline tokens, 1 hour) is refreshed ~60 s before it expires; one refresh
//      at a time per store in this process, the current token cached. A token
//      without a refresh token is a non-expiring one and is used as it is.
//   2. client-credentials grant (SHOPIFY_CLIENT_ID/SECRET) — 24h, same-org dev
//      stores only; never once Shopify asked for the store to connect again
// Every URL goes through shopifyBase (lib/shopify-origin.js).
import { tenantCfg, tenantOwnCfg, tenantOwnSecret, tenantId, currentTenant, withTenant } from "./tenant-context.js";
import { shopifyBase } from "./shopify-origin.js";

const API_VERSION = () => tenantCfg("shopify_api_version", "SHOPIFY_API_VERSION", "2025-10");

function storeDomain() {
  const d = tenantOwnCfg("shopify_store_domain", "SHOPIFY_STORE_DOMAIN"); // S24: tenant-scoped
  if (!d) throw new Error("Shopify store domain is not configured (tenant config or SHOPIFY_STORE_DOMAIN)");
  return d;
}

const ccCache = new Map(); // tenant id → { token, expiresAt } (per-tenant apps, S21)

async function clientCredentialsToken() {
  const clientId = tenantOwnCfg("shopify_client_id", "SHOPIFY_CLIENT_ID");
  const clientSecret = tenantOwnSecret("shopify_client_secret", "SHOPIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("No SHOPIFY_ADMIN_TOKEN, and SHOPIFY_CLIENT_ID/SECRET not set either");
  }
  const cacheKey = `${tenantId()}:${clientId}`;
  const hit = ccCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const res = await fetch(`${shopifyBase(storeDomain())}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`client-credentials grant failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text);
  ccCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 86399) * 1000 });
  return json.access_token;
}

export const REAUTH_ERROR = "Shopify needs this store connected again (401 invalid_request)";

export async function getAdminAccessToken() {
  const token = tenantOwnSecret("shopify_admin_token", "SHOPIFY_ADMIN_TOKEN");
  const t = currentTenant();
  const own = t && t.id !== "_default" ? t : null;
  if (token) {
    if (own?.secrets?.shopify_refresh_token && own.config?.shopify_token_expires_at) return expiringToken(own);
    return token;
  }
  if (own?.config?.shopify_reauth_needed_at) throw new Error(REAUTH_ERROR);
  return clientCredentialsToken();
}

// ---- expiring offline tokens (Phase 1 line 4) --------------------------------
const REFRESH_SKEW_MS = 60_000;
const tokenCache = new Map(); // tenant id → { token, expiresAt } (the newest this process knows)
const refreshing = new Map(); // tenant id → the one refresh in flight
const expiresAtOf = (t) => Date.parse(t?.config?.shopify_token_expires_at || "") || 0;

// A connect or a clear drops what this process remembers for the store.
export function forgetAdminToken(id) {
  tokenCache.delete(id);
}

async function expiringToken(t) {
  const stored = { token: t.secrets.shopify_admin_token, expiresAt: expiresAtOf(t) };
  const hit = tokenCache.get(t.id);
  const best = hit && hit.expiresAt > stored.expiresAt ? hit : stored;
  if (best.expiresAt - Date.now() > REFRESH_SKEW_MS) return best.token;
  if (!refreshing.has(t.id)) refreshing.set(t.id, refreshStoredToken(t.id).finally(() => refreshing.delete(t.id)));
  return refreshing.get(t.id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshStoredToken(id) {
  const { getTenant, patchTenant } = await import("./platform/control.js");
  const { slog } = await import("./log.js");
  const row = await getTenant(id, { fresh: true });
  if (!row) throw new Error(`tenant ${id} not found`);
  // another instance may have refreshed since this request read the row
  if (row.secrets?.shopify_admin_token && expiresAtOf(row) - Date.now() > REFRESH_SKEW_MS) {
    tokenCache.set(id, { token: row.secrets.shopify_admin_token, expiresAt: expiresAtOf(row) });
    return row.secrets.shopify_admin_token;
  }
  const refreshToken = row.secrets?.shopify_refresh_token;
  if (!refreshToken) throw new Error(REAUTH_ERROR);
  let tok;
  try {
    tok = await withTenant(row, () => refreshAdminToken(refreshToken));
  } catch (e) {
    if (e?.permanent) {
      await patchTenant(id, {
        secrets: { shopify_admin_token: null, shopify_refresh_token: null },
        config: { shopify_token_expires_at: null, shopify_refresh_expires_at: null, shopify_reauth_needed_at: new Date().toISOString() },
      });
      forgetAdminToken(id);
      slog("shopify_reauth_needed", { tenant: id });
      const { sendAlert } = await import("./alerts.js");
      await sendAlert(`Shopify asked ${id} to connect again: its refresh token was refused`, { tenant: id }, { severity: "warn" }).catch(() => {});
      throw new Error(REAUTH_ERROR);
    }
    throw e;
  }
  const saved = tokenFields(tok);
  // re-read before saving: a refresh that wrote meanwhile holds the newer pair
  const latest = await getTenant(id, { fresh: true });
  if (latest?.secrets?.shopify_admin_token && expiresAtOf(latest) > expiresAtOf(row) && latest.secrets.shopify_admin_token !== row.secrets?.shopify_admin_token) {
    tokenCache.set(id, { token: latest.secrets.shopify_admin_token, expiresAt: expiresAtOf(latest) });
    return latest.secrets.shopify_admin_token;
  }
  await patchTenant(id, { secrets: saved.secrets, config: saved.config });
  tokenCache.set(id, { token: tok.access_token, expiresAt: Date.parse(saved.config.shopify_token_expires_at) || 0 });
  slog("shopify_token_refreshed", { tenant: id });
  return tok.access_token;
}

// Shopify's token answer → the tenant keys it is stored under. A token without
// a refresh token is non-expiring: no expiry is recorded for it.
export function tokenFields(tok, now = Date.now()) {
  const at = (s) => (Number(s) > 0 ? new Date(now + Number(s) * 1000).toISOString() : null);
  const refresh = tok?.refresh_token || null;
  return {
    secrets: { shopify_admin_token: tok.access_token, shopify_refresh_token: refresh },
    config: { shopify_token_expires_at: refresh ? at(tok.expires_in) : null, shopify_refresh_expires_at: refresh ? at(tok.refresh_token_expires_in) : null },
  };
}

// One refresh: network errors, 5xx and 429 are tried again (three tries); a
// refused refresh token (400/401) throws with permanent: true.
export async function refreshAdminToken(refreshToken, { tries = 3, backoffMs = 500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${shopifyBase(storeDomain())}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: tenantOwnCfg("shopify_client_id", "SHOPIFY_CLIENT_ID"),
          client_secret: tenantOwnSecret("shopify_client_secret", "SHOPIFY_CLIENT_SECRET"),
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
    } catch (e) {
      if (attempt < tries) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw e;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if ((res.status >= 500 || res.status === 429) && attempt < tries) {
      await sleep(backoffMs * attempt);
      continue;
    }
    throw Object.assign(new Error(`token refresh failed (${res.status}): ${text.slice(0, 200)}`), { status: res.status, permanent: res.status === 400 || res.status === 401 });
  }
}

// `timeoutMs` (GEN-02 review fix): give up on a call that hasn't answered in
// that long. Only for reads (the catalog sync passes it); a write cut off
// mid-flight could still land in Shopify, so writes never set one.
export async function adminGraphqlWithToken(token, query, variables = {}, attempt = 0, { timeoutMs = null } = {}) {
  const res = await fetch(`${shopifyBase(storeDomain())}/admin/api/${API_VERSION()}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // 429 = REST-style rate limit; back off and retry.
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return adminGraphqlWithToken(token, query, variables, attempt + 1, { timeoutMs });
    }
    throw new Error(`Admin GraphQL HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text);
  if (json.errors) {
    const throttled = json.errors.some((e) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return adminGraphqlWithToken(token, query, variables, attempt + 1, { timeoutMs });
    }
    throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
  }
  return json.data;
}

export async function adminGraphql(query, variables = {}, { timeoutMs = null } = {}) {
  return adminGraphqlWithToken(await getAdminAccessToken(), query, variables, 0, { timeoutMs });
}

// Exchange an OAuth authorization code for an offline Admin token. Phase 1
// line 4: asks for an expiring one (expiring: 1), so the answer carries
// expires_in, refresh_token and refresh_token_expires_in (see tokenFields).
// Tenant app creds first (S21 web connect flow), env fallback (legacy script).
export async function exchangeCodeForToken(code) {
  const res = await fetch(`${shopifyBase(storeDomain())}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: tenantOwnCfg("shopify_client_id", "SHOPIFY_CLIENT_ID"),
      client_secret: tenantOwnSecret("shopify_client_secret", "SHOPIFY_CLIENT_SECRET"),
      code,
      expiring: 1,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text); // { access_token, scope, expires_in?, refresh_token?, refresh_token_expires_in? }
}

const MINT_MUTATION = /* GraphQL */ `
  mutation Mint($input: StorefrontAccessTokenInput!) {
    storefrontAccessTokenCreate(input: $input) {
      storefrontAccessToken { accessToken title }
      userErrors { field message }
    }
  }
`;

export async function mintStorefrontToken(adminToken, title = "storeasy26 catalog sync") {
  const data = await adminGraphqlWithToken(adminToken, MINT_MUTATION, { input: { title } });
  const payload = data.storefrontAccessTokenCreate;
  if (payload.userErrors?.length) {
    throw new Error(`userErrors: ${JSON.stringify(payload.userErrors)}`);
  }
  return payload.storefrontAccessToken.accessToken;
}
