// An operator's store lifecycle actions (Phase 3 line 2): suspend or resume,
// maintenance on or off, and rotating the secrets Storeasy holds for a store.
// Node-only (the operator API and the store page). Each write records an
// audit row with the real operator and a slog line; no secret value ever
// reaches either, nor the owner's mail.
//
//   setStoreStatus(id, "suspended" | "active", { reason, actor })
//     -> { tenant, mail: "sent" | "failed" | "not_configured" | "no_owner" }
//   setMaintenance(id, { enabled, message }, { actor }) -> { tenant }
//   rotateStoreSecrets(id, keys) -> { rotated, values }   (no audit: callers do)
//   operatorRotate(id, keys, { actor }) -> { rotated, consolePassword? }
//   lifecycleView(id) -> what the store page's lifecycle card shows
//
// A suspended store fails closed everywhere through resolveHost (S25):
// storefront and console answer "unavailable", the job worker defers its jobs
// (lib/platform/worker.js), and patchTenant drops this server's cache at once.
// Other servers see it when their 30-second host cache runs out.
import { randomBytes } from "node:crypto";
import { getTenant, patchTenant, platformDb } from "./control.js";
import { audit, operatorActor } from "./audit.js";
import { tenantHasMembers } from "./sessions.js";
import { sendPlatformMail } from "./platform-mail.js";
import { mailConfigured } from "../mail.js";
import { slog } from "../log.js";

// The only secrets an operator may rotate: Storeasy made them, nobody outside
// holds them. Anything else in a store's envelope belongs to the merchant (or
// to Shopify's install) and is never rotated here.
export const ROTATABLE_SECRETS = Object.freeze({
  order_link_secret: "Order-link signing key",
  admin_password: "Store console password",
});

// Merchant-owned keys, listed by name so the operator knows where they live.
export const MERCHANT_KEYS = Object.freeze([
  { name: "Razorpay", keys: ["razorpay_key_secret", "razorpay_webhook_secret"] },
  { name: "Meta", keys: ["meta_capi_token"] },
  { name: "Google Analytics", keys: ["ga4_api_secret"] },
]);

export const REASON_MIN = 5;
const REASON_MAX = 300;
const MESSAGE_MAX = 300;

export class LifecycleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function tenantOr404(id) {
  const tenant = typeof id === "string" && id ? await getTenant(id, { fresh: true }) : null;
  if (!tenant) throw new LifecycleError("Not found", 404);
  return tenant;
}

const ownerEmails = async (id) =>
  (await platformDb().execute({ sql: "SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = 'owner' AND u.email IS NOT NULL ORDER BY u.email", args: [id] })).rows.map((r) => String(r.email));

const STATUS_MAIL = {
  suspended: {
    kind: "store_suspended",
    subject: (name) => `${name} is paused`,
    text: (name) =>
      `Storeasy has paused ${name}.\n\nWhile it is paused, shoppers see the store as unavailable and the store's console is closed. Nothing has been deleted: your products, pages, orders and settings are kept.\n\nReply to this email if you have questions.`,
  },
  active: {
    kind: "store_resumed",
    subject: (name) => `${name} is open again`,
    text: (name) => `Storeasy has resumed ${name}. Shoppers can visit the store again and your console is open.`,
  },
};

// The owner hears about a suspend or resume when mail is set up. The reason
// is the operator's note for the audit trail, so it is not in the mail.
async function mailOwners(tenant, status) {
  if (!mailConfigured()) return "not_configured";
  const to = await ownerEmails(tenant.id);
  if (!to.length) return "no_owner";
  const m = STATUS_MAIL[status];
  let sent = 0;
  for (const email of to) {
    const r = await sendPlatformMail({ kind: m.kind, to: email, subject: m.subject(tenant.name), text: m.text(tenant.name), ref: tenant.id }).catch(() => null);
    if (r?.ok) sent++;
  }
  return sent === to.length ? "sent" : "failed";
}

export async function setStoreStatus(id, status, { reason, actor }) {
  if (!["active", "suspended"].includes(status)) throw new LifecycleError('status must be "active" or "suspended"');
  const why = String(reason ?? "").trim().slice(0, REASON_MAX);
  if (why.length < REASON_MIN) throw new LifecycleError(`Give a reason of at least ${REASON_MIN} characters.`);
  const current = await tenantOr404(id);
  if (current.status === status) throw new LifecycleError(status === "suspended" ? "The store is already suspended." : "The store is already active.", 409);
  const tenant = await patchTenant(id, { status });
  slog("tenant_status_changed", { tenant: id, status });
  await audit({ actor: operatorActor(actor), action: "tenant.status", resource: `tenant:${id}`, tenantId: id, diff: { status, reason: why } });
  const mail = await mailOwners(tenant, status);
  return { tenant, mail };
}

export async function setMaintenance(id, { enabled, message } = {}, { actor }) {
  await tenantOr404(id);
  const on = Boolean(enabled);
  const maintenance = on ? { enabled: true, message: String(message || "").trim().slice(0, MESSAGE_MAX), since: new Date().toISOString() } : null;
  const tenant = await patchTenant(id, { config: { maintenance } });
  slog("tenant_maintenance", { tenant: id, enabled: on });
  await audit({ actor: operatorActor(actor), action: "tenant.maintenance", resource: `tenant:${id}`, tenantId: id, diff: { enabled: on } });
  return { tenant };
}

// Fresh values for the named keys, written in one patch. Offboarding uses it
// too (lib/platform/export.js). Values go back to the caller only.
export async function rotateStoreSecrets(id, keys) {
  const list = [...new Set(Array.isArray(keys) ? keys : [])];
  if (!list.length) throw new LifecycleError("Choose at least one key to rotate.");
  const unknown = list.find((k) => !Object.hasOwn(ROTATABLE_SECRETS, k));
  if (unknown) throw new LifecycleError(`"${String(unknown).slice(0, 40)}" can't be rotated here.`);
  const values = {};
  for (const k of list) values[k] = k === "admin_password" ? randomBytes(12).toString("base64url") : randomBytes(32).toString("hex");
  await patchTenant(id, { secrets: values });
  return { rotated: list, values };
}

// The operator's rotation. The console password is only the bootstrap way in
// before a store has members (lib/admin-auth.js), so it is rotated only then:
// a store with members has no use for a new one, and showing one would hand
// out a credential nobody needs.
export async function operatorRotate(id, keys, { actor }) {
  await tenantOr404(id);
  if (Array.isArray(keys) && keys.includes("admin_password") && (await tenantHasMembers(id))) {
    throw new LifecycleError("This store has team members, so its console password isn't used. Members change their own passwords.", 409);
  }
  const { rotated, values } = await rotateStoreSecrets(id, keys);
  slog("tenant_secrets_rotated", { tenant: id, rotated });
  await audit({ actor: operatorActor(actor), action: "tenant.secrets_rotate", resource: `tenant:${id}`, tenantId: id, diff: { rotated } });
  return { rotated, ...(values.admin_password ? { consolePassword: values.admin_password } : {}) };
}

// The store page's lifecycle card: real status, maintenance and its message,
// which rotatable keys exist, merchant key names, members, mail. No values.
export async function lifecycleView(id) {
  const tenant = await getTenant(id);
  if (!tenant) return null;
  const names = new Set(Object.keys(tenant.secrets || {}));
  const m = tenant.config?.maintenance;
  return {
    status: tenant.status,
    maintenance: m?.enabled ? { enabled: true, message: m.message || "", since: m.since || null } : { enabled: false, message: "" },
    hasMembers: await tenantHasMembers(id),
    mailReady: mailConfigured(),
    rotatable: Object.entries(ROTATABLE_SECRETS).map(([key, label]) => ({ key, label, present: names.has(key) })),
    merchantKeys: MERCHANT_KEYS.map((g) => ({ name: g.name, present: g.keys.some((k) => names.has(k)) })),
    details: {
      name: tenant.name,
      domains: tenant.domains || [],
      shopDomain: tenant.config?.shopify_store_domain || "",
      clientId: tenant.config?.shopify_client_id || "",
      hasClientSecret: names.has("shopify_client_secret"),
      orderPrefix: tenant.config?.order_prefix || "",
      supportEmail: tenant.config?.site?.support_email || "",
    },
  };
}
