// Phase 1 line 4: what every Shopify connect does once Shopify has sent the
// browser back with a code, shared by the operator flow
// (app/api/connect/shopify/callback) and the founder flow
// (lib/onboarding/connect.js). Node only. Nothing here writes to Shopify
// except the allowlisted webhook registration (lib/platform/shopify-webhooks.js).
//
//   otherTenantHoldingShop(shop, tenantId)
//     → the id of another ACTIVE store that holds a token for this shop (and
//       has not been uninstalled), or null
//   completeConnection({ tenant, code, shop, connectedBy, platformUrl, defer, started, exclusive })
//     exchanges the code (expiring token), stores the token pair encrypted with
//     its expiry times, connected_at and connected_by, clears the uninstall and
//     reconnect flags, warns on missing scopes, registers webhooks on an https
//     platform URL and queues the first sync (startedBy "connect").
//     exclusive: check again, just before saving, that no other store holds
//     this shop (throws ConnectError "other_store").
//     → { scope, missing, webhooks, syncQueued }
//     A failed exchange throws ConnectError "token_failed".
import { getTenant, getTenantsByShopDomain, patchTenant } from "./control.js";
import { missingScopes } from "./oauth.js";
import { registerWebhooks } from "./shopify-webhooks.js";
import { startCatalogSync, KICK_BUDGET_MS } from "./sync-jobs.js";
import { exchangeCodeForToken, forgetAdminToken, tokenFields } from "../shopify-admin.js";
import { withTenant } from "../tenant-context.js";
import { sendAlert } from "../alerts.js";
import { slog } from "../log.js";

export class ConnectError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export async function otherTenantHoldingShop(shop, tenantId) {
  for (const t of await getTenantsByShopDomain(shop)) {
    if (t.id === tenantId) continue;
    if ((t.secrets?.shopify_admin_token || t.secrets?.shopify_refresh_token) && !t.config?.shopify_app_uninstalled_at) return t.id;
  }
  return null;
}

export async function completeConnection({ tenant, code, shop, connectedBy = null, platformUrl = "", defer = null, started = Date.now(), exclusive = false }) {
  let tok;
  try {
    tok = await withTenant(tenant, () => exchangeCodeForToken(code));
    if (!tok?.access_token) throw new Error("no access_token in Shopify's answer");
  } catch (e) {
    console.error(`[connect] ${tenant.id}: ${e?.message || e}`);
    throw new ConnectError("token_failed", String(e?.message || e));
  }
  if (exclusive && (await otherTenantHoldingShop(shop, tenant.id))) throw new ConnectError("other_store");
  const fields = tokenFields(tok);
  await patchTenant(tenant.id, {
    secrets: fields.secrets,
    config: {
      ...fields.config,
      shopify_scopes: tok.scope || null,
      shopify_connected_at: new Date().toISOString(),
      shopify_connected_by: connectedBy,
      shopify_app_uninstalled_at: null, // a reconnect clears the uninstall flag
      shopify_reauth_needed_at: null,
    },
  });
  forgetAdminToken(tenant.id);
  slog("shopify_connected", { tenant: tenant.id, shop, scopes: tok.scope });

  // S30 (BE25): a partial grant is a loud warning now, not a mystery failure later
  const missing = missingScopes(tok.scope);
  if (missing.length) {
    await sendAlert(
      `Shopify token for ${tenant.id} is missing scope(s): ${missing.join(", ")} — re-run the connect flow after fixing the app's scopes`,
      { tenant: tenant.id, shop, missing },
      { severity: "warn" },
    );
  }

  // Webhooks need a publicly reachable https URL — on localhost this is
  // skipped (register later with `pnpm webhooks:register <slug>`).
  let webhooks = "skipped (no https platform URL)";
  if (String(platformUrl).startsWith("https://")) {
    const fresh = await getTenant(tenant.id, { fresh: true });
    const results = await registerWebhooks(fresh, { callbackUrl: `${platformUrl}/api/shopify/webhooks` }).catch((e) => ({ error: String(e?.message || e) }));
    webhooks = Array.isArray(results) ? `${results.filter((r) => r.status !== "error").length}/${results.length} registered` : `failed: ${results.error}`;
  }

  // First catalog sync: recorded and queued BEFORE the response, so it
  // survives this function ending; its first slice runs after the response.
  let syncQueued = true;
  try {
    const fresh = await getTenant(tenant.id, { fresh: true });
    const { run, action } = await withTenant(fresh, () => startCatalogSync({ startedBy: "connect", defer, budgetMs: Math.max(0, KICK_BUDGET_MS - (Date.now() - started)) }));
    slog("initial_sync_queued", { tenant: tenant.id, run: run.id, action });
  } catch (e) {
    syncQueued = false;
    console.error(`[connect] could not queue the first sync for ${tenant.id}: ${e?.message || e}`);
  }
  return { scope: tok.scope || "", missing, webhooks, syncQueued };
}
