// Shopify OAuth plumbing for the web connect flow (Session 21) — ports the
// one-time scripts/shopify-oauth.js logic to per-tenant, stateless routes.
// Node-runtime only (node:crypto).
import crypto from "node:crypto";
import { shopifyBase } from "../shopify-origin.js";

const STATE_TTL_MS = 10 * 60 * 1000;

// S28: during a secret rotation BOTH keys verify (PLATFORM_SECRET_NEXT first
// for signing), so in-flight OAuth states survive the key swap.
function platformKeys() {
  const current = process.env.PLATFORM_SECRET;
  if (!current) throw new Error("PLATFORM_SECRET not set");
  const next = process.env.PLATFORM_SECRET_NEXT;
  const secrets = next && next !== current ? [next, current] : [current];
  return secrets.map((s) => crypto.createHash("sha256").update(s).digest());
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Stateless CSRF state, HMAC-signed with the platform key, so the callback
// verifies it on any isolate. Phase 1 line 4: every state carries a kind, and
// each callback takes only its own:
//   op  the operator flow   op|tenantId|nonce|exp          signState / verifyState
//   fd  the founder flow    fd|tenantId|sha256(admin cookie)|sha256(nonce)|exp
//                                                          signFounderState / verifyFounderState
// The founder's nonce lives in an httpOnly cookie (the connect route sets it),
// so a state is good only with the session and the browser that started it.
const sign = (payload) => `${b64url(payload)}.${crypto.createHmac("sha256", platformKeys()[0]).update(payload).digest("base64url")}`;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const same = (a, b) => {
  try {
    return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
  } catch {
    return false;
  }
};

// The signed payload's fields, or null when the signature is not ours.
function openState(state) {
  try {
    const [payloadB64, sig] = String(state || "").split(".");
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    const matches = platformKeys().some((key) => same(sig || "", crypto.createHmac("sha256", key).update(payload).digest("base64url")));
    return matches ? payload.split("|") : null;
  } catch {
    return null;
  }
}

export function signState(tenantId, now = Date.now()) {
  return sign(`op|${tenantId}|${crypto.randomBytes(12).toString("hex")}|${now + STATE_TTL_MS}`);
}

export function verifyState(state, now = Date.now()) {
  const f = openState(state);
  if (!f || f.length !== 4 || f[0] !== "op") return null;
  const [, tenantId, , expStr] = f;
  if (!tenantId || now > Number(expStr)) return null;
  return { tenantId };
}

export const newNonce = () => crypto.randomBytes(16).toString("base64url");

export function signFounderState({ tenantId, adminCookie, nonce, now = Date.now() }) {
  return sign(`fd|${tenantId}|${sha(adminCookie)}|${sha(nonce)}|${now + STATE_TTL_MS}`);
}

// → { ok: true } | { ok: false, code: "mismatch" | "expired" }
// mismatch: not our signature, not a founder state, another store, another
// session or another browser (the nonce cookie missing or different).
export function verifyFounderState(state, { tenantId, adminCookie, nonce, now = Date.now() }) {
  const f = openState(state);
  if (!f || f.length !== 5 || f[0] !== "fd") return { ok: false, code: "mismatch" };
  const [, tid, cookieHash, nonceHash, expStr] = f;
  if (tid !== tenantId) return { ok: false, code: "mismatch" };
  // before the cookies: the nonce cookie lapses with the state
  if (!(now <= Number(expStr))) return { ok: false, code: "expired" };
  if (!adminCookie || !nonce || !same(cookieHash, sha(adminCookie)) || !same(nonceHash, sha(nonce))) return { ok: false, code: "mismatch" };
  return { ok: true };
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

// The one scope list (SHOP-01): the web connect flow here and the one-time
// scripts/shopify-oauth.js both use it. Catalog reads, draft-order push, plus
// storefront-token minting rights. Write scopes are locked by
// scripts/test-shopify-boundary.js: content is never written back to Shopify.
export const OAUTH_SCOPES = [
  "read_products",
  "read_orders",
  "write_orders", // S24 quirk fix: order:cancel calls orderCancel — tokens minted here must carry it
  "write_draft_orders",
  "unauthenticated_read_product_listings",
  "unauthenticated_read_product_inventory",
  "unauthenticated_read_product_tags",
].join(",");

// S30 (BE25): a minted token must carry every requested scope — a partial
// grant surfaces NOW, not months later when orderCancel needs write_orders.
// S51: Shopify grants imply read when write is held (write_orders ⊇
// read_orders) and only echo the write scope, so a read_x is satisfied by
// write_x — the first real onboarding false-alarmed on exactly this.
export function missingScopes(granted) {
  const have = new Set(
    String(granted || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const satisfied = (s) => have.has(s) || (s.startsWith("read_") && have.has(`write_${s.slice(5)}`));
  return OAUTH_SCOPES.split(",").filter((s) => !satisfied(s));
}

export function buildAuthorizeUrl({ shopDomain, clientId, redirectUri, state }) {
  return (
    `${shopifyBase(shopDomain)}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`
  );
}
