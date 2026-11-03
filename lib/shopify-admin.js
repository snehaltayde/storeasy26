// Shopify Admin API helper (SERVER-ONLY). Never import into client code.
//
// Token resolution order:
//   1. SHOPIFY_ADMIN_TOKEN  — a permanent offline token from OAuth (preferred)
//   2. client-credentials grant (SHOPIFY_CLIENT_ID/SECRET) — 24h, same-org dev stores only
import { tenantCfg, tenantOwnCfg, tenantOwnSecret, tenantId } from "./tenant-context.js";

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

  const res = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
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

export async function getAdminAccessToken() {
  const token = tenantOwnSecret("shopify_admin_token", "SHOPIFY_ADMIN_TOKEN");
  if (token) return token;
  return clientCredentialsToken();
}

// `timeoutMs` (GEN-02 review fix): give up on a call that hasn't answered in
// that long. Only for reads (the catalog sync passes it); a write cut off
// mid-flight could still land in Shopify, so writes never set one.
export async function adminGraphqlWithToken(token, query, variables = {}, attempt = 0, { timeoutMs = null } = {}) {
  const res = await fetch(`https://${storeDomain()}/admin/api/${API_VERSION()}/graphql.json`, {
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

// Exchange an OAuth authorization code for a (permanent) offline Admin token.
// Tenant app creds first (S21 web connect flow), env fallback (legacy script).
export async function exchangeCodeForToken(code) {
  const res = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: tenantOwnCfg("shopify_client_id", "SHOPIFY_CLIENT_ID"),
      client_secret: tenantOwnSecret("shopify_client_secret", "SHOPIFY_CLIENT_SECRET"),
      code,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text); // { access_token, scope }
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
