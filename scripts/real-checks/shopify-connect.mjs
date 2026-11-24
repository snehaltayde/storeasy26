// The one real Shopify check for Phase 1 line 4 (owner-run only; no test,
// drill or agent runs it). Everything else talks to the local stand-in
// (scripts/support/fake-shopify.js); this is the only thing that proves
// Shopify's expiring offline tokens and their refresh against the real service.
//
//   STOREASY_REAL_SHOPIFY=1 PLATFORM_DB_URL=… PLATFORM_DB_TOKEN=… PLATFORM_SECRET=… \
//     node scripts/real-checks/shopify-connect.mjs --tenant <slug>
//
// Run it on a store the founder flow has just connected (onboarding step 1).
// It refuses unless STOREASY_REAL_SHOPIFY is exactly "1", --tenant is given
// and SHOPIFY_API_ORIGIN is unset. Then, never printing a token:
//   1. the stored access token's expiry (about an hour) and the refresh
//      token's (about 90 days)
//   2. the granted scopes against the requested list (missing ones named)
//   3. one refresh through getAdminAccessToken (the stored expiry is set to
//      now first, so the real refresh path runs and saves the new pair)
//   4. a read-only `shop { name }` query with the new token
// It writes only the store's own token fields (what any refresh writes).
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { tenant: { type: "string" } } });
const refuse = (why) => {
  console.error(`✗ ${why}`);
  process.exit(2);
};
if (process.env.STOREASY_REAL_SHOPIFY !== "1") refuse("This reaches the real Shopify. Set STOREASY_REAL_SHOPIFY=1 to say you mean it.");
if (process.env.SHOPIFY_API_ORIGIN) refuse("SHOPIFY_API_ORIGIN is set (the local stand-in). Unset it for the real check.");
if (!values.tenant) refuse("Name the store: --tenant <slug>.");
if (!process.env.PLATFORM_DB_URL || !process.env.PLATFORM_SECRET) refuse("PLATFORM_DB_URL and PLATFORM_SECRET are needed to read the store's tokens.");

const C = await import("../../lib/platform/control.js");
const { withTenant } = await import("../../lib/tenant-context.js");
const { missingScopes } = await import("../../lib/platform/oauth.js");
const SA = await import("../../lib/shopify-admin.js");

const id = values.tenant;
const before = await C.getTenant(id, { fresh: true });
if (!before) refuse(`No store "${id}".`);
const mins = (iso) => (iso ? Math.round((Date.parse(iso) - Date.now()) / 60_000) : null);
if (!before.secrets?.shopify_admin_token) refuse("The store holds no Shopify token. Connect it from onboarding step 1 first.");
if (!before.secrets?.shopify_refresh_token) refuse("The store's token has no refresh token: it is non-expiring (not from the founder flow, or Shopify ignored expiring=1).");
console.log(`✓ access token expires in ${mins(before.config.shopify_token_expires_at)} min (expect about 60)`);
console.log(`✓ refresh token expires in ${Math.round(mins(before.config.shopify_refresh_expires_at) / 1440)} days (expect about 90)`);
const missing = missingScopes(before.config.shopify_scopes);
console.log(missing.length ? `✗ missing scopes: ${missing.join(", ")}` : "✓ every requested scope was granted");

await C.patchTenant(id, { config: { shopify_token_expires_at: new Date().toISOString() } });
SA.forgetAdminToken(id);
const t = await C.getTenant(id, { fresh: true });
const token = await withTenant(t, () => SA.getAdminAccessToken());
const after = await C.getTenant(id, { fresh: true });
const changed = token !== before.secrets.shopify_admin_token && after.secrets.shopify_refresh_token !== before.secrets.shopify_refresh_token;
console.log(changed ? `✓ one refresh: a new pair saved, access token now expires in ${mins(after.config.shopify_token_expires_at)} min` : "✗ the refresh did not save a new pair");
const d = await withTenant(after, () => SA.adminGraphql("query { shop { name } }"));
console.log(d?.shop?.name ? `✓ shop { name } with the new token: ${d.shop.name}` : "✗ the shop query answered nothing");
process.exit(changed && d?.shop?.name && !missing.length ? 0 : 1);
