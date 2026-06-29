// Shopify Admin API helper (SERVER-ONLY). Never import into client code.
//
// Token resolution order:
//   1. SHOPIFY_ADMIN_TOKEN  — a permanent offline token from OAuth (preferred)
//   2. client-credentials grant (SHOPIFY_CLIENT_ID/SECRET) — 24h, same-org dev stores only
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

function storeDomain() {
  const d = process.env.SHOPIFY_STORE_DOMAIN;
  if (!d) throw new Error("SHOPIFY_STORE_DOMAIN is not set (.env.local)");
  return d;
}

let ccCache = null; // { token, expiresAt }

async function clientCredentialsToken() {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("No SHOPIFY_ADMIN_TOKEN, and SHOPIFY_CLIENT_ID/SECRET not set either");
  }
  if (ccCache && ccCache.expiresAt > Date.now() + 60_000) return ccCache.token;

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
  ccCache = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 86399) * 1000 };
  return ccCache.token;
}

export async function getAdminAccessToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  return clientCredentialsToken();
}

export async function adminGraphqlWithToken(token, query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${storeDomain()}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    // 429 = REST-style rate limit; back off and retry.
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return adminGraphqlWithToken(token, query, variables, attempt + 1);
    }
    throw new Error(`Admin GraphQL HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text);
  if (json.errors) {
    const throttled = json.errors.some((e) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return adminGraphqlWithToken(token, query, variables, attempt + 1);
    }
    throw new Error(`Admin GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
  }
  return json.data;
}

export async function adminGraphql(query, variables = {}) {
  return adminGraphqlWithToken(await getAdminAccessToken(), query, variables);
}

// Exchange an OAuth authorization code for a (permanent) offline Admin token.
export async function exchangeCodeForToken(code) {
  const res = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
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
