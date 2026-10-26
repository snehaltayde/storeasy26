import { AsyncLocalStorage } from "node:async_hooks";

// Tenant request context (Session 20) — the heart of multi-tenancy.
//
// `withTenant(tenant, fn)` binds a resolved tenant for fn's ENTIRE await chain
// (AsyncLocalStorage; supported on Node AND the edge runtime). lib/db.js and
// every config accessor consult `currentTenant()`:
//   • context set   → that tenant's database + config/secrets
//   • no context    → the env-configured default (BeastLife) — which is why
//     every pre-S20 script, test, and cron keeps working unchanged.
//
// This file is runtime-pure (no next/* imports) so node scripts can load it;
// the Next-facing resolution helpers live in lib/tenant-request.js.

const als = new AsyncLocalStorage();

export function withTenant(tenant, fn) {
  return als.run(tenant || null, fn);
}

export const currentTenant = () => als.getStore() || null;

// Non-secret config: tenant value first, env fallback.
export function tenantCfg(key, envKey, fallback = undefined) {
  const t = currentTenant();
  if (t && t.config && t.config[key] != null) return t.config[key];
  if (envKey && process.env[envKey] != null && process.env[envKey] !== "") return process.env[envKey];
  return fallback;
}

// Secrets: tenant secrets first, env fallback.
export function tenantSecret(key, envKey, fallback = undefined) {
  const t = currentTenant();
  if (t && t.secrets && t.secrets[key] != null && t.secrets[key] !== "") return t.secrets[key];
  if (envKey && process.env[envKey] != null && process.env[envKey] !== "") return process.env[envKey];
  return fallback;
}

export const tenantId = () => currentTenant()?.id || "_default";

// Shipping rules live in tenant config once the S22 console edits them;
// undefined here lets computeShipping fall back to its code default.
// (Helper lives HERE because lib/shipping.js must stay client-safe.)
export const tenantShippingConfig = () => currentTenant()?.config?.shipping_config ?? undefined;
