// Shopify OAuth plumbing for the web connect flow (Session 21) — ports the
// one-time scripts/shopify-oauth.js logic to per-tenant, stateless routes.
// Node-runtime only (node:crypto).
import crypto from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

function platformKey() {
  const secret = process.env.PLATFORM_SECRET;
  if (!secret) throw new Error("PLATFORM_SECRET not set");
  return crypto.createHash("sha256").update(secret).digest();
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Stateless CSRF state: tenant + nonce + expiry, HMAC-signed with the platform
// key — the callback can verify it on any isolate (no session store needed).
export function signState(tenantId, now = Date.now()) {
  const payload = `${tenantId}|${crypto.randomBytes(12).toString("hex")}|${now + STATE_TTL_MS}`;
  const sig = crypto.createHmac("sha256", platformKey()).update(payload).digest("base64url");
  return `${b64url(payload)}.${sig}`;
}

export function verifyState(state, now = Date.now()) {
  try {
    const [payloadB64, sig] = String(state || "").split(".");
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    const expect = crypto.createHmac("sha256", platformKey()).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig || ""), Buffer.from(expect))) return null;
    const [tenantId, , expStr] = payload.split("|");
    if (!tenantId || now > Number(expStr)) return null;
    return { tenantId };
  } catch {
    return null;
  }
}

// Shopify signs callback query params with the APP's client secret (hex HMAC
// over the sorted params minus hmac/signature).
export function verifyOAuthCallbackHmac(searchParams, clientSecret) {
  const p = new URLSearchParams(searchParams);
  const hmac = p.get("hmac") || "";
  p.delete("hmac");
  p.delete("signature");
  const message = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", clientSecret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

// Same scopes the single-store OAuth used: catalog reads, draft-order push,
// plus storefront-token minting rights.
export const OAUTH_SCOPES = [
  "read_products",
  "read_orders",
  "write_draft_orders",
  "unauthenticated_read_product_listings",
  "unauthenticated_read_product_inventory",
  "unauthenticated_read_product_tags",
].join(",");

export function buildAuthorizeUrl({ shopDomain, clientId, redirectUri, state }) {
  return (
    `https://${shopDomain}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`
  );
}
